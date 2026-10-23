const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { pushMany, pushToUsers } = require('./push');

// Notification System v2 adds columns (sql/055). Until that migration has been
// run, inserts fall back to the original columns so nothing breaks.
let extraColumns = true;
const isMissingColumn = (error) => error && (error.code === '42703' || error.code === 'PGRST204' || /column .* (does not exist|of relation)|Could not find the .* column/i.test(error.message || ''));

const toRow = (r, withExtras) => ({
  id: uuidv4(),
  user_id: r.user_id,
  type: r.type,
  title: r.title,
  body: r.body,
  data: r.data || {},
  created_at: new Date(),
  ...(withExtras ? {
    template_key: r.template_key || null,
    variant_id: r.variant_id || null,
    kind: r.kind || 'class',
    push_sent: r.push !== false,
  } : {}),
});

/**
 * Bulk insert + push. Each row is { user_id, type, title, body, data?,
 * template_key?, variant_id?, kind?: 'class' | 'nudge', push?: false }.
 * `push: false` stores the bell entry only (no OS banner). Returns how many
 * rows were stored. Never throws.
 */
async function createNotifications(rows) {
  const list = (rows || []).filter(r => r && r.user_id && r.title && r.body);
  if (list.length === 0) return 0;

  let { error } = await supabase.from('notifications').insert(list.map(r => toRow(r, extraColumns)));
  if (error && extraColumns && isMissingColumn(error)) {
    extraColumns = false;
    console.warn('notifications: sql/055_notification_v2.sql has not been run; storing without rotation/cap metadata');
    ({ error } = await supabase.from('notifications').insert(list.map(r => toRow(r, false))));
  }
  if (error) { console.warn('createNotifications failed:', error.message); return 0; }

  pushMany(list.filter(r => r.push !== false).map(r => ({
    userId: r.user_id,
    title: r.title,
    body: r.body,
    data: { ...(r.data || {}), type: r.type },
  })));
  return list.length;
}

/** One notification. Same payload as createNotifications' rows, minus user_id/type. */
async function createNotification(userId, type, { title, body, data = {}, push = true, ...meta } = {}) {
  return createNotifications([{ user_id: userId, type, title, body, data, push, ...meta }]);
}

/**
 * Who each recipient is for notification purposes: preferred language
 * ('km' default), friend-notification style and display name. Works before
 * users.language exists (sql/055) by falling back to the default.
 * @returns {Promise<Map<string, { language: 'km'|'en', style: string, name: string, isActive: boolean }>>}
 */
async function userPrefs(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    let res = await supabase.from('users').select('id, name, is_active, notification_style, language').in('id', chunk);
    if (res.error && isMissingColumn(res.error)) {
      res = await supabase.from('users').select('id, name, is_active, notification_style').in('id', chunk);
    }
    (res.data || []).forEach(u => out.set(u.id, {
      language: u.language === 'en' ? 'en' : 'km',
      style: u.notification_style === 'competitive' ? 'competitive' : 'balanced',
      name: u.name || '',
      isActive: u.is_active !== false,
    }));
  }
  return out;
}

/**
 * The "friends" of a student: everyone enrolled in a course they're also
 * enrolled in, minus themselves. (Same relation the activity feed +
 * leaderboard use.) Returns a list of user ids.
 */
async function coursePeers(studentId) {
  const { data: myEnr } = await supabase
    .from('course_enrollments').select('course_id').eq('student_id', studentId);
  const courseIds = [...new Set((myEnr || []).map(e => e.course_id))];
  if (courseIds.length === 0) return [];

  const { data: peers } = await supabase
    .from('course_enrollments').select('student_id').in('course_id', courseIds);
  return [...new Set((peers || []).map(p => p.student_id))].filter(id => id && id !== studentId);
}

module.exports = { createNotification, createNotifications, coursePeers, userPrefs, isMissingColumn };
