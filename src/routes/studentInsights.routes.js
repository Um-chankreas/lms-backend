const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const { levelInfo } = require('../utils/xp');
const { getStreakSummary } = require('../utils/streak');
const { isSubscriptionActive } = require('../utils/access');
const { buildStudentTableWorkbook } = require('../utils/dashboardReport');
const { buildCsv, buildCsvZip, buildPdf, safeName } = require('../utils/studentTableExport');
const { courseProgress, fetchAllRows, fetchAllIn, toMs, toIso } = require('../utils/studentProgress');
const { buildLiveReport } = require('../utils/liveReport');
const { createNotifications, userPrefs } = require('../utils/notifications');
const tg = require('../utils/telegram');

// Student progress insights for the web portal (admins + teachers). Teachers
// only ever see their own courses: a class roster for a course they own, and a
// student profile limited to the courses of theirs the student is enrolled in.
// Global gamification (XP, level, rank, streaks, achievements, study time) is
// shown to both.

const DAY_MS = 86400000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INACTIVE_DAYS = 7;        // no activity for this long -> 'inactive'
const BEHIND_MARGIN = 20;       // percentage points under the class median -> 'behind'
const CALENDAR_DAYS = 84;       // profile study heatmap (12 weeks)
const XP_WEEKS = 12;            // profile weekly XP chart
const RECENT_XP = 15;
const QUIZ_HISTORY = 30;
const ASSIGNMENT_HISTORY = 30;
const RECENT_LIVE_CLASSES = 10;
const OVERVIEW_DAYS = 30;           // dashboard daily-active chart
const OVERVIEW_CONCURRENCY = 4;     // course rosters built at once
const TOP_LEARNERS = 5;

// UTC 'YYYY-MM-DD' — how activity_days / study_minutes days are written.
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const roundOrNull = (v) => (v == null ? null : Math.round(v));
const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// rows -> Map(row[key] -> rows[])
function groupBy(rows, key) {
  const out = new Map();
  rows.forEach(r => {
    if (!out.has(r[key])) out.set(r[key], []);
    out.get(r[key]).push(r);
  });
  return out;
}

// The earliest enrolled_at per id (old enrollments predate the unique
// constraint, so duplicates can exist). Map(row[key] -> enrolled_at).
function earliestEnrollment(rows, key) {
  const out = new Map();
  rows.forEach(r => {
    const cur = out.get(r[key]);
    if (!out.has(r[key]) || (toMs(r.enrolled_at) ?? Infinity) < (toMs(cur) ?? Infinity)) out.set(r[key], r.enrolled_at);
  });
  return out;
}

// One submission per assignment (the latest, should a duplicate slip in).
function latestByAssignment(subs) {
  const out = new Map();
  subs.forEach(s => {
    const cur = out.get(s.assignment_id);
    if (!cur || (toMs(s.submitted_at) ?? 0) > (toMs(cur.submitted_at) ?? 0)) out.set(s.assignment_id, s);
  });
  return out;
}

const publicCourse = (c) => ({ id: c.id, title: c.title, color: c.color || null, icon: c.icon || null });

/**
 * { total, attempted, passed, avg_score } for one student over the published
 * quizzes in `publishedIds`. avg_score = mean of each attempted quiz's best
 * score (retakes don't drag it down).
 */
function quizStats(publishedIds, subs) {
  const attempted = new Set();
  const passed = new Set();
  const best = new Map();
  subs.forEach(s => {
    if (!publishedIds.has(s.quiz_id)) return;
    attempted.add(s.quiz_id);
    if (s.passed) passed.add(s.quiz_id);
    const score = numOrNull(s.score);
    if (score != null && score > (best.get(s.quiz_id) ?? -Infinity)) best.set(s.quiz_id, score);
  });
  return {
    total: publishedIds.size,
    attempted: attempted.size,
    passed: passed.size,
    avg_score: roundOrNull(mean([...best.values()])),
  };
}

/**
 * { total, submitted, missing, avg_pct } for one student over `published`
 * assignments. `grade`/`score` are stored as 0-100 percentages for both file-
 * and quiz-type assignments (sql/033: `points` only scales them for display),
 * so a submission's percentage is grade (a teacher's grade/override) ?? score.
 */
function assignmentStats(published, subByAssignment, now) {
  let submitted = 0;
  let missing = 0;
  const pcts = [];
  published.forEach(a => {
    const s = subByAssignment.get(a.id);
    if (s) {
      submitted += 1;
      const pct = numOrNull(s.grade) ?? numOrNull(s.score);
      if (pct != null) pcts.push(pct);
    } else if (a.due_date && toMs(a.due_date) < now) {
      missing += 1;
    }
  });
  return { total: published.length, submitted, missing, avg_pct: roundOrNull(mean(pcts)) };
}

// Staff only. The role comes from the account row authenticateToken just
// re-read (not the days-old token), so a role change applies immediately.
const isStaff = (req, res, next) => {
  const role = req.account?.role || req.user?.role;
  if (role !== 'admin' && role !== 'super_admin' && role !== 'teacher') {
    return res.status(403).json({
      success: false,
      error: 'This action requires admin or teacher privileges'
    });
  }
  // A super admin sees the whole school, exactly like an admin.
  req.staffRole = role === 'super_admin' ? 'admin' : role;
  next();
};

router.use(authenticateToken, isStaff);

/**
 * The class roster for one course (see GET /courses/:courseId/students):
 * { course, lessons, summary, students }. Shared with GET /overview.
 */
async function buildRoster(course, opts) {
  const courseId = course.id;

  const enrollments = await fetchAllRows(() => supabase
    .from('course_enrollments')
    .select('id, student_id, enrolled_at')
    .eq('course_id', courseId)
    .order('id', { ascending: true }));
  const enrolledAt = earliestEnrollment(enrollments, 'student_id');

  // Test / team accounts stay out of the roster unless asked for.
  const includeTest = !!(opts && opts.includeTest === true);
  const users = await fetchAllIn([...enrolledAt.keys()], chunk => {
    const q = supabase
      .from('users')
      .select('id, name, email, phone, avatar_url, is_active, xp, created_at')
      .in('id', chunk)
      .eq('role', 'student');
    let query = includeTest ? q : q.eq('is_test', false);
    // The class page also hides deactivated accounts (they are not really in the class).
    if (opts && opts.excludeDeactivated === true) query = query.eq('is_active', true);
    return query.order('id', { ascending: true });
  });
  const studentIds = users.map(u => u.id);
  const studentSet = new Set(studentIds);

  const now = Date.now();
  const since7 = dayKey(now - 6 * DAY_MS);   // today + the 6 days before
  const since90 = dayKey(now - 89 * DAY_MS);

  const [progress, quizzes, assignments, xpRows, activityRows, studyRows, subscriptionRows] = await Promise.all([
    courseProgress({ courseIds: [courseId], studentIds }),
    fetchAllRows(() => supabase
      .from('quizzes')
      .select('id, status')
      .eq('course_id', courseId)
      .order('id', { ascending: true })),
    fetchAllRows(() => supabase
      .from('assignments')
      .select('id, due_date')
      .eq('course_id', courseId)
      .eq('status', 'published')
      .order('id', { ascending: true })),
    fetchAllIn(studentIds, chunk => supabase
      .from('xp_events')
      .select('id, student_id, amount, created_at')
      .eq('course_id', courseId)
      .in('student_id', chunk)
      .order('id', { ascending: true })),
    fetchAllIn(studentIds, chunk => supabase
      .from('activity_days')
      .select('student_id, day')
      .in('student_id', chunk)
      .gte('day', since90)
      .order('student_id', { ascending: true })
      .order('day', { ascending: true })),
    fetchAllIn(studentIds, chunk => supabase
      .from('study_minutes')
      .select('student_id, day, minutes')
      .in('student_id', chunk)
      .gte('day', since7)
      .order('student_id', { ascending: true })
      .order('day', { ascending: true })),
    fetchAllIn(studentIds, chunk => supabase
      .from('student_course_subscriptions')
      .select('student_id, expiry_date')
      .eq('course_id', courseId)
      .in('student_id', chunk)
      .order('student_id', { ascending: true })),
  ]);

  // Submissions for this course's quizzes / assignments (by anyone), then
  // narrowed to the roster — keeps the URL to the course's own id lists.
  const [quizSubs, assignmentSubs] = studentIds.length === 0 ? [[], []] : await Promise.all([
    fetchAllIn(quizzes.map(q => q.id), chunk => supabase
      .from('quiz_submissions')
      .select('id, student_id, quiz_id, score, passed, submitted_at')
      .in('quiz_id', chunk)
      .order('id', { ascending: true })),
    fetchAllIn(assignments.map(a => a.id), chunk => supabase
      .from('assignment_submissions')
      .select('id, student_id, assignment_id, grade, score, submitted_at')
      .in('assignment_id', chunk)
      .order('id', { ascending: true })),
  ]);

  const publishedQuizIds = new Set(quizzes.filter(q => q.status === 'published').map(q => q.id));
  const onRoster = (r) => studentSet.has(r.student_id);
  const quizSubsBy = groupBy(quizSubs.filter(onRoster), 'student_id');
  const assignmentSubsBy = groupBy(assignmentSubs.filter(onRoster), 'student_id');
  const xpBy = groupBy(xpRows, 'student_id');
  const activityBy = groupBy(activityRows, 'student_id');
  const studyBy = groupBy(studyRows, 'student_id');
  const expiryBy = new Map(subscriptionRows.map(s => [s.student_id, s.expiry_date]));

  const rows = users.map(u => {
    const { path, ...progressSummary } = progress.get(u.id, courseId);
    const mySubs = quizSubsBy.get(u.id) || [];
    const myXp = xpBy.get(u.id) || [];
    const myDays = activityBy.get(u.id) || [];
    const courseXp = myXp.reduce((sum, e) => sum + (e.amount || 0), 0);

    // Last active = the latest of: an active day (last 90 days), progress in
    // this course, a submission to one of its quizzes, XP earned in it.
    let lastMs = null;
    const touch = (ts) => { const ms = toMs(ts); if (ms != null && (lastMs == null || ms > lastMs)) lastMs = ms; };
    myDays.forEach(d => touch(d.day));
    touch(progressSummary.last_progress_at);
    mySubs.forEach(s => touch(s.submitted_at));
    myXp.forEach(e => touch(e.created_at));
    const daysInactive = lastMs == null ? null : Math.max(0, Math.floor((now - lastMs) / DAY_MS));

    const expiry = expiryBy.get(u.id) || null;
    return {
      student: {
        id: u.id,
        name: u.name,
        email: u.email || null,
        phone: u.phone || null,
        avatar_url: u.avatar_url || null,
        is_active: u.is_active !== false,
        created_at: toIso(u.created_at)
      },
      enrolled_at: toIso(enrolledAt.get(u.id)),
      progress: progressSummary,
      xp: { total: u.xp || 0, course: courseXp, level: levelInfo(u.xp || 0).level },
      quizzes: quizStats(publishedQuizIds, mySubs),
      assignments: assignmentStats(assignments, latestByAssignment(assignmentSubsBy.get(u.id) || []), now),
      activity: {
        last_active: lastMs == null ? null : new Date(lastMs).toISOString(),
        days_inactive: daysInactive,
        active_days_7d: myDays.filter(d => String(d.day).slice(0, 10) >= since7).length,
        study_minutes_7d: (studyBy.get(u.id) || []).reduce((sum, r) => sum + (r.minutes || 0), 0)
      },
      subscription: { is_active: isSubscriptionActive(expiry), expiry_date: expiry },
      // Any submission counts as "started", even to a quiz since unpublished.
      _attemptedAny: mySubs.length > 0,
    };
  });

  // Status, first match wins. 'behind' is relative to the class median.
  const classMedian = median(rows.map(r => r.progress.percentage));
  rows.forEach(r => {
    const p = r.progress;
    const idle = r.activity.days_inactive;
    if (p.units_total > 0 && p.percentage === 100 && p.current === null) r.status = 'completed';
    else if (p.units_done === 0 && !r._attemptedAny && r.xp.course === 0) r.status = 'not_started';
    else if (idle === null || idle >= INACTIVE_DAYS) r.status = 'inactive';
    else if (p.percentage < classMedian - BEHIND_MARGIN) r.status = 'behind';
    else r.status = 'on_track';
    delete r._attemptedAny;
  });

  rows.sort((a, b) =>
    b.progress.percentage - a.progress.percentage ||
    (a.student.name || '').localeCompare(b.student.name || ''));

  // Chapters in playback order, with how many students are currently on each.
  const here = new Map();
  rows.forEach(r => {
    const id = r.progress.current?.lesson_id;
    if (id) here.set(id, (here.get(id) || 0) + 1);
  });
  const lessons = (progress.lessonsByCourse.get(courseId) || []).map((l, i) => ({
    lesson_id: l.id,
    title: l.title,
    index: i + 1,
    // Same unit-level counting as progress: a unit-less chapter is one unit.
    units_total: (progress.unitsByLesson.get(l.id) || []).length || 1,
    students_here: here.get(l.id) || 0,
  }));

  const countStatus = (status) => rows.filter(r => r.status === status).length;
  const summary = {
    students: rows.length,
    avg_progress: rows.length ? Math.round(mean(rows.map(r => r.progress.percentage))) : 0,
    completed: countStatus('completed'),
    not_started: countStatus('not_started'),
    active_7d: rows.filter(r => r.activity.days_inactive != null && r.activity.days_inactive < INACTIVE_DAYS).length,
    inactive: countStatus('inactive'),
    avg_quiz_score: roundOrNull(mean(rows.map(r => r.quizzes.avg_score).filter(v => v != null))),
  };

  return { course: publicCourse(course), lessons, summary, students: rows };
}

/**
 * GET /api/insights/courses/:courseId/students
 * Class roster: where every enrolled student is in the course (current
 * chapter + unit, unit-level %), plus XP, quiz / assignment results, recent
 * activity, subscription and a computed status. Admin: any course. Teacher:
 * only a course they own.
 */
router.get('/courses/:courseId/students', async (req, res) => {
  try {
    const { courseId } = req.params;
    if (!UUID_REGEX.test(courseId)) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('id, title, color, icon, teacher_id')
      .eq('id', courseId)
      .maybeSingle();
    if (courseError) throw courseError;
    if (!course) return res.status(404).json({ success: false, error: 'Course not found' });

    if (req.staffRole !== 'admin' && course.teacher_id !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'You can only view students in your own courses' });
    }

    const roster = await buildRoster(course, {
      includeTest: req.query.include_test === '1',
      excludeDeactivated: req.query.include_deactivated !== '1',
    });
    res.json({ success: true, data: roster });
  } catch (error) {
    console.error('Insights course roster error:', error);
    res.status(500).json({ success: false, error: 'Failed to load class roster: ' + error.message });
  }
});

/**
 * GET /api/insights/overview
 * Dashboard panel: where students are across every course the viewer can see
 * (admin: all courses, teacher: their own). Per course: students, average
 * progress, status counts and how many students sit on each chapter. Plus
 * daily active students (30 UTC days) and this week's top learners by XP.
 */
router.get('/overview', async (req, res) => {
  try {
    const courses = await fetchAllRows(() => {
      let q = supabase
        .from('courses')
        .select('id, title, color, icon, teacher_id')
        .eq('is_test', false) // test classes stay off the dashboard
        .order('id', { ascending: true });
      if (req.staffRole !== 'admin') q = q.eq('teacher_id', req.user.userId);
      return q;
    });

    // A handful of rosters at a time — each one is ~a dozen queries.
    const rosters = [];
    for (let i = 0; i < courses.length; i += OVERVIEW_CONCURRENCY) {
      rosters.push(...await Promise.all(courses.slice(i, i + OVERVIEW_CONCURRENCY).map(buildRoster)));
    }

    const STATUSES = ['on_track', 'behind', 'inactive', 'not_started', 'completed'];
    const emptyCounts = () => Object.fromEntries(STATUSES.map(s => [s, 0]));
    const totals = { students: 0, enrollments: 0, avg_progress: 0, ...emptyCounts() };
    const studentMeta = new Map();
    const allPct = [];

    const courseRows = rosters
      .filter(r => r.students.length > 0)
      .map(r => {
        const statusCounts = emptyCounts();
        r.students.forEach(s => {
          statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
          totals[s.status] = (totals[s.status] || 0) + 1;
          allPct.push(s.progress.percentage);
          if (!studentMeta.has(s.student.id)) {
            studentMeta.set(s.student.id, { name: s.student.name, avatar_url: s.student.avatar_url, level: s.xp.level });
          }
        });
        return {
          course: r.course,
          students: r.summary.students,
          avg_progress: r.summary.avg_progress,
          status_counts: statusCounts,
          lessons: r.lessons.map(({ lesson_id, title, index, students_here }) => ({ lesson_id, title, index, students_here })),
          // Same rule as the roster's "Finished" bucket: nothing left to do.
          finished: r.students.filter(s => s.progress.current === null && s.progress.units_total > 0).length,
        };
      })
      .sort((a, b) => b.students - a.students || (a.course.title || '').localeCompare(b.course.title || ''));

    totals.enrollments = allPct.length;
    totals.students = studentMeta.size;
    totals.avg_progress = allPct.length ? Math.round(mean(allPct)) : 0;

    const studentIds = [...studentMeta.keys()];
    const now = Date.now();
    const since30 = dayKey(now - (OVERVIEW_DAYS - 1) * DAY_MS);
    const since7Iso = new Date(now - 7 * DAY_MS).toISOString();

    const [activityRows, xpRows] = await Promise.all([
      fetchAllIn(studentIds, chunk => supabase
        .from('activity_days')
        .select('student_id, day')
        .in('student_id', chunk)
        .gte('day', since30)
        .order('student_id', { ascending: true })
        .order('day', { ascending: true })),
      fetchAllIn(studentIds, chunk => supabase
        .from('xp_events')
        .select('id, student_id, amount')
        .in('student_id', chunk)
        .gte('created_at', since7Iso)
        .order('id', { ascending: true })),
    ]);

    const activeByDay = new Map();
    activityRows.forEach(r => {
      const day = String(r.day).slice(0, 10);
      if (!activeByDay.has(day)) activeByDay.set(day, new Set());
      activeByDay.get(day).add(r.student_id);
    });
    const daily_active = Array.from({ length: OVERVIEW_DAYS }, (_, i) => {
      const day = dayKey(now - (OVERVIEW_DAYS - 1 - i) * DAY_MS);
      return { day, students: activeByDay.get(day)?.size || 0 };
    });

    const xp7 = new Map();
    xpRows.forEach(e => xp7.set(e.student_id, (xp7.get(e.student_id) || 0) + (e.amount || 0)));
    const top_learners = [...xp7]
      .filter(([, xp]) => xp > 0)
      .sort((a, b) => b[1] - a[1] || (studentMeta.get(a[0])?.name || '').localeCompare(studentMeta.get(b[0])?.name || ''))
      .slice(0, TOP_LEARNERS)
      .map(([id, xp]) => ({ student_id: id, ...studentMeta.get(id), xp_7d: xp }));

    res.json({ success: true, data: { totals, courses: courseRows, daily_active, top_learners } });
  } catch (error) {
    console.error('Insights overview error:', error);
    res.status(500).json({ success: false, error: 'Failed to load student overview: ' + error.message });
  }
});

// ── Dashboard "Student performance" table ───────────────────────────────
// One row per (student, course) enrollment, built from the same class rosters
// as the overview (progress %, quiz average, last active, status). Rosters are
// the expensive part (~a dozen queries per course), so the assembled rows are
// cached for a minute per viewer + class filter and concurrent requests share
// one build. Search / filter / sort / paging then run in memory.
const TABLE_TTL_MS = 60 * 1000;
const TABLE_MAX_LIMIT = 100;
const TABLE_STATUSES = ['on_track', 'behind', 'inactive', 'not_started', 'completed'];
const tableCache = new Map();   // key -> { at, data, promise }

// Cached class rosters for the viewer (+ optional class filter) — the shared
// base of the student table and the learning overview. Concurrent callers wait
// on one build; a failed build is not cached.
async function loadRosters(req, courseFilter, fresh) {
  const key = `${req.staffRole}:${req.user.userId}:${courseFilter || 'all'}`;
  const hit = tableCache.get(key);
  if (hit && !fresh) {
    if (hit.promise) return hit.promise;
    if (Date.now() - hit.at < TABLE_TTL_MS) return hit.data;
  }

  const promise = (async () => {
    const courses = await fetchAllRows(() => {
      let q = supabase
        .from('courses')
        .select('id, title, color, icon, teacher_id')
        .eq('is_test', false) // test classes stay off the dashboard
        .order('id', { ascending: true });
      if (req.staffRole !== 'admin') q = q.eq('teacher_id', req.user.userId);
      if (courseFilter) q = q.eq('id', courseFilter);
      return q;
    });

    const rosters = [];
    for (let i = 0; i < courses.length; i += OVERVIEW_CONCURRENCY) {
      rosters.push(...await Promise.all(courses.slice(i, i + OVERVIEW_CONCURRENCY).map(buildRoster)));
    }
    return { rosters, rows: rosterRows(rosters) };
  })();

  tableCache.set(key, { at: Date.now(), data: null, promise });
  try {
    const data = await promise;
    tableCache.set(key, { at: Date.now(), data, promise: null });
    return data;
  } catch (err) {
    tableCache.delete(key);
    throw err;
  }
}

// One flat row per (student, class) for the dashboard table.
function rosterRows(rosters) {
  const rows = [];
  rosters.forEach(r => r.students.forEach(st => rows.push({
    student_id: st.student.id,
    name: st.student.name || '',
    email: st.student.email,
    phone: st.student.phone,
    avatar_url: st.student.avatar_url,
    is_active: st.student.is_active,
    registered_at: st.student.created_at || null,
    course_id: r.course.id,
    course_title: r.course.title || '',
    progress: st.progress.percentage,
    // Where the student is now: the first chapter they haven't finished. null
    // title + finished=true once nothing is left; null + false if the class has no lessons.
    current_lesson_index: st.progress.current?.lesson_index ?? null,
    current_lesson_title: st.progress.current?.lesson_title ?? null,
    finished: st.progress.current === null && st.progress.units_total > 0,
    avg_quiz: st.quizzes.avg_score,
    quizzes_attempted: st.quizzes.attempted,
    quizzes_total: st.quizzes.total,
    assignments_total: st.assignments.total,
    assignments_missing: st.assignments.missing,
    assignments_avg: st.assignments.avg_pct,
    last_active: st.activity.last_active,
    days_inactive: st.activity.days_inactive,
    status: st.status,
  })));
  return rows;
}

// Live-class time per student per class, merged into every table row. Cached
// for a minute like the rosters; a failure leaves the live columns empty
// instead of breaking the whole table.
const liveTableCache = new Map();
async function loadLiveByStudentCourse(req, courseFilter, fresh) {
  const key = `${req.staffRole}:${req.user.userId}:${courseFilter || 'all'}`;
  const hit = liveTableCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < TABLE_TTL_MS) return hit.data;
  const report = buildLiveReport(await loadLiveReportInput(req));
  const map = new Map();
  report.students.forEach(s => Object.entries(s.by_course).forEach(([courseId, v]) => map.set(`${s.student_id}|${courseId}`, v)));
  liveTableCache.set(key, { at: Date.now(), data: map });
  return map;
}

const loadTableRows = async (req, courseFilter, fresh) => {
  const [{ rows }, live] = await Promise.all([
    loadRosters(req, courseFilter, fresh),
    loadLiveByStudentCourse(req, courseFilter, fresh).catch((e) => { console.warn('live table data failed:', e.message); return new Map(); }),
  ]);
  // Which students a message can reach on Telegram (linked, reminders on, bot not blocked).
  let telegramIds = new Set();
  try {
    const ids = [...new Set(rows.map(r => r.student_id))];
    const reachable = [];
    for (let i = 0; i < ids.length; i += 150) reachable.push(...await tg.reachableStudents(ids.slice(i, i + 150)));
    telegramIds = new Set(reachable.map(x => x.user_id));
  } catch (e) { console.warn('telegram flags failed:', e.message); }

  // New objects, so the cached roster rows are never mutated.
  return rows.map(r => {
    const v = live.get(`${r.student_id}|${r.course_id}`);
    return {
      ...r,
      has_telegram: telegramIds.has(r.student_id),
      live_minutes: v ? v.minutes : null,
      live_attended: v ? v.attended : null,
      live_eligible: v ? v.eligible : null,
      live_last: v ? v.last_attended : null,
      live_held_minutes: v ? v.held_minutes : null,
      live_missed_run: v ? v.missed_in_a_row : null,
      live_last_session: v ? v.last_session_at : null,
    };
  });
};

// Filter + sort the cached rows according to the query string.
function queryTable(rows, query) {
  const q = String(query.q || '').trim().toLowerCase();
  const status = TABLE_STATUSES.includes(query.status) ? query.status : null;
  let out = rows;
  if (status) out = out.filter(r => r.status === status);
  // ?live=never: students who attended none of the live classes they could have joined;
  // ?live=joined: students who attended at least one.
  if (query.live === 'never') out = out.filter(r => r.live_eligible > 0 && r.live_attended === 0);
  if (query.live === 'joined') out = out.filter(r => r.live_attended > 0);
  // Last-active date range (UTC days, inclusive). Students who were never
  // active have no date, so any date range leaves them out.
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  const from = ymd.test(query.active_from || '') ? query.active_from : null;
  const to = ymd.test(query.active_to || '') ? query.active_to : null;
  if (from || to) {
    out = out.filter(r => {
      if (!r.last_active) return false;
      const day = String(r.last_active).slice(0, 10);
      return (!from || day >= from) && (!to || day <= to);
    });
  }
  if (q) {
    out = out.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (r.email || '').toLowerCase().includes(q) ||
      (r.phone || '').toLowerCase().includes(q));
  }

  const sorts = {
    name: (a, b) => a.name.localeCompare(b.name),
    course: (a, b) => a.course_title.localeCompare(b.course_title),
    progress: (a, b) => a.progress - b.progress,
    avg_quiz: (a, b) => (a.avg_quiz ?? -1) - (b.avg_quiz ?? -1),
    quizzes: (a, b) => a.quizzes_attempted - b.quizzes_attempted,
    // Smaller days_inactive = more recent; never active sorts as oldest.
    last_active: (a, b) => (b.days_inactive ?? Infinity) - (a.days_inactive ?? Infinity),
    status: (a, b) => TABLE_STATUSES.indexOf(a.status) - TABLE_STATUSES.indexOf(b.status),
    live_time: (a, b) => (a.live_minutes ?? -1) - (b.live_minutes ?? -1),
    live_classes: (a, b) => (a.live_attended ?? -1) - (b.live_attended ?? -1) || (a.live_minutes ?? -1) - (b.live_minutes ?? -1),
    registered: (a, b) => String(a.registered_at || '').localeCompare(String(b.registered_at || '')),
  };
  const key = sorts[query.sort] ? query.sort : 'progress';
  const dir = query.dir === 'asc' || (!query.dir && key === 'name') ? 1 : -1;
  return [...out].sort((a, b) => dir * sorts[key](a, b) || a.name.localeCompare(b.name));
}

const courseFilterOf = (req) => {
  const c = typeof req.query.course_id === 'string' ? req.query.course_id : '';
  return UUID_REGEX.test(c) ? c : null;
};

/**
 * GET /api/insights/students-table
 *   ?course_id=<uuid>  one class (teachers: only their own; anything else is empty)
 *   &status=on_track|behind|inactive|not_started|completed
 *   &q=<text>          name / email / phone contains
 *   &active_from=YYYY-MM-DD&active_to=YYYY-MM-DD  last active within (UTC days)
 *   &sort=name|course|progress|avg_quiz|quizzes|last_active|status  &dir=asc|desc
 *   &page=1&limit=10 (max 100)   &fresh=1 skips the 1-minute cache
 * -> { rows, pagination, status_counts, generated_at }
 */
router.get('/students-table', async (req, res) => {
  try {
    const all = await loadTableRows(req, courseFilterOf(req), req.query.fresh === '1');

    // Counts per status for the chosen class + search (before the status filter).
    const { status: _ignored, ...noStatus } = req.query;
    const base = queryTable(all, noStatus);
    const status_counts = Object.fromEntries(TABLE_STATUSES.map(s => [s, 0]));
    base.forEach(r => { status_counts[r.status] += 1; });
    const never_joined_live = queryTable(all, { ...noStatus, live: '' }).filter(r => r.live_eligible > 0 && r.live_attended === 0).length;

    const filtered = queryTable(all, req.query);
    const limit = Math.min(TABLE_MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(totalPages, Math.max(1, parseInt(req.query.page, 10) || 1));
    const rows = filtered.slice((page - 1) * limit, page * limit)
      .map(({ phone, ...r }) => r);   // phone is only used for search / export

    res.json({
      success: true,
      data: {
        rows,
        pagination: { page, limit, total, total_pages: totalPages },
        status_counts,
        never_joined_live,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Insights students-table error:', error);
    res.status(500).json({ success: false, error: 'Failed to load student table: ' + error.message });
  }
});

/**
 * GET /api/insights/students-table/export
 *   ?format=xlsx|csv|pdf  (default xlsx)
 *   ?course_id=<uuid>     one class; omit for ALL classes
 *   + the same search / status / active_from / active_to filters as the table
 *   &include_contacts=1   adds email + phone (left out otherwise)
 * One class -> a single sheet/file. All classes -> "All classes" first, then
 * one sheet per class (Excel), one CSV per class zipped (CSV), or one section
 * per class (PDF). Every matching row, no paging.
 */
router.get('/students-table/export', async (req, res) => {
  try {
    const format = ['xlsx', 'csv', 'pdf'].includes(req.query.format) ? req.query.format : 'xlsx';
    const courseFilter = courseFilterOf(req);
    const all = await loadTableRows(req, courseFilter, req.query.fresh === '1');

    const filteredAll = queryTable(all, req.query);
    let groups;
    if (courseFilter) {
      groups = [{ title: all[0]?.course_title || 'Class', rows: filteredAll }];
    } else {
      const byCourse = new Map();
      all.forEach(r => { if (!byCourse.has(r.course_id)) byCourse.set(r.course_id, r.course_title || 'Class'); });
      const perClass = [...byCourse]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, title]) => ({ title, rows: filteredAll.filter(r => r.course_id === id) }));
      groups = [{ title: 'All classes', rows: filteredAll }, ...perClass];
    }

    const includeContacts = req.query.include_contacts === '1';
    const description = [
      courseFilter ? `Class: ${groups[0].title}` : 'All classes',
      TABLE_STATUSES.includes(req.query.status) ? `Status: ${req.query.status.replace('_', ' ')}` : null,
      req.query.q ? `Search: "${String(req.query.q).slice(0, 60)}"` : null,
      (req.query.active_from || req.query.active_to) ? `Last active ${req.query.active_from || '…'} to ${req.query.active_to || '…'}` : null,
    ].filter(Boolean).join(' · ');
    const today = new Date().toISOString().slice(0, 10);
    const scopeName = courseFilter ? safeName(groups[0].title, 'class').replace(/\s/g, '-') : 'all-classes';
    const base = `romduol-students_${scopeName}_${today}`;
    // Quote + RFC 5987 so Khmer class names survive in the header.
    const disposition = (ext) => `attachment; filename="romduol-students_${today}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`;

    if (format === 'csv') {
      if (groups.length === 1) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', disposition('csv'));
        return res.send(buildCsv(groups[0].rows, { includeContacts }));
      }
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', disposition('zip'));
      return res.send(await buildCsvZip(groups, { includeContacts }));
    }
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', disposition('pdf'));
      return res.send(await buildPdf(groups, { description, includeContacts }));
    }

    const wb = await buildStudentTableWorkbook(groups, { includeContacts, description });
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', disposition('xlsx'));
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('Insights students-table export error:', error);
    res.status(500).json({ success: false, error: 'Failed to export student table: ' + error.message });
  }
});

// ── Learning overview: classes, lesson locations, live-class attendance ──
const ATTENDANCE_SESSIONS = 8;     // most recent held live classes per class
const MISSED_LIST = 8;
const LOW_ATTENDANCE_PCT = 70;
const INACTIVE_SHARE_FLAG = 0.4;   // this share of a class inactive -> "needs attention"

// Quartile by linear interpolation on a sorted array.
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Score spread for a list of 0-100 scores: ten 10-point buckets (the last one
 * includes 100) and box-plot numbers — whiskers reach the most extreme score
 * within 1.5 x IQR of the box, anything beyond is an outlier.
 */
function scoreSpread(people) {
  // people: [{ id, name, score }] — the names let the box plot label its outliers.
  const scored = people.filter(p => p.score != null).sort((a, b) => a.score - b.score);
  const sorted = scored.map(p => p.score);
  const buckets = Array(10).fill(0);
  sorted.forEach(v => { buckets[Math.min(9, Math.max(0, Math.floor(v / 10)))] += 1; });
  if (!sorted.length) return { n: 0, buckets, box: null };
  const q1 = quantile(sorted, 0.25);
  const med = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  const fence = 1.5 * (q3 - q1);
  const inside = sorted.filter(v => v >= q1 - fence && v <= q3 + fence);
  return {
    n: sorted.length,
    buckets,
    box: {
      min: inside[0],
      q1: Math.round(q1 * 10) / 10,
      median: Math.round(med * 10) / 10,
      q3: Math.round(q3 * 10) / 10,
      max: inside[inside.length - 1],
      // Students far from the rest, lowest first, with who they are.
      outliers: scored
        .filter(p => p.score < q1 - fence || p.score > q3 + fence)
        .map(p => ({ student_id: p.id, name: p.name || null, score: p.score })),
    },
  };
}

const pct = (num, den) => (den ? Math.round((num / den) * 100) : null);
const ymdOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Rows the live-class report is built from, for the classes this caller may see. */
async function loadLiveReportInput(req) {
  const courseFilter = courseFilterOf(req);
  const courses = await fetchAllRows(() => {
    let q = supabase.from('courses').select('id, title, category').eq('is_test', false).order('id', { ascending: true });
    if (req.staffRole !== 'admin') q = q.eq('teacher_id', req.user.userId);
    if (courseFilter) q = q.eq('id', courseFilter);
    return q;
  });
  const courseIds = courses.map(c => c.id);
  if (!courseIds.length) return { courses, enrollments: [], students: [], classes: [], participants: [], schedules: [] };

  const [enrollments, classes, schedules] = await Promise.all([
    fetchAllIn(courseIds, chunk => supabase.from('course_enrollments')
      .select('id, course_id, student_id, enrolled_at').in('course_id', chunk).order('id', { ascending: true })),
    fetchAllIn(courseIds, chunk => supabase.from('live_classes')
      .select('id, course_id, status, started_at, ended_at').in('course_id', chunk).order('id', { ascending: true })),
    fetchAllIn(courseIds, chunk => supabase.from('class_schedules')
      .select('id, course_id, days_of_week, start_time, end_time').eq('is_active', true).in('course_id', chunk).order('id', { ascending: true })),
  ]);
  const [students, participants] = await Promise.all([
    // Active, real students only — test / team accounts stay out of the numbers.
    fetchAllIn(enrollments.map(e => e.student_id), chunk => supabase.from('users')
      .select('id, name, avatar_url').in('id', chunk).eq('role', 'student').eq('is_active', true).eq('is_test', false)
      .order('id', { ascending: true })),
    fetchAllIn(classes.filter(c => c.started_at).map(c => c.id), chunk => supabase.from('live_class_participants')
      .select('id, live_class_id, user_id, joined_at, left_at').eq('role', 'student').in('live_class_id', chunk)
      .order('id', { ascending: true })),
  ]);
  return { courses, enrollments, students, classes, participants, schedules };
}

/**
 * GET /api/insights/live-report?course_id=
 * The dashboard's Live classes report: live hours against the goal, how many
 * students are reached, and time spent in live classes per student.
 */
router.get('/live-report', async (req, res) => {
  try {
    const report = buildLiveReport(await loadLiveReportInput(req));
    res.json({ success: true, data: report });
  } catch (error) {
    console.error('Insights live report error:', error);
    res.status(500).json({ success: false, error: 'Failed to load the live class report: ' + error.message });
  }
});

// Nudging the same group twice in a row is noise: one reminder per caller and
// scope every few hours.
const REMIND_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const lastRemind = new Map();

const NUDGE = {
  en: { title: 'Join our live class 🎥', body: 'Live classes help you learn faster and you can ask your teacher questions. Join the next one — we would love to see you there!' },
  km: { title: 'ចូលរួមថ្នាក់រៀនផ្ទាល់ 🎥', body: 'ថ្នាក់រៀនផ្ទាល់ជួយឱ្យអ្នករៀនបានលឿន ហើយអាចសួរលោកគ្រូអ្នកគ្រូបាន។ សូមចូលរួមថ្នាក់បន្ទាប់!' },
};

/**
 * POST /api/insights/live-report/remind   body: { course_id? }
 * Push a friendly nudge to every student who never attended a live class
 * they could have joined.
 */
router.post('/live-report/remind', async (req, res) => {
  try {
    const scope = `${req.user.userId}:${courseFilterOf(req) || 'all'}`;
    const last = lastRemind.get(scope);
    if (last && Date.now() - last < REMIND_COOLDOWN_MS) {
      const wait = Math.ceil((REMIND_COOLDOWN_MS - (Date.now() - last)) / 60000);
      return res.status(429).json({ success: false, error: `You already sent this reminder recently. Try again in ${wait} minutes.`, retry_after_minutes: wait });
    }

    const report = buildLiveReport(await loadLiveReportInput(req));
    const targets = report.students.filter(s => s.classes_eligible > 0 && s.classes_attended === 0).map(s => s.student_id);
    if (!targets.length) return res.json({ success: true, data: { sent: 0, pending: 0 } });

    const prefs = await userPrefs(targets);
    const rows = targets
      .filter(id => prefs.get(id)?.isActive)
      .map(id => ({
        user_id: id,
        type: 'live_class_nudge',
        title: NUDGE[prefs.get(id).language].title,
        body: NUDGE[prefs.get(id).language].body,
        data: { course_id: courseFilterOf(req) },
        kind: 'class',
      }));
    const sent = await createNotifications(rows);
    lastRemind.set(scope, Date.now());
    res.json({ success: true, data: { sent, pending: targets.length } });
  } catch (error) {
    console.error('Insights live report remind error:', error);
    res.status(500).json({ success: false, error: 'Failed to send the reminder: ' + error.message });
  }
});

/**
 * GET /api/insights/learning-overview   (&course_id=<uuid>, &fresh=1)
 * Everything the dashboard needs to answer "how are my classes doing":
 *   totals            — classes, students, avg progress, active 7d, avg quiz, attendance %
 *   classes[]         — per class: students, lessons, next live class, avg progress,
 *                       attendance %, avg quiz, inactive, status counts, a flag, and
 *                       the lesson distribution (students currently on each lesson)
 *   attendance        — per class series for the last 8 held live classes
 *   missed            — students who missed the latest live class(es), most in a row first
 * A student counts for a live class only if enrolled before it started and
 * still active. Teachers only get their own classes. Built on the same cached
 * class rosters as the student table.
 */
router.get('/learning-overview', async (req, res) => {
  try {
    const { rosters } = await loadRosters(req, courseFilterOf(req), req.query.fresh === '1');
    const courseIds = rosters.map(r => r.course.id);
    const nowMs = Date.now();

    const liveClasses = courseIds.length
      ? await fetchAllIn(courseIds, chunk => supabase
        .from('live_classes')
        .select('id, course_id, title, status, scheduled_at, started_at')
        .in('course_id', chunk)
        .order('id', { ascending: true }))
      : [];

    // Held = it actually started. Time of a session = when it started.
    const heldByCourse = new Map();
    const nextByCourse = new Map();
    liveClasses.forEach(c => {
      const startedMs = toMs(c.started_at);
      if (startedMs != null) {
        if (!heldByCourse.has(c.course_id)) heldByCourse.set(c.course_id, []);
        heldByCourse.get(c.course_id).push({ ...c, timeMs: startedMs });
      } else if (c.status === 'scheduled') {
        const when = toMs(c.scheduled_at);
        if (when != null && when >= nowMs && when < (nextByCourse.get(c.course_id) ?? Infinity)) nextByCourse.set(c.course_id, when);
      }
    });
    heldByCourse.forEach((list, courseId) => {
      list.sort((a, b) => a.timeMs - b.timeMs);
      heldByCourse.set(courseId, list.slice(-ATTENDANCE_SESSIONS));
    });

    const heldIds = [...heldByCourse.values()].flat().map(c => c.id);
    const participantRows = heldIds.length
      ? await fetchAllIn(heldIds, chunk => supabase
        .from('live_class_participants')
        .select('id, live_class_id, user_id')
        .eq('role', 'student')
        .in('live_class_id', chunk)
        .order('id', { ascending: true }))
      : [];
    const joinedBy = new Map();   // live_class_id -> Set(user_id)
    participantRows.forEach(r => {
      if (!joinedBy.has(r.live_class_id)) joinedBy.set(r.live_class_id, new Set());
      joinedBy.get(r.live_class_id).add(r.user_id);
    });

    let allAttended = 0;
    let allEligible = 0;
    const missed = [];
    const attendance = [];

    const classes = rosters.map(r => {
      const sessions = heldByCourse.get(r.course.id) || [];
      const students = r.students.filter(s => s.student.is_active);
      const eligibleFor = (session) => students.filter(s => {
        const enrolled = toMs(s.enrolled_at);
        return enrolled == null || enrolled <= session.timeMs;
      });

      let attended = 0;
      let eligibleTotal = 0;
      const series = sessions.map(session => {
        const eligible = eligibleFor(session);
        const joined = joinedBy.get(session.id) || new Set();
        const got = eligible.filter(s => joined.has(s.student.id)).length;
        attended += got;
        eligibleTotal += eligible.length;
        return {
          live_class_id: session.id,
          title: session.title,
          date: ymdOf(session.timeMs),
          eligible: eligible.length,
          attended: got,
          rate: pct(got, eligible.length),
        };
      });
      allAttended += attended;
      allEligible += eligibleTotal;
      attendance.push({ course: publicCourse(r.course), sessions: series });

      // Misses in a row, counting back from the latest session the student was
      // eligible for (sessions from before they enrolled are skipped).
      students.forEach(s => {
        const enrolled = toMs(s.enrolled_at);
        let inARow = 0;
        for (let i = sessions.length - 1; i >= 0; i--) {
          if (enrolled != null && enrolled > sessions[i].timeMs) continue;
          if (joinedBy.get(sessions[i].id)?.has(s.student.id)) break;
          inARow += 1;
        }
        if (inARow === 0) return;
        let lastJoinedMs = null;
        for (let i = sessions.length - 1; i >= 0; i--) {
          if (joinedBy.get(sessions[i].id)?.has(s.student.id)) { lastJoinedMs = sessions[i].timeMs; break; }
        }
        missed.push({
          student_id: s.student.id,
          name: s.student.name,
          avatar_url: s.student.avatar_url,
          course_id: r.course.id,
          course_title: r.course.title,
          missed_in_a_row: inARow,
          last_joined: lastJoinedMs == null ? null : ymdOf(lastJoinedMs),
        });
      });

      const inactiveShare = r.summary.students ? r.summary.inactive / r.summary.students : 0;
      const attendanceRate = pct(attended, eligibleTotal);
      const flag = attendanceRate != null && attendanceRate < LOW_ATTENDANCE_PCT
        ? { key: 'low_attendance', label: 'Low attendance' }
        : inactiveShare >= INACTIVE_SHARE_FLAG
          ? { key: 'needs_attention', label: 'Needs attention' }
          : { key: 'on_track', label: 'On track' };

      const counts = Object.fromEntries(TABLE_STATUSES.map(st => [st, 0]));
      r.students.forEach(s => { counts[s.status] += 1; });
      const nextMs = nextByCourse.get(r.course.id);

      return {
        course: publicCourse(r.course),
        students: r.summary.students,
        lessons: r.lessons.length,
        next_live_at: nextMs ? new Date(nextMs).toISOString() : null,
        avg_progress: r.summary.avg_progress,
        attendance_rate: attendanceRate,
        live_classes_held: sessions.length,
        avg_quiz: r.summary.avg_quiz_score,
        inactive: r.summary.inactive,
        status_counts: counts,
        flag,
        finished: r.students.filter(s => s.progress.current === null && s.progress.units_total > 0).length,
        // Students who haven't started would all pile onto chapter 1, so they're
        // counted separately and the per-lesson counts only cover those under way.
        not_started: counts.not_started,
        lesson_distribution: r.lessons.map(({ lesson_id, title, index }) => ({
          lesson_id,
          title,
          index,
          students_here: r.students.filter(s => s.status !== 'not_started' && s.progress.current?.lesson_id === lesson_id).length,
        })),
        scores: scoreSpread(r.students.map(s => ({ id: s.student.id, name: s.student.name, score: s.quizzes.avg_score }))),
      };
    }).sort((a, b) => b.students - a.students || (a.course.title || '').localeCompare(b.course.title || ''));

    missed.sort((a, b) => b.missed_in_a_row - a.missed_in_a_row || (a.name || '').localeCompare(b.name || ''));

    const rows = rosters.flatMap(r => r.students);
    const unique = new Map();
    rows.forEach(s => { if (!unique.has(s.student.id)) unique.set(s.student.id, s); });
    const quizScores = rows.map(s => s.quizzes.avg_score).filter(v => v != null);
    const totals = {
      classes: rosters.length,
      classes_with_students: rosters.filter(r => r.students.length > 0).length,
      enrolments: rows.length,
      students: unique.size,
      avg_progress: rows.length ? Math.round(mean(rows.map(s => s.progress.percentage))) : 0,
      active_7d: [...unique.values()].filter(s => s.activity.days_inactive != null && s.activity.days_inactive < INACTIVE_DAYS).length,
      avg_quiz: quizScores.length ? Math.round(mean(quizScores)) : null,
      attendance_rate: pct(allAttended, allEligible),
    };

    res.json({
      success: true,
      data: {
        totals,
        classes,
        scores_all: scoreSpread(rosters.flatMap(r => r.students.map(s => ({ id: s.student.id, name: s.student.name, score: s.quizzes.avg_score })))),
        attendance,
        missed: { total: missed.length, students: missed.slice(0, MISSED_LIST) },
        generated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Insights learning-overview error:', error);
    res.status(500).json({ success: false, error: 'Failed to load learning overview: ' + error.message });
  }
});

/**
 * GET /api/insights/students/:studentId
 * One student's full profile: level / XP / rank, streaks, per-course progress
 * (with the chapter path), study calendar, XP history, quiz + assignment
 * history, live classes, daily challenges and achievements.
 * Admin: any student, every enrolled course. Teacher: only a student enrolled
 * in one of their courses, and every course-scoped section is limited to
 * those courses.
 */
router.get('/students/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!UUID_REGEX.test(studentId)) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    const { data: student, error: studentError } = await supabase
      .from('users')
      .select('id, name, email, phone, avatar_url, bio, is_active, created_at, xp')
      .eq('id', studentId)
      .eq('role', 'student')
      .maybeSingle();
    if (studentError) throw studentError;
    if (!student) return res.status(404).json({ success: false, error: 'Student not found' });

    const isAdminViewer = req.staffRole === 'admin';
    const enrollments = await fetchAllRows(() => supabase
      .from('course_enrollments')
      .select('id, course_id, enrolled_at')
      .eq('student_id', studentId)
      .order('id', { ascending: true }));
    const enrolledAt = earliestEnrollment(enrollments, 'course_id');

    // The courses this viewer may see: every enrolled course for an admin; for
    // a teacher, only the enrolled courses they own (none -> no access).
    const courses = await fetchAllIn([...enrolledAt.keys()], chunk => {
      let q = supabase
        .from('courses')
        .select('id, title, color, icon')
        .in('id', chunk)
        .order('id', { ascending: true });
      if (!isAdminViewer) q = q.eq('teacher_id', req.user.userId);
      return q;
    });
    if (!isAdminViewer && courses.length === 0) {
      return res.status(403).json({ success: false, error: 'You can only view students enrolled in your classes' });
    }
    const courseIds = courses.map(c => c.id);
    const courseById = new Map(courses.map(c => [c.id, c]));

    const now = Date.now();
    const todayMs = toMs(dayKey(now));   // 00:00 UTC today
    const since7 = dayKey(now - 6 * DAY_MS);

    const [
      progress,
      rankRows,
      streak,
      quizzes,
      quizSubs,
      assignments,
      assignmentSubs,
      xpEvents,
      activityRows,
      studyRows,
      liveClasses,
      liveRows,
      challengeRows,
      { data: challengeStreak, error: challengeStreakError },
      subscriptionRows,
      { data: badges, error: badgesError },
      { data: earned, error: earnedError },
    ] = await Promise.all([
      courseProgress({ courseIds, studentIds: [studentId] }),
      fetchAllRows(() => supabase
        .from('users')
        .select('id, name, xp')
        .eq('role', 'student')
        .order('id', { ascending: true })),
      getStreakSummary(studentId),
      fetchAllIn(courseIds, chunk => supabase
        .from('quizzes')
        .select('id, title, course_id, status')
        .in('course_id', chunk)
        .order('id', { ascending: true })),
      fetchAllRows(() => supabase
        .from('quiz_submissions')
        .select('id, quiz_id, score, passed, submitted_at')
        .eq('student_id', studentId)
        .order('id', { ascending: true })),
      fetchAllIn(courseIds, chunk => supabase
        .from('assignments')
        .select('id, title, course_id, type, points, due_date, status, created_at')
        .in('course_id', chunk)
        .order('id', { ascending: true })),
      fetchAllRows(() => supabase
        .from('assignment_submissions')
        .select('id, assignment_id, grade, score, submitted_at')
        .eq('student_id', studentId)
        .order('id', { ascending: true })),
      fetchAllRows(() => supabase
        .from('xp_events')
        .select('id, amount, reason, course_id, created_at')
        .eq('student_id', studentId)
        .order('id', { ascending: true })),
      fetchAllRows(() => supabase
        .from('activity_days')
        .select('day')
        .eq('student_id', studentId)
        .order('day', { ascending: true })),
      fetchAllRows(() => supabase
        .from('study_minutes')
        .select('day, minutes')
        .eq('student_id', studentId)
        .order('day', { ascending: true })),
      fetchAllIn(courseIds, chunk => supabase
        .from('live_classes')
        .select('id, title, course_id')
        .in('course_id', chunk)
        .order('id', { ascending: true })),
      fetchAllRows(() => supabase
        .from('live_class_participants')
        .select('id, live_class_id, joined_at, left_at')
        .eq('user_id', studentId)
        .order('id', { ascending: true })),
      fetchAllRows(() => supabase
        .from('daily_challenges')
        .select('id, status, best_score')
        .eq('student_id', studentId)
        .order('id', { ascending: true })),
      supabase
        .from('daily_challenge_streaks')
        .select('current_streak, longest_streak, last_completed_date')
        .eq('student_id', studentId)
        .maybeSingle(),
      fetchAllIn(courseIds, chunk => supabase
        .from('student_course_subscriptions')
        .select('course_id, expiry_date')
        .eq('student_id', studentId)
        .in('course_id', chunk)
        .order('course_id', { ascending: true })),
      supabase.from('badges').select('code, label, description'),
      supabase.from('achievements').select('badge_code, earned_at').eq('student_id', studentId),
    ]);
    if (challengeStreakError) throw challengeStreakError;
    if (badgesError) throw badgesError;
    if (earnedError) throw earnedError;

    // ── Rank (all-time, among students: xp desc, name asc) ────────────────
    rankRows.sort((a, b) =>
      (b.xp || 0) - (a.xp || 0) ||
      (a.name || '').localeCompare(b.name || '') ||
      String(a.id).localeCompare(String(b.id)));
    const rankIdx = rankRows.findIndex(u => u.id === studentId);
    const xpTotal = student.xp || 0;

    // ── Course-scoped data (visible courses only) ─────────────────────────
    const quizById = new Map(quizzes.map(q => [q.id, q]));
    const myQuizSubs = quizSubs.filter(s => quizById.has(s.quiz_id));
    const assignmentById = new Map(assignments.map(a => [a.id, a]));
    const subByAssignment = latestByAssignment(assignmentSubs.filter(s => assignmentById.has(s.assignment_id)));
    const published = assignments.filter(a => a.status === 'published');
    const publishedQuizIds = new Set(quizzes.filter(q => q.status === 'published').map(q => q.id));
    const expiryByCourse = new Map(subscriptionRows.map(s => [s.course_id, s.expiry_date]));

    const courseXp = new Map();
    xpEvents.forEach(e => {
      if (e.course_id) courseXp.set(e.course_id, (courseXp.get(e.course_id) || 0) + (e.amount || 0));
    });

    const courseRows = courseIds.map(id => {
      const p = progress.get(studentId, id);
      const courseQuizIds = new Set([...publishedQuizIds].filter(qid => quizById.get(qid).course_id === id));
      const { avg_pct, ...assignmentCounts } = assignmentStats(
        published.filter(a => a.course_id === id), subByAssignment, now);
      const expiry = expiryByCourse.get(id) || null;
      return {
        course: publicCourse(courseById.get(id)),
        enrolled_at: toIso(enrolledAt.get(id)),
        progress: p,
        xp: courseXp.get(id) || 0,
        quizzes: quizStats(courseQuizIds, myQuizSubs),
        assignments: assignmentCounts,
        subscription: { is_active: isSubscriptionActive(expiry), expiry_date: expiry },
      };
    });
    // Most recent progress (or, failing that, enrollment) first.
    const recency = (c) => toMs(c.progress.last_progress_at) ?? toMs(c.enrolled_at) ?? 0;
    courseRows.sort((a, b) => recency(b) - recency(a));

    // ── Study calendar: 84 UTC days ending today, oldest first ───────────
    const activeDays = new Set(activityRows.map(r => String(r.day).slice(0, 10)));
    const minutesByDay = new Map();
    studyRows.forEach(r => {
      const day = String(r.day).slice(0, 10);
      minutesByDay.set(day, (minutesByDay.get(day) || 0) + (r.minutes || 0));
    });
    const activityCalendar = Array.from({ length: CALENDAR_DAYS }, (_, i) => {
      const day = dayKey(todayMs - (CALENDAR_DAYS - 1 - i) * DAY_MS);
      return { day, minutes: minutesByDay.get(day) || 0, active: activeDays.has(day) };
    });

    // ── XP history ───────────────────────────────────────────────────────
    const thisMonday = todayMs - ((new Date(todayMs).getUTCDay() + 6) % 7) * DAY_MS;
    const firstMonday = thisMonday - (XP_WEEKS - 1) * 7 * DAY_MS;
    const weekly = new Array(XP_WEEKS).fill(0);
    const byReason = new Map();
    xpEvents.forEach(e => {
      const r = byReason.get(e.reason) || { reason: e.reason, xp: 0, count: 0 };
      r.xp += e.amount || 0;
      r.count += 1;
      byReason.set(e.reason, r);

      const ms = toMs(e.created_at);
      if (ms == null || ms < firstMonday) return;
      const week = Math.floor((ms - firstMonday) / (7 * DAY_MS));
      if (week < XP_WEEKS) weekly[week] += e.amount || 0;
    });

    // Course titles for the XP feed. A teacher only gets titles of their own
    // courses; XP from anyone else's course shows without one.
    const titleById = new Map(courses.map(c => [c.id, c.title]));
    if (isAdminViewer) {
      const otherIds = [...courseXp.keys()].filter(id => !titleById.has(id));
      const others = await fetchAllIn(otherIds, chunk => supabase
        .from('courses')
        .select('id, title')
        .in('id', chunk)
        .order('id', { ascending: true }));
      others.forEach(c => titleById.set(c.id, c.title));
    }

    const newestFirst = (key) => (a, b) => (toMs(b[key]) ?? 0) - (toMs(a[key]) ?? 0);
    const recentXp = [...xpEvents].sort(newestFirst('created_at')).slice(0, RECENT_XP).map(e => ({
      amount: e.amount,
      reason: e.reason,
      course_title: (e.course_id && titleById.get(e.course_id)) || null,
      // Lets the UI say "Another class" (vs daily practice) when a teacher
      // can't see the title — no id or title of that course is exposed.
      has_course: !!e.course_id,
      created_at: toIso(e.created_at),
    }));

    // ── Quiz + assignment history ────────────────────────────────────────
    const quizHistory = [...myQuizSubs].sort(newestFirst('submitted_at')).slice(0, QUIZ_HISTORY).map(s => {
      const q = quizById.get(s.quiz_id);
      return {
        quiz_id: s.quiz_id,
        title: q.title,
        course_id: q.course_id,
        course_title: courseById.get(q.course_id)?.title || null,
        score: numOrNull(s.score),
        passed: !!s.passed,
        submitted_at: toIso(s.submitted_at),
      };
    });

    // Every published assignment, plus any assignment (e.g. since unpublished)
    // the student did submit.
    const historyAssignments = assignments.filter(a => a.status === 'published' || subByAssignment.has(a.id));
    const assignmentHistory = historyAssignments
      .map(a => {
        const s = subByAssignment.get(a.id) || null;
        const grade = numOrNull(s?.grade);
        const score = numOrNull(s?.score);
        let status;
        if (s) status = grade != null || score != null ? 'graded' : 'submitted';
        else status = a.due_date && toMs(a.due_date) < now ? 'missing' : 'pending';
        return {
          assignment_id: a.id,
          title: a.title,
          course_id: a.course_id,
          course_title: courseById.get(a.course_id)?.title || null,
          type: a.type || 'file',
          points: a.points ?? null,
          due_date: toIso(a.due_date),
          submitted_at: toIso(s?.submitted_at),
          grade,
          score,
          status,
          _sort: toMs(s?.submitted_at) ?? toMs(a.due_date) ?? toMs(a.created_at) ?? 0,
        };
      })
      .sort((a, b) => b._sort - a._sort)
      .slice(0, ASSIGNMENT_HISTORY)
      .map(({ _sort, ...a }) => a);

    // ── Live classes (visible courses): one entry per class, its sessions
    //    (reconnects / rejoins) merged ─────────────────────────────────────
    const liveById = new Map(liveClasses.map(c => [c.id, c]));
    const attendance = new Map();
    liveRows.forEach(r => {
      const cls = liveById.get(r.live_class_id);
      if (!cls) return;
      const joined = toMs(r.joined_at);
      const left = toMs(r.left_at);
      const a = attendance.get(cls.id) || { cls, joined: null, left: null, open: false, minutes: 0 };
      if (joined != null && (a.joined == null || joined < a.joined)) a.joined = joined;
      if (left == null) a.open = true;
      else if (a.left == null || left > a.left) a.left = left;
      if (joined != null && left != null && left > joined) a.minutes += (left - joined) / 60000;
      attendance.set(cls.id, a);
    });
    const liveRecent = [...attendance.values()]
      .sort((a, b) => (b.joined ?? 0) - (a.joined ?? 0))
      .slice(0, RECENT_LIVE_CLASSES)
      .map(a => ({
        live_class_id: a.cls.id,
        title: a.cls.title,
        course_title: courseById.get(a.cls.course_id)?.title || null,
        joined_at: a.joined == null ? null : new Date(a.joined).toISOString(),
        left_at: a.open || a.left == null ? null : new Date(a.left).toISOString(),
        minutes: Math.round(a.minutes),
      }));

    // ── Daily challenges ─────────────────────────────────────────────────
    // The stored current_streak only moves on a completion, so a streak whose
    // last day is before yesterday (UTC) has lapsed.
    const lastChallengeDay = challengeStreak?.last_completed_date
      ? String(challengeStreak.last_completed_date).slice(0, 10) : null;
    const challengeStreakAlive = !!lastChallengeDay && lastChallengeDay >= dayKey(todayMs - DAY_MS);
    const challengeScores = challengeRows.map(c => numOrNull(c.best_score)).filter(v => v != null);
    const dailyChallenges = {
      completed: challengeRows.filter(c => c.status === 'COMPLETED' || c.status === 'RETAKEN').length,
      attempted: challengeRows.filter(c => c.status && c.status !== 'NOT_STARTED').length,
      best_score: challengeScores.length ? Math.max(...challengeScores) : null,
      current_streak: challengeStreakAlive ? challengeStreak.current_streak || 0 : 0,
      longest_streak: challengeStreak?.longest_streak || 0,
    };

    // ── Achievements ─────────────────────────────────────────────────────
    const earnedAt = new Map((earned || []).map(r => [r.badge_code, r.earned_at]));
    const catalog = badges || [];
    const achievements = {
      earned: catalog
        .filter(b => earnedAt.has(b.code))
        .map(b => ({ code: b.code, label: b.label, description: b.description || null, earned_at: toIso(earnedAt.get(b.code)) }))
        .sort(newestFirst('earned_at')),
      locked: catalog
        .filter(b => !earnedAt.has(b.code))
        .map(b => ({ code: b.code, label: b.label, description: b.description || null })),
    };

    // ── Summary ──────────────────────────────────────────────────────────
    // Last active = the latest of: an active day, any XP earned, and in the
    // visible courses progress, a quiz or an assignment submission.
    let lastMs = null;
    const touch = (ts) => { const ms = toMs(ts); if (ms != null && (lastMs == null || ms > lastMs)) lastMs = ms; };
    activityRows.forEach(r => touch(r.day));
    xpEvents.forEach(e => touch(e.created_at));
    courseRows.forEach(c => touch(c.progress.last_progress_at));
    myQuizSubs.forEach(s => touch(s.submitted_at));
    subByAssignment.forEach(s => touch(s.submitted_at));

    const allQuizzes = quizStats(publishedQuizIds, myQuizSubs);
    const sum = (list, fn) => list.reduce((total, x) => total + fn(x), 0);
    const summary = {
      courses: courseRows.length,
      lessons_completed: sum(courseRows, c => c.progress.lessons_done),
      units_completed: sum(courseRows, c => c.progress.units_done),
      quizzes_attempted: allQuizzes.attempted,
      quizzes_passed: allQuizzes.passed,
      avg_quiz_score: allQuizzes.avg_score,
      assignments_submitted: sum(courseRows, c => c.assignments.submitted),
      assignments_missing: sum(courseRows, c => c.assignments.missing),
      live_classes_attended: attendance.size,
      study_minutes_total: sum(studyRows, r => r.minutes || 0),
      study_minutes_7d: sum(studyRows.filter(r => String(r.day).slice(0, 10) >= since7), r => r.minutes || 0),
      badges_earned: achievements.earned.length,
      last_active: lastMs == null ? null : new Date(lastMs).toISOString(),
      days_inactive: lastMs == null ? null : Math.max(0, Math.floor((now - lastMs) / DAY_MS)),
    };

    res.json({
      success: true,
      data: {
        student: {
          id: student.id,
          name: student.name,
          email: student.email || null,
          phone: student.phone || null,
          avatar_url: student.avatar_url || null,
          bio: student.bio || null,
          is_active: student.is_active !== false,
          created_at: toIso(student.created_at)
        },
        xp: {
          total: xpTotal,
          level: levelInfo(xpTotal),
          rank: rankIdx >= 0 ? rankIdx + 1 : null,
          total_students: rankRows.length
        },
        streak: { current: streak.current, week: streak.week },
        summary,
        courses: courseRows,
        activity_calendar: activityCalendar,
        xp_weekly: weekly.map((xp, i) => ({ week: dayKey(firstMonday + i * 7 * DAY_MS), xp })),
        xp_by_reason: [...byReason.values()].sort((a, b) => b.xp - a.xp || b.count - a.count),
        recent_xp: recentXp,
        quiz_history: quizHistory,
        assignment_history: assignmentHistory,
        live_classes: { attended: attendance.size, recent: liveRecent },
        daily_challenges: dailyChallenges,
        achievements
      }
    });
  } catch (error) {
    console.error('Insights student profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to load student profile: ' + error.message });
  }
});

// ── Messaging students ─────────────────────────────────────────────────────

const PP_OFFSET = '+07:00'; // Cambodia has no daylight saving
const ppDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh' }).format(d);

/** Course ids the viewer may message students in (admin: every non-test class). */
async function messageableCourseIds(req) {
  let q = supabase.from('courses').select('id, title, teacher_id').eq('is_test', false);
  if (req.staffRole !== 'admin') q = q.eq('teacher_id', req.user.userId);
  const { data } = await q;
  return data || [];
}

/**
 * GET /api/insights/live-missed-today
 * The latest live class held today (Cambodia time) in the viewer's classes and
 * the enrolled students who never joined it, with how each can be reached.
 * -> { live_class: {...}|null, missed: [{ student_id, name, avatar_url, channel: 'telegram'|'app' }],
 *      telegram: n, app: n }
 */
router.get('/live-missed-today', async (req, res) => {
  try {
    const courses = await messageableCourseIds(req);
    const courseIds = courses.map(c => c.id);
    const empty = { live_class: null, missed: [], telegram: 0, app: 0 };
    if (courseIds.length === 0) return res.json({ success: true, data: empty });

    const day = ppDay(new Date());
    const from = new Date(`${day}T00:00:00${PP_OFFSET}`);
    const to = new Date(from.getTime() + DAY_MS);
    const { data: classes } = await supabase
      .from('live_classes')
      .select('id, title, course_id, status, started_at, scheduled_at')
      .in('course_id', courseIds)
      .in('status', ['completed', 'active'])
      .gte('started_at', from.toISOString()).lt('started_at', to.toISOString())
      .order('started_at', { ascending: false });
    const lc = (classes || [])[0];
    if (!lc) return res.json({ success: true, data: empty });

    const [{ data: enrolled }, { data: joined }] = await Promise.all([
      supabase.from('course_enrollments').select('student_id').eq('course_id', lc.course_id),
      supabase.from('live_class_participants').select('user_id').eq('live_class_id', lc.id).eq('role', 'student'),
    ]);
    const joinedSet = new Set((joined || []).map(j => j.user_id));
    const candidateIds = [...new Set((enrolled || []).map(e => e.student_id))].filter(id => id && !joinedSet.has(id));
    const users = await fetchAllIn(candidateIds, chunk => supabase
      .from('users').select('id, name, avatar_url').in('id', chunk)
      .eq('role', 'student').eq('is_active', true).eq('is_test', false));
    const reachable = new Set((await tg.reachableStudents(users.map(u => u.id))).map(x => x.user_id));

    const missed = users.map(u => ({ student_id: u.id, name: u.name || '', avatar_url: u.avatar_url || null, channel: reachable.has(u.id) ? 'telegram' : 'app' }));
    const course = courses.find(c => c.id === lc.course_id);
    res.json({
      success: true,
      data: {
        live_class: { id: lc.id, title: lc.title, course_id: lc.course_id, course_title: course?.title || '', at: lc.started_at || lc.scheduled_at, status: lc.status },
        missed,
        telegram: missed.filter(m => m.channel === 'telegram').length,
        app: missed.filter(m => m.channel === 'app').length,
      },
    });
  } catch (error) {
    console.error('Insights live-missed-today error:', error);
    res.status(500).json({ success: false, error: 'Failed to load who missed the live class: ' + error.message });
  }
});

/**
 * POST /api/insights/message-students   { student_ids: [uuid], message: string }
 * Sends the same message to each student: on Telegram when they have linked it,
 * otherwise as an in-app notification. Teachers can only reach students in their
 * own classes. -> { telegram, app, skipped }
 */
router.post('/message-students', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim().slice(0, 500);
    const ids = [...new Set((Array.isArray(req.body?.student_ids) ? req.body.student_ids : []).filter(id => UUID_REGEX.test(String(id))))];
    if (!message) return res.status(400).json({ success: false, error: 'Write a message first' });
    if (ids.length === 0) return res.status(400).json({ success: false, error: 'Choose at least one student' });
    if (ids.length > 300) return res.status(400).json({ success: false, error: 'Too many students at once (max 300)' });

    // Only students in classes the sender is allowed to message.
    const courses = await messageableCourseIds(req);
    const courseIds = courses.map(c => c.id);
    const enrollments = courseIds.length
      ? await fetchAllIn(ids, chunk => supabase.from('course_enrollments').select('student_id').in('student_id', chunk).in('course_id', courseIds))
      : [];
    const allowedSet = new Set(enrollments.map(e => e.student_id));
    const allowed = ids.filter(id => allowedSet.has(id));
    const active = await fetchAllIn(allowed, chunk => supabase.from('users').select('id').in('id', chunk).eq('role', 'student').eq('is_active', true));
    const targets = active.map(u => u.id);

    const reachable = await tg.reachableStudents(targets);
    const delivered = new Set(await tg.sendToStudents(reachable, () => ({ text: `📢 ${tg.escapeHtml(message)}` })));
    // Everyone Telegram did not reach (not linked, blocked, or a failed send) gets an app notification.
    const fallback = targets.filter(id => !delivered.has(id));
    const appCount = await createNotifications(fallback.map(id => ({
      user_id: id, type: 'teacher_message', title: '📢 Message from your teacher', body: message,
      data: { from: req.user.userId }, kind: 'class',
    })));

    res.json({ success: true, data: { telegram: delivered.size, app: appCount, skipped: ids.length - targets.length } });
  } catch (error) {
    console.error('Insights message-students error:', error);
    res.status(500).json({ success: false, error: 'Failed to send the message: ' + error.message });
  }
});

// ── Follow-up page: who needs help, why, and what to do next ───────────────
// Flags are worked out from the same rows as the students table. A student in
// several classes is one row; each flag names its class when there is more than one.
const FOLLOW_DAYS = 7;            // "Followed up" lasts this long, then they come back if still flagged
const FOLLOW_KINDS = ['note', 'message', 'praise', 'done', 'reopen'];

const LIVE_STALE_DAYS = 14;       // a class with no session for this long is not "missed" any more
const PRACTICE_DAYS = 14;         // window for "does daily practice"
const PRACTICE_LOW = 3;           // fewer practice days than this in the window = little practice

// Why a student may be scoring low, from what the data shows: not joining the
// live classes, and not doing the daily challenge. `practiceDays` = days with a
// finished daily challenge in the last PRACTICE_DAYS (null when unknown).
function quizCauses(row, practiceDays) {
  const causes = [];
  if (row.live_eligible > 0 && row.live_attended != null) {
    if (row.live_attended === 0) causes.push({ type: 'live', text: `Has never joined a live class (${row.live_eligible} held)` });
    else if (row.live_eligible >= 3 && row.live_attended / row.live_eligible < 0.5) causes.push({ type: 'live', text: `Rarely joins live classes (${row.live_attended} of ${row.live_eligible})` });
  }
  if (practiceDays != null && practiceDays < PRACTICE_LOW) {
    causes.push({ type: 'practice', text: practiceDays === 0 ? `No daily practice in the last ${PRACTICE_DAYS} days` : `Little daily practice (${practiceDays} of the last ${PRACTICE_DAYS} days)` });
  }
  return causes;
}

function flagsFor(rows, practiceDays = null) {
  const multi = rows.length > 1;
  const issues = [];
  const wins = [];
  rows.forEach(r => {
    const where = multi ? ` (${r.course_title})` : '';
    if (r.status === 'inactive') issues.push({ type: 'idle', text: `Inactive ${r.days_inactive == null ? 'for a long time' : r.days_inactive + ' days'}${where}`, course_id: r.course_id });
    else if (r.status === 'not_started') issues.push({ type: 'idle', text: `Has not started${where}`, course_id: r.course_id });
    if (r.status === 'behind') issues.push({ type: 'slow', text: `Behind the class${r.current_lesson_title ? ' · on ' + r.current_lesson_title : ''} (${r.progress}%)${where}`, course_id: r.course_id });
    if (r.avg_quiz != null && r.quizzes_attempted >= 2 && r.avg_quiz < 50) issues.push({ type: 'quiz', text: `Quiz average ${r.avg_quiz}%${where}`, course_id: r.course_id, causes: quizCauses(r, practiceDays) });
    // Missed class = the last 2 live classes (class days) in a row, while the class is still running
    // (its latest session is within 2 weeks).
    const lastSessionMs = toMs(r.live_last_session);
    if (r.live_missed_run >= 2 && lastSessionMs != null && Date.now() - lastSessionMs <= LIVE_STALE_DAYS * DAY_MS) {
      issues.push({ type: 'live', text: `Missed the last ${r.live_missed_run} live classes in a row${where}`, course_id: r.course_id });
    }
    // Joins the live classes but does not study: no lesson started, or no quiz taken.
    if (r.live_attended >= 3 && r.live_eligible > 0 && r.live_attended / r.live_eligible >= 0.5 && (r.progress === 0 || r.quizzes_attempted === 0)) {
      const what = r.progress === 0 && r.quizzes_attempted === 0 ? 'has not started a lesson or taken a quiz' : r.progress === 0 ? 'has not started a lesson' : 'has not taken a quiz';
      issues.push({ type: 'passive', text: `Joins live classes (${r.live_attended} of ${r.live_eligible}) but ${what}${where}`, course_id: r.course_id });
    }
    // Not handed in past the deadline, and handed in but scored low, are different problems.
    if (r.assignments_missing > 0) issues.push({ type: 'missing', text: `Missing ${r.assignments_missing} assignment${r.assignments_missing === 1 ? '' : 's'}${where}`, course_id: r.course_id });
    if (r.assignments_avg != null && r.assignments_avg < 70) issues.push({ type: 'assign', text: `Assignments average ${r.assignments_avg}%${where}`, course_id: r.course_id });

    if (r.status === 'completed') wins.push(`Finished the class${where}`);
    if (r.avg_quiz != null && r.quizzes_attempted >= 2 && r.avg_quiz >= 80) wins.push(`Quiz average ${r.avg_quiz}%${where}`);
    if (r.live_eligible >= 3 && r.live_attended != null && r.live_attended / r.live_eligible >= 0.85) wins.push(`Joined ${r.live_attended} of ${r.live_eligible} live classes${where}`);
    if (r.assignments_total > 0 && r.assignments_missing === 0 && r.assignments_avg != null && r.assignments_avg >= 85) wins.push(`Assignments average ${r.assignments_avg}%${where}`);
  });
  return { issues, wins };
}

/** Course ids the viewer may follow up students in (admin: all non-test classes). */
async function canFollowUp(req, studentId) {
  const courses = await messageableCourseIds(req);
  if (!courses.length) return false;
  const { data } = await supabase.from('course_enrollments').select('id').eq('student_id', studentId).in('course_id', courses.map(c => c.id)).limit(1);
  return !!(data && data.length);
}

/**
 * GET /api/insights/follow-up?course_id=
 * -> { students: [{ student_id, name, avatar_url, classes:[{id,title}], days_inactive, has_telegram,
 *      issues:[{type,text}], wins:[text], last_contact:{at,by,kind,text}|null, followed_up }],
 *      counts: { slow, quiz, live, passive, missing, assign, idle, good, todo, followed_up } }
 */
router.get('/follow-up', async (req, res) => {
  try {
    const all = await loadTableRows(req, courseFilterOf(req), req.query.fresh === '1');
    const byStudent = groupBy(all.filter(r => r.is_active !== false), 'student_id');
    const ids = [...byStudent.keys()];
    const logs = ids.length ? await fetchAllIn(ids, chunk => supabase
      .from('student_followups').select('id, student_id, author_name, kind, text, created_at').in('student_id', chunk).order('created_at', { ascending: false })) : [];
    const logBy = groupBy(logs, 'student_id');
    const now = Date.now();

    // Whose own Telegram the teacher can open straight from here: linked, the student lets
    // teachers see it, and there is a username or a phone to open a chat with.
    // (The username / number itself is fetched on click, never put in this list.)
    const canOpenTg = new Set();
    try {
      const priv = await fetchAllIn(ids, chunk => supabase.from('student_private')
        .select('user_id, telegram_username, telegram_phone, telegram_visibility, telegram_chat_id')
        .in('user_id', chunk).order('user_id', { ascending: true }));
      priv.forEach(p => {
        if (p.telegram_chat_id && ['teachers', 'friends'].includes(p.telegram_visibility) && (p.telegram_username || p.telegram_phone)) canOpenTg.add(p.user_id);
      });
    } catch (e) { console.warn('telegram contact flags failed:', e.message); }

    // Daily practice in the last two weeks, only for students who need the "why" of a low quiz score.
    const lowQuizIds = ids.filter(id => byStudent.get(id).some(r => r.avg_quiz != null && r.quizzes_attempted >= 2 && r.avg_quiz < 50));
    const sinceDay = dayKey(now - (PRACTICE_DAYS - 1) * DAY_MS);
    const practiceRows = lowQuizIds.length ? await fetchAllIn(lowQuizIds, chunk => supabase
      .from('daily_challenges').select('id, student_id, challenge_date, status')
      .in('student_id', chunk).gte('challenge_date', sinceDay).in('status', ['COMPLETED', 'RETAKEN'])
      .order('id', { ascending: true })).catch(() => null) : [];
    const practiceDaysBy = new Map();
    (practiceRows || []).forEach(r => {
      if (!practiceDaysBy.has(r.student_id)) practiceDaysBy.set(r.student_id, new Set());
      practiceDaysBy.get(r.student_id).add(r.challenge_date);
    });

    const students = ids.map(id => {
      const rows = byStudent.get(id);
      const first = rows[0];
      const { issues, wins } = flagsFor(rows, practiceRows ? (practiceDaysBy.get(id)?.size || 0) : null);
      const log = logBy.get(id) || [];            // newest first
      const lastDone = log.find(l => l.kind === 'done' || l.kind === 'reopen');
      const followed = !!lastDone && lastDone.kind === 'done' && now - toMs(lastDone.created_at) < FOLLOW_DAYS * DAY_MS;
      const contact = log.find(l => l.kind !== 'reopen');
      const idle = rows.map(r => r.days_inactive).filter(v => v != null);
      return {
        student_id: id,
        name: first.name || '',
        avatar_url: first.avatar_url,
        classes: rows.map(r => ({ id: r.course_id, title: r.course_title })),
        days_inactive: idle.length ? Math.min(...idle) : null,
        has_telegram: !!first.has_telegram,
        can_open_telegram: canOpenTg.has(id),
        registered_at: first.registered_at || null,
        // Live time across all their classes: time spent vs the live teaching held since they enrolled.
        live: (() => {
          const withLive = rows.filter(r => r.live_eligible > 0);
          if (!withLive.length) return null;
          return {
            minutes: withLive.reduce((n, r) => n + (r.live_minutes || 0), 0),
            held_minutes: withLive.reduce((n, r) => n + (r.live_held_minutes || 0), 0),
            attended: withLive.reduce((n, r) => n + (r.live_attended || 0), 0),
            eligible: withLive.reduce((n, r) => n + r.live_eligible, 0),
          };
        })(),
        issues: issues.filter((i, n, a) => a.findIndex(x => x.text === i.text) === n),
        wins: [...new Set(wins)],
        last_contact: contact ? { at: toIso(contact.created_at), by: contact.author_name || null, kind: contact.kind, text: contact.text || null } : null,
        followed_up: followed,
      };
    });

    const needs = students.filter(s => s.issues.length && !s.followed_up);
    const counts = { todo: needs.length, followed_up: students.filter(s => s.followed_up).length, good: students.filter(s => !s.issues.length && s.wins.length).length };
    ['slow', 'quiz', 'live', 'passive', 'missing', 'assign', 'idle'].forEach(k => { counts[k] = needs.filter(s => s.issues.some(i => i.type === k)).length; });
    res.json({ success: true, data: { students, counts, total: students.length } });
  } catch (error) {
    console.error('Insights follow-up error:', error);
    res.status(500).json({ success: false, error: 'Failed to load follow-up: ' + error.message });
  }
});

/** GET /api/insights/follow-up/:studentId/notes -> { notes: [{ id, kind, text, author, at }] } newest first */
router.get('/follow-up/:studentId/notes', async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!UUID_REGEX.test(studentId) || !(await canFollowUp(req, studentId))) return res.status(404).json({ success: false, error: 'Student not found' });
    const { data, error } = await supabase.from('student_followups')
      .select('id, kind, text, author_name, created_at').eq('student_id', studentId).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    res.json({ success: true, data: { notes: (data || []).map(n => ({ id: n.id, kind: n.kind, text: n.text, author: n.author_name, at: toIso(n.created_at) })) } });
  } catch (error) {
    console.error('Insights follow-up notes error:', error);
    res.status(500).json({ success: false, error: 'Failed to load notes: ' + error.message });
  }
});

/** POST /api/insights/follow-up/:studentId/notes { kind: note|message|praise|done|reopen, text } */
router.post('/follow-up/:studentId/notes', async (req, res) => {
  try {
    const { studentId } = req.params;
    const kind = FOLLOW_KINDS.includes(req.body?.kind) ? req.body.kind : 'note';
    const text = String(req.body?.text || '').trim().slice(0, 1000);
    if (!UUID_REGEX.test(studentId) || !(await canFollowUp(req, studentId))) return res.status(404).json({ success: false, error: 'Student not found' });
    if (kind === 'note' && !text) return res.status(400).json({ success: false, error: 'Write a note first' });
    const { data: me } = await supabase.from('users').select('name').eq('id', req.user.userId).maybeSingle();
    const { data, error } = await supabase.from('student_followups')
      .insert({ student_id: studentId, author_id: req.user.userId, author_name: me?.name || null, kind, text: text || null })
      .select('id, kind, text, author_name, created_at').single();
    if (error) throw error;
    res.status(201).json({ success: true, data: { note: { id: data.id, kind: data.kind, text: data.text, author: data.author_name, at: toIso(data.created_at) } } });
  } catch (error) {
    console.error('Insights follow-up add note error:', error);
    res.status(500).json({ success: false, error: 'Failed to save: ' + error.message });
  }
});

module.exports = router;
