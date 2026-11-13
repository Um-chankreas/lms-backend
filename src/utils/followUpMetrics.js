const cfgDefault = require('./followUpConfig');

// Turns raw rows into the numbers stored in student_subject_metrics / student_onboarding.
// The pure functions here are tested; followUpMetricsJob.js loads the rows and saves the result.

const DAY = 86400000;
const HOUR = 3600000;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

/**
 * Share of attended classes that were followed by study (a lesson/unit done or a quiz taken)
 * within `withinHours` of the class ending. A class whose window is still open and has no study yet is
 * undecided and left out. Returns null when no class is decided.
 */
function studiedAfterRatio(sessions, activityMs, now, cfg = cfgDefault) {
  const win = cfg.studiedAfter.withinHours * HOUR;
  let decided = 0;
  let studied = 0;
  for (const [, end] of sessions || []) {
    const did = (activityMs || []).some(t => t >= end && t <= end + win);
    if (did) { decided += 1; studied += 1; }
    else if (end + win <= now) decided += 1;
  }
  return decided ? Math.round((studied / decided) * 1000) / 1000 : null;
}

/** Past-due assignments in the window: how many have no submission, how many were failed. */
function assignmentCounts(assignments, subsByAssignment, now, cfg = cfgDefault) {
  const from = now - cfg.windowDays * DAY;
  let missing = 0;
  let failed = 0;
  for (const a of assignments || []) {
    const due = a.due_date ? Date.parse(a.due_date) : null;
    if (due == null || due > now || due < from) continue;
    const sub = subsByAssignment.get(a.id);
    if (!sub) { missing += 1; continue; }
    const pct = sub.grade != null ? Number(sub.grade) : sub.score != null ? Number(sub.score) : null;
    if (pct != null && pct < cfg.progress.assignmentPassPct) failed += 1;
  }
  return { missing, failed };
}

/**
 * The class pace for a course. The teacher's own log wins once any lesson is marked taught;
 * until then it is the median progress of students who were active in the window.
 */
function classPace(taughtSummary, activeProgress) {
  if (taughtSummary && taughtSummary.taught_count > 0 && taughtSummary.pace_pct != null) return { pct: taughtSummary.pace_pct, source: 'teacher' };
  const m = median(activeProgress || []);
  return m == null ? { pct: null, source: null } : { pct: m, source: 'median' };
}

/**
 * One student x subject row.
 *  live: the liveReport by_course entry (or undefined)   sessions: [[startMs,endMs]] attended
 */
function subjectMetrics({ live, sessions, activityMs, progressPct, lastProgressMs, enrolledMs, pace, assignments, subsByAssignment, now }, cfg = cfgDefault) {
  const l = live || {};
  const since = lastProgressMs != null ? lastProgressMs : enrolledMs;
  const counts = assignmentCounts(assignments, subsByAssignment, now, cfg);
  return {
    classes_held: l.eligible || 0,
    classes_joined: l.attended || 0,
    live_minutes: l.minutes || 0,
    live_hours_held: Math.round(((l.held_minutes || 0) / 60) * 10) / 10,
    studied_after_ratio: studiedAfterRatio(sessions, activityMs, now, cfg),
    progress_pct: progressPct || 0,
    class_pace_pct: pace.pct,
    class_pace_source: pace.source,
    days_since_new_lesson: since == null ? null : Math.max(0, Math.floor((now - since) / DAY)),
    assignments_past_due_missing: counts.missing,
    assignments_failed: counts.failed,
  };
}

/** First-week facts for one student. All inputs are epoch ms (or null). */
function onboardingFacts({ joinedMs, tourMs, telegramMs, completionMs, quizMs, liveSessions, activeDays }, cfg = cfgDefault) {
  const first = (arr) => { const v = (arr || []).filter(x => x != null && x >= joinedMs - DAY); return v.length ? Math.min(...v) : null; };
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  const attended = (liveSessions || []).filter(s => s.attended).map(s => s.start);
  return {
    joined_at: iso(joinedMs),
    tour_done_at: iso(tourMs),
    first_lesson_at: iso(first(completionMs)),
    telegram_linked_at: iso(telegramMs),
    first_quiz_at: iso(first(quizMs)),
    first_live_at: iso(attended.length ? Math.min(...attended) : null),
    live_held_since_join: (liveSessions || []).length,
    active_days_count: activeDays || 0,
  };
}

module.exports = { studiedAfterRatio, assignmentCounts, classPace, subjectMetrics, onboardingFacts, median };
