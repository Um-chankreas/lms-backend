const assert = require('assert');
const { buildEntry, summarize, page } = require('../src/utils/followUpModel');
const NOW = Date.parse('2026-11-12T05:00:00Z'); const D = 86400000;
const sub = (t, held, joined, x = {}) => ({ course_id: t, title: t, m: { classes_held: held, classes_joined: joined, studied_after_ratio: joined ? 0.9 : null, progress_pct: 50, class_pace_pct: 50, days_since_new_lesson: 1, ...x } });
const mk = (name, subjects, o = {}) => buildEntry({ student: { id: name, name, phone: o.phone === undefined ? '012345678' : o.phone, created_at: new Date(NOW - 90 * D).toISOString() }, subjects, onboarding: null, logs: o.logs || [], activeDays: o.active ?? 5 }, NOW);
let n = 0; const ok = (_, f) => { f(); n += 1; };

const a = mk('Ann', [sub('Math', 8, 0), sub('Khmer', 8, 8)]);
const b = mk('Bo', [sub('Math', 8, 0), sub('Khmer', 8, 1)]);
const c = mk('Cy', [sub('Math', 8, 8), sub('Khmer', 8, 8)]);
const d = mk('Di', [sub('Math', 8, 8, { studied_after_ratio: 0.1 })]);
const all = [a, b, c, d];

ok('students with no phone and no Telegram go to their own block', () => {
  const u = mk('Ung', [sub('Math', 8, 0)], { phone: null });
  assert.equal(u.unreachable, true); assert.equal(u.needs, false);
  const s = summarize([...all, u]);
  assert.equal(s.tabs.unreachable, 1); assert.equal(s.tabs.needs, 3); assert.equal(s.cases['4'], 1);
  assert.deepEqual(page([...all, u], { tab: 'unreachable' }).rows.map(r => r.name), ['Ung']);
  assert.equal(a.unreachable, false);
});

ok('tabs and case counts', () => {
  const s = summarize(all);
  assert.deepEqual(s.cases, { '4': 1, '1': 1, '2': 1, '3': 0 });
  assert.equal(s.tabs.needs, 3); assert.equal(s.tabs.doing_well, 1); assert.equal(s.tabs.all, 4);
});

ok('most urgent first, case card filter, subject-scoped filter', () => {
  assert.deepEqual(page(all, { tab: 'needs' }).rows.map(r => r.name), ['Bo', 'Ann', 'Di']);
  assert.deepEqual(page(all, { tab: 'needs', filters: { case: '1' } }).rows.map(r => r.name), ['Ann']);
  assert.deepEqual(page(all, { tab: 'all', filters: { attendance: 'never' } }).rows.map(r => r.name), ['Bo', 'Ann']);
  assert.deepEqual(page(all, { tab: 'all', filters: { subject: 'Khmer', attendance: 'never' } }).rows.map(r => r.name), []);
});

ok('saving a follow-up moves them to Followed up; a worse case brings them back', () => {
  const log = { kind: 'done', case_code: '1', reason: 'time_clash', created_at: new Date(NOW - 1 * D).toISOString() };
  const f = mk('Ann', [sub('Math', 8, 0), sub('Khmer', 8, 8)], { logs: [log] });
  assert.equal(f.followed, true); assert.equal(f.needs, false); assert.equal(f.contact.count, 1); assert.equal(f.contact.last_reason, 'time_clash');
  assert.equal(f.next_action, 'view');
  const worse = mk('Ann', [sub('Math', 8, 0), sub('Khmer', 8, 0)], { logs: [log] });   // now case 4
  assert.equal(worse.followed, false); assert.equal(worse.needs, true);
  const old = mk('Ann', [sub('Math', 8, 0), sub('Khmer', 8, 8)], { logs: [{ ...log, created_at: new Date(NOW - 8 * D).toISOString() }] });
  assert.equal(old.needs, true);   // back after 7 days
});

ok('pagination', () => {
  const many = Array.from({ length: 60 }, (_, i) => mk('S' + String(i).padStart(2, '0'), [sub('Math', 8, 0)]));
  const p = page(many, { pageNo: 4 });
  assert.equal(p.total, 60); assert.equal(p.pages, 4); assert.equal(p.size, 15); assert.equal(p.rows.length, 15);
  assert.equal(page(many, { pageNo: 9 }).page, 4);   // past the end clamps to the last page
});

ok('new student: next action and tab', () => {
  const e = buildEntry({ student: { id: 'x', name: 'X', created_at: new Date(NOW - 3 * D).toISOString() }, subjects: [sub('Math', 2, 0)], onboarding: { joined_at: new Date(NOW - 3 * D).toISOString(), live_held_since_join: 0, active_days_count: 1 }, logs: [], activeDays: 1 }, NOW);
  assert.equal(e.is_new, true); assert.equal(e.needs, false); assert.equal(e.next_action, 'check_in'); assert.equal(summarize([e]).tabs.new, 1);
  const ok1 = buildEntry({ student: { id: 'y', name: 'Y', created_at: new Date(NOW - 1 * D).toISOString() }, subjects: [], onboarding: { joined_at: new Date(NOW - 1 * D).toISOString(), tour_done_at: 'x' }, logs: [], activeDays: 1 }, NOW);
  assert.equal(ok1.next_action, 'send_welcome');
});
console.log(`followUpModel: ${n} groups passed`);
