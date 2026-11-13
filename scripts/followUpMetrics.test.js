const assert = require('assert');
const { studiedAfterRatio, assignmentCounts, classPace, subjectMetrics, onboardingFacts } = require('../src/utils/followUpMetrics');
const H = 3600000, D = 86400000;
const NOW = Date.parse('2026-11-12T05:00:00Z');
let n = 0; const ok = (_, f) => { f(); n += 1; };

ok('studied after: counted within 48h, open windows are undecided', () => {
  const s1 = [NOW - 5 * D, NOW - 5 * D + H];
  const s2 = [NOW - 3 * D, NOW - 3 * D + H];
  const s3 = [NOW - 3 * H, NOW - 2 * H];                       // window still open
  assert.equal(studiedAfterRatio([s1, s2], [s1[1] + 10 * H], NOW), 0.5);
  assert.equal(studiedAfterRatio([s1, s2], [], NOW), 0);
  assert.equal(studiedAfterRatio([s3], [], NOW), null);
  assert.equal(studiedAfterRatio([s3], [NOW - H], NOW), 1);
  assert.equal(studiedAfterRatio([s1], [s1[1] + 49 * H], NOW), 0);   // too late
  assert.equal(studiedAfterRatio([], [], NOW), null);
});

ok('assignments: only past-due in the last 14 days', () => {
  const a = [
    { id: 'a', due_date: new Date(NOW - 2 * D).toISOString() },    // missing
    { id: 'b', due_date: new Date(NOW - 3 * D).toISOString() },    // failed
    { id: 'c', due_date: new Date(NOW - 4 * D).toISOString() },    // passed
    { id: 'd', due_date: new Date(NOW + 2 * D).toISOString() },    // not due yet
    { id: 'e', due_date: new Date(NOW - 30 * D).toISOString() },   // too old
  ];
  const subs = new Map([['b', { grade: 30 }], ['c', { score: 80 }]]);
  assert.deepEqual(assignmentCounts(a, subs, NOW), { missing: 1, failed: 1 });
});

ok('class pace: teacher log wins, else median of active students', () => {
  assert.deepEqual(classPace({ taught_count: 3, pace_pct: 25 }, [10, 50]), { pct: 25, source: 'teacher' });
  assert.deepEqual(classPace({ taught_count: 0, pace_pct: 0 }, [10, 50, 90]), { pct: 50, source: 'median' });
  assert.deepEqual(classPace(null, []), { pct: null, source: null });
});

ok('subject metrics row', () => {
  const m = subjectMetrics({
    live: { eligible: 8, attended: 7, minutes: 400, held_minutes: 480 },
    sessions: [[NOW - 5 * D, NOW - 5 * D + H]], activityMs: [], progressPct: 40,
    lastProgressMs: NOW - 9 * D, enrolledMs: NOW - 60 * D, pace: { pct: 60, source: 'teacher' },
    assignments: [], subsByAssignment: new Map(), now: NOW,
  });
  assert.equal(m.classes_held, 8); assert.equal(m.classes_joined, 7); assert.equal(m.live_hours_held, 8);
  assert.equal(m.studied_after_ratio, 0); assert.equal(m.days_since_new_lesson, 9); assert.equal(m.class_pace_pct, 60);
  const none = subjectMetrics({ live: undefined, sessions: [], activityMs: [], progressPct: 0, lastProgressMs: null, enrolledMs: NOW - 20 * D, pace: { pct: null, source: null }, assignments: [], subsByAssignment: new Map(), now: NOW });
  assert.equal(none.days_since_new_lesson, 20); assert.equal(none.classes_held, 0);
});

ok('onboarding facts', () => {
  const j = NOW - 3 * D;
  const f = onboardingFacts({ joinedMs: j, tourMs: j + H, telegramMs: null, completionMs: [j + 5 * H, j - 50 * D], quizMs: [], liveSessions: [{ start: j + D, attended: true }, { start: j + 2 * D, attended: false }], activeDays: 2 });
  assert.equal(f.first_lesson_at, new Date(j + 5 * H).toISOString());
  assert.equal(f.first_quiz_at, null); assert.equal(f.telegram_linked_at, null);
  assert.equal(f.first_live_at, new Date(j + D).toISOString());
  assert.equal(f.live_held_since_join, 2); assert.equal(f.active_days_count, 2);
});

console.log(`followUpMetrics: ${n} groups passed`);
