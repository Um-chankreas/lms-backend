const assert = require('assert');
const { buildLiveReport, unionMinutes } = require('../../src/utils/liveReport');

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log('ok  ', name); };

const T0 = Date.parse('2026-10-05T02:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const courses = [{ id: 'c1', title: 'Math 12', category: 'Math' }, { id: 'c2', title: 'History 12', category: 'history' }];
const students = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id.toUpperCase(), avatar_url: null }));
const enrollments = [
  ...['a', 'b', 'c', 'd'].map(s => ({ course_id: 'c1', student_id: s, enrolled_at: at(-1000) })),
  { course_id: 'c2', student_id: 'a', enrolled_at: at(-1000) },
];
const classes = [
  { id: 'k1', course_id: 'c1', status: 'completed', started_at: at(0), ended_at: at(60) },
  { id: 'k2', course_id: 'c1', status: 'completed', started_at: at(1440), ended_at: at(1500) },
  { id: 'k3', course_id: 'c2', status: 'completed', started_at: at(0), ended_at: at(2) },   // accidental start
  { id: 'k4', course_id: 'c2', status: 'completed', started_at: at(2880), ended_at: at(2940) },
];
const p = (cls, user, a, b) => ({ live_class_id: cls, user_id: user, joined_at: at(a), left_at: b == null ? null : at(b) });
const participants = [
  p('k1', 'a', 0, 60), p('k2', 'a', 1440, 1500), p('k4', 'a', 2880, 2940),   // a: every class
  p('k1', 'b', 0, 10),                                                      // b: 10 min only -> not attended
  p('k1', 'c', 0, 30), p('k1', 'c', 20, 50),                                // c: overlapping joins -> 50 min once
];
const r = buildLiveReport({ courses, enrollments, students, classes, participants, now: T0 + 5000 * 60000, goalHours: 100 });

check('overlapping joins count once', () => assert.strictEqual(unionMinutes([[0, 30 * 60000], [20 * 60000, 50 * 60000]]), 50));
check('a visit with a gap counts from first join to last leave', () => {
  const g = buildLiveReport({ courses, enrollments, students, classes, participants: [p('k1', 'd', 0, 5), p('k1', 'd', 40, 45)], now: T0 + 5000 * 60000 });
  const d = g.students.find(s => s.student_id === 'd');
  assert.strictEqual(d.minutes, 45);
  assert.strictEqual(d.by_course.c1.attended, 1);
});
check('missed_in_a_row counts the latest sessions the student skipped', () => {
  // c1 has two sessions (k1, k2). b attended neither, a attended both, c only k1.
  const x = buildLiveReport({ courses, enrollments, students, classes, participants, now: T0 + 5000 * 60000 });
  const run = (id) => x.students.find(s => s.student_id === id).by_course.c1.missed_in_a_row;
  assert.strictEqual(run('b'), 2);
  assert.strictEqual(run('a'), 0);
  assert.strictEqual(run('c'), 1);
  assert.ok(x.students.find(s => s.student_id === 'b').by_course.c1.last_session_at);
});
check('accidental 2 min start is not a class', () => assert.strictEqual(r.classes_held, 3));
check('live hours are summed class lengths (3 h)', () => assert.strictEqual(r.live_hours, 3));
check('hours split by subject', () => assert.deepStrictEqual(r.hours_by_course.map(h => [h.subject, h.hours]), [['Math', 2], ['history', 1]]));
check('student a attended everything', () => { const a = r.students.find(s => s.student_id === 'a'); assert.strictEqual(a.classes_attended, 3); assert.strictEqual(a.classes_eligible, 3); assert.strictEqual(a.minutes, 180); });
check('10 minutes is not attending', () => assert.strictEqual(r.students.find(s => s.student_id === 'b').classes_attended, 0));
check('c attended once with 50 min', () => { const c = r.students.find(s => s.student_id === 'c'); assert.strictEqual(c.classes_attended, 1); assert.strictEqual(c.minutes, 50); });
check('reached = a and c', () => assert.strictEqual(r.reached, 2));
check('never joined = b and d', () => assert.strictEqual(r.never_joined, 2));
check('a is regular, c is rarely/sometimes (1 of 2)', () => { assert.strictEqual(r.frequency.regular, 1); assert.strictEqual(r.frequency.sometimes, 1); });
check('per-course breakdown for the student table', () => { const a = r.students.find(s => s.student_id === 'a'); assert.deepStrictEqual(a.by_course.c1, { minutes: 120, attended: 2, eligible: 2, held_minutes: 120, missed_in_a_row: 0, last_session_at: at(1440), last_attended: at(1440) }); assert.deepStrictEqual(a.by_course.c2, { minutes: 60, attended: 1, eligible: 1, held_minutes: 60, missed_in_a_row: 0, last_session_at: at(2880), last_attended: at(2880) }); const d = r.students.find(s => s.student_id === 'd'); assert.deepStrictEqual(d.by_course.c1, { minutes: 0, attended: 0, eligible: 2, held_minutes: 120, missed_in_a_row: 2, last_session_at: at(1440), last_attended: null }); });
check('sorted by time spent', () => assert.strictEqual(r.students[0].student_id, 'a'));
check('pace projects a goal date', () => assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.projected_goal_date)));
check('no classes -> empty report', () => { const e = buildLiveReport({ courses, enrollments, students, classes: [], participants: [], now: T0 }); assert.strictEqual(e.live_hours, 0); assert.strictEqual(e.projected_goal_date, null); });
console.log(`${passed} checks passed`);
