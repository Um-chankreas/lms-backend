const assert = require('assert');
const { makeBot } = require('../src/utils/telegramFollowUpBot');
const { callbackData } = require('../src/utils/followUpMessages');
let n = 0; const ok = async (_, f) => { await f(); n += 1; };
const MSG = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const TEACHER = '33333333-3333-4333-8333-333333333333';
const COURSE = '44444444-4444-4444-8444-444444444444';

function world(over = {}) {
  const w = { seen: new Set(), followUps: [], inbox: [], chosen: [], replied: [], sent: [], edited: [], answered: [], notes: [],
    msg: { id: MSG, chat_id: 555, student_id: STUDENT, sent_by: TEACHER, subject_id: COURSE, case_code: '1', lang: 'en', body_sent: 'Hi Dara', chosen_reason: null, buttons: { items: [{ label: 'Please call me', callback: 'call_me' }], vars: { chapter_id: '55555555-5555-4555-8555-555555555555' } }, ...over } };
  w.store = {
    linkBase: () => 'https://api.example.com',
    claimUpdate: async (id) => { if (w.seen.has(id)) return false; w.seen.add(id); return true; },
    getMessage: async (id) => (id === MSG ? w.msg : null),
    markChosen: async (id, v) => { w.chosen.push(v); w.msg.chosen_reason = v; },
    markReplied: async (id) => { w.replied.push(id); },
    insertFollowUp: async (r) => { w.followUps.push(r); },
    insertInbox: async (r) => { w.inbox.push(r); },
    reasons: async () => ({ time_clash: { label: { km: 'ម៉ោងរៀនជាន់គ្នា', en: 'Time clash' }, reply: { km: 'x', en: 'Thanks. Recording for {subject}.' }, reply_links: ['recording:last:{subject_id}', 'live:schedule:{subject_id}'] } }),
    callbackReplies: async () => ({ call_me: { km: 'k', en: '{teacher} will call you soon.' }, help: { km: 'h', en: 'help' } }),
    teacher: async () => ({ id: TEACHER, name: 'Sophea' }), courseTitle: async () => 'Math',
    studentByChat: async (c) => (c === 555 ? { id: STUDENT, name: 'Dara' } : null),
    lastMessageToChat: async () => ({ id: MSG, sent_by: TEACHER }),
  };
  w.tg = {
    answerCallback: async (id) => { w.answered.push(id); },
    editMessage: async (chat, mid, text, extra) => { w.edited.push({ chat, mid, text, extra }); },
    sendPlain: async (chat, text, extra) => { w.sent.push({ chat, text, extra }); return { ok: true }; },
  };
  w.bot = makeBot({ store: w.store, tg: w.tg, notify: async (uid, p) => { w.notes.push({ uid, ...p }); } });
  return w;
}
const tapUpdate = (data, id = 1) => ({ update_id: id, callback_query: { id: 'cb' + id, data, message: { message_id: 77, chat: { id: 555 } } } });

(async () => {
  await ok('a retried update_id is handled once', async () => {
    const w = world();
    const u = tapUpdate(callbackData('r', MSG, 'time_clash'), 10);
    assert.equal(await w.bot.handleUpdate(u), 'reason');
    assert.equal(await w.bot.handleUpdate(u), 'duplicate');
    assert.equal(w.followUps.length, 1); assert.equal(w.sent.length, 1);
  });

  await ok('a reason tap writes follow-up, edits the message, replies with links and notifies the teacher', async () => {
    const w = world();
    await w.bot.handleUpdate(tapUpdate(callbackData('r', MSG, 'time_clash')));
    assert.equal(w.answered.length, 1);
    const f = w.followUps[0];
    assert.equal(f.source, 'student_button'); assert.equal(f.reason, 'time_clash'); assert.equal(f.case_code, '1');
    assert.equal(f.course_id, COURSE); assert.equal(f.telegram_message_id, MSG); assert.equal(f.student_id, STUDENT);
    assert.deepEqual(w.edited[0].extra, { reply_markup: { inline_keyboard: [] } });
    assert.equal(w.edited[0].text, 'Hi Dara\n\n✓ Time clash');
    assert.equal(w.sent[0].text, 'Thanks. Recording for Math.');
    const btns = w.sent[0].extra.reply_markup.inline_keyboard;
    assert.equal(btns.length, 2); assert.ok(btns.every(r => r[0].url.startsWith('https://')));
    assert.equal(w.notes[0].uid, TEACHER); assert.equal(w.chosen[0], 'time_clash');
  });

  await ok('a second tap on the same message does nothing', async () => {
    const w = world();
    await w.bot.handleUpdate(tapUpdate(callbackData('r', MSG, 'time_clash'), 1));
    assert.equal(await w.bot.handleUpdate(tapUpdate(callbackData('r', MSG, 'sick'), 2)), 'already_answered');
    assert.equal(w.followUps.length, 1);
  });

  await ok('a tap from another chat or with bad data is ignored', async () => {
    const w = world();
    const other = tapUpdate(callbackData('r', MSG, 'time_clash'), 3); other.callback_query.message.chat.id = 999;
    assert.equal(await w.bot.handleUpdate(other), 'unknown_message');
    assert.equal(await w.bot.handleUpdate(tapUpdate('garbage', 4)), 'ignored');
    assert.equal(w.followUps.length, 0);
  });

  await ok('call_me notifies the teacher with high priority', async () => {
    const w = world();
    assert.equal(await w.bot.handleUpdate(tapUpdate(callbackData('call_me', MSG), 5)), 'call_me');
    assert.equal(w.sent[0].text, 'Sophea will call you soon.');
    assert.equal(w.notes[0].priority, 'high'); assert.equal(w.followUps[0].text, 'Student asked to be called');
    assert.equal(w.edited[0].text, 'Hi Dara\n\n✓ Please call me');
  });

  await ok('free text goes to the inbox, marks the last message replied and notifies', async () => {
    const w = world();
    assert.equal(await w.bot.handleUpdate({ update_id: 6, message: { chat: { id: 555, type: 'private' }, text: ' My phone broke ' } }), 'inbox');
    assert.deepEqual(w.inbox[0], { student_id: STUDENT, message_id: MSG, text: 'My phone broke' });
    assert.deepEqual(w.replied, [MSG]); assert.equal(w.notes[0].uid, TEACHER);
    assert.equal(await w.bot.handleUpdate({ update_id: 7, message: { chat: { id: 555, type: 'private' }, text: '/stop' } }), 'ignored');   // commands stay with the old handler
    assert.equal(await w.bot.handleUpdate({ update_id: 8, message: { chat: { id: 1, type: 'private' }, text: 'hi' } }), 'ignored');         // not a linked student
  });
  console.log(`telegramFollowUpBot: ${n} groups passed`);
})().catch(e => { console.error(e); process.exit(1); });
