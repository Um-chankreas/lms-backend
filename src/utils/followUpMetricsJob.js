const supabase = require('../config/supabase');
const cfg = require('./followUpConfig');
const { buildLiveReport } = require('./liveReport');
const { courseProgress, fetchAllRows, fetchAllIn, toMs } = require('./studentProgress');
const { summarize } = require('./teachingProgress');
const { classPace, subjectMetrics, onboardingFacts } = require('./followUpMetrics');

const DAY = 86400000;
const HOUR_MS = 60 * 60 * 1000;
let running = false;

const chunks = (arr, n = 500) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/** Reads everything, computes every student x subject row and first-week row, saves them. */
async function refreshFollowUpMetrics(now = Date.now()) {
  const startedAt = new Date().toISOString();
  const windowFrom = new Date(now - cfg.windowDays * DAY).toISOString();
  const lookback = new Date(now - 45 * DAY).toISOString();

  const courses = await fetchAllRows(() => supabase.from('courses').select('id, title, category').eq('is_test', false).order('id', { ascending: true }));
  const courseIds = courses.map(c => c.id);
  if (!courseIds.length) return { subjects: 0, onboarding: 0 };

  const [enrollments, classes, schedules] = await Promise.all([
    fetchAllIn(courseIds, ch => supabase.from('course_enrollments').select('id, course_id, student_id, enrolled_at').in('course_id', ch).order('id', { ascending: true })),
    fetchAllIn(courseIds, ch => supabase.from('live_classes').select('id, course_id, status, started_at, ended_at').in('course_id', ch).gte('started_at', windowFrom).order('id', { ascending: true })),
    fetchAllIn(courseIds, ch => supabase.from('class_schedules').select('id, course_id, days_of_week, start_time, end_time').eq('is_active', true).in('course_id', ch).order('id', { ascending: true })),
  ]);
  const students = await fetchAllIn(enrollments.map(e => e.student_id), ch => supabase.from('users')
    .select('id, name, avatar_url, created_at').in('id', ch).eq('role', 'student').eq('is_active', true).eq('is_test', false).order('id', { ascending: true }));
  const studentIds = students.map(s => s.id);
  const studentSet = new Set(studentIds);
  if (!studentIds.length) return { subjects: 0, onboarding: 0 };

  const participants = await fetchAllIn(classes.map(c => c.id), ch => supabase.from('live_class_participants')
    .select('id, live_class_id, user_id, joined_at, left_at').eq('role', 'student').in('live_class_id', ch).order('id', { ascending: true }));
  const report = buildLiveReport({ courses, enrollments, students, classes, participants, schedules, now });
  const liveBy = new Map(report.students.map(r => [r.student_id, r]));

  const progress = await courseProgress({ courseIds, studentIds });

  // Study events (for "studied after class" and the first-week steps).
  const lessonCourse = new Map();
  const unitCourse = new Map();
  progress.lessonsByCourse.forEach((lessons, cid) => lessons.forEach(l => {
    lessonCourse.set(l.id, cid);
    (progress.unitsByLesson.get(l.id) || []).forEach(u => unitCourse.set(u.id, cid));
  }));
  const [lessonDone, unitDone, quizzes, assignments, activity, priv] = await Promise.all([
    fetchAllIn(studentIds, ch => supabase.from('lesson_completions').select('id, student_id, lesson_id, completed_at').in('student_id', ch).gte('completed_at', lookback).order('id', { ascending: true })),
    fetchAllIn(studentIds, ch => supabase.from('unit_completions').select('id, student_id, unit_id, completed_at').in('student_id', ch).gte('completed_at', lookback).order('id', { ascending: true })),
    fetchAllIn(courseIds, ch => supabase.from('quizzes').select('id, course_id').in('course_id', ch).order('id', { ascending: true })),
    fetchAllIn(courseIds, ch => supabase.from('assignments').select('id, course_id, due_date').eq('status', 'published').in('course_id', ch).order('id', { ascending: true })),
    fetchAllIn(studentIds, ch => supabase.from('activity_days').select('student_id, day').in('student_id', ch).gte('day', lookback.slice(0, 10)).order('student_id', { ascending: true }).order('day', { ascending: true })),
    fetchAllIn(studentIds, ch => supabase.from('student_private').select('user_id, tour_completed_at, telegram_linked_at').in('user_id', ch).order('user_id', { ascending: true })),
  ]);
  const quizCourse = new Map(quizzes.map(q => [q.id, q.course_id]));
  const [quizSubs, assignSubs] = await Promise.all([
    fetchAllIn(quizzes.map(q => q.id), ch => supabase.from('quiz_submissions').select('id, student_id, quiz_id, submitted_at').in('quiz_id', ch).gte('submitted_at', lookback).order('id', { ascending: true })),
    fetchAllIn(assignments.map(a => a.id), ch => supabase.from('assignment_submissions').select('id, student_id, assignment_id, grade, score').in('assignment_id', ch).order('id', { ascending: true })),
  ]);

  // studentId -> courseId -> [ms] of lesson / unit / quiz activity
  const actBy = new Map();
  const addAct = (sid, cid, ts) => {
    const ms = toMs(ts);
    if (ms == null || !cid || !studentSet.has(sid)) return;
    if (!actBy.has(sid)) actBy.set(sid, new Map());
    const m = actBy.get(sid);
    if (!m.has(cid)) m.set(cid, []);
    m.get(cid).push(ms);
  };
  lessonDone.forEach(r => addAct(r.student_id, lessonCourse.get(r.lesson_id), r.completed_at));
  unitDone.forEach(r => addAct(r.student_id, unitCourse.get(r.unit_id), r.completed_at));
  quizSubs.forEach(r => addAct(r.student_id, quizCourse.get(r.quiz_id), r.submitted_at));

  // Teacher's own pace per course (the table may not exist yet; then everything falls back to the median).
  const taughtBy = new Map();
  try {
    const rows = await fetchAllIn(courseIds, ch => supabase.from('class_taught_lessons').select('id, course_id, lesson_id, taught_on, live_class_id').in('course_id', ch).order('id', { ascending: true }));
    rows.forEach(r => { if (!taughtBy.has(r.course_id)) taughtBy.set(r.course_id, []); taughtBy.get(r.course_id).push(r); });
  } catch (e) { /* migration 071 not run */ }

  const assignmentsBy = new Map();
  assignments.forEach(a => { if (!assignmentsBy.has(a.course_id)) assignmentsBy.set(a.course_id, []); assignmentsBy.get(a.course_id).push(a); });
  const subsBy = new Map();   // studentId -> assignmentId -> submission
  assignSubs.forEach(s => { if (!subsBy.has(s.student_id)) subsBy.set(s.student_id, new Map()); subsBy.get(s.student_id).set(s.assignment_id, s); });

  const enrolledMs = new Map();   // `${cid}|${sid}` -> ms
  enrollments.forEach(e => { const k = `${e.course_id}|${e.student_id}`; const t = toMs(e.enrolled_at); if (!enrolledMs.has(k) || (t != null && t < enrolledMs.get(k))) enrolledMs.set(k, t); });

  const rows = [];
  for (const course of courses) {
    const members = [...enrolledMs.keys()].filter(k => k.startsWith(`${course.id}|`)).map(k => k.split('|')[1]).filter(id => studentSet.has(id));
    if (!members.length) continue;
    const prog = new Map(members.map(id => [id, progress.get(id, course.id)]));
    const activeProgress = members.map(id => prog.get(id)).filter(p => p && p.last_progress_at && now - toMs(p.last_progress_at) <= cfg.windowDays * DAY).map(p => p.percentage);
    const taught = progress.lessonsByCourse.get(course.id) ? summarize(progress.lessonsByCourse.get(course.id), taughtBy.get(course.id) || []) : null;
    const pace = classPace(taught, activeProgress);
    for (const sid of members) {
      const p = prog.get(sid);
      const lr = liveBy.get(sid);
      const m = subjectMetrics({
        live: lr && lr.by_course[course.id],
        sessions: (lr && lr.attended_sessions && lr.attended_sessions[course.id]) || [],
        activityMs: (actBy.get(sid) && actBy.get(sid).get(course.id)) || [],
        progressPct: p ? p.percentage : 0,
        lastProgressMs: p && p.last_progress_at ? toMs(p.last_progress_at) : null,
        enrolledMs: enrolledMs.get(`${course.id}|${sid}`),
        pace, assignments: assignmentsBy.get(course.id) || [], subsByAssignment: subsBy.get(sid) || new Map(), now,
      });
      rows.push({ student_id: sid, course_id: course.id, ...m, computed_at: startedAt });
    }
  }
  for (const part of chunks(rows)) {
    const { error } = await supabase.from('student_subject_metrics').upsert(part, { onConflict: 'student_id,course_id' });
    if (error) throw error;
  }
  // Rows nobody refreshed any more (student left the class, class deleted).
  await supabase.from('student_subject_metrics').delete().lt('computed_at', startedAt);

  // First-week facts for anyone who joined recently.
  const privBy = new Map(priv.map(p => [p.user_id, p]));
  const lessonTimes = new Map();
  const quizTimes = new Map();
  const push = (m, k, ts) => { const ms = toMs(ts); if (ms == null) return; if (!m.has(k)) m.set(k, []); m.get(k).push(ms); };
  lessonDone.forEach(r => push(lessonTimes, r.student_id, r.completed_at));
  unitDone.forEach(r => push(lessonTimes, r.student_id, r.completed_at));
  quizSubs.forEach(r => push(quizTimes, r.student_id, r.submitted_at));
  const actDays = new Map();
  activity.forEach(a => { if (!actDays.has(a.student_id)) actDays.set(a.student_id, []); actDays.get(a.student_id).push(a.day); });

  const recent = students.filter(s => toMs(s.created_at) != null && now - toMs(s.created_at) <= 30 * DAY);
  const obRows = recent.map(s => {
    const joinedMs = toMs(s.created_at);
    const lr = liveBy.get(s.id);
    const liveSessions = [];
    Object.entries((lr && lr.by_course) || {}).forEach(([cid, v]) => {
      ((lr.attended_sessions || {})[cid] || []).filter(([a]) => a >= joinedMs - DAY).forEach(([a]) => liveSessions.push({ start: a, attended: true }));
      for (let i = 0; i < Math.max(0, (v.eligible || 0) - (v.attended || 0)); i += 1) liveSessions.push({ start: null, attended: false });
    });
    const pv = privBy.get(s.id) || {};
    return {
      student_id: s.id,
      ...onboardingFacts({
        joinedMs, tourMs: toMs(pv.tour_completed_at), telegramMs: toMs(pv.telegram_linked_at),
        completionMs: lessonTimes.get(s.id) || [], quizMs: quizTimes.get(s.id) || [], liveSessions,
        activeDays: (actDays.get(s.id) || []).filter(d => toMs(d) >= joinedMs - DAY).length,
      }),
      computed_at: startedAt,
    };
  });
  for (const part of chunks(obRows)) {
    const { error } = await supabase.from('student_onboarding').upsert(part, { onConflict: 'student_id' });
    if (error) throw error;
  }
  return { subjects: rows.length, onboarding: obRows.length };
}

async function runOnce() {
  if (running) return null;
  running = true;
  try {
    const out = await refreshFollowUpMetrics();
    console.log(`[follow-up] metrics refreshed: ${out.subjects} student-subjects, ${out.onboarding} new students`);
    return out;
  } catch (e) {
    console.error('[follow-up] metrics refresh failed:', e.message || e);
    return null;
  } finally { running = false; }
}

/** Hourly refresh. Set FOLLOWUP_METRICS=off to disable (for example on a second instance). */
function startFollowUpMetricsJob() {
  if (process.env.FOLLOWUP_METRICS === 'off') return;
  setTimeout(runOnce, 90 * 1000).unref();
  setInterval(runOnce, HOUR_MS).unref();
}

module.exports = { refreshFollowUpMetrics, startFollowUpMetricsJob, runOnce };
