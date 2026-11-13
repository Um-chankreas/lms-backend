const assert = require('assert');
const { evaluateStudent, attendanceOf, progressOf, urgency } = require('../src/utils/followUpRules');

const NOW = Date.parse('2026-11-12T05:00:00Z');
const OLD = '2026-08-01T00:00:00Z';
const sub = (title, held, joined, extra = {}) => ({
  course_id: title, title,
  m: { classes_held: held, classes_joined: joined, studied_after_ratio: joined ? 0.8 : null, progress_pct: 50, class_pace_pct: 50, days_since_new_lesson: 2, assignments_past_due_missing: 0, assignments_failed: 0, ...extra },
});
const ev = (subjects, extra = {}) => evaluateStudent({ joined_at: OLD, subjects, ...extra }, NOW);
const codes = (r) => r.cases.map(c => c.code + c.title);
let n = 0;
const ok = (name, fn) => { fn(); n += 1; };

ok('attendance bands and boundaries', () => {
  assert.equal(attendanceOf({ classes_held: 10, classes_joined: 7 }, require('../src/utils/followUpConfig')), 'regular');
  assert.equal(attendanceOf({ classes_held: 10, classes_joined: 6 }, require('../src/utils/followUpConfig')), 'sometimes');
  assert.equal(attendanceOf({ classes_held: 10, classes_joined: 3 }, require('../src/utils/followUpConfig')), 'sometimes');
  assert.equal(attendanceOf({ classes_held: 10, classes_joined: 2 }, require('../src/utils/followUpConfig')), 'rarely');
  assert.equal(attendanceOf({ classes_held: 8, classes_joined: 0 }, require('../src/utils/followUpConfig')), 'never');
  assert.equal(attendanceOf({ classes_held: 0, classes_joined: 0 }, require('../src/utils/followUpConfig')), 'none');
});

ok('Math 0/8, History and Khmer fine -> case 1 Math only', () => {
  const r = ev([sub('Math', 8, 0), sub('History', 8, 7), sub('Khmer', 8, 8)]);
  assert.deepEqual(codes(r), ['1Math']);
  assert.equal(r.main.code, '1'); assert.equal(r.extra, 0); assert.equal(r.doing_well, false);
});

ok('3 subjects all 0-1 of 8 -> case 4 (not 1)', () => {
  const r = ev([sub('Math', 8, 0), sub('History', 8, 1), sub('Khmer', 8, 1)]);
  assert.equal(r.main.code, '4');
  assert.ok(r.cases.every(c => c.code === '4'));
  assert.equal(r.extra, 2);
});

ok('a single subject missed is case 1, never 4', () => {
  assert.deepEqual(codes(ev([sub('Math', 8, 0)])), ['1Math']);
});

ok('joins Math 7/8 but does not study -> case 2 Math', () => {
  const r = ev([sub('Math', 8, 7, { studied_after_ratio: 0.2 })]);
  assert.deepEqual(codes(r), ['2Math']);
});

ok('slow progress in an attended subject -> case 3; in a skipped one it is case 1 only', () => {
  assert.deepEqual(codes(ev([sub('Math', 8, 7, { progress_pct: 20, class_pace_pct: 50 })])), ['3Math']);
  assert.deepEqual(codes(ev([sub('Math', 8, 0, { progress_pct: 0, class_pace_pct: 50 }), sub('Khmer', 8, 8)])), ['1Math']);
});

ok('slow triggers: 15 points behind (boundary), 7 idle days, missing or failed assignment; none at 14 days = no progress', () => {
  const cfg = require('../src/utils/followUpConfig');
  assert.equal(progressOf({ progress_pct: 35, class_pace_pct: 50 }, cfg), 'slow');
  assert.equal(progressOf({ progress_pct: 36, class_pace_pct: 50 }, cfg), 'on_track');
  assert.equal(progressOf({ progress_pct: 50, class_pace_pct: 50, days_since_new_lesson: 7 }, cfg), 'slow');
  assert.equal(progressOf({ progress_pct: 50, class_pace_pct: 50, days_since_new_lesson: 6 }, cfg), 'on_track');
  assert.equal(progressOf({ progress_pct: 50, assignments_past_due_missing: 1 }, cfg), 'slow');
  assert.equal(progressOf({ progress_pct: 50, assignments_failed: 1 }, cfg), 'slow');
  assert.equal(progressOf({ progress_pct: 50, days_since_new_lesson: 14 }, cfg), 'no_progress');
  assert.equal(progressOf({ progress_pct: 10, class_pace_pct: null, days_since_new_lesson: 1 }, cfg), 'on_track');
});

ok('doing well needs regular + on track everywhere and no cases', () => {
  assert.equal(ev([sub('Math', 8, 8), sub('Khmer', 8, 7)]).doing_well, true);
  assert.equal(ev([sub('Math', 8, 8), sub('Khmer', 8, 4)]).doing_well, false);   // sometimes
  assert.equal(ev([sub('Math', 8, 8, { progress_pct: 10 })]).doing_well, false); // slow
  assert.equal(ev([sub('Math', 0, 0)]).doing_well, false);                       // nothing held, nothing proven
});

ok('main problem is the highest case; extra counts the rest', () => {
  const r = ev([sub('Math', 8, 0), sub('Khmer', 8, 7, { studied_after_ratio: 0.1, progress_pct: 10 })]);
  assert.equal(r.main.code, '1'); assert.equal(r.main.title, 'Math');
  assert.deepEqual(r.cases.map(c => c.code), ['1', '2', '3']);
  assert.equal(r.extra, 2);
  assert.ok(urgency(r) > urgency(ev([sub('Math', 8, 7, { studied_after_ratio: 0.1 })])));
});

ok('subject dots: problem, watch, ok', () => {
  const r = ev([sub('Math', 8, 0), sub('Khmer', 8, 4), sub('Art', 8, 8)]);
  assert.deepEqual(r.subjects.map(s => s.status), ['problem', 'watch', 'ok']);
});

const fresh = (daysAgo, onboarding = {}, subjects = [sub('Math', 2, 0, { progress_pct: 0 })]) => evaluateStudent({
  joined_at: new Date(NOW - daysAgo * 86400000).toISOString(), subjects,
  onboarding: { live_held_since_join: 0, active_days_count: 1, ...onboarding },
}, NOW);

ok('day-4 student with no lesson -> case 0 and nothing from 1-4', () => {
  const r = fresh(3, {});
  assert.equal(r.day, 4); assert.equal(r.is_new, true);
  assert.equal(r.new_case, true); assert.ok(r.new_reasons.includes('no_lesson'));
  assert.deepEqual(r.cases, []);
});

ok('day-2 student is not flagged', () => {
  const r = fresh(1, {});
  assert.equal(r.day, 2); assert.equal(r.new_case, false);
});

ok('0 case: missed first 2 live classes, or only 1 active day after day 3', () => {
  assert.ok(fresh(1, { first_lesson_at: 'x', live_held_since_join: 2, active_days_count: 2 }).new_reasons.includes('missed_live'));
  assert.ok(fresh(4, { first_lesson_at: 'x', active_days_count: 1 }).new_reasons.includes('one_active_day'));
  assert.equal(fresh(4, { first_lesson_at: 'x', active_days_count: 2 }).new_case, false);
});

ok('checklist: done, late, pending', () => {
  const r = fresh(3, { tour_done_at: 'a', first_lesson_at: 'b' });   // day 4
  const by = Object.fromEntries(r.steps.map(s => [s.key, s.state]));
  assert.deepEqual(by, { tour: 'done', first_lesson: 'done', telegram: 'late', first_quiz: 'late', first_live: 'pending', back_days: 'pending' });
});

ok('day 14 is still new, day 15 is normal follow-up', () => {
  assert.equal(fresh(13, {}).is_new, true);
  const r = fresh(14, {}, [sub('Math', 8, 0)]);
  assert.equal(r.is_new, false); assert.equal(r.main.code, '1');
});

console.log(`followUpRules: ${n} groups passed`);
