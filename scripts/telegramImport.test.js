const assert = require('assert');
const { cleanHandle, buildPreview } = require('../src/utils/telegramImport');

assert.strictEqual(cleanHandle('@Monykanhaa'), 'Monykanhaa');
assert.strictEqual(cleanHandle('sornaliza'), 'sornaliza');
assert.strictEqual(cleanHandle("Don't have username telegram"), null);
assert.strictEqual(cleanHandle('@King spaidermen'), null);          // spaces are not allowed
assert.strictEqual(cleanHandle('@'), null);
assert.strictEqual(cleanHandle('@ab'), null);                       // too short
assert.strictEqual(cleanHandle('', 'https://t.me/Panhareachme'), 'Panhareachme');
assert.strictEqual(cleanHandle('@Ry Sreynan', 'https://t.me/real_name'), 'real_name');

const students = [
  { id: '1', name: 'Sok Dina', phone: null },
  { id: '2', name: 'សន អេលីហ្សា', phone: null, telegram_username: 'old_one' },
  { id: '3', name: 'Y Sonakun', phone: '+85585683886' },
  { id: '4', name: 'Twin One' }, { id: '5', name: 'Twin One' },
];
const rows = [
  { name: 'Sok Dina', full_name: 'សុខ ឌីណា', handle: '@sokdinaa' },                  // exact (display name)
  { name: 'Sorn aliza', full_name: 'សន​ អេលីហ្សា', handle: 'sornaliza' },        // exact (Khmer, zero-width ignored)
  { name: 'Sonakun', full_name: '', handle: '', link: 'https://t.me/Ysonakun' },       // suggested (shares "sonakun")
  { name: 'Twin One', full_name: '', handle: '@twin_one' },                            // ambiguous
  { name: 'Nobody Here', full_name: '', handle: '@nobody_here' },                      // unmatched
  { name: 'X', full_name: '', handle: "Don't have username" },                         // unusable
  { name: 'Y', full_name: '', handle: '' },                                            // empty
];
const p = buildPreview(rows, students);
assert.deepStrictEqual(p.exact.map((x) => [x.student.id, x.handle]), [['1', 'sokdinaa'], ['2', 'sornaliza']]);
assert.strictEqual(p.exact[1].student.current, 'old_one');
assert.deepStrictEqual(p.suggested.map((x) => [x.handle, x.candidates[0].id]), [['Ysonakun', '3']]);
assert.strictEqual(p.ambiguous.length, 1);
assert.strictEqual(p.ambiguous[0].candidates.length, 2);
assert.strictEqual(p.unmatched.length, 1);
assert.strictEqual(p.unusable.length, 1);
assert.strictEqual(p.empty, 1);
console.log('telegramImport: all checks passed');
