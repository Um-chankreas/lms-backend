const supabase = require('../config/supabase');
const { createNotifications, userPrefs } = require('./notifications');
const { XP_VALUES } = require('./xp');
const { todayYmd, LIVE_REQUIRES_SUBSCRIPTION } = require('./access');
const { T, renderTemplate, formatDay } = require('./notificationCopy');

// Class notifications: things a teacher did (a new assignment, a live class).
// They have no daily cap and ignore quiet hours — a live class can start at any
// time. Text comes from notificationCopy.js in the student's own language.
//
// Best-effort wrappers: a notification failure must never break the action
// that triggered it. Every export is safe to `await` (or fire-and-forget).

/**
 * Build one class notification per recipient (their language, their values)
 * and store + push them. Recipients whose copy can't be built are skipped.
 */
async function sendClass(templateKey, type, userIds, varsFor, dataFor) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (ids.length === 0) return 0;
  const prefs = await userPrefs(ids);
  const rows = [];
  for (const uid of ids) {
    const pref = prefs.get(uid);
    if (!pref || !pref.isActive) continue;
    const msg = renderTemplate(templateKey, pref.language, varsFor(pref.language));
    if (!msg) continue;
    rows.push({
      user_id: uid,
      type,
      title: msg.title,
      body: msg.body,
      data: dataFor,
      template_key: templateKey,
      variant_id: msg.id,
      kind: T[templateKey].kind,
    });
  }
  return createNotifications(rows);
}

/**
 * Students who can actually join live classes of a course: with the paywall
 * on, those with an active subscription for that course; with it off (the
 * default), everyone enrolled.
 */
async function liveClassRecipients(courseId) {
  if (LIVE_REQUIRES_SUBSCRIPTION) {
    const { data } = await supabase
      .from('student_course_subscriptions')
      .select('student_id')
      .eq('course_id', courseId)
      .gte('expiry_date', todayYmd());
    return [...new Set((data || []).map(s => s.student_id))].filter(Boolean);
  }
  const { data } = await supabase.from('course_enrollments').select('student_id').eq('course_id', courseId);
  return [...new Set((data || []).map(s => s.student_id))].filter(Boolean);
}

/**
 * A teacher published an assignment (file or quiz-type) — draft saves never
 * reach here. Every student enrolled in the assignment's course gets one
 * notification: a class-wide announcement, so it skips the friend logic.
 */
async function notifyAssignmentPublished(assignmentId) {
  try {
    const { data: assignment } = await supabase
      .from('assignments')
      .select('id, title, due_date, type, course_id, courses(title)')
      .eq('id', assignmentId)
      .maybeSingle();
    if (!assignment) return;

    const { data: enrollments } = await supabase
      .from('course_enrollments')
      .select('student_id')
      .eq('course_id', assignment.course_id);
    const studentIds = (enrollments || []).map(e => e.student_id);

    await sendClass(
      'assignment_new',
      'assignment_new',
      studentIds,
      (lang) => ({
        assignmentTitle: assignment.title,
        courseTitle: assignment.courses?.title || null,   // empty -> "Your course" (see copy defaults)
        dueDate: assignment.due_date ? formatDay(assignment.due_date, lang) : null,
        xp: XP_VALUES.ASSIGNMENT_ONTIME,
      }),
      {
        assignment_id: assignment.id,
        assignment_title: assignment.title,
        course_id: assignment.course_id,
        course_title: assignment.courses?.title || null,
        assignment_type: assignment.type,
        due_date: assignment.due_date,
      },
    );
  } catch (e) {
    console.warn('notifyAssignmentPublished failed:', e.message);
  }
}

/**
 * The teacher started a live class: tell every student who can actually join it
 * (see liveClassRecipients). Skipped when live classes are off for the course —
 * a "live now" nobody can open is just noise.
 */
async function notifyLiveClassStarted(liveClassId) {
  try {
    const { data: lc } = await supabase
      .from('live_classes')
      .select('id, title, course_id, teacher_id, courses(title, live_enabled)')
      .eq('id', liveClassId)
      .maybeSingle();
    if (!lc || lc.courses?.live_enabled === false) return;

    const [recipients, { data: teacher }] = await Promise.all([
      liveClassRecipients(lc.course_id),
      supabase.from('users').select('name').eq('id', lc.teacher_id).maybeSingle(),
    ]);
    if (recipients.length === 0) return;

    const teacherName = teacher?.name || null;
    const courseTitle = lc.courses?.title || null;
    await sendClass(
      'live_class_started',
      'live_class_started',
      recipients,
      () => ({ liveClassTitle: lc.title, teacherName, courseTitle }),
      {
        live_class_id: lc.id,
        live_class_title: lc.title,
        course_id: lc.course_id,
        course_title: courseTitle,
        teacher_name: teacherName || null,
      },
    );
  } catch (e) {
    console.warn('notifyLiveClassStarted failed:', e.message);
  }
}

/**
 * A recurring class_schedules slot is about to start (called by the reminder
 * cron in src/utils/classScheduler.js, 10-15 min ahead). Distinct from
 * notifyLiveClassStarted: this fires on the SCHEDULE, whether or not the
 * teacher has pressed "Start" yet, so it reads as a heads-up, not "live now".
 */
async function notifyClassScheduleReminder(schedule) {
  try {
    const { data: course } = await supabase
      .from('courses')
      .select('id, title, live_enabled')
      .eq('id', schedule.course_id)
      .maybeSingle();
    if (!course || course.live_enabled === false) return;

    const [recipients, { data: teacher }, { data: planned }] = await Promise.all([
      liveClassRecipients(schedule.course_id),
      supabase.from('users').select('name').eq('id', schedule.teacher_id).maybeSingle(),
      // The teacher's own live class for this slot, if they already created one.
      supabase
        .from('live_classes')
        .select('title, scheduled_at')
        .eq('course_id', schedule.course_id)
        .eq('status', 'scheduled')
        .gte('scheduled_at', new Date().toISOString())
        .lte('scheduled_at', new Date(Date.now() + 30 * 60 * 1000).toISOString())
        .order('scheduled_at', { ascending: true })
        .limit(1),
    ]);
    if (recipients.length === 0) return;

    const time = String(schedule.start_time || '').slice(0, 5) || null;   // 'HH:MM:SS' -> 'HH:MM'
    const teacherName = teacher?.name || null;
    const liveClassTitle = planned?.[0]?.title || null;
    await sendClass(
      'live_class_reminder',
      'live_class_reminder',
      recipients,
      () => ({ courseTitle: course.title, teacherName, liveClassTitle, time }),
      {
        course_id: course.id,
        course_title: course.title,
        schedule_id: schedule.id,
        start_time: schedule.start_time,
      },
    );
  } catch (e) {
    console.warn('notifyClassScheduleReminder failed:', e.message);
  }
}

module.exports = {
  notifyAssignmentPublished,
  notifyLiveClassStarted,
  notifyClassScheduleReminder,
  liveClassRecipients,
};
