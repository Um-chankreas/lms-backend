const { v4: uuidv4 } = require('uuid');

/**
 * Whether `user` has access to everything in `course` — free courses are
 * open to everyone, otherwise the course owner (teacher) and enrolled
 * students have access. Individual free lessons are handled separately by
 * callers (a locked course can still have specific free preview lessons).
 */
async function hasCourseAccess({ supabase, course, user }) {
  if (course.is_free) return true;
  if (!user) return false;

  if (user.role === 'teacher') {
    return course.teacher_id === user.userId;
  }

  if (user.role === 'student') {
    const { data: enrollment } = await supabase
      .from('course_enrollments')
      .select('id')
      .eq('course_id', course.id)
      .eq('student_id', user.userId)
      .maybeSingle();
    return !!enrollment;
  }

  return false;
}

/**
 * There's no payment flow yet, so any student who engages with a course
 * (views it, completes a lesson, submits a quiz) counts as "starting" it —
 * no separate explicit "Enroll" step required. Call this before
 * hasCourseAccess so a first-time engagement is immediately recognized as
 * enrolled rather than rejected. is_free stays meaningful for later (e.g.
 * per-lesson previews on a not-yet-purchased course); once real payment
 * exists, this unconditional auto-enroll is what should change, not
 * hasCourseAccess itself.
 *
 * Uses a check-then-insert (not upsert+onConflict) since there's no
 * confirmed unique constraint on (course_id, student_id) to conflict on —
 * an upsert without one would just insert a fresh duplicate row on every
 * call. Best-effort: failures here shouldn't block the caller's response.
 */
async function ensureEnrolled({ supabase, course, user }) {
  if (!user || user.role !== 'student') return;

  try {
    const { data: existing } = await supabase
      .from('course_enrollments')
      .select('id')
      .eq('course_id', course.id)
      .eq('student_id', user.userId)
      .limit(1)
      .maybeSingle();

    if (!existing) {
      await supabase
        .from('course_enrollments')
        .insert({
          id: uuidv4(),
          course_id: course.id,
          student_id: user.userId,
          enrolled_at: new Date()
        });
    }
  } catch (enrollError) {
    console.warn('Auto-enrollment failed:', enrollError);
  }
}

/**
 * Whether a student's account-level weekly subscription is currently active
 * (users.paid_until >= today). This is what gates joining live classes; an
 * active subscription covers every course.
 */
async function hasActiveSubscription({ supabase, studentId }) {
  const { data } = await supabase
    .from('users')
    .select('paid_until')
    .eq('id', studentId)
    .maybeSingle();

  if (!data || !data.paid_until) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(data.paid_until) >= today;
}

module.exports = { hasCourseAccess, ensureEnrolled, hasActiveSubscription };
