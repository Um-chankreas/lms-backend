const supabase = require('../config/supabase');
const { fetchAllIn } = require('./studentProgress');
const { sendNudges, cambodiaNow } = require('./nudges');
const { shortName } = require('./dailyDigest');

// Friend activity (Notification System v2, 3.8 and 3.9). "Friends" are the
// other students enrolled in the same course.
//
//  - friend_beat_score: a push, only when a classmate just got a NEW BEST on a
//    quiz that edges past YOUR best by 10 points or less. Max 1 per student per day.
//  - friend_lesson / friend_quiz: bell only (no push). Max 3 per student per day.
//
// Best-effort: these run after the student's own action succeeded and must
// never break it.

const BEAT_MAX_GAP = 10;
const BELL_MAX_PER_DAY = 3;

async function classmates(courseId, exceptId) {
  const { data } = await supabase.from('course_enrollments').select('student_id').eq('course_id', courseId);
  const ids = [...new Set((data || []).map(e => e.student_id))].filter(id => id && id !== exceptId);
  if (ids.length === 0) return [];
  const rows = await fetchAllIn(ids, chunk => supabase.from('users').select('id').in('id', chunk).eq('role', 'student').eq('is_active', true).order('id', { ascending: true }));
  return rows.map(r => r.id);
}

// userId -> how many of these templates they already got today (Cambodia day).
async function countToday(userIds, templateKeys) {
  const since = new Date(cambodiaNow().startMs).toISOString();
  const rows = await fetchAllIn(userIds, chunk => supabase
    .from('notifications')
    .select('id, user_id')
    .in('user_id', chunk)
    .in('template_key', templateKeys)
    .gte('created_at', since)
    .order('id', { ascending: true }));
  const out = new Map();
  rows.forEach(r => out.set(r.user_id, (out.get(r.user_id) || 0) + 1));
  return out;
}

async function nameOf(studentId) {
  const { data } = await supabase.from('users').select('name').eq('id', studentId).maybeSingle();
  return shortName(data?.name);
}

/** A student finished a lesson: tell their classmates (bell only). */
async function notifyFriendsLessonDone({ studentId, courseId, lessonId, lessonTitle }) {
  try {
    if (!courseId || !lessonTitle) return;
    const [mates, name] = await Promise.all([classmates(courseId, studentId), nameOf(studentId)]);
    if (mates.length === 0 || !name) return;
    const today = await countToday(mates, ['friend_lesson', 'friend_quiz']);
    const items = mates
      .filter(id => (today.get(id) || 0) < BELL_MAX_PER_DAY)
      .map(userId => ({
        userId,
        vars: { name, lessonTitle },
        data: { actor_id: studentId, lesson_id: lessonId, course_id: courseId },
      }));
    await sendNudges('friend_lesson', items);
  } catch (e) {
    console.warn('notifyFriendsLessonDone failed:', e.message);
  }
}

/**
 * A student submitted a quiz. Classmates get a bell entry ("took a quiz"), and
 * those this just overtook by a little get the friend_beat_score push.
 * `submissionId` is the new row, so the student's previous best can be told apart.
 */
async function notifyFriendsQuizDone({ studentId, courseId, quizId, quizTitle, score, submissionId }) {
  try {
    if (!courseId || !quizTitle || !Number.isFinite(Number(score))) return;
    const [mates, name] = await Promise.all([classmates(courseId, studentId), nameOf(studentId)]);
    if (mates.length === 0 || !name) return;

    // 1) bell only: "took a quiz"
    const today = await countToday(mates, ['friend_lesson', 'friend_quiz']);
    await sendNudges('friend_quiz', mates
      .filter(id => (today.get(id) || 0) < BELL_MAX_PER_DAY)
      .map(userId => ({ userId, vars: { name, quizTitle }, data: { actor_id: studentId, quiz_id: quizId, course_id: courseId, score } })));

    // 2) push: you were just passed on this quiz
    const subs = await fetchAllIn([quizId], chunk => supabase
      .from('quiz_submissions')
      .select('id, student_id, score')
      .in('quiz_id', chunk)
      .order('id', { ascending: true }));
    const best = new Map();
    let myPrevBest = -Infinity;
    subs.forEach(s => {
      const sc = Number(s.score);
      if (!Number.isFinite(sc)) return;
      if (s.student_id === studentId) { if (s.id !== submissionId) myPrevBest = Math.max(myPrevBest, sc); return; }
      best.set(s.student_id, Math.max(best.get(s.student_id) ?? -Infinity, sc));
    });
    if (!(score > myPrevBest)) return;   // not a new personal best: nothing to announce

    const passed = mates.filter(id => best.has(id) && score > best.get(id) && score - best.get(id) <= BEAT_MAX_GAP);
    if (passed.length === 0) return;
    const beatToday = await countToday(passed, ['friend_beat_score']);
    await sendNudges('friend_beat_score', passed
      .filter(id => !beatToday.get(id))
      .map(userId => ({
        userId,
        vars: { name, score, quizTitle, gap: score - best.get(userId), myScore: best.get(userId) },
        groups: (pref) => [pref.style],
        data: { actor_id: studentId, quiz_id: quizId, course_id: courseId, score },
      })));
  } catch (e) {
    console.warn('notifyFriendsQuizDone failed:', e.message);
  }
}

module.exports = { notifyFriendsLessonDone, notifyFriendsQuizDone, BEAT_MAX_GAP, BELL_MAX_PER_DAY };
