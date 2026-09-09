const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { awardXp, XP_VALUES } = require('./xp');
const { notifyLessonComplete } = require('./notifyEvents');

/**
 * A chapter auto-completes (inserts lesson_completions + awards
 * LESSON_COMPLETE XP, same as the old manual mark-complete) the moment every
 * one of its units has been read (unit_completions), every one of those
 * units' own quizzes has been passed, AND the chapter's own end-of-lesson
 * quiz (if it has one) has been passed. Called after POST
 * /api/units/:id/complete and after any lesson/unit quiz is passed. No-op for
 * a chapter with no units yet (those still use the manual POST
 * /api/lessons/:id/mark-complete).
 *
 * Returns true if this call is what completed the chapter.
 */
async function checkChapterAutoComplete({ lessonId, studentId }) {
  const { data: already } = await supabase
    .from('lesson_completions')
    .select('id')
    .eq('lesson_id', lessonId)
    .eq('student_id', studentId)
    .maybeSingle();
  if (already) return false;

  const { data: units } = await supabase
    .from('lesson_units')
    .select('id')
    .eq('lesson_id', lessonId);
  if (!units || units.length === 0) return false;

  const unitIds = units.map(u => u.id);

  const [{ data: completions }, { data: quizzes }] = await Promise.all([
    supabase.from('unit_completions').select('unit_id').eq('student_id', studentId).in('unit_id', unitIds),
    supabase.from('quizzes').select('id, unit_id, created_at').in('unit_id', unitIds).eq('status', 'published').order('created_at', { ascending: true })
  ]);

  const completedUnitIds = new Set((completions || []).map(c => c.unit_id));
  if (unitIds.some(id => !completedUnitIds.has(id))) return false; // not every unit read yet

  // One canonical quiz per unit — the earliest published one.
  const canonicalQuizIds = [];
  const seenUnit = new Set();
  (quizzes || []).forEach(q => {
    if (seenUnit.has(q.unit_id)) return;
    seenUnit.add(q.unit_id);
    canonicalQuizIds.push(q.id);
  });

  if (canonicalQuizIds.length > 0) {
    const { data: submissions } = await supabase
      .from('quiz_submissions')
      .select('quiz_id')
      .eq('student_id', studentId)
      .eq('passed', true)
      .in('quiz_id', canonicalQuizIds);
    const passedQuizIds = new Set((submissions || []).map(s => s.quiz_id));
    if (canonicalQuizIds.some(id => !passedQuizIds.has(id))) return false; // a unit quiz still unpassed
  }

  // The chapter's own end-of-lesson quiz (lesson_id set, no unit_id) — the
  // final path step before the chest — must also be passed. It's optional
  // content: a chapter without one still completes on units + unit quizzes.
  const { data: lessonQuiz } = await supabase
    .from('quizzes')
    .select('id')
    .eq('lesson_id', lessonId)
    .is('unit_id', null)
    .eq('status', 'published')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (lessonQuiz) {
    const { data: lessonQuizPass } = await supabase
      .from('quiz_submissions')
      .select('id')
      .eq('student_id', studentId)
      .eq('quiz_id', lessonQuiz.id)
      .eq('passed', true)
      .limit(1)
      .maybeSingle();
    if (!lessonQuizPass) return false; // end-of-lesson quiz still unpassed
  }

  const { error } = await supabase
    .from('lesson_completions')
    .insert({ id: uuidv4(), lesson_id: lessonId, student_id: studentId, completed_at: new Date() });
  if (error) return false; // lost a race with a duplicate call — harmless

  const { data: lessonRow } = await supabase
    .from('lessons').select('course_id').eq('id', lessonId).maybeSingle();
  await awardXp(studentId, XP_VALUES.LESSON_COMPLETE, 'lesson_complete', lessonRow?.course_id || null);
  await require('./streak').recordActivity(studentId).catch(() => {});
  notifyLessonComplete(studentId, lessonId); // owner + friends "lesson complete"
  return true;
}

// Score (0-100) -> 0-3 stars. Shared by the lesson-list path and the
// per-lesson step path so both rate quiz performance the same way.
function starsForScore(score) {
  if (score == null) return null;
  if (score >= 90) return 3;
  if (score >= 70) return 2;
  return 1; // any attempt, however low — showed up
}

module.exports = { checkChapterAutoComplete, starsForScore };
