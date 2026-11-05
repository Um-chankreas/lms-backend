// Thin Telegram Bot API client + the reminder copy. The bot token only ever
// lives in this server's environment.
const supabase = require('../config/supabase');

const API = 'https://api.telegram.org';
// Telegram's broadcast limit is ~30 messages/second overall; stay well under it.
const SEND_GAP_MS = 45;

const enabled = () => !!process.env.TELEGRAM_BOT_TOKEN;
const botUsername = () => process.env.TELEGRAM_BOT_USERNAME || 'RomduolScholarsBot';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** POST to a Bot API method. Resolves to { ok, ...payload } and never throws. */
async function call(method, body) {
  if (!enabled()) return { ok: false, error_code: 0, description: 'TELEGRAM_BOT_TOKEN not set' };
  try {
    const res = await fetch(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error_code: 0, description: e.message };
  }
}

const sendMessage = (chatId, text, extra = {}) =>
  call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "15:30" in Cambodia (24-hour), whatever timezone this server runs in. */
function phnomPenhTime(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Phnom_Penh', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

/** Link the "Join class" button opens. Telegram buttons need http(s), so this goes through /open/live-class/:id. */
const joinUrl = (liveClassId) =>
  `${(process.env.PUBLIC_API_URL || 'https://api.romduolscholars.com').replace(/\/$/, '')}/open/live-class/${liveClassId}`;

const JOIN_LABEL = 'ចូលរៀន / Join class';

/**
 * Send a reminder to many students, one at a time (rate limit). `buildMessage`
 * returns { text, button?: { text, url } } for a recipient row.
 * A 403 (student blocked the bot) flags the row; a 429 waits as told and retries once.
 * Returns the user ids that were actually delivered.
 */
async function sendToStudents(recipients, buildMessage) {
  const delivered = [];
  for (const r of recipients) {
    const msg = buildMessage(r);
    const extra = msg.button ? { reply_markup: { inline_keyboard: [[{ text: msg.button.text, url: msg.button.url }]] } } : {};
    let result = await sendMessage(r.telegram_chat_id, msg.text, extra);
    if (!result.ok && result.error_code === 429) {
      await sleep(((result.parameters?.retry_after) || 1) * 1000 + 100);
      result = await sendMessage(r.telegram_chat_id, msg.text, extra);
    }
    if (result.ok) {
      delivered.push(r.user_id);
    } else if (result.error_code === 403) {
      await supabase.from('student_private')
        .update({ telegram_blocked_at: new Date().toISOString() }).eq('user_id', r.user_id);
    } else {
      console.warn('[telegram] send failed:', result.error_code, result.description);
    }
    await sleep(SEND_GAP_MS);
  }
  return delivered;
}

/** Students (of the given ids) who can be messaged: linked, reminders on, bot not blocked. */
async function reachableStudents(userIds) {
  if (!enabled() || !userIds || userIds.length === 0) return [];
  const { data, error } = await supabase
    .from('student_private')
    .select('user_id, telegram_chat_id')
    .in('user_id', userIds)
    .not('telegram_chat_id', 'is', null)
    .eq('telegram_reminders', true)
    .is('telegram_blocked_at', null);
  if (error) return [];   // migration 064 not run yet
  return data || [];
}

module.exports = {
  enabled, botUsername, call, sendMessage, sendToStudents, reachableStudents,
  escapeHtml, phnomPenhTime, joinUrl, JOIN_LABEL
};
