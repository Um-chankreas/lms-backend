const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const { fetchAllRows, fetchAllIn } = require('../utils/studentProgress');
const cfg = require('../utils/followUpConfig');
const { buildEntry, summarize, page } = require('../utils/followUpModel');

// The Students -> Follow-up page. Rules and numbers come from utils/followUpRules.js and the hourly
// student_subject_metrics / student_onboarding tables (utils/followUpMetricsJob.js).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = ['time_clash', 'not_interested', 'no_internet_device', 'too_hard', 'family_work', 'sick', 'other', 'checked_in'];
const CHANNELS = ['telegram', 'call', 'sms'];
const KINDS = ['done', 'message', 'praise', 'note'];
const CASES = ['0', '1', '2', '3', '4', 'praise'];
const DAY = 86400000;

router.use(authenticateToken, (req, res, next) => {
  const role = req.account?.role || req.user?.role;
  if (!['admin', 'super_admin', 'teacher'].includes(role)) return res.status(403).json({ success: false, error: 'This action requires admin or teacher privileges' });
  req.staffRole = role === 'super_admin' ? 'admin' : role;
  next();
});

const cache = new Map();   // scope -> { at, entries, drops }
const TTL = 30 * 1000;
const scopeKey = (req) => (req.staffRole === 'admin' ? 'admin' : `t:${req.user.userId}`);

/** Every entry the viewer may see (all their classes), built from the stored metrics. */
async function loadEntries(req, fresh) {
  const key = scopeKey(req);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit;

  let cq = supabase.from('courses').select('id, title').eq('is_test', false).order('id', { ascending: true });
  if (req.staffRole !== 'admin') cq = cq.eq('teacher_id', req.user.userId);
  const courses = await fetchAllRows(() => cq);
  const titleBy = new Map(courses.map(c => [c.id, c.title]));
  const courseIds = courses.map(c => c.id);
  const empty = { at: Date.now(), entries: [], courses: [], drops: [], metricsAt: null };
  if (!courseIds.length) return empty;

  const enrollments = await fetchAllIn(courseIds, ch => supabase.from('course_enrollments').select('id, course_id, student_id').in('course_id', ch).order('id', { ascending: true }));
  const students = await fetchAllIn(enrollments.map(e => e.student_id), ch => supabase.from('users')
    .select('id, name, phone, avatar_url, created_at').in('id', ch).eq('role', 'student').eq('is_active', true).eq('is_test', false).order('id', { ascending: true }));
  const ids = students.map(s => s.id);
  const since14 = new Date(Date.now() - cfg.windowDays * DAY).toISOString().slice(0, 10);
  const since30 = new Date(Date.now() - 30 * DAY).toISOString();

  const [metrics, onboarding, logs, activity, priv] = await Promise.all([
    fetchAllIn(ids, ch => supabase.from('student_subject_metrics').select('*').in('student_id', ch).order('student_id', { ascending: true })),
    fetchAllIn(ids, ch => supabase.from('student_onboarding').select('*').in('student_id', ch).order('student_id', { ascending: true })),
    fetchAllIn(ids, ch => supabase.from('student_followups').select('id, student_id, kind, case_code, reason, channel, text, author_name, created_at').in('student_id', ch).order('created_at', { ascending: false })),
    fetchAllIn(ids, ch => supabase.from('activity_days').select('student_id, day').in('student_id', ch).gte('day', since14).order('student_id', { ascending: true }).order('day', { ascending: true })),
    fetchAllIn(ids, ch => supabase.from('student_private').select('user_id, telegram_chat_id, telegram_username, telegram_phone, telegram_visibility').in('user_id', ch).order('user_id', { ascending: true })).catch(() => []),
  ]);

  const by = (rows, k) => { const m = new Map(); rows.forEach(r => { if (!m.has(r[k])) m.set(r[k], []); m.get(r[k]).push(r); }); return m; };
  const metricsBy = by(metrics, 'student_id');
  const obBy = new Map(onboarding.map(o => [o.student_id, o]));
  const logBy = by(logs, 'student_id');
  const actBy = by(activity, 'student_id');
  const privBy = new Map(priv.map(p => [p.user_id, p]));
  const myCourses = by(enrollments, 'student_id');

  const entries = students.map(s => {
    const mrows = metricsBy.get(s.id) || [];
    const mByCourse = new Map(mrows.map(m => [m.course_id, m]));
    const enrolled = [...new Set((myCourses.get(s.id) || []).map(e => e.course_id))];
    const subjects = enrolled.map(cid => ({ course_id: cid, title: titleBy.get(cid) || '', m: mByCourse.get(cid) || {} }));
    const p = privBy.get(s.id) || {};
    const e = buildEntry({
      student: { ...s, has_telegram: !!p.telegram_chat_id, can_open_telegram: ['teachers', 'friends'].includes(p.telegram_visibility) && !!(p.telegram_username || p.telegram_phone) },
      subjects, onboarding: obBy.get(s.id) || null, logs: logBy.get(s.id) || [], activeDays: (actBy.get(s.id) || []).length,
    });
    return e;
  });

  const drops = {};
  logs.filter(l => l.reason && l.reason !== 'checked_in' && l.created_at >= since30).forEach(l => { drops[l.reason] = (drops[l.reason] || 0) + 1; });
  const metricsAt = metrics.reduce((m, r) => (!m || r.computed_at > m ? r.computed_at : m), null);
  const out = { at: Date.now(), entries, courses: courses.map(c => ({ id: c.id, title: c.title })), drops: Object.entries(drops).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count), metricsAt };
  cache.set(key, out);
  return out;
}

const one = (v) => (Array.isArray(v) ? v[0] : v);
const oneOf = (v, list) => (list.includes(one(v)) ? one(v) : undefined);

/**
 * GET /api/follow-up?tab=needs|new|doing_well|followed|unreachable|all&page=1&sort=urgent|name|recent|newest
 *   &course_id=&case=4|1|2|3|0&attendance=&after=studied|not_studied|none&progress=&engagement=&q=
 * -> { students, total, page, pages, size, counts: { tabs, cases, new_summary }, drops, courses, metrics_at }
 */
router.get('/', async (req, res) => {
  try {
    const q = req.query;
    const model = await loadEntries(req, q.fresh === '1');
    const courseId = UUID.test(one(q.course_id) || '') ? one(q.course_id) : null;
    // The tab and card counts follow the subject and search the viewer picked, but not the other filters.
    const scope = model.entries.filter(e => (!courseId || e.subjects.some(s => s.course_id === courseId))
      && (!q.q || e.name.toLowerCase().includes(String(one(q.q)).toLowerCase())));
    const filters = {
      subject: courseId || undefined, case: oneOf(q.case, ['0', '1', '2', '3', '4']),
      attendance: oneOf(q.attendance, ['regular', 'sometimes', 'rarely', 'never']),
      after: oneOf(q.after, ['studied', 'not_studied', 'none']),
      progress: oneOf(q.progress, ['on_track', 'slow', 'no_progress']),
      engagement: oneOf(q.engagement, ['high', 'medium', 'low', 'none']),
      q: q.q ? String(one(q.q)).slice(0, 80) : undefined,
    };
    const p = page(model.entries, { tab: oneOf(q.tab, ['needs', 'new', 'doing_well', 'followed', 'unreachable', 'all']) || 'needs', filters, sort: oneOf(q.sort, ['urgent', 'name', 'recent', 'newest']) || 'urgent', pageNo: parseInt(one(q.page), 10) || 1 });
    res.json({ success: true, data: { students: p.rows, total: p.total, page: p.page, pages: p.pages, size: p.size, counts: summarize(scope), drops: model.drops, courses: model.courses, metrics_at: model.metricsAt, config: { engagement: cfg.engagement, window_days: cfg.windowDays } } });
  } catch (error) {
    console.error('Follow-up list error:', error);
    res.status(500).json({ success: false, error: 'Failed to load follow-up: ' + error.message });
  }
});

/** GET /api/follow-up/:studentId -> { student, history: [{ id, kind, case_code, reason, channel, text, author, at }] } */
router.get('/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!UUID.test(studentId)) return res.status(404).json({ success: false, error: 'Student not found' });
    const model = await loadEntries(req, true);
    const student = model.entries.find(e => e.student_id === studentId);
    if (!student) return res.status(404).json({ success: false, error: 'Student not found' });
    const { data } = await supabase.from('student_followups')
      .select('id, kind, case_code, reason, channel, text, author_name, created_at').eq('student_id', studentId).order('created_at', { ascending: false }).limit(30);
    let messages = [];
    try {
      const m = await supabase.from('follow_up_messages').select('id, template_key, case_code, status, error, scheduled_for, sent_at, replied_at, chosen_reason, created_at').eq('student_id', studentId).order('created_at', { ascending: false }).limit(15);
      messages = m.data || [];
    } catch { /* migration 073 not run yet */ }
    res.json({ success: true, data: { student, messages, history: (data || []).map(h => ({ id: h.id, kind: h.kind, case_code: h.case_code, reason: h.reason, channel: h.channel, text: h.text, author: h.author_name, at: h.created_at })) } });
  } catch (error) {
    console.error('Follow-up detail error:', error);
    res.status(500).json({ success: false, error: 'Failed to load the student: ' + error.message });
  }
});

/**
 * POST /api/follow-up/:studentId { kind: done|message|praise|note, reason?, note?, channel?, case_code?, course_id? }
 * 'done' = "Mark as followed up" (needs a reason, except a new student's check-in which is saved as 'checked_in').
 */
router.post('/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const b = req.body || {};
    const kind = KINDS.includes(b.kind) ? b.kind : 'done';
    if (!UUID.test(studentId)) return res.status(404).json({ success: false, error: 'Student not found' });
    const model = await loadEntries(req, true);
    const student = model.entries.find(e => e.student_id === studentId);
    if (!student) return res.status(404).json({ success: false, error: 'Student not found' });

    let reason = REASONS.includes(b.reason) ? b.reason : null;
    if (kind === 'done' && student.is_new) reason = 'checked_in';
    if (kind === 'done' && !reason) return res.status(400).json({ success: false, error: 'Pick a reason first' });
    const note = String(b.note || '').trim().slice(0, 1000) || null;
    if (kind === 'note' && !note) return res.status(400).json({ success: false, error: 'Write a note first' });
    const caseCode = kind === 'praise' ? 'praise' : CASES.includes(String(b.case_code)) ? String(b.case_code) : (student.is_new ? '0' : student.main ? student.main.code : null);

    const { data: me } = await supabase.from('users').select('name').eq('id', req.user.userId).maybeSingle();
    const { data, error } = await supabase.from('student_followups').insert({
      student_id: studentId, author_id: req.user.userId, author_name: me?.name || null, contacted_by: req.user.userId,
      kind, text: note, reason: kind === 'done' ? reason : null, case_code: caseCode,
      channel: CHANNELS.includes(b.channel) ? b.channel : null,
      course_id: UUID.test(b.course_id || '') ? b.course_id : null,
    }).select('id, kind, case_code, reason, channel, text, author_name, created_at').single();
    if (error) throw error;
    cache.clear();
    res.status(201).json({ success: true, data: { entry: data } });
  } catch (error) {
    console.error('Follow-up save error:', error);
    res.status(500).json({ success: false, error: 'Failed to save: ' + error.message });
  }
});

// Shared with the messages routes: who the viewer may follow up, and a way to drop the cached list after a send.
router.loadEntries = loadEntries;
router.clearCache = () => cache.clear();

module.exports = router;
