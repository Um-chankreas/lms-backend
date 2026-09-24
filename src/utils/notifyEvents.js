const supabase = require('../config/supabase');
const { createNotification, createNotifications, coursePeers } = require('./notifications');
const { friendNotification } = require('./notificationTemplates');
const { XP_VALUES } = require('./xp');
const { todayYmd } = require('./access');

// Best-effort wrappers — a notification failure must never break the action
// that triggered it. Every export is safe to `await` (or fire-and-forget).

async function actorName(studentId) {
  const { data } = await supabase.from('users').select('name').eq('id', studentId).maybeSingle();
  return data?.name || 'A classmate';
}

// recipient id -> notification_style (defaults to 'balanced')
async function stylesFor(userIds) {
  const map = new Map();
  if (!userIds || userIds.length === 0) return map;
  const { data } = await supabase
    .from('users')
    .select('id, notification_style')
    .in('id', [...userIds]);
  (data || []).forEach(u => map.set(u.id, u.notification_style || 'balanced'));
  return map;
}

/**
 * A student submitted a quiz.
 *  - owner:   "You scored X% …"  (first attempt, or the run that earned XP)
 *  - friends: "<Name> took a quiz"  (their first attempt only)
 *  - beaten:  "<Name> beat your score"  (once per quiz per friend)
 */
async function notifyQuizComplete(studentId, quizId, score, {
  firstAttempt = false, xpAwarded = 0, passed = null, passPercentage = 70,
  lessonId = null, courseId = null, correctCount = null, totalCount = null,
} = {}) {
  try {
    const { data: quiz } = await supabase
      .from('quizzes').select('id, title').eq('id', quizId).maybeSingle();
    if (!quiz) return;
    const name = await actorName(studentId);
    const didPass = passed == null ? score >= passPercentage : !!passed;

    // Notify on: first attempt (pass or fail — a failed first try becomes the
    // "NEEDS REVIEW" card), or any run that earned XP.
    if (firstAttempt || xpAwarded > 0) {
      await createNotification(studentId, 'quiz_complete', {
        title: 'Quiz submitted',
        body: `You scored ${score}% on “${quiz.title}”${xpAwarded > 0 ? ` · +${xpAwarded} XP` : ''}`,
        data: {
          quiz_id: quiz.id,
          quiz_title: quiz.title,
          score,
          passed: didPass,
          pass_percentage: passPercentage,
          xp_awarded: xpAwarded,
          lesson_id: lessonId,
          course_id: courseId,
          correct_count: correctCount,
          total_questions: totalCount,
        },
      });
    }

    const peers = new Set(await coursePeers(studentId));
    if (peers.size === 0) return;
    const styles = await stylesFor(peers);
    const styleOf = (uid) => styles.get(uid) || 'balanced';

    if (firstAttempt) {
      await createNotifications([...peers].map(uid => {
        const style = styleOf(uid);
        const { title, body, cta } = friendNotification('friend_quiz', style, { name, quizTitle: quiz.title });
        return {
          user_id: uid,
          type: 'friend_quiz',
          title,
          body,
          data: { quiz_id: quiz.id, quiz_title: quiz.title, actor_id: studentId, actor_name: name, style, cta },
        };
      }));
    }

    // "Beat your score": peers on this quiz whose best is now below this
    // student's best. Sent at most once per (friend, quiz, actor).
    const { data: subs } = await supabase
      .from('quiz_submissions').select('student_id, score').eq('quiz_id', quiz.id);
    const bestByStudent = new Map();
    (subs || []).forEach(s => {
      const prev = bestByStudent.get(s.student_id);
      if (prev == null || s.score > prev) bestByStudent.set(s.student_id, s.score);
    });
    const myBest = bestByStudent.get(studentId) ?? score;

    const beatable = [...bestByStudent].filter(([uid, b]) => peers.has(uid) && b < myBest).map(([uid]) => uid);
    if (beatable.length === 0) return;

    const { data: already } = await supabase
      .from('notifications')
      .select('user_id')
      .eq('type', 'friend_beat_score')
      .eq('data->>quiz_id', quiz.id)
      .eq('data->>actor_id', studentId)
      .in('user_id', beatable);
    const alreadySet = new Set((already || []).map(r => r.user_id));

    await createNotifications(beatable.filter(uid => !alreadySet.has(uid)).map(uid => {
      const style = styleOf(uid);
      const { title, body, cta } = friendNotification('friend_beat_score', style, { name, score: myBest });
      return {
        user_id: uid,
        type: 'friend_beat_score',
        title,
        body,
        data: {
          quiz_id: quiz.id,
          quiz_title: quiz.title,
          actor_id: studentId,
          actor_name: name,
          their_score: myBest,
          your_score: bestByStudent.get(uid),
          style,
          cta,
        },
      };
    }));
  } catch (e) {
    console.warn('notifyQuizComplete failed:', e.message);
  }
}

/**
 * A teacher published an assignment (file or quiz-type) — draft saves never
 * reach here. Every student enrolled in the assignment's course gets one
 * notification — this is a class-wide announcement, not a friend-activity
 * fan-out, so it skips coursePeers/notification_style entirely.
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
    const studentIds = [...new Set((enrollments || []).map(e => e.student_id))];
    if (studentIds.length === 0) return;

    const dueText = assignment.due_date
      ? `Due ${new Date(assignment.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : null;
    const courseTitle = assignment.courses?.title || 'Your course';

    // "📚 New Assignment Unlocked! History 101: "Causes of War" · Due Sep 25
    // · Earn 75+ XP!" — the title stays generic/catchy; the body carries the
    // specifics. XP is the on-time reward (the best case) even though a late
    // submission earns less — same flourish-over-precision call as showing
    // the up-front number at all before anyone's submitted.
    await createNotifications(studentIds.map(uid => ({
      user_id: uid,
      type: 'assignment_new',
      title: '📚 New Assignment Unlocked!',
      body: `${courseTitle}: "${assignment.title}"${dueText ? ` · ${dueText}` : ''} · Earn ${XP_VALUES.ASSIGNMENT_ONTIME}+ XP!`,
      data: {
        assignment_id: assignment.id,
        assignment_title: assignment.title,
        course_id: assignment.course_id,
        course_title: assignment.courses?.title || null,
        assignment_type: assignment.type,
        due_date: assignment.due_date,
      },
    })));
  } catch (e) {
    console.warn('notifyAssignmentPublished failed:', e.message);
  }
}

/**
 * The teacher started a live class: tell every student who can actually join it
 * (active subscription for that course, live classes enabled for the course). Students who couldn't join are skipped — a "live now" they can't
 * open is just noise. Bell entry + push via createNotifications.
 */
async function notifyLiveClassStarted(liveClassId) {
  try {
    const { data: lc } = await supabase
      .from('live_classes')
      .select('id, title, course_id, teacher_id, courses(title, live_enabled)')
      .eq('id', liveClassId)
      .maybeSingle();
    if (!lc || lc.courses?.live_enabled === false) return;

    // Only students subscribed to THIS course (the same rule that gates
    // joining it), so someone who paid for a different course isn't pinged.
    const [{ data: subs }, { data: teacher }] = await Promise.all([
      supabase
        .from('student_course_subscriptions')
        .select('student_id')
        .eq('course_id', lc.course_id)
        .gte('expiry_date', todayYmd()),
      supabase.from('users').select('name').eq('id', lc.teacher_id).maybeSingle(),
    ]);
    const recipients = [...new Set((subs || []).map(s => s.student_id))].filter(Boolean);
    if (recipients.length === 0) return;

    const teacherName = teacher?.name || 'Your teacher';
    const courseTitle = lc.courses?.title || null;

    await createNotifications(recipients.map(uid => ({
      user_id: uid,
      type: 'live_class_started',
      title: `🔴 Live now: ${lc.title}`,
      body: `${teacherName} just started a live class${courseTitle ? ` in ${courseTitle}` : ''}. Tap to join.`,
      data: {
        live_class_id: lc.id,
        live_class_title: lc.title,
        course_id: lc.course_id,
        course_title: courseTitle,
        teacher_name: teacherName,
      },
    })));
  } catch (e) {
    console.warn('notifyLiveClassStarted failed:', e.message);
  }
}

/**
 * A recurring class_schedules slot is about to start (called by the reminder
 * cron in src/utils/classScheduler.js, ~10-15 min ahead). Distinct from
 * notifyLiveClassStarted: this fires on the SCHEDULE, whether or not the
 * teacher has actually pressed "Start" yet, so it must read as a heads-up
 * ("starts in 15 minutes"), not "live now" — a student tapping in wouldn't
 * find anything to join if the teacher is running a couple minutes late.
 */
async function notifyClassScheduleReminder(schedule) {
  try {
    const { data: course } = await supabase
      .from('courses')
      .select('id, title, live_enabled')
      .eq('id', schedule.course_id)
      .maybeSingle();
    if (!course || course.live_enabled === false) return;

    const { data: subs } = await supabase
      .from('student_course_subscriptions')
      .select('student_id')
      .eq('course_id', schedule.course_id)
      .gte('expiry_date', todayYmd());
    const recipients = [...new Set((subs || []).map(s => s.student_id))].filter(Boolean);
    if (recipients.length === 0) return;

    await createNotifications(recipients.map(uid => ({
      user_id: uid,
      type: 'live_class_reminder',
      title: `⏰ Starting soon: ${course.title}`,
      body: `Your live class starts in 15 minutes.`,
      data: {
        course_id: course.id,
        course_title: course.title,
        schedule_id: schedule.id,
        start_time: schedule.start_time
      }
    })));
  } catch (e) {
    console.warn('notifyClassScheduleReminder failed:', e.message);
  }
}

module.exports = {
  notifyQuizComplete,
  notifyAssignmentPublished,
  notifyLiveClassStarted,
  notifyClassScheduleReminder
};
