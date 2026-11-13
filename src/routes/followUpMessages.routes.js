const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const followUp = require('./followUp.routes');
const M = require('../utils/followUpMessages');
const S = require('../utils/followUpMessageService');

// Telegram follow-up messages: the composer, sending, the inbox of student replies, and the admin template editor.
//   GET  /composer?student_id=&case=&course_id=&lang=     the default template + variables + warnings for one student
//   POST /preview   { student_id, template_key, lang, course_id, vars, body }
//   POST /send      { ...same, override }                  sends now, or queues for the sending window
//   GET  /inbox, GET /inbox/unread-count, POST /inbox/student/:id/read
//   GET/PUT /templates, PUT /reasons/:reason               admins only

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT_CODES = ['daily', 'same_case', 'unanswered', 'praise_week'];

router.use(authenticateToken, (req, res, next) => {
  const role = req.account?.role || req.user?.role;
  if (!['admin', 'super_admin', 'teacher'].includes(role)) return res.status(403).json({ success: false, error: 'This action requires admin or teacher privileges' });
  req.staffRole = role === 'super_admin' ? 'admin' : role;
  next();
});
const adminOnly = (req, res, next) => (req.staffRole === 'admin' ? next() : res.status(403).json({ success: false, error: 'Admins only' }));

const cleanVars = (v) => {
  const out = {};
  Object.entries(v && typeof v === 'object' ? v : {}).forEach(([k, val]) => {
    if (/^\w{1,40}$/.test(k) && (typeof val === 'string' || typeof val === 'number')) out[k] = String(val).trim().slice(0, 200);
  });
  return out;
};
const unresolved = (text) => [...new Set([...String(text).matchAll(M.PLACEHOLDER)].map(m => m[1]))];

async function entryFor(req, studentId) {
  if (!UUID.test(String(studentId || ''))) return null;
  const model = await followUp.loadEntries(req, false);
  return model.entries.find(e => e.student_id === studentId) || null;
}

/** Everything the composer shows for one student + template. */
async function compose(req, { entry, key, lang, caseCode, courseId, overrides, body }) {
  const now = Date.now();
  const templates = await S.loadTemplates();
  const template = templates.get(key || S.defaultTemplateKey(entry, caseCode));
  if (!template) { const err = new Error('Template not found'); err.status = 404; throw err; }
  const focus = (entry.cases.find(c => c.code === caseCode) || entry.main || {}).course_id;
  const course = courseId || focus || (entry.subjects[0] && entry.subjects[0].course_id) || null;
  const ctx = await S.buildVars({ studentId: entry.student_id, courseId: course, teacherId: req.user.userId, entry });
  const L = lang === 'en' || lang === 'km' ? lang : ctx.lang;
  const vars = { ...ctx.vars, ...cleanVars(overrides) };
  const rendered = M.renderTemplate(template, vars, L, { linkBase: S.LINK_BASE() });
  const edited = typeof body === 'string' && body.trim() ? body : null;
  const text = edited || rendered.text;
  const missing = edited ? unresolved(edited) : rendered.missing;
  const history = await S.loadHistory(entry.student_id);
  const warnings = M.checkRules({ now, caseCode: template.case_code, history }).map(w => ({ ...w }));
  if (template.copy_only) warnings.push({ code: 'copy_only' });
  if (!ctx.student.chat_id) warnings.push({ code: 'no_telegram' });
  else if (ctx.student.blocked) warnings.push({ code: 'blocked' });
  if (text && M.wordCount(text, L) > M.RULES.max_words) warnings.push({ code: 'long', params: { words: M.wordCount(text, L), max: M.RULES.max_words } });
  const w = M.sendWindow(now);
  return { template, ctx, lang: L, vars, rendered, text, draft: edited || rendered.draft, missing, warnings, window: { open: w.open, at: new Date(w.at).toISOString() }, now, course };
}

const publicTemplate = (t) => ({ key: t.key, case_code: t.case_code, audience: t.audience, asks_reason: t.asks_reason, copy_only: t.copy_only, version: t.version, buttons: t.buttons });

router.get('/composer', async (req, res) => {
  try {
    const entry = await entryFor(req, req.query.student_id);
    if (!entry) return res.status(404).json({ success: false, error: 'Student not found' });
    const caseCode = req.query.case ? String(req.query.case) : null;
    const key = S.defaultTemplateKey(entry, caseCode);
    const c = await compose(req, { entry, key, lang: req.query.lang, caseCode, courseId: UUID.test(req.query.course_id || '') ? req.query.course_id : null });
    const all = [...(await S.loadTemplates()).values()].map(publicTemplate);
    const history = await S.loadHistory(entry.student_id, 10);
    res.json({ success: true, data: {
      template_key: key, templates: all, lang: c.lang, student_lang: c.ctx.lang, vars: c.vars, suggested: c.ctx.suggested, course_id: c.course,
      text: c.text, draft: c.draft, buttons: c.rendered.buttons, missing: c.missing, error: c.rendered.error, warnings: c.warnings, window: c.window,
      reachable: !!c.ctx.student.chat_id && !c.ctx.student.blocked, blocked: c.ctx.student.blocked, asks_reason: c.template.asks_reason, copy_only: c.template.copy_only,
      history, rules: M.RULES,
    } });
  } catch (e) {
    console.error('Composer error:', e);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

router.post('/preview', async (req, res) => {
  try {
    const b = req.body || {};
    const entry = await entryFor(req, b.student_id);
    if (!entry) return res.status(404).json({ success: false, error: 'Student not found' });
    const c = await compose(req, { entry, key: b.template_key, lang: b.lang, caseCode: b.case_code, courseId: UUID.test(b.course_id || '') ? b.course_id : null, overrides: b.vars, body: b.body });
    res.json({ success: true, data: { template_key: c.template.key, lang: c.lang, vars: c.vars, suggested: c.ctx.suggested, text: c.text, draft: c.draft, buttons: c.rendered.buttons, missing: c.missing, error: c.rendered.error, warnings: c.warnings, window: c.window, asks_reason: c.template.asks_reason, copy_only: c.template.copy_only } });
  } catch (e) {
    console.error('Preview error:', e);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

router.post('/send', async (req, res) => {
  try {
    const b = req.body || {};
    const entry = await entryFor(req, b.student_id);
    if (!entry) return res.status(404).json({ success: false, error: 'Student not found' });
    const c = await compose(req, { entry, key: b.template_key, lang: b.lang, caseCode: b.case_code, courseId: UUID.test(b.course_id || '') ? b.course_id : null, overrides: b.vars, body: b.body });
    if (c.template.copy_only) return res.status(400).json({ success: false, error: 'This message is copy-only. It is never sent through the bot.', code: 'copy_only' });
    if (!c.ctx.student.chat_id || c.ctx.student.blocked) return res.status(409).json({ success: false, error: 'This student cannot be reached on the bot. Copy the message instead.', code: c.ctx.student.blocked ? 'blocked' : 'no_telegram' });
    if (!c.text || c.missing.length) return res.status(400).json({ success: false, error: c.missing.length ? `Missing ${c.missing.map(k => `{${k}}`).join(', ')}` : 'The message is empty', code: 'missing', missing: c.missing });
    const limits = c.warnings.filter(w => LIMIT_CODES.includes(w.code));
    if (limits.length && !b.override) return res.status(409).json({ success: false, error: 'This message goes past a sending limit.', code: 'needs_override', warnings: limits });

    // Sends straight away by default. Outside the usual hours that is only a warning; `schedule: 'later'` queues it for the next window instead.
    const w = M.sendWindow(c.now);
    const later = b.schedule === 'later' && !w.open;
    const row = await S.queueMessage({
      studentId: entry.student_id, chatId: c.ctx.student.chat_id, template: c.template, lang: c.lang, caseCode: c.template.case_code, subjectId: c.course,
      body: c.text, rendered: c.rendered, sentBy: req.user.userId, override: limits.length > 0, at: later ? w.at : c.now, vars: c.vars,
    });
    const result = later ? { status: 'queued' } : await S.sendRow(row);
    followUp.clearCache();
    if (result.status === 'blocked') return res.status(409).json({ success: false, error: 'The student has blocked the bot.', code: 'blocked', data: { message_id: row.id } });
    if (result.status === 'failed') return res.status(502).json({ success: false, error: result.error || 'Telegram could not send it.', code: 'failed', data: { message_id: row.id } });
    res.status(201).json({ success: true, data: { message_id: row.id, status: result.status, scheduled_for: row.scheduled_for, queued: later } });
  } catch (e) {
    console.error('Send error:', e);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// ── Inbox ───────────────────────────────────────────────────────────────────
async function visibleStudentIds(req) {
  if (req.staffRole === 'admin') return null;     // everyone
  const model = await followUp.loadEntries(req, false);
  return new Set(model.entries.map(e => e.student_id));
}
async function inboxRows(req, { unreadOnly, limit = 60 }) {
  let q = supabase.from('telegram_inbox').select('id, student_id, message_id, text, received_at, read_at').order('received_at', { ascending: false }).limit(200);
  if (unreadOnly) q = q.is('read_at', null);
  const { data, error } = await q;
  if (error) throw error;
  const allowed = await visibleStudentIds(req);
  const rows = (data || []).filter(r => !allowed || allowed.has(r.student_id)).slice(0, limit);
  return rows;
}
router.get('/inbox/unread-count', async (req, res) => {
  try { res.json({ success: true, data: { unread: (await inboxRows(req, { unreadOnly: true, limit: 200 })).length } }); }
  catch (e) { res.json({ success: true, data: { unread: 0 } }); }   // migration 073 not run yet: no badge
});
router.get('/inbox', async (req, res) => {
  try {
    const rows = await inboxRows(req, { unreadOnly: req.query.unread === '1' });
    const ids = [...new Set(rows.map(r => r.student_id))];
    const { data: users } = ids.length ? await supabase.from('users').select('id, name, avatar_url').in('id', ids) : { data: [] };
    const by = new Map((users || []).map(u => [u.id, u]));
    res.json({ success: true, data: { items: rows.map(r => ({ ...r, name: by.get(r.student_id)?.name || '', avatar_url: by.get(r.student_id)?.avatar_url || null })), unread: rows.filter(r => !r.read_at).length } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/inbox/student/:studentId/read', async (req, res) => {
  try {
    if (!UUID.test(req.params.studentId)) return res.status(404).json({ success: false, error: 'Student not found' });
    const allowed = await visibleStudentIds(req);
    if (allowed && !allowed.has(req.params.studentId)) return res.status(404).json({ success: false, error: 'Student not found' });
    await supabase.from('telegram_inbox').update({ read_by: req.user.userId, read_at: new Date().toISOString() }).eq('student_id', req.params.studentId).is('read_at', null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Template editor (admins) ────────────────────────────────────────────────
router.get('/templates', adminOnly, async (req, res) => {
  try {
    const [rows, reasons] = await Promise.all([supabase.from('message_templates').select('*').order('key'), supabase.from('message_reasons').select('*').order('reason')]);
    if (rows.error) throw rows.error;
    const byKey = new Map();
    (rows.data || []).forEach(r => { const t = byKey.get(r.key) || { key: r.key, case_code: r.case_code, audience: r.audience, asks_reason: r.asks_reason, copy_only: r.copy_only, active: r.active, version: r.version, buttons: r.buttons, extra: r.extra, body: {}, updated_at: r.updated_at, edited: r.edited }; t.body[r.lang] = r.body; t.version = Math.max(t.version, r.version); byKey.set(r.key, t); });
    res.json({ success: true, data: { templates: [...byKey.values()], reasons: reasons.data || [], max_words: M.RULES.max_words } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.put('/templates/:key', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const { data: rows } = await supabase.from('message_templates').select('*').eq('key', req.params.key);
    if (!rows || !rows.length) return res.status(404).json({ success: false, error: 'Template not found' });
    const now = new Date().toISOString();
    for (const r of rows) {
      const body = b.body && typeof b.body[r.lang] === 'string' ? b.body[r.lang].trim() : null;
      if (body === '') return res.status(400).json({ success: false, error: 'The message cannot be empty' });
      const patch = { version: r.version + 1, edited: true, updated_by: req.user.userId, updated_at: now };
      if (body) patch.body = body.slice(0, 2000);
      if (typeof b.active === 'boolean') patch.active = b.active;
      const { error } = await supabase.from('message_templates').update(patch).eq('key', r.key).eq('lang', r.lang);
      if (error) throw error;
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.put('/reasons/:reason', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = { edited: true, updated_by: req.user.userId, updated_at: new Date().toISOString() };
    ['label_km', 'label_en', 'reply_km', 'reply_en'].forEach(k => { if (typeof b[k] === 'string') patch[k] = b[k].trim().slice(0, 1000); });
    const { error } = await supabase.from('message_reasons').update(patch).eq('reason', req.params.reason);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
