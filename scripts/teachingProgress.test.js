const assert = require('assert');
const { summarize } = require('../src/utils/teachingProgress');

const L = (id, order, title = id, created_at = '2026-01-01') => ({ id, title, order_number: order, created_at });

// empty class
let s = summarize([], []);
assert.strictEqual(s.total, 0); assert.strictEqual(s.pace_pct, null); assert.strictEqual(s.next_lesson_id, null);

// nothing taught yet: next = first lesson
s = summarize([L('b', 2), L('a', 1), L('c', 3)], []);
assert.deepStrictEqual(s.lessons.map(l => l.id), ['a', 'b', 'c']);
assert.strictEqual(s.taught_count, 0); assert.strictEqual(s.pace_pct, 0); assert.strictEqual(s.next_lesson_id, 'a');

// 2 of 4 taught (out of order): next = first NOT taught in lesson order
s = summarize([L('a', 1), L('b', 2), L('c', 3), L('d', 4)], [
  { lesson_id: 'a', taught_on: '2026-11-01' }, { lesson_id: 'c', taught_on: '2026-11-08' },
]);
assert.strictEqual(s.taught_count, 2); assert.strictEqual(s.pace_pct, 50);
assert.strictEqual(s.next_lesson_id, 'b'); assert.strictEqual(s.last_taught_on, '2026-11-08');

// all taught
s = summarize([L('a', 1)], [{ lesson_id: 'a', taught_on: '2026-11-02', live_class_id: 'x' }]);
assert.strictEqual(s.pace_pct, 100); assert.strictEqual(s.next_lesson_id, null); assert.strictEqual(s.lessons[0].live_class_id, 'x');

// courses whose lessons all share order_number 0 fall back to creation date, then title
s = summarize([L('z', 0, 'Zed', '2026-02-01'), L('y', 0, 'Why', '2026-01-01'), L('x', 0, 'Ex', '2026-01-01')], []);
assert.deepStrictEqual(s.lessons.map(l => l.id), ['x', 'y', 'z']);

// a taught row for a deleted lesson is ignored
s = summarize([L('a', 1)], [{ lesson_id: 'gone', taught_on: '2026-11-02' }]);
assert.strictEqual(s.taught_count, 0);

console.log('teachingProgress: all checks passed');
