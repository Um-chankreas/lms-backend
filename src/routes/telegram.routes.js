const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, isStudent, hasRole } = require('../middleware/auth');
const { awardXp } = require('../utils/xp');
const tg = require('../utils/telegram');

/**
 * Telegram reminders. See sql/064_telegram.sql for what is stored and why it is private.
 *
 *   POST   /api/telegram/link-code            (student)  -> { url, expiresAt }
 *   POST   /api/telegram/webhook              (Telegram)
 *   DELETE /api/telegram/link                 (student)
 *   GET    /api/telegram/students/:id/contact (teacher)  -> { username } only if the student allows it
 *
 * The student's own settings (reminders, who can see it, school, province) are
 * read and written through GET/PUT /api/profile/private.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const LINK_XP = 20;
// Telegram allows A-Z a-z 0-9 _ - in a start parameter, up to 64 characters.
const newCode = () => crypto.randomBytes(24).toString('base64url');

const WELCOME =
  'សូមស្វាគមន៍! Telegram របស់អ្នកត្រូវបានភ្ជាប់ជាមួយ Romduol Scholars ហើយ។ យើងនឹងរំលឹកអ្នកមុនម៉ោងរៀនផ្ទាល់។\n' +
  'វាយ /stop ដើម្បីបិទការរំលឹក។\n\n' +
  "Welcome! Your Telegram is now connected to Romduol Scholars. We'll remind you before live classes.\n" +
  'Send /stop to turn reminders off.';
const NO_CODE =
  'សូមបើកកម្មវិធី Romduol Scholars → ប្រវត្តិរូប → កែប្រវត្តិរូប → ភ្ជាប់ Telegram រួចចុចតំណដែលបានផ្តល់។\n\n' +
  'Open the Romduol Scholars app → Profile → Edit profile → Connect Telegram, then tap the link it gives you.';
const BAD_CODE =
  'តំណនេះផុតកំណត់ ឬត្រូវបានប្រើរួចហើយ។ សូមចុច «ភ្ជាប់ Telegram» ក្នុងកម្មវិធីម្តងទៀត។\n\n' +
  'This link has expired or was already used. Tap “Connect Telegram” in the app again.';
const SHARE_LABEL = '📱 ចែករំលែកលេខទូរស័ព្ទ / Share my phone number';
const SHARE_HINT =
  '\n\nបើចង់ ចុចប៊ូតុងខាងក្រោមដើម្បីចែករំលែកលេខទូរស័ព្ទរបស់អ្នក (មិនបង្ខំ)។ មានតែគ្រូរបស់អ្នកទេដែលអាចឃើញ។\n' +
  'Optional: tap the button below to share your phone number. Only your teachers can see it.';
const SHARE_THANKS =
  'អរគុណ! បានទទួលលេខទូរស័ព្ទរបស់អ្នកហើយ។\n\nThank you! We saved your phone number.';
const SHARE_OWN_ONLY =
  'សូមចុចប៊ូតុងដើម្បីចែករំលែកលេខទូរស័ព្ទផ្ទាល់ខ្លួនរបស់អ្នក។\n\nPlease use the button to share your own phone number.';
const STOPPED =
  'បានបិទការរំលឹក។ អ្នកអាចបើកវាវិញបានក្នុងកម្មវិធី។\n\nReminders are off. You can turn them back on in the app.';
const NOT_LINKED =
  'គណនីនេះមិនទាន់ភ្ជាប់ជាមួយ Romduol Scholars ទេ។\n\nThis Telegram isn’t connected to a Romduol Scholars account yet.';

/** Called once per link: +20 XP the first time only (the flag survives unlink/relink). */
async function awardLinkXpOnce(userId) {
  const { data } = await supabase
    .from('student_private')
    .update({ telegram_xp_awarded: true })
    .eq('user_id', userId)
    .eq('telegram_xp_awarded', false)
    .select('user_id');
  if (data && data.length > 0) await awardXp(userId, LINK_XP, 'telegram_connected');
}

router.post('/link-code', authenticateToken, isStudent, async (req, res) => {
  try {
    if (!tg.enabled()) {
      return res.status(503).json({ success: false, error: 'Telegram reminders are not set up yet' });
    }
    const userId = req.user.userId;
    await supabase.from('telegram_link_codes').delete().eq('user_id', userId).is('used_at', null);

    const code = newCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    const { error } = await supabase.from('telegram_link_codes')
      .insert({ code, user_id: userId, expires_at: expiresAt.toISOString() });
    if (error) throw error;

    res.json({
      success: true,
      data: { url: `https://t.me/${tg.botUsername()}?start=${code}`, expiresAt: expiresAt.toISOString() }
    });
  } catch (error) {
    console.error('Telegram link-code error:', error);
    res.status(500).json({ success: false, error: 'Could not create a Telegram link' });
  }
});

const secretOk = (given) => {
  const want = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

async function handleStart(msg, code) {
  const chatId = msg.chat.id;
  if (!code) return tg.sendMessage(chatId, NO_CODE);

  // Claim the code atomically so a double tap can't link twice.
  const { data: claimed } = await supabase
    .from('telegram_link_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('code', code)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('user_id');
  const userId = claimed?.[0]?.user_id;
  if (!userId) return tg.sendMessage(chatId, BAD_CODE);

  const from = msg.from || {};
  // The same Telegram account can belong to one student only: unlink it from anyone else.
  await supabase.from('student_private')
    .update({
      telegram_chat_id: null, telegram_user_id: null, telegram_username: null,
      telegram_first_name: null, telegram_linked_at: null, telegram_blocked_at: null, telegram_phone: null
    })
    .eq('telegram_user_id', from.id)
    .neq('user_id', userId);

  const { error } = await supabase.from('student_private').upsert({
    user_id: userId,
    telegram_chat_id: chatId,
    telegram_user_id: from.id,
    telegram_username: from.username || null,
    telegram_first_name: from.first_name || null,
    telegram_linked_at: new Date().toISOString(),
    telegram_blocked_at: null,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) {
    console.error('Telegram link upsert failed:', error.message);
    return tg.sendMessage(chatId, BAD_CODE);
  }
  await awardLinkXpOnce(userId);
  // A one-tap, optional "share my number" button: Telegram only hands a bot a phone number the user sends.
  return tg.sendMessage(chatId, WELCOME + SHARE_HINT, {
    reply_markup: { keyboard: [[{ text: SHARE_LABEL, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
  });
}

/** The student tapped "Share my phone number". Only their own contact counts. */
async function handleContact(msg) {
  const chatId = msg.chat.id;
  const contact = msg.contact;
  if (!contact?.phone_number || contact.user_id !== msg.from?.id) return tg.sendMessage(chatId, SHARE_OWN_ONLY);
  const phone = String(contact.phone_number).startsWith('+') ? contact.phone_number : `+${contact.phone_number}`;
  const { data } = await supabase.from('student_private')
    .update({ telegram_phone: phone, updated_at: new Date().toISOString() })
    .eq('telegram_chat_id', chatId)
    .eq('telegram_user_id', msg.from.id)
    .select('user_id');
  if (!data || data.length === 0) return tg.sendMessage(chatId, NOT_LINKED);
  return tg.sendMessage(chatId, SHARE_THANKS, { reply_markup: { remove_keyboard: true } });
}

async function handleStop(msg) {
  const { data } = await supabase.from('student_private')
    .update({ telegram_reminders: false, updated_at: new Date().toISOString() })
    .eq('telegram_chat_id', msg.chat.id)
    .select('user_id');
  return tg.sendMessage(msg.chat.id, data && data.length > 0 ? STOPPED : NOT_LINKED);
}

router.post('/webhook', async (req, res) => {
  if (!secretOk(req.get('X-Telegram-Bot-Api-Secret-Token'))) return res.sendStatus(401);
  res.sendStatus(200);   // answer Telegram first; the work below can take a moment
  try {
    const msg = req.body?.message;
    if (!msg || msg.chat?.type !== 'private') return;
    if (msg.contact) return await handleContact(msg);
    if (typeof msg.text !== 'string') return;
    const [command, arg] = msg.text.trim().split(/\s+/);
    const name = command.split('@')[0].toLowerCase();
    if (name === '/start') await handleStart(msg, arg);
    else if (name === '/stop') await handleStop(msg);
  } catch (error) {
    console.error('Telegram webhook error:', error);
  }
});

router.delete('/link', authenticateToken, isStudent, async (req, res) => {
  try {
    const { error } = await supabase.from('student_private')
      .update({
        telegram_chat_id: null, telegram_user_id: null, telegram_username: null,
        telegram_first_name: null, telegram_linked_at: null, telegram_blocked_at: null, telegram_phone: null,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', req.user.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Telegram unlink error:', error);
    res.status(500).json({ success: false, error: 'Could not remove Telegram' });
  }
});

/** A teacher may see a student's Telegram username only if they teach a course the student is in AND the student allows it. */
router.get('/students/:id/contact', authenticateToken, hasRole('teacher', 'admin', 'super_admin'), async (req, res) => {
  try {
    const studentId = req.params.id;
    if (req.user.role === 'teacher') {
      const { data: courses } = await supabase.from('courses').select('id').eq('teacher_id', req.user.userId);
      const ids = (courses || []).map(c => c.id);
      const { data: enrolled } = ids.length
        ? await supabase.from('course_enrollments').select('student_id').eq('student_id', studentId).in('course_id', ids).limit(1)
        : { data: [] };
      if (!enrolled || enrolled.length === 0) {
        return res.status(403).json({ success: false, error: 'This student is not in one of your classes' });
      }
    }
    const { data: row } = await supabase.from('student_private')
      .select('telegram_username, telegram_phone, telegram_visibility, telegram_chat_id')
      .eq('user_id', studentId).maybeSingle();
    // A contact counts when the student linked the bot OR a username/phone was saved for them by hand.
    const visible = row && (row.telegram_chat_id || row.telegram_username || row.telegram_phone) && ['teachers', 'friends'].includes(row.telegram_visibility);
    res.json({ success: true, data: { username: visible ? row.telegram_username : null, phone: visible ? row.telegram_phone : null } });
  } catch (error) {
    console.error('Telegram contact error:', error);
    res.status(500).json({ success: false, error: 'Could not load contact' });
  }
});

module.exports = router;
