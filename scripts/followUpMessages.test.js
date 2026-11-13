const assert = require('assert');
const seed = require('../seed/follow-up-templates.json');
const M = require('../src/utils/followUpMessages');
let n = 0; const ok = (_, f) => { f(); n += 1; };
const U = (c) => `00000000-0000-4000-8000-00000000000${c}`;
const BASE = 'https://api.example.com';

// A template object the way the backend assembles it from the seed file.
const tpl = (key) => seed.templates.find(t => t.key === key);
const VARS = { name: 'Dara', teacher: 'Sophea', subject: 'Math', attended: 3, held: 8, next_class: 'Wed 6pm', lesson: 'Limits', minutes: 10, chapter: 4, step: 'x', done: 2, lessons: 5, teacher_phone: '012345678',
  first_lesson_id: U(1), next_lesson_id: U(2), lesson_id: U(3), subject_id: U(4), chapter_id: U(5), quiz_id: U(6), step_key: 'quiz' };

ok('every template renders in both languages with all variables', () => {
  for (const t of seed.templates) for (const lang of ['km', 'en']) {
    const r = M.renderTemplate(t, VARS, lang, { linkBase: BASE });
    assert.equal(r.error, null, `${t.key}/${lang}: ${r.error}`);
    assert.ok(r.text && !/\{\w+\}/.test(r.text), `${t.key}/${lang} left a placeholder`);
    r.buttons.forEach(b => { assert.ok(b.callback || b.url.startsWith('https://'), `${t.key} button not https`); assert.ok(!/\{\w+\}/.test(b.label)); });
  }
});

ok('a missing variable blocks sending and names it; 0 counts as a value', () => {
  const r = M.renderTemplate(tpl('welcome'), { ...VARS, next_class: undefined }, 'en');
  assert.equal(r.text, null); assert.deepEqual(r.missing, ['next_class']); assert.match(r.error, /\{next_class\}/); assert.match(r.draft, /\{next_class\}/);
  assert.equal(M.renderTemplate(tpl('praise_week'), { ...VARS, attended: 0, lessons: 0 }, 'en').error, null);
  const two = M.renderTemplate(tpl('no_study'), { ...VARS, lesson: '', minutes: null }, 'km');
  assert.deepEqual(two.missing.sort(), ['lesson', 'minutes']);
});

ok('skip_subject: attended 0 swaps line 2', () => {
  const en = M.renderTemplate(tpl('skip_subject'), { ...VARS, attended: 0 }, 'en');
  assert.equal(en.text.split('\n')[1], "You haven't joined a Math live class yet.");
  assert.ok(!en.text.includes('joined 0 of'));
  const km = M.renderTemplate(tpl('skip_subject'), { ...VARS, attended: 0 }, 'km');
  assert.ok(km.text.split('\n')[1].includes('មិនទាន់បានចូលរៀនថ្នាក់ផ្ទាល់ Math'));
  assert.ok(M.renderTemplate(tpl('skip_subject'), VARS, 'en').text.includes('joined 3 of 8 Math'));
});

ok('step_reminder fills {step} and the button from the steps map', () => {
  const r = M.renderTemplate(tpl('step_reminder'), { ...VARS, step_key: 'quiz', done: 2 }, 'en', { linkBase: BASE });
  assert.ok(r.text.includes('Next step: do your first quiz.'));
  assert.equal(r.buttons[0].label, 'do your first quiz');
  const live = M.renderTemplate(tpl('step_reminder'), { ...VARS, step_key: 'lesson' }, 'en', { linkBase: BASE });
  assert.equal(live.buttons[0].url, `${BASE}/open/lesson/${U(1)}`);   // lesson:first -> the first lesson's link
});

ok('language: per-language values and class time text', () => {
  const r = M.renderTemplate(tpl('welcome'), { ...VARS, subject: { km: 'គណិតវិទ្យា', en: 'Math' } }, 'km');
  assert.ok(r.text.includes('គណិតវិទ្យា'));
  const wed6 = Date.parse('2026-11-11T11:00:00Z');   // 18:00 Cambodia, a Wednesday
  assert.equal(M.formatClassTime(wed6, 'en'), 'Wed 6pm');
  assert.equal(M.formatClassTime(wed6, 'km'), 'ថ្ងៃពុធ ម៉ោង ៦ល្ងាច');
  assert.equal(M.formatClassTime(Date.parse('2026-11-11T11:30:00Z'), 'en'), 'Wed 6:30pm');
});

ok('links are https; unknown targets open the app; callbacks stay callbacks', () => {
  assert.equal(M.targetToLink('lesson:' + U(3), {}, BASE), `${BASE}/open/lesson/${U(3)}`);
  assert.equal(M.targetToLink('quiz:first', {}, BASE), `${BASE}/open/app`);
  assert.equal(M.targetToLink('lesson:{lesson_id}', {}, BASE), `${BASE}/open/app`);   // unresolved id -> app
  assert.equal(M.targetToLink('live:next', { live_class_id: U(7) }, BASE), `${BASE}/open/live-class/${U(7)}`);
  assert.ok(!M.targetToLink('progress', {}, BASE).startsWith('learnquest'));
  const r = M.renderTemplate(tpl('slow'), VARS, 'en', { linkBase: BASE });
  assert.equal(r.buttons[2].callback, 'help');
});

ok('callback_data: format, 64-byte limit, parsing', () => {
  const id = U(9);
  assert.equal(M.callbackData('r', id, 'time_clash'), `r:time_clash:${id}`);
  for (const r of M.REASONS) assert.ok(Buffer.byteLength(M.callbackData('r', id, r)) <= 64, r);
  assert.throws(() => M.callbackData('r', 'x'.repeat(60), 'time_clash'));
  assert.deepEqual(M.parseCallback(`r:sick:${id}`), { kind: 'r', reason: 'sick', id });
  assert.deepEqual(M.parseCallback(`help:${id}`), { kind: 'help', id });
  assert.equal(M.parseCallback('r:bogus:' + id), null); assert.equal(M.parseCallback('help:nope'), null); assert.equal(M.parseCallback(''), null);
});

ok('keyboard: reasons in 2 columns after the template buttons', () => {
  const labels = Object.fromEntries(seed.reasons.map(r => [r.reason, r.button]));
  const kb = M.buildKeyboard({ buttons: [{ label: 'Start', url: BASE + '/open/app' }], asksReason: true, reasonLabels: labels, lang: 'en', messageId: U(9) });
  assert.equal(kb.length, 1 + 4); assert.equal(kb[1].length, 2); assert.equal(kb[4].length, 1);
  assert.equal(kb[1][0].callback_data, `r:time_clash:${U(9)}`);
  assert.equal(kb[1][0].text, 'Time clash');
});

// Sending window, Cambodia time. 2026-11-11 is a Wednesday, 2026-11-14 a Saturday.
const at = (day, hm) => Date.parse(`2026-11-${day}T${hm}:00+07:00`);
ok('sending window edges', () => {
  assert.equal(M.sendWindow(at('11', '16:59')).open, false);
  assert.equal(M.sendWindow(at('11', '16:59')).at, at('11', '17:00'));
  assert.equal(M.sendWindow(at('11', '17:00')).open, true);
  assert.equal(M.sendWindow(at('11', '19:59')).open, true);
  assert.equal(M.sendWindow(at('11', '20:00')).open, false);
  assert.equal(M.sendWindow(at('11', '20:00')).at, at('12', '17:00'));   // Thursday 17:00
  assert.equal(M.sendWindow(at('11', '09:00')).open, false);             // weekday morning
  assert.equal(M.sendWindow(at('14', '08:00')).open, true);              // Saturday opens at 08:00
  assert.equal(M.sendWindow(at('14', '07:59')).open, false);
  assert.equal(M.sendWindow(at('14', '12:00')).open, true);
  assert.equal(M.sendWindow(at('14', '20:00')).at, at('15', '08:00'));   // Sat night -> Sunday 08:00
  assert.equal(M.sendWindow(at('15', '20:30')).at, at('16', '17:00'));   // Sun night -> Monday 17:00
});

ok('limits: daily, same case, unanswered, praise', () => {
  const now = at('11', '18:00');
  const msg = (daysAgo, o = {}) => ({ case_code: '1', status: 'sent', created_at: new Date(now - daysAgo * 86400000).toISOString(), ...o });
  const codes = (w) => w.map(x => x.code);
  assert.deepEqual(codes(M.checkRules({ now, caseCode: '1', history: [] })), []);
  assert.ok(codes(M.checkRules({ now, caseCode: '2', history: [msg(0.01)] })).includes('daily'));
  assert.ok(!codes(M.checkRules({ now, caseCode: '2', history: [msg(1)] })).includes('daily'));
  assert.ok(codes(M.checkRules({ now, caseCode: '1', history: [msg(2.9)] })).includes('same_case'));
  assert.ok(!codes(M.checkRules({ now, caseCode: '1', history: [msg(3.1)] })).includes('same_case'));
  assert.ok(codes(M.checkRules({ now, caseCode: '2', history: [msg(5), msg(9)] })).includes('unanswered'));
  assert.ok(!codes(M.checkRules({ now, caseCode: '2', history: [msg(5, { replied_at: 'x' }), msg(9)] })).includes('unanswered'));
  assert.ok(!codes(M.checkRules({ now, caseCode: '1', history: [msg(1, { status: 'failed' }), msg(2, { status: 'blocked' })] })).includes('daily'));
  assert.ok(codes(M.checkRules({ now, caseCode: 'praise', history: [msg(5, { case_code: 'praise' })] })).includes('praise_week'));
  assert.ok(!codes(M.checkRules({ now, caseCode: 'praise', history: [msg(8, { case_code: 'praise' })] })).includes('praise_week'));
  assert.ok(codes(M.checkRules({ now: at('11', '10:00'), caseCode: '1', history: [] })).includes('outside_hours'));
});

ok('word count and the 60-word guide', () => {
  assert.equal(M.wordCount('one two three', 'en'), 3);
  assert.ok(M.wordCount(seed.templates[0].body.km, 'km') > 10);
  const words = seed.templates.map(t => [t.key, M.wordCount(t.body.en, 'en')]);
  assert.ok(words.every(([, w]) => w < 70), JSON.stringify(words));
});
console.log(`followUpMessages: ${n} groups passed`);
