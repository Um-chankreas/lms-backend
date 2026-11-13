const defaultConfig = require('./followUpConfig');

// The Follow-up page's rule engine. One pure function per student: no database, no clock
// (pass `now`), no globals, so every rule can be unit tested.

const DAY = 86400000;
const toMs = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return v; const ms = Date.parse(v); return Number.isNaN(ms) ? null : ms; };
const PRIORITY = { '4': 4, '1': 3, '2': 2, '3': 1 };

/** Never / rarely / sometimes / regular, or 'none' when no class was held (nothing to judge). */
function attendanceOf(m, cfg) {
  const held = m.classes_held || 0;
  if (held <= 0) return 'none';
  const joined = m.classes_joined || 0;
  if (joined <= 0) return 'never';
  const r = joined / held;
  if (r >= cfg.attendance.regular) return 'regular';
  if (r >= cfg.attendance.sometimes) return 'sometimes';
  return 'rarely';
}

/** true / false, or null when the student joined no class (nothing to study after). */
function studiedAfterOf(m, cfg) {
  if (!(m.classes_joined > 0) || m.studied_after_ratio == null) return null;
  return Number(m.studied_after_ratio) >= cfg.studiedAfter.minRatio;
}

/** 'on_track' | 'slow' | 'no_progress'. */
function progressOf(m, cfg) {
  const p = cfg.progress;
  const idle = m.days_since_new_lesson;
  if (idle != null && idle >= p.noneDays) return 'no_progress';
  const behind = m.class_pace_pct != null && (m.class_pace_pct - (m.progress_pct || 0)) >= p.slowBehindPoints;
  const stalled = idle != null && idle >= p.slowNoLessonDays;
  const homework = (m.assignments_past_due_missing || 0) > 0 || (m.assignments_failed || 0) > 0;
  return behind || stalled || homework ? 'slow' : 'on_track';
}

/** Day number since joining: the join day is day 1. */
function dayNumber(joinedAt, now) {
  const j = toMs(joinedAt);
  return j == null ? null : Math.floor((now - j) / DAY) + 1;
}

/** The six first-week steps with their state: done (date), late (due, not done) or pending. */
function onboardingSteps(ob, day, cfg) {
  const n = cfg.newStudent;
  const live = ob.live_held_since_join || 0;
  const defs = [
    { key: 'tour', at: ob.tour_done_at, due: day >= n.steps.tour },
    { key: 'first_lesson', at: ob.first_lesson_at, due: day >= n.steps.firstLesson },
    { key: 'telegram', at: ob.telegram_linked_at, due: day >= n.steps.telegram },
    { key: 'first_quiz', at: ob.first_quiz_at, due: day >= n.steps.firstQuiz },
    { key: 'first_live', at: ob.first_live_at, due: live >= n.firstLiveAfterClasses },
    { key: 'back_days', at: (ob.active_days_count || 0) >= n.backDaysNeeded ? (ob.back_days_at || true) : null, due: day >= n.steps.backDays },
  ];
  return defs.map(d => ({ key: d.key, state: d.at ? 'done' : d.due ? 'late' : 'pending', at: d.at && d.at !== true ? d.at : null }));
}

/** "Not getting started" for a new student: the reasons it applies, empty when it does not. */
function notStartedReasons(ob, day, cfg) {
  const ns = cfg.newStudent.notStarted;
  const why = [];
  if (!ob.first_lesson_at && day > ns.lessonByDay) why.push('no_lesson');
  if ((ob.live_held_since_join || 0) >= ns.missedLiveClasses && !ob.first_live_at) why.push('missed_live');
  if ((ob.active_days_count || 0) <= ns.activeDaysByDay3 && day > ns.lessonByDay) why.push('one_active_day');
  return why;
}

/**
 * student: { joined_at, onboarding, subjects: [{ course_id, title, m }] }  (m = student_subject_metrics row)
 * returns:
 *  { is_new, day, steps, new_case (bool, case 0), new_reasons,
 *    subjects: [{ course_id, title, attendance, studied_after, progress, status, cases }],
 *    cases: [{ code, course_id, title, attendance, progress }] (all, highest first),
 *    main, extra, doing_well }
 */
function evaluateStudent(student, now = Date.now(), cfg = defaultConfig) {
  const day = dayNumber(student.joined_at, now);
  const isNew = day != null && day <= cfg.newStudent.days;
  const subjects = (student.subjects || []).map(s => {
    const m = s.m || {};
    return {
      course_id: s.course_id, title: s.title,
      attendance: attendanceOf(m, cfg), studied_after: studiedAfterOf(m, cfg), progress: progressOf(m, cfg),
      cases: [], status: 'ok',
    };
  });

  if (isNew) {
    const ob = student.onboarding || {};
    const reasons = notStartedReasons(ob, day, cfg);
    subjects.forEach(s => { s.status = 'new'; });
    return {
      is_new: true, day, steps: onboardingSteps(ob, day, cfg),
      new_case: reasons.length > 0, new_reasons: reasons,
      subjects, cases: [], main: reasons.length ? { code: '0' } : null, extra: 0, doing_well: false,
    };
  }

  const cases = [];
  const addCase = (code, s) => { const c = { code, course_id: s.course_id, title: s.title, attendance: s.attendance, progress: s.progress }; cases.push(c); s.cases.push(code); };
  const missing = (s) => s.attendance === 'rarely' || s.attendance === 'never';

  const allMissing = subjects.length >= cfg.multiSubjectMin && subjects.every(missing);
  if (allMissing) subjects.forEach(s => addCase('4', s));
  subjects.forEach(s => {
    const attends = s.attendance === 'regular' || s.attendance === 'sometimes';
    if (missing(s) && !allMissing) addCase('1', s);
    if (attends && s.studied_after === false) addCase('2', s);
    if (attends && (s.progress === 'slow' || s.progress === 'no_progress')) addCase('3', s);
  });
  // Highest case first; within a code, a student who never joins before one who rarely does.
  cases.sort((a, b) => PRIORITY[b.code] - PRIORITY[a.code] || (b.attendance === 'never') - (a.attendance === 'never'));

  subjects.forEach(s => {
    if (s.cases.length) s.status = 'problem';
    else if (s.attendance === 'sometimes' || s.attendance === 'none') s.status = 'watch';
  });
  const doingWell = cases.length === 0 && subjects.length > 0
    && subjects.every(s => s.attendance === 'none' || (s.attendance === 'regular' && s.progress === 'on_track'))
    && subjects.some(s => s.attendance === 'regular');

  return {
    is_new: false, day, steps: null, new_case: false, new_reasons: [],
    subjects, cases, main: cases[0] || null, extra: Math.max(0, cases.length - 1), doing_well: doingWell,
  };
}

/** Sort key for "most urgent first": 4, 1, 2, 3, then more cases first. */
function urgency(result) {
  const top = result.main ? (PRIORITY[result.main.code] || 0) : 0;
  return top * 100 + result.cases.length;
}

module.exports = { evaluateStudent, attendanceOf, studiedAfterOf, progressOf, dayNumber, onboardingSteps, notStartedReasons, urgency, PRIORITY };
