const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, isStudent, hasRole } = require('../middleware/auth');
const { awardXp } = require('../utils/xp');
const tg = require('../utils/telegram');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { rateLimit } = require('express-rate-limit');
const { generateToken } = require('../utils/jwt');
const { makeBot, supabaseStore } = require('../utils/telegramFollowUpBot');
const { createNotification } = require('../utils/notifications');
const { LINK_BASE } = require('../utils/followUpMessageService');

// Buttons and replies on the follow-up messages teachers send (see utils/telegramFollowUpBot.js).
const followStore = supabaseStore(supabase, LINK_BASE);
const followBot = makeBot({
  store: followStore, tg,
  notify: (userId, p) => createNotification(userId, 'follow_up_reply', { title: p.title, body: p.body, data: { ...(p.data || {}), priority: p.priority || 'normal' }, push: true }),
});

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


// ---------------------------------------------------------------------------
// Sign in / sign up with Telegram
//
//   POST /api/telegram/login/start  { device }  -> { url, token, expiresAt }
//   POST /api/telegram/login/poll   { token }   -> { status, user?, token? }
//
// The app opens `url` (the bot), the student taps Start and then "Yes, sign me
// in" in Telegram, and the app polls until it can collect a normal login
// token. The confirm step names the device that asked, so a student who was
// sent someone else's link can see it is not their phone and tap No.
// ---------------------------------------------------------------------------
const LOGIN_TTL_MS = 5 * 60 * 1000;
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const loginStartLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, error: 'Too many sign-in attempts. Please try again later.' }
});
const loginPollLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: (req) => sha256(String(req.body?.token || req.ip)).slice(0, 24),
  message: { success: false, error: 'Slow down.' }
});

router.post('/login/start', loginStartLimiter, async (req, res) => {
  try {
    if (!tg.enabled()) {
      return res.status(503).json({ success: false, error: 'Telegram sign-in is not set up yet' });
    }
    const clean = (v) => String(v || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40);
    const device = [clean(req.body?.device?.model), clean(req.body?.device?.platform)].filter(Boolean).join(' · ') || null;

    const ref = crypto.randomBytes(16).toString('base64url');
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + LOGIN_TTL_MS);
    const { error } = await supabase.from('telegram_login_requests').insert({
      ref, token_hash: sha256(token), device_label: device, expires_at: expiresAt.toISOString()
    });
    if (error) throw error;
    // Housekeeping: drop requests that expired a while ago.
    supabase.from('telegram_login_requests').delete().lt('expires_at', new Date(Date.now() - 3600 * 1000).toISOString()).then(() => {}, () => {});

    res.json({
      success: true,
      data: { url: `https://t.me/${tg.botUsername()}?start=login_${ref}`, token, expiresAt: expiresAt.toISOString() }
    });
  } catch (error) {
    console.error('Telegram login start error:', error);
    res.status(500).json({ success: false, error: 'Could not start Telegram sign-in' });
  }
});

/** Find the student behind a Telegram account, or create one. Returns { user, isNew }. */
async function userForTelegram(row) {
  const { data: priv } = await supabase.from('student_private')
    .select('user_id').eq('telegram_user_id', row.telegram_user_id).maybeSingle();
  if (priv?.user_id) {
    const { data: user } = await supabase.from('users').select('*').eq('id', priv.user_id).maybeSingle();
    if (user) return { user, isNew: false };
  }
  const name = [row.telegram_first_name, row.telegram_last_name].filter(Boolean).join(' ').trim()
    || row.telegram_username || 'Student';
  const { data: user, error } = await supabase.from('users').insert({
    id: uuidv4(),
    name: name.slice(0, 100),
    email: null,
    phone: null,
    password: await bcrypt.hash(uuidv4() + uuidv4(), 10),   // nobody knows it; they sign in with Telegram
    role: 'student',
    created_at: new Date()
  }).select().single();
  if (error) throw error;
  const { error: privError } = await supabase.from('student_private').upsert({
    user_id: user.id,
    telegram_chat_id: row.telegram_chat_id,
    telegram_user_id: row.telegram_user_id,
    telegram_username: row.telegram_username,
    telegram_first_name: row.telegram_first_name,
    telegram_linked_at: new Date().toISOString(),
    telegram_blocked_at: null,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (privError) throw privError;
  await awardLinkXpOnce(user.id);
  return { user, isNew: true };
}

router.post('/login/poll', loginPollLimiter, async (req, res) => {
  try {
    const token = String(req.body?.token || '');
    if (!token || token.length > 200) return res.status(400).json({ success: false, error: 'Missing token' });

    const { data: row } = await supabase.from('telegram_login_requests')
      .select('*').eq('token_hash', sha256(token)).maybeSingle();
    if (!row || row.consumed_at || new Date(row.expires_at) <= new Date()) {
      return res.json({ success: true, data: { status: 'expired' } });
    }
    if (row.status === 'denied') return res.json({ success: true, data: { status: 'denied' } });
    if (row.status !== 'approved') return res.json({ success: true, data: { status: row.status } });

    // Collect once: a second poll (or a copy of the token) gets nothing.
    const { data: claimed } = await supabase.from('telegram_login_requests')
      .update({ consumed_at: new Date().toISOString() })
      .eq('ref', row.ref).is('consumed_at', null).select('ref');
    if (!claimed?.length) return res.json({ success: true, data: { status: 'expired' } });

    const { sanitizeUser, accountLoginGate, reactivateIfSelfDeactivated } = require('./auth.routes').helpers;
    const { user, isNew } = await userForTelegram(row);
    if (user.role !== 'student') {
      return res.status(403).json({ success: false, error: 'Telegram sign-in is for student accounts only' });
    }
    const gate = accountLoginGate(user);
    if (gate) return res.status(gate.status).json(gate.body);
    await reactivateIfSelfDeactivated(user);

    res.json({
      success: true,
      data: { status: 'approved', user: sanitizeUser(user), token: generateToken(user.id, user.role), is_new: isNew }
    });
  } catch (error) {
    console.error('Telegram login poll error:', error);
    res.status(500).json({ success: false, error: 'Telegram sign-in failed' });
  }
});

/** /start login_<ref>: ask the person to confirm which device is signing in. */
async function handleLoginStart(msg, ref) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const { data: rows } = await supabase.from('telegram_login_requests')
    .update({
      status: 'awaiting',
      telegram_user_id: from.id,
      telegram_chat_id: chatId,
      telegram_username: from.username || null,
      telegram_first_name: from.first_name || null,
      telegram_last_name: from.last_name || null
    })
    .eq('ref', ref).eq('status', 'pending').is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('device_label');
  if (!rows?.length) {
    return tg.sendPlain(chatId,
      'តំណនេះផុតកំណត់ ឬត្រូវបានប្រើរួចហើយ។ សូមព្យាយាមម្តងទៀតក្នុងកម្មវិធី។\n\nThis sign-in link expired or was already used. Please try again in the app.');
  }
  const device = rows[0].device_label || 'unknown device';
  return tg.sendPlain(chatId,
    `ចូលគណនី Romduol Scholars នៅលើ ${device}?\nចុច «បាទ/ចាស» តែបើអ្នកទើបតែចុចចូលដោយ Telegram នៅលើទូរស័ព្ទរបស់អ្នក។\n\n` +
    `Sign in to Romduol Scholars on ${device}?\nOnly tap “Yes” if you just started this on your own phone.`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ បាទ/ចាស · Yes, sign me in', callback_data: `tl:ok:${ref}` },
      { text: '❌ ទេ · No', callback_data: `tl:no:${ref}` }
    ]] } });
}

async function handleLoginCallback(cb) {
  const [, action, ref] = String(cb.data).split(':');
  const msg = cb.message;
  const ok = action === 'ok';
  const { data: rows } = await supabase.from('telegram_login_requests')
    .update({ status: ok ? 'approved' : 'denied' })
    .eq('ref', ref).eq('status', 'awaiting')
    .eq('telegram_user_id', cb.from?.id)          // only the person who tapped Start can confirm
    .gt('expires_at', new Date().toISOString())
    .select('ref');
  await tg.answerCallback(cb.id);
  if (!msg) return;
  const text = !rows?.length
    ? 'តំណនេះផុតកំណត់។ សូមព្យាយាមម្តងទៀតក្នុងកម្មវិធី។\nThis sign-in expired. Please try again in the app.'
    : ok
      ? '✅ រួចរាល់! សូមត្រឡប់ទៅកម្មវិធី Romduol Scholars។\nDone! Go back to the Romduol Scholars app.'
      : '❌ បានបដិសេធការចូលគណនី។\nSign-in cancelled.';
  return tg.editMessage(msg.chat.id, msg.message_id, text, { reply_markup: { inline_keyboard: [] } });
}

const secretOk = (given) => {
  const want = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

async function handleStart(msg, code) {
  const chatId = msg.chat.id;
  if (!code) return tg.sendMessage(chatId, NO_CODE);
  if (code.startsWith('login_')) return handleLoginStart(msg, code.slice(6));

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
    // Telegram retries an update it thinks we missed: handle each update_id once.
    const updateId = req.body?.update_id;
    if (updateId != null && !(await followStore.claimUpdate(updateId))) return;
    const cb = req.body?.callback_query;
    if (cb && String(cb.data || '').startsWith('tl:')) return await handleLoginCallback(cb);
    if (cb) return await followBot.handleCallback(cb);
    const msg = req.body?.message;
    if (!msg || msg.chat?.type !== 'private') return;
    if (msg.contact) return await handleContact(msg);
    if (typeof msg.text !== 'string') return;
    const [command, arg] = msg.text.trim().split(/\s+/);
    const name = command.split('@')[0].toLowerCase();
    if (name === '/start') await handleStart(msg, arg);
    else if (name === '/stop') await handleStop(msg);
    else if (!msg.text.startsWith('/')) await followBot.handleText(msg.chat.id, msg.text);   // a reply to a follow-up message
  } catch (error) {
    console.error('Telegram webhook error:', error);
  }
});

router.delete('/link', authenticateToken, isStudent, async (req, res) => {
  try {
    // An account made with Telegram has no email, phone or Google: removing Telegram would lock the student out for good.
    const { data: me } = await supabase.from('users').select('email, phone, google_sub').eq('id', req.user.userId).maybeSingle();
    if (me && !me.email && !me.phone && !me.google_sub) {
      return res.status(409).json({
        success: false,
        code: 'TELEGRAM_IS_ONLY_LOGIN',
        error: 'Telegram is how you sign in to this account. Add an email or phone number first, then you can remove it.'
      });
    }
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


/**
 * A teacher saves (or clears) the Telegram @username they found for one of their students.
 *   PUT /api/telegram/students/:id/contact  { username: "@name" | "name" | "https://t.me/name" | "" }
 * Empty clears it. The student's own bot link and privacy choice are never changed; if the student
 * chose "nobody" the save is refused, because the teacher could not open it anyway.
 */
router.put('/students/:id/contact', authenticateToken, hasRole('teacher', 'admin', 'super_admin'), async (req, res) => {
  try {
    const studentId = req.params.id;
    if (req.user.role === 'teacher') {
      const { data: courses } = await supabase.from('courses').select('id').eq('teacher_id', req.user.userId);
      const ids = (courses || []).map(c => c.id);
      const { data: enrolled } = ids.length
        ? await supabase.from('course_enrollments').select('student_id').eq('student_id', studentId).in('course_id', ids).limit(1)
        : { data: [] };
      if (!enrolled || enrolled.length === 0) return res.status(403).json({ success: false, error: 'This student is not in one of your classes' });
    }
    const { data: user } = await supabase.from('users').select('id, role').eq('id', studentId).maybeSingle();
    if (!user || user.role !== 'student') return res.status(404).json({ success: false, error: 'Student not found' });

    const raw = String(req.body.username ?? '').trim();
    const username = raw ? cleanHandle(raw, raw) : null;
    if (raw && !username) return res.status(400).json({ success: false, error: 'That is not a Telegram username. Use @name or a t.me link (5–32 letters, numbers or _).' });

    const { data: cur } = await supabase.from('student_private').select('telegram_visibility, telegram_chat_id').eq('user_id', studentId).maybeSingle();
    if (username && cur && cur.telegram_visibility === 'nobody') return res.status(409).json({ success: false, error: 'This student chose not to share Telegram with teachers.' });
    const now = new Date().toISOString();
    const { error } = cur
      ? await supabase.from('student_private').update({ telegram_username: username, updated_at: now }).eq('user_id', studentId)
      : (username ? await supabase.from('student_private').insert({ user_id: studentId, telegram_username: username }) : { error: null });
    if (error) throw error;
    try { require('./followUp.routes').clearCache(); } catch { /* list cache only */ }
    res.json({ success: true, data: { username } });
  } catch (error) {
    console.error('Telegram contact save error:', error);
    res.status(500).json({ success: false, error: 'Could not save the Telegram contact' });
  }
});

/**
 * Import a teacher's Telegram sheet (admin / super_admin).
 *   POST /api/telegram/import/preview  { rows: [{ name, full_name, handle, link }] } -> matches to review
 *   POST /api/telegram/import/apply    { items: [{ student_id, username, overwrite? }] } -> saves them
 * Only the Telegram @username is written; the student's own bot link and privacy setting are untouched
 * (a new row keeps the default "teachers can see it").
 */
const { buildPreview, USERNAME_RE, cleanHandle } = require('../utils/telegramImport');

router.post('/import/preview', authenticateToken, hasRole('admin', 'super_admin'), async (req, res) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 2000) : null;
    if (!rows) return res.status(400).json({ success: false, error: 'rows is required' });
    const { data: users, error } = await supabase.from('users').select('id, name, phone').eq('role', 'student').limit(5000);
    if (error) throw error;
    const ids = (users || []).map(u => u.id);
    const current = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase.from('student_private').select('user_id, telegram_username').in('user_id', ids.slice(i, i + 200));
      (data || []).forEach(r => current.set(r.user_id, r.telegram_username));
    }
    const students = (users || []).map(u => ({ ...u, telegram_username: current.get(u.id) || null }));
    res.json({ success: true, data: buildPreview(rows, students) });
  } catch (e) {
    console.error('Telegram import preview error:', e);
    res.status(500).json({ success: false, error: 'Could not read the sheet' });
  }
});

router.post('/import/apply', authenticateToken, hasRole('admin', 'super_admin'), async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 2000) : null;
    if (!items) return res.status(400).json({ success: false, error: 'items is required' });
    let saved = 0, skipped = 0;
    const problems = [];
    for (const it of items) {
      const username = String(it.username || '').replace(/^@/, '');
      if (!it.student_id || !USERNAME_RE.test(username)) { skipped += 1; problems.push(`${it.student_id || '?'}: bad username`); continue; }
      const { data: user } = await supabase.from('users').select('id, role').eq('id', it.student_id).maybeSingle();
      if (!user || user.role !== 'student') { skipped += 1; problems.push(`${it.student_id}: not a student`); continue; }
      const { data: cur } = await supabase.from('student_private').select('telegram_username').eq('user_id', it.student_id).maybeSingle();
      if (cur?.telegram_username && cur.telegram_username.toLowerCase() !== username.toLowerCase() && !it.overwrite) { skipped += 1; problems.push(`${it.student_id}: already has @${cur.telegram_username}`); continue; }
      const { error } = cur
        ? await supabase.from('student_private').update({ telegram_username: username, updated_at: new Date().toISOString() }).eq('user_id', it.student_id)
        : await supabase.from('student_private').insert({ user_id: it.student_id, telegram_username: username });
      if (error) { skipped += 1; problems.push(`${it.student_id}: ${error.message}`); } else saved += 1;
    }
    res.json({ success: true, data: { saved, skipped, problems: problems.slice(0, 20) } });
  } catch (e) {
    console.error('Telegram import apply error:', e);
    res.status(500).json({ success: false, error: 'Could not save the usernames' });
  }
});

module.exports = router;
