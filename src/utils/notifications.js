const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { pushMany, pushToUsers } = require('./push');

/**
 * Insert one notification row. Best-effort: never throws into the caller's
 * request path.
 * @param {string} userId  recipient (a logged-in user; guests have no row)
 * @param {string} type
 * @param {{ title: string, body: string, data?: object }} payload
 */
async function createNotification(userId, type, { title, body, data = {} } = {}) {
  if (!userId || !title || !body) return;
  const { error } = await supabase.from('notifications').insert({
    id: uuidv4(),
    user_id: userId,
    type,
    title,
    body,
    data,
    created_at: new Date(),
  });
  if (error) { console.warn('createNotification failed:', error.message); return; }
  pushToUsers([userId], { title, body, data: { ...data, type } });
}

/**
 * Bulk insert — for fanning one event out to many friends. Each row is
 * { user_id, type, title, body, data? }.
 */
async function createNotifications(rows) {
  const list = (rows || []).filter(r => r && r.user_id && r.title && r.body);
  if (list.length === 0) return;
  const { error } = await supabase.from('notifications').insert(
    list.map(r => ({
      id: uuidv4(),
      user_id: r.user_id,
      type: r.type,
      title: r.title,
      body: r.body,
      data: r.data || {},
      created_at: new Date(),
    }))
  );
  if (error) { console.warn('createNotifications failed:', error.message); return; }
  pushMany(list.map(r => ({
    userId: r.user_id,
    title: r.title,
    body: r.body,
    data: { ...(r.data || {}), type: r.type },
  })));
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

module.exports = { createNotification, createNotifications, coursePeers };
