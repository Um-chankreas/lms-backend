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

/** Today as "YYYY-MM-DD" (server-local), the format subscription expiries use. */
function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A subscription is active through its expiry day (expiry_date >= today). */
const isSubscriptionActive = (expiryDate) => !!expiryDate && String(expiryDate).slice(0, 10) >= todayYmd();

/**
 * Whether a student has an active subscription for THIS course
 * (student_course_subscriptions.expiry_date >= today). This is what gates
 * joining that course's live classes; paying for one course does not unlock
 * another.
 */
async function hasCourseSubscription({ supabase, studentId, courseId }) {
  if (!studentId || !courseId) return false;
  const { data } = await supabase
    .from('student_course_subscriptions')
    .select('expiry_date')
    .eq('student_id', studentId)
    .eq('course_id', courseId)
    .maybeSingle();
  return isSubscriptionActive(data?.expiry_date);
}

/**
 * Of `courseIds`, the ones this student has an active subscription for
 * (one query — used to annotate a whole list). Returns a Set of course ids.
 */
async function subscribedCourseIds({ supabase, studentId, courseIds }) {
  if (!studentId || !courseIds || courseIds.length === 0) return new Set();
  const { data } = await supabase
    .from('student_course_subscriptions')
    .select('course_id')
    .eq('student_id', studentId)
    .in('course_id', courseIds)
    .gte('expiry_date', todayYmd());
  return new Set((data || []).map(r => r.course_id));
}

module.exports = {
  hasCourseAccess,
  ensureEnrolled,
  hasCourseSubscription,
  subscribedCourseIds,
  isSubscriptionActive,
  todayYmd
};
