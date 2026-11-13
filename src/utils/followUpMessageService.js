const supabase = require('../config/supabase');
const tg = require('./telegram');
const { courseProgress, fetchAllRows, toMs } = require('./studentProgress');
const M = require('./followUpMessages');

// Database side of the Telegram follow-up messages: templates, the variables for one student, the send queue.
// Rendering and the rules are pure and live in followUpMessages.js.

const LINK_BASE = () => (process.env.PUBLIC_API_URL || 'https://api.romduolscholars.com').replace(/\/$/, '');
const SUGGESTED = { minutes: 10 };      // shown in the composer as an estimate the teacher can change

// ── Templates ───────────────────────────────────────────────────────────────
/** key -> template object the renderer takes, assembled from the two per-language rows. */
async function loadTemplates({ onlyActive = true } = {}) {
  const { data, error } = await supabase.from('message_templates').select('*');
  if (error) throw error;
  const map = new Map();
  for (const r of data || []) {
    if (onlyActive && !r.active) continue;
    const t = map.get(r.key) || { key: r.key, audience: r.audience, case_code: r.case_code, asks_reason: r.asks_reason, copy_only: r.copy_only, body: {}, buttons: [], version: 0, rows: {} };
    t.body[r.lang] = r.body;
    t.rows[r.lang] = r;
    t.version = Math.max(t.version, r.version);
    // Buttons are stored once per language row; labels carry both languages, so either row can supply them.
    if (!t.buttons.length || r.lang === 'km') t.buttons = r.buttons || [];
    if (r.extra?.variant_if_attended_zero) t.variant_if_attended_zero = r.extra.variant_if_attended_zero;
    if (r.extra?.steps) t.steps = r.extra.steps;
    map.set(r.key, t);
  }
  return map;
}

async function loadReasons(db = supabase) {
  const { data, error } = await db.from('message_reasons').select('*');
  if (error) throw error;
  const out = {};
  (data || []).forEach(r => { out[r.reason] = { label: { km: r.label_km, en: r.label_en }, reply: { km: r.reply_km, en: r.reply_en }, reply_links: r.reply_links || [] }; });
  return out;
}

/** Which template fits this student right now. `caseCode` can force a case (the card the teacher clicked). */
function defaultTemplateKey(entry, caseCode) {
  const c = caseCode || (entry.is_new ? (entry.new_case ? '0' : 'new') : entry.main ? entry.main.code : entry.doing_well ? 'praise' : null);
  if (c === 'praise') return entry.is_new && entry.steps_done === 6 ? 'praise_first_week' : 'praise_week';
  if (c === 'new') return entry.contact && entry.contact.count ? 'step_reminder' : 'welcome';
  return { '0': 'not_started', '1': 'skip_subject', '2': 'no_study', '3': 'slow', '4': 'missing_all' }[c] || 'welcome';
}

// ── Variables for one student ───────────────────────────────────────────────
const STEP_KEYS = { tour: 'tour', first_lesson: 'lesson', first_quiz: 'quiz', first_live: 'live', back_days: 'back' };   // our steps -> the template's steps map

/** Real next class: a scheduled live class first, then the weekly schedule. -> { ms, live_class_id } | null */
async function nextClass(courseId, now = Date.now()) {
  if (!courseId) return null;
  const { data: lc } = await supabase.from('live_classes').select('id, scheduled_at').eq('course_id', courseId).eq('status', 'scheduled')
    .gt('scheduled_at', new Date(now).toISOString()).order('scheduled_at', { ascending: true }).limit(1);
  if (lc && lc[0]) return { ms: toMs(lc[0].scheduled_at), live_class_id: lc[0].id };
  const { data: sc } = await supabase.from('class_schedules').select('days_of_week, start_time').eq('course_id', courseId).eq('is_active', true);
  let best = null;
  for (const s of sc || []) {
    for (let d = 0; d < 8; d += 1) {
      const day = new Date(now + 7 * 3600000 + d * 86400000);
      if (!(s.days_of_week || []).includes(day.getUTCDay())) continue;
      const [h, m] = String(s.start_time).split(':').map(Number);
      const ms = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h || 0, m || 0) - 7 * 3600000;
      if (ms > now && (best == null || ms < best)) best = ms;
    }
  }
  return best == null ? null : { ms: best, live_class_id: null };
}

/**
 * Everything the placeholders need for one student (and one subject), in the student's language.
 * -> { lang, vars, suggested: [keys], student: {...}, teacher: {...}, course_id }
 */
async function buildVars({ studentId, courseId, teacherId, stepKey, entry, now = Date.now() }) {
  const [{ data: stu }, { data: priv }, { data: teacher }] = await Promise.all([
    supabase.from('users').select('id, name, language').eq('id', studentId).maybeSingle(),
    supabase.from('student_private').select('telegram_chat_id, telegram_blocked_at').eq('user_id', studentId).maybeSingle(),
    supabase.from('users').select('id, name, phone').eq('id', teacherId).maybeSingle(),
  ]);
  const lang = stu && stu.language === 'en' ? 'en' : 'km';
  const vars = { name: stu && stu.name, teacher: teacher && teacher.name, teacher_phone: teacher && teacher.phone };
  const suggested = [];

  if (courseId) {
    const [{ data: course }, { data: metric }, cls, prog] = await Promise.all([
      supabase.from('courses').select('id, title').eq('id', courseId).maybeSingle(),
      supabase.from('student_subject_metrics').select('classes_joined, classes_held').eq('student_id', studentId).eq('course_id', courseId).maybeSingle(),
      nextClass(courseId, now),
      courseProgress({ courseIds: [courseId], studentIds: [studentId] }),
    ]);
    vars.subject = course && course.title; vars.subject_id = courseId;
    if (metric) { vars.attended = metric.classes_joined; vars.held = metric.classes_held; }
    if (cls) { vars.next_class = M.formatClassTime(cls.ms, lang); if (cls.live_class_id) vars.live_class_id = cls.live_class_id; }
    const p = prog.get(studentId, courseId);
    if (p) {
      if (p.path && p.path[0]) vars.first_lesson_id = p.path[0].lesson_id;
      if (p.current) {
        vars.lesson = p.current.lesson_title; vars.next_lesson_id = p.current.lesson_id; vars.lesson_id = p.current.lesson_id;
        vars.chapter = p.current.lesson_index; vars.chapter_id = p.current.lesson_id;
      }
    }
  }
  // Lessons finished in the last 7 days (the weekly praise).
  const since = new Date(now - 7 * 86400000).toISOString();
  const { count } = await supabase.from('lesson_completions').select('id', { count: 'exact', head: true }).eq('student_id', studentId).gte('completed_at', since);
  vars.lessons = count || 0;

  if (entry && entry.steps) {
    vars.done = entry.steps_done;
    const late = entry.steps.find(s => s.state === 'late' && STEP_KEYS[s.key]) || entry.steps.find(s => s.state !== 'done' && STEP_KEYS[s.key]);
    vars.step_key = stepKey || (late && STEP_KEYS[late.key]);
  }
  Object.entries(SUGGESTED).forEach(([k, v]) => { if (M.isBlank(vars[k])) { vars[k] = v; suggested.push(k); } });
  return {
    lang, vars, suggested, course_id: courseId || null,
    student: { id: studentId, name: stu && stu.name, chat_id: priv && priv.telegram_chat_id ? Number(priv.telegram_chat_id) : null, blocked: !!(priv && priv.telegram_blocked_at) },
    teacher: teacher || null,
  };
}

async function loadHistory(studentId, limit = 20) {
  const { data } = await supabase.from('follow_up_messages')
    .select('id, template_key, case_code, subject_id, lang, status, error, scheduled_for, sent_at, replied_at, chosen_reason, created_at, sent_by, body_sent')
    .eq('student_id', studentId).order('created_at', { ascending: false }).limit(limit);
  return data || [];
}

// ── Sending ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let working = false;

/** Queue one message. `at` is when it may go out (inside the sending window). -> the follow_up_messages row. */
async function queueMessage({ studentId, chatId, template, lang, caseCode, subjectId, body, rendered, sentBy, override, at, vars = {} }) {
  const row = {
    student_id: studentId, template_key: template.key, template_version: template.version, case_code: caseCode || template.case_code,
    subject_id: subjectId || null, lang, chat_id: chatId, body_sent: body, sent_by: sentBy, status: 'queued',
    buttons: { items: rendered.buttons, asks_reason: !!template.asks_reason, vars: { chapter_id: vars.chapter_id, lesson_id: vars.lesson_id, first_lesson_id: vars.first_lesson_id, next_lesson_id: vars.next_lesson_id, live_class_id: vars.live_class_id } },
    override_reason: override ? 'limit_override' : null, scheduled_for: new Date(at).toISOString(),
  };
  const { data, error } = await supabase.from('follow_up_messages').insert(row).select('*').single();
  if (error) throw error;
  return data;
}

/** Send one queued row now. Marks it sent / failed / blocked and writes the follow-up log entry. */
async function sendRow(row, deps = {}) {
  const db = deps.supabase || supabase;
  const bot = deps.tg || tg;
  const reasons = row.buttons && row.buttons.asks_reason ? await loadReasons(db) : {};
  const reasonLabels = Object.fromEntries(Object.entries(reasons).filter(([k]) => M.REASONS.includes(k)).map(([k, v]) => [k, v.label]));
  const keyboard = M.buildKeyboard({ buttons: (row.buttons && row.buttons.items) || [], asksReason: !!(row.buttons && row.buttons.asks_reason), reasonLabels, lang: row.lang, messageId: row.id });
  const extra = keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
  let res = await bot.sendPlain(row.chat_id, row.body_sent, extra);
  if (!res.ok && res.error_code === 429) { await sleep(((res.parameters && res.parameters.retry_after) || 1) * 1000 + 100); res = await bot.sendPlain(row.chat_id, row.body_sent, extra); }
  const now = new Date().toISOString();
  if (res.ok) {
    await db.from('follow_up_messages').update({ status: 'sent', sent_at: now, telegram_message_id: res.result.message_id, error: null }).eq('id', row.id);
    const { data: sender } = await db.from('users').select('name').eq('id', row.sent_by).maybeSingle();
    await db.from('student_followups').insert({
      student_id: row.student_id, author_id: row.sent_by, author_name: sender && sender.name, contacted_by: row.sent_by, kind: row.case_code === 'praise' ? 'praise' : 'message',
      text: row.body_sent.slice(0, 1000), case_code: row.case_code, channel: 'telegram', course_id: row.subject_id, source: 'teacher', telegram_message_id: row.id,
    });
    return { status: 'sent' };
  }
  if (res.error_code === 403) {
    await db.from('follow_up_messages').update({ status: 'blocked', error: res.description || 'blocked' }).eq('id', row.id);
    await db.from('student_private').update({ telegram_blocked_at: now }).eq('user_id', row.student_id);
    return { status: 'blocked' };
  }
  await db.from('follow_up_messages').update({ status: 'failed', error: (res.description || 'send failed').slice(0, 300) }).eq('id', row.id);
  return { status: 'failed', error: res.description };
}

/** Send every queued message that is due, one at a time (about 1 per second per chat, well under 25/s overall). */
async function processQueue() {
  if (working || !tg.enabled()) return 0;
  working = true;
  let sent = 0;
  try {
    const { data } = await supabase.from('follow_up_messages').select('*').eq('status', 'queued').lte('scheduled_for', new Date().toISOString()).order('scheduled_for', { ascending: true }).limit(25);
    for (const row of data || []) {
      const w = M.sendWindow(Date.now());
      if (!w.open) { await supabase.from('follow_up_messages').update({ scheduled_for: new Date(w.at).toISOString() }).eq('id', row.id); continue; }
      const r = await sendRow(row);
      if (r.status === 'sent') sent += 1;
      await sleep(1000);
    }
  } catch (e) { console.warn('[follow-up messages] queue failed:', e.message); } finally { working = false; }
  return sent;
}

function startMessageQueue() {
  setInterval(() => { processQueue(); }, 30 * 1000).unref();
}

module.exports = { loadTemplates, loadReasons, defaultTemplateKey, buildVars, loadHistory, queueMessage, sendRow, processQueue, startMessageQueue, nextClass, LINK_BASE, STEP_KEYS };
