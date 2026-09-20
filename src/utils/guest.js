const supabase = require('../config/supabase');

// How many path step-nodes a signed-out guest may sample per course before
// they're asked to create an account. "Step" = any content node on the path
// (a unit, a unit practice quiz, a lesson's end-of-lesson quiz, or a
// unit-less lesson) — chests don't count.
const GUEST_FREE_STEPS = 2;

/**
 * The ordered list of step keys for a course, matching the order the path
 * endpoints emit nodes in (chests excluded). Walk lessons in order; for each
 * lesson walk its units in order, each unit followed by its canonical
 * practice quiz; then the lesson's own end-of-lesson quiz. A lesson with no
 * authored units contributes a single `lesson:<id>` step.
 *
 * Keys: `lesson:<lessonId>` | `unit:<unitId>` | `quiz:<quizId>`
 */
async function courseStepKeys(courseId) {
  const { data: lessons } = await supabase
    .from('lessons')
    .select('id')
    .eq('course_id', courseId)
    .order('order_number', { ascending: true })
    .order('created_at', { ascending: true });

  const lessonIds = (lessons || []).map(l => l.id);
  if (lessonIds.length === 0) return [];

  const [{ data: units }, { data: quizzes }] = await Promise.all([
    supabase
      .from('lesson_units')
      .select('id, lesson_id, order_number')
      .in('lesson_id', lessonIds)
      .order('order_number', { ascending: true }),
    supabase
      .from('quizzes')
      .select('id, lesson_id, unit_id, created_at')
      .in('lesson_id', lessonIds)
      .eq('status', 'published')
      .order('created_at', { ascending: true }),
  ]);

  const unitsByLesson = new Map();
  (units || []).forEach(u => {
    if (!unitsByLesson.has(u.lesson_id)) unitsByLesson.set(u.lesson_id, []);
    unitsByLesson.get(u.lesson_id).push(u);
  });

  const canonicalUnitQuiz = new Map();   // unitId  -> quizId (earliest published)
  const lessonEndQuiz = new Map();       // lessonId -> quizId
  (quizzes || []).forEach(q => {
    if (q.unit_id) {
      if (!canonicalUnitQuiz.has(q.unit_id)) canonicalUnitQuiz.set(q.unit_id, q.id);
    } else if (!lessonEndQuiz.has(q.lesson_id)) {
      lessonEndQuiz.set(q.lesson_id, q.id);
    }
  });

  const keys = [];
  for (const lessonId of lessonIds) {
    const us = (unitsByLesson.get(lessonId) || [])
      .slice()
      .sort((a, b) => (a.order_number || 0) - (b.order_number || 0));

    if (us.length === 0) {
      keys.push(`lesson:${lessonId}`);
    } else {
      for (const u of us) {
        keys.push(`unit:${u.id}`);
        const qz = canonicalUnitQuiz.get(u.id);
        if (qz) keys.push(`quiz:${qz}`);
      }
    }
    const lq = lessonEndQuiz.get(lessonId);
    if (lq) keys.push(`quiz:${lq}`);
  }
  return keys;
}

/**
 * Which step keys of a course are free for a guest — the first
 * GUEST_FREE_STEPS of courseStepKeys().
 */
async function guestFreeStepKeys(courseId) {
  return (await courseStepKeys(courseId)).slice(0, GUEST_FREE_STEPS);
}

/** Is `key` (e.g. "unit:<id>") one a signed-out guest may open in this course? */
async function guestCanAccessStep(courseId, key) {
  const free = await guestFreeStepKeys(courseId);
  return free.includes(key);
}

/** Send the standard 403 that the mobile app turns into the sign-up wall. */
function sendGuestWall(res) {
  return res.status(403).json({
    success: false,
    code: 'GUEST_WALL',
    error: 'Create a free account to keep learning.',
    data: { free_steps: GUEST_FREE_STEPS },
  });
}

module.exports = {
  GUEST_FREE_STEPS,
  courseStepKeys,
  guestFreeStepKeys,
  guestCanAccessStep,
  sendGuestWall,
};
