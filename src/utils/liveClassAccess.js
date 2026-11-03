const supabase = require('../config/supabase');

const isAdminRole = (role) => role === 'admin' || role === 'super_admin';

/**
 * Can `user` run this live class (start, end, teach, record)?
 *  - an admin or super admin: any class;
 *  - the teacher who created it;
 *  - the teacher of the course it belongs to. A course's running session is
 *    shared (starting a class on a live course rejoins the running one), so
 *    whoever happened to click first — another teacher, or an admin — must not
 *    lock the course's own teacher out of it.
 */
async function canRunLiveClass(liveClass, user) {
  if (!liveClass || !user) return false;
  if (isAdminRole(user.role)) return true;
  if (user.role !== 'teacher') return false;
  if (liveClass.teacher_id === user.userId) return true;
  if (!liveClass.course_id) return false;
  const { data: course } = await supabase
    .from('courses')
    .select('teacher_id')
    .eq('id', liveClass.course_id)
    .maybeSingle();
  return course?.teacher_id === user.userId;
}

module.exports = { isAdminRole, canRunLiveClass };
