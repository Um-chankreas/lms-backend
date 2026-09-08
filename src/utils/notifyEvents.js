const supabase = require('../config/supabase');
const { createNotification, createNotifications, coursePeers } = require('./notifications');

// Best-effort wrappers — a notification failure must never break the action
// that triggered it. Every export is safe to `await` (or fire-and-forget).

async function actorName(studentId) {
  const { data } = await supabase.from('users').select('name').eq('id', studentId).maybeSingle();
  return data?.name || 'A classmate';
}

/**
 * A student finished a lesson/chapter.
 *  - owner:   "You finished …"
 *  - friends: "<Name> completed a lesson"
 */
async function notifyLessonComplete(studentId, lessonId) {
  try {
    const { data: lesson } = await supabase
      .from('lessons').select('id, title').eq('id', lessonId).maybeSingle();
    if (!lesson) return;
    const name = await actorName(studentId);

    await createNotification(studentId, 'lesson_complete', {
      title: 'Lesson complete',
      body: `You finished “${lesson.title}”. +15 XP`,
      data: { lesson_id: lesson.id },
    });

    const peers = await coursePeers(studentId);
    await createNotifications(peers.map(uid => ({
      user_id: uid,
      type: 'friend_lesson',
      title: `${name} completed a lesson`,
      body: `${name} finished “${lesson.title}”`,
      data: { lesson_id: lesson.id, actor_id: studentId },
    })));
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
async function notifyQuizComplete(studentId, quizId, score, { firstAttempt = false, xpAwarded = 0 } = {}) {
  try {
    const { data: quiz } = await supabase
      .from('quizzes').select('id, title').eq('id', quizId).maybeSingle();
    if (!quiz) return;
    const name = await actorName(studentId);

    if (firstAttempt || xpAwarded > 0) {
      await createNotification(studentId, 'quiz_complete', {
        title: 'Quiz submitted',
        body: `You scored ${score}% on “${quiz.title}”${xpAwarded > 0 ? ` · +${xpAwarded} XP` : ''}`,
        data: { quiz_id: quiz.id, score },
      });
    }

    const peers = new Set(await coursePeers(studentId));
    if (peers.size === 0) return;

    if (firstAttempt) {
      await createNotifications([...peers].map(uid => ({
        user_id: uid,
        type: 'friend_quiz',
        title: `${name} took a quiz`,
        body: `${name} completed “${quiz.title}”`,
        data: { quiz_id: quiz.id, actor_id: studentId },
      })));
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

    await createNotifications(beatable.filter(uid => !alreadySet.has(uid)).map(uid => ({
      user_id: uid,
      type: 'friend_beat_score',
      title: `${name} beat your score`,
      body: `${name} scored ${myBest}% on “${quiz.title}” — you have ${bestByStudent.get(uid)}%`,
      data: { quiz_id: quiz.id, actor_id: studentId, their_score: myBest, your_score: bestByStudent.get(uid) },
    })));
  } catch (e) {
    console.warn('notifyQuizComplete failed:', e.message);
  }
}

module.exports = { notifyLessonComplete, notifyQuizComplete };
