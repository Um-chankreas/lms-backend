const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const { levelInfo } = require('../utils/xp');
const { getStreakSummary } = require('../utils/streak');
const { isSubscriptionActive } = require('../utils/access');
const { courseProgress, fetchAllRows, fetchAllIn, toMs, toIso } = require('../utils/studentProgress');

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
  if (role !== 'admin' && role !== 'teacher') {
    return res.status(403).json({
      success: false,
      error: 'This action requires admin or teacher privileges'
    });
  }
  req.staffRole = role;
  next();
};

router.use(authenticateToken, isStaff);

/**
 * The class roster for one course (see GET /courses/:courseId/students):
 * { course, lessons, summary, students }. Shared with GET /overview.
 */
async function buildRoster(course) {
  const courseId = course.id;

  const enrollments = await fetchAllRows(() => supabase
    .from('course_enrollments')
    .select('id, student_id, enrolled_at')
    .eq('course_id', courseId)
    .order('id', { ascending: true }));
  const enrolledAt = earliestEnrollment(enrollments, 'student_id');

  const users = await fetchAllIn([...enrolledAt.keys()], chunk => supabase
    .from('users')
    .select('id, name, email, phone, avatar_url, is_active, xp')
    .in('id', chunk)
    .eq('role', 'student')
    .order('id', { ascending: true }));
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
        is_active: u.is_active !== false
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

    const roster = await buildRoster(course);
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

module.exports = router;
