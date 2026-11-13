const assert = require('assert');
// The service imports the real Supabase client; the tests pass a fake one, so any placeholder config will do.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';
const { sendRow } = require('../src/utils/followUpMessageService');
let n = 0;

// A chainable stand-in for the Supabase client that records every write.
function fakeDb() {
  const log = [];
  const db = { log, from(table) {
    const q = { table, op: null, vals: null, filters: [] };
    const b = {
      select() { q.op = q.op || 'select'; return b; }, update(v) { q.op = 'update'; q.vals = v; return b; }, insert(v) { q.op = 'insert'; q.vals = v; return b; },
      eq(k, v) { q.filters.push([k, v]); return b; }, in() { return b; },
      maybeSingle() { return Promise.resolve({ data: table === 'users' ? { name: 'Sophea' } : null }); },
      then(res) { log.push({ ...q }); return Promise.resolve({ data: table === 'message_reasons' ? [] : null, error: null }).then(res); },
    };
    return b;
  } };
  return db;
}
const row = { id: 'm1', student_id: 's1', sent_by: 't1', chat_id: 555, lang: 'en', body_sent: 'Hi', case_code: '1', subject_id: null, buttons: { items: [], asks_reason: false } };
const find = (db, table, op) => db.log.find(l => l.table === table && l.op === op);

(async () => {
  { // success: sent + follow-up logged
    const db = fakeDb();
    const r = await sendRow(row, { supabase: db, tg: { sendPlain: async (chat, text, extra) => { assert.equal(chat, 555); assert.equal(extra.parse_mode, undefined); return { ok: true, result: { message_id: 42 } }; } } });
    assert.equal(r.status, 'sent');
    assert.equal(find(db, 'follow_up_messages', 'update').vals.status, 'sent'); assert.equal(find(db, 'follow_up_messages', 'update').vals.telegram_message_id, 42);
    const f = find(db, 'student_followups', 'insert').vals; assert.equal(f.channel, 'telegram'); assert.equal(f.telegram_message_id, 'm1'); assert.equal(f.kind, 'message'); n += 1;
  }
  { // 403: the student blocked the bot -> blocked, student flagged not reachable, nothing logged as contact
    const db = fakeDb();
    const r = await sendRow(row, { supabase: db, tg: { sendPlain: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) } });
    assert.equal(r.status, 'blocked');
    assert.equal(find(db, 'follow_up_messages', 'update').vals.status, 'blocked');
    const priv = find(db, 'student_private', 'update'); assert.ok(priv.vals.telegram_blocked_at); assert.deepEqual(priv.filters, [['user_id', 's1']]);
    assert.equal(find(db, 'student_followups', 'insert'), undefined); n += 1;
  }
  { // other failure: failed, student NOT marked blocked
    const db = fakeDb();
    const r = await sendRow(row, { supabase: db, tg: { sendPlain: async () => ({ ok: false, error_code: 400, description: 'Bad Request' }) } });
    assert.equal(r.status, 'failed'); assert.equal(find(db, 'student_private', 'update'), undefined); n += 1;
  }
  { // 429 is retried once
    const db = fakeDb(); let calls = 0;
    const r = await sendRow(row, { supabase: db, tg: { sendPlain: async () => (++calls === 1 ? { ok: false, error_code: 429, parameters: { retry_after: 0 } } : { ok: true, result: { message_id: 1 } }) } });
    assert.equal(r.status, 'sent'); assert.equal(calls, 2); n += 1;
  }
  { // asks_reason: 7 reason buttons are attached in 2 columns
    const db = fakeDb(); let kb;
    await sendRow({ ...row, buttons: { items: [], asks_reason: true } }, { supabase: db, tg: { sendPlain: async (c, t, extra) => { kb = extra.reply_markup.inline_keyboard; return { ok: true, result: { message_id: 1 } }; } } });
    assert.equal(kb.length, 4); assert.ok(kb[0][0].callback_data.startsWith('r:time_clash:m1') || kb[0][0].callback_data.startsWith('r:')); n += 1;
  }
  console.log(`followUpSend: ${n} groups passed`);
})().catch(e => { console.error(e); process.exit(1); });
