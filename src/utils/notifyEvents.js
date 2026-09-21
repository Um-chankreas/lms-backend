const supabase = require('../config/supabase');
const { createNotification, createNotifications, coursePeers } = require('./notifications');
const { friendNotification } = require('./notificationTemplates');
const { XP_VALUES } = require('./xp');

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
 * A student finished a lesson/chapter.
 *  - owner:   "You finished …"
 *  - friends: "<Name> completed a lesson"
 */
async function notifyLessonComplete(studentId, lessonId) {
  try {
    const { data: lesson } = await supabase
      .from('lessons').select('id, title, order_number, course_id, courses(title)').eq('id', lessonId).maybeSingle();
    if (!lesson) return;
    const name = await actorName(studentId);

    await createNotification(studentId, 'lesson_complete', {
      title: 'Lesson complete',
      body: `You finished “${lesson.title}”. +15 XP`,
      data: {
        lesson_id: lesson.id,
        lesson_title: lesson.title,
        course_id: lesson.course_id || null,
        course_title: lesson.courses?.title || null,
        chapter_number: lesson.order_number ?? null,
        xp: 15,
      },
    });

    const peers = await coursePeers(studentId);
    const styles = await stylesFor(peers);
    await createNotifications(peers.map(uid => {
      const style = styles.get(uid) || 'balanced';
      const { title, body, cta } = friendNotification('friend_lesson', style, { name, lessonTitle: lesson.title });
      return {
        user_id: uid,
        type: 'friend_lesson',
        title,
        body,
        data: {
          lesson_id: lesson.id,
          lesson_title: lesson.title,
          course_id: lesson.course_id || null,
          actor_id: studentId,
          actor_name: name,
          style,
          cta,
        },
      };
    }));
  } catch (e) {
    console.warn('notifyLessonComplete failed:', e.message);
  }
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
 * (enrolled in the course, active subscription, live classes enabled for the
 * course). Students who couldn't join are skipped — a "live now" they can't
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

    const [{ data: enrollments }, { data: teacher }] = await Promise.all([
      supabase.from('course_enrollments').select('student_id').eq('course_id', lc.course_id),
      supabase.from('users').select('name').eq('id', lc.teacher_id).maybeSingle(),
    ]);
    const enrolledIds = [...new Set((enrollments || []).map(e => e.student_id))].filter(Boolean);
    if (enrolledIds.length === 0) return;

    // Same rule as hasActiveSubscription(), in one query for the whole roster.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { data: students } = await supabase
      .from('users')
      .select('id, paid_until')
      .in('id', enrolledIds);
    const recipients = (students || [])
      .filter(s => s.paid_until && new Date(s.paid_until) >= today)
      .map(s => s.id);
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

module.exports = { notifyLessonComplete, notifyQuizComplete, notifyAssignmentPublished, notifyLiveClassStarted };
