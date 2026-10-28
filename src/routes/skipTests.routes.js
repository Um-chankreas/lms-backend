const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const { hasCourseAccess, ensureEnrolled } = require('../utils/access');
const { pickRandom, optionsFor, answersMatch } = require('../utils/quizGrading');
const { awardGold, getGold, GOLD_TEST_OUT } = require('../utils/gold');
const { grantBadge, evaluateAchievements } = require('../utils/achievements');
const { checkChapterAutoComplete } = require('../utils/progress');
const { recordActivity } = require('../utils/streak');

const router = express.Router();

/**
 * Skip tests ("test out", Duolingo-style) — sql/059_skip_tests.sql.
 *
 *   units   after a good practice score, skip the NEXT TWO unread units by
 *           passing a 3-question test of hard questions (at most 1 mistake).
 *   chapter skip the rest of a chapter by passing a 10-question test of hard
 *           questions drawn from its units (70% correct, at most 3 mistakes).
 *
 * Questions come from the units' own quiz banks, filtered to difficulty
 * "Hard". The server remembers which questions it served (skip_test_attempts)
 * and grades against exactly those, so an unanswered question counts as a
 * mistake. Passing marks the skipped units done (no unit-read XP) and counts
 * their practice quizzes as passed so the chapter can auto-complete.
 *
 *   GET  /api/skip-tests/offer?unit_id=|quiz_id=  offer after passing that unit's practice
 *   GET  /api/skip-tests/offer?lesson_id= chapter skip offer
 *   GET  /api/skip-tests/offer?lesson_id=&scope=units  the same units offer, for the learning path:
 *                                         standing as long as the latest thing done in the chapter
 *                                         was a practice passed with a great score
 *   POST /api/skip-tests/start            { scope, lesson_id, unit_ids? } -> questions
 *   POST /api/skip-tests/:id/check        { question_id, answer } -> is_correct + the right answer, one question at a time
 *   POST /api/skip-tests/:id/submit       { answers: { questionId: answer } }
 */

const UNITS_TEST = { count: 3, maxMistakes: 1, maxUnits: 2 };
// 10 hard questions, pass with 70% correct (at most 3 mistakes).
const CHAPTER_TEST = { count: 10, maxMistakes: 3 };
const GOLD_UNITS = GOLD_TEST_OUT;       // 10
const GOLD_CHAPTER = GOLD_TEST_OUT * 2; // 20
const GOOD_SCORE = 80; // a practice passed at this score or better earns the units offer
const isHard = (q) => String(q.difficulty || '').toLowerCase() === 'hard';

/** Student + lesson + course-access gate. Returns { lesson } or sends the error. */
async function loadLessonForStudent(req, res, lessonId) {
  if (req.user.role !== 'student') {
    res.status(403).json({ success: false, error: 'Skip tests are for students' });
    return null;
  }
  const { data: lesson } = await supabase
    .from('lessons')
    .select('id, title, course_id, courses(id, is_free, teacher_id)')
    .eq('id', lessonId)
    .maybeSingle();
  if (!lesson) {
    res.status(404).json({ success: false, error: 'Chapter not found' });
    return null;
  }
  await ensureEnrolled({ supabase, course: lesson.courses, user: req.user });
  const access = await hasCourseAccess({ supabase, course: lesson.courses, user: req.user });
  if (!access) {
    res.status(403).json({ success: false, error: 'Enroll in this course first' });
    return null;
  }
  return { lesson };
}

/**
 * A chapter's units with what the student has already finished, plus each
 * unit's practice quiz id. Done = read, or its practice quiz passed.
 */
async function loadChapterState(lessonId, studentId) {
  const { data: units } = await supabase
    .from('lesson_units')
    .select('id, title, order_number')
    .eq('lesson_id', lessonId)
    .order('order_number', { ascending: true });
  const unitIds = (units || []).map(u => u.id);
  if (unitIds.length === 0) return { units: [], quizByUnit: new Map(), doneUnits: new Set() };

  const [{ data: completions }, { data: quizzes }] = await Promise.all([
    supabase.from('unit_completions').select('unit_id').eq('student_id', studentId).in('unit_id', unitIds),
    supabase.from('quizzes').select('id, unit_id').in('unit_id', unitIds).eq('status', 'published').order('created_at', { ascending: true }),
  ]);

  const quizByUnit = new Map(); // one canonical (earliest published) quiz per unit
  (quizzes || []).forEach(q => { if (!quizByUnit.has(q.unit_id)) quizByUnit.set(q.unit_id, q.id); });

  const quizIds = [...quizByUnit.values()];
  let passed = new Set();
  if (quizIds.length > 0) {
    const { data: subs } = await supabase
      .from('quiz_submissions').select('quiz_id').eq('student_id', studentId).eq('passed', true).in('quiz_id', quizIds);
    passed = new Set((subs || []).map(s => s.quiz_id));
  }

  const doneUnits = new Set();
  const completed = new Set((completions || []).map(c => c.unit_id));
  for (const u of units) {
    if (completed.has(u.id) || passed.has(quizByUnit.get(u.id))) doneUnits.add(u.id);
  }
  return { units, quizByUnit, doneUnits };
}

/** Hard questions in the practice quizzes of `unitIds` (answer key included). */
async function hardPool(unitIds, quizByUnit) {
  const quizIds = unitIds.map(id => quizByUnit.get(id)).filter(Boolean);
  if (quizIds.length === 0) return [];
  const { data } = await supabase
    .from('quiz_questions')
    .select('id, quiz_id, question, options, correct_answer, explanation, question_type, difficulty')
    .in('quiz_id', quizIds);
  return (data || []).filter(isHard);
}

/** The units a "units" test would skip: the next two unread units after `afterOrder` with a quiz. */
function nextUnitsToSkip(state, afterOrder = -Infinity) {
  return state.units
    .filter(u => u.order_number > afterOrder && !state.doneUnits.has(u.id) && state.quizByUnit.has(u.id))
    .slice(0, UNITS_TEST.maxUnits);
}

const offerShape = (scope, lesson, units, test) => ({
  scope,
  lesson_id: lesson.id,
  lesson_title: lesson.title,
  unit_ids: units.map(u => u.id),
  unit_titles: units.map(u => u.title),
  question_count: test.count,
  max_mistakes: test.maxMistakes,
});

router.get('/offer', authenticateToken, async (req, res) => {
  try {
    const { quiz_id: quizId, lesson_id: lessonIdParam } = req.query;
    let unitId = req.query.unit_id ? String(req.query.unit_id) : null;
    let lessonId = lessonIdParam ? String(lessonIdParam) : null;
    let afterOrder = -Infinity;

    // The app knows the quiz it just finished, not necessarily its unit.
    if (quizId && !unitId) {
      const { data: quiz } = await supabase.from('quizzes').select('unit_id').eq('id', String(quizId)).maybeSingle();
      if (!quiz?.unit_id) return res.json({ success: true, data: { offer: null } }); // a chapter quiz: nothing to skip after it
      unitId = quiz.unit_id;
    }

    if (unitId) {
      const { data: unit } = await supabase
        .from('lesson_units').select('id, lesson_id, order_number').eq('id', unitId).maybeSingle();
      if (!unit) return res.status(404).json({ success: false, error: 'Unit not found' });
      lessonId = unit.lesson_id;
      afterOrder = unit.order_number;
    }
    if (!lessonId) return res.status(400).json({ success: false, error: 'unit_id, quiz_id or lesson_id is required' });

    const ctx = await loadLessonForStudent(req, res, lessonId);
    if (!ctx) return;

    const state = await loadChapterState(lessonId, req.user.userId);
    let offer = null;

    if (unitId) {
      const targets = nextUnitsToSkip(state, afterOrder);
      if (targets.length > 0) {
        const pool = await hardPool(targets.map(u => u.id), state.quizByUnit);
        if (pool.length >= UNITS_TEST.count) offer = offerShape('units', ctx.lesson, targets, UNITS_TEST);
      }
    } else if (req.query.scope === 'units') {
      // Learning-path version of the post-quiz offer: it stands for as long as the most recent thing
      // the student did in this chapter was a unit practice passed with a great score — read or
      // finish anything later, or skip, and it's gone.
      const quizToUnit = new Map([...state.quizByUnit.entries()].map(([uid, qid]) => [qid, uid]));
      const quizIds = [...quizToUnit.keys()];
      if (quizIds.length > 0) {
        const { data: subs } = await supabase
          .from('quiz_submissions')
          .select('quiz_id, score, submitted_at')
          .eq('student_id', req.user.userId).eq('passed', true).in('quiz_id', quizIds)
          .order('submitted_at', { ascending: false }).limit(1);
        const last = subs?.[0];
        const lastUnit = last ? state.units.find(u => u.id === quizToUnit.get(last.quiz_id)) : null;
        if (lastUnit && last.score >= GOOD_SCORE) {
          const laterDone = state.units.some(u => u.order_number > lastUnit.order_number && state.doneUnits.has(u.id));
          const targets = laterDone ? [] : nextUnitsToSkip(state, lastUnit.order_number);
          if (targets.length > 0) {
            const pool = await hardPool(targets.map(u => u.id), state.quizByUnit);
            if (pool.length >= UNITS_TEST.count) offer = offerShape('units', ctx.lesson, targets, UNITS_TEST);
          }
        }
      }
    } else {
      const { data: done } = await supabase
        .from('lesson_completions').select('id').eq('lesson_id', lessonId).eq('student_id', req.user.userId).maybeSingle();
      const targets = state.units.filter(u => !state.doneUnits.has(u.id) && state.quizByUnit.has(u.id));
      if (!done && targets.length > 0) {
        const pool = await hardPool(targets.map(u => u.id), state.quizByUnit);
        if (pool.length >= CHAPTER_TEST.count) offer = offerShape('chapter', ctx.lesson, targets, CHAPTER_TEST);
      }
    }

    res.json({ success: true, data: { offer } });
  } catch (err) {
    console.error('Skip-test offer error:', err);
    res.status(500).json({ success: false, error: 'Failed to check skip test' });
  }
});

router.post('/start', authenticateToken, async (req, res) => {
  try {
    const { scope, lesson_id: lessonId, unit_ids: requestedUnitIds } = req.body || {};
    if (!['units', 'chapter'].includes(scope) || !lessonId) {
      return res.status(400).json({ success: false, error: 'scope (units | chapter) and lesson_id are required' });
    }
    const ctx = await loadLessonForStudent(req, res, lessonId);
    if (!ctx) return;

    const state = await loadChapterState(lessonId, req.user.userId);
    const test = scope === 'units' ? UNITS_TEST : CHAPTER_TEST;

    let targets;
    if (scope === 'units') {
      const wanted = new Set(Array.isArray(requestedUnitIds) ? requestedUnitIds.map(String) : []);
      targets = state.units
        .filter(u => wanted.has(u.id) && !state.doneUnits.has(u.id) && state.quizByUnit.has(u.id))
        .slice(0, UNITS_TEST.maxUnits);
    } else {
      targets = state.units.filter(u => !state.doneUnits.has(u.id) && state.quizByUnit.has(u.id));
    }
    if (targets.length === 0) {
      return res.status(409).json({ success: false, error: 'There is nothing left to skip here' });
    }

    const pool = await hardPool(targets.map(u => u.id), state.quizByUnit);
    if (pool.length < test.count) {
      return res.status(409).json({ success: false, error: 'Not enough hard questions to build a skip test for this' });
    }
    const questions = pickRandom(pool, test.count);

    const attemptId = uuidv4();
    const { error } = await supabase.from('skip_test_attempts').insert({
      id: attemptId,
      student_id: req.user.userId,
      scope,
      lesson_id: lessonId,
      unit_ids: targets.map(u => u.id),
      question_ids: questions.map(q => q.id),
      max_mistakes: test.maxMistakes,
      created_at: new Date(),
    });
    if (error) throw error;

    res.status(201).json({
      success: true,
      data: {
        attempt_id: attemptId,
        scope,
        lesson_id: lessonId,
        unit_titles: targets.map(u => u.title),
        max_mistakes: test.maxMistakes,
        questions: questions.map(q => {
          const options = typeof q.options === 'string' ? JSON.parse(q.options) : q.options;
          return {
            id: q.id,
            question: q.question,
            question_type: q.question_type,
            difficulty: q.difficulty,
            options: optionsFor(q, options),
          };
        }),
      },
    });
  } catch (err) {
    console.error('Skip-test start error:', err);
    res.status(500).json({ success: false, error: 'Failed to start the skip test' });
  }
});

/** A quiz pass that is not an attempt: lets the chapter auto-complete logic count the quiz as passed. */
async function markQuizPassed(studentId, quizId, score) {
  const { data: existing } = await supabase
    .from('quiz_submissions').select('id').eq('quiz_id', quizId).eq('student_id', studentId).eq('passed', true).limit(1).maybeSingle();
  if (existing) return;
  await supabase.from('quiz_submissions').insert({
    id: uuidv4(), quiz_id: quizId, student_id: studentId,
    answers: '{}', score, passed: true, submitted_at: new Date(),
  });
}

/** Everything a passed skip test does to the student's progress. */
async function applySkip({ attempt, courseId, score, studentId }) {
  const state = await loadChapterState(attempt.lesson_id, studentId);

  for (const unitId of attempt.unit_ids) {
    const { data: read } = await supabase
      .from('unit_completions').select('id').eq('unit_id', unitId).eq('student_id', studentId).maybeSingle();
    // Marked done without the unit-read XP: a skipped topic pays less than reading it.
    if (!read) await supabase.from('unit_completions').insert({ id: uuidv4(), unit_id: unitId, student_id: studentId, completed_at: new Date() });
    const quizId = state.quizByUnit.get(unitId);
    if (quizId) await markQuizPassed(studentId, quizId, score);
  }

  if (attempt.scope === 'chapter') {
    // The chapter's own end-of-lesson quiz is skipped with it.
    const { data: lessonQuiz } = await supabase
      .from('quizzes').select('id').eq('lesson_id', attempt.lesson_id).is('unit_id', null).eq('status', 'published')
      .order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (lessonQuiz) await markQuizPassed(studentId, lessonQuiz.id, score);
  }

  await awardGold(studentId, attempt.scope === 'chapter' ? GOLD_CHAPTER : GOLD_UNITS, 'test_out', courseId);
  await grantBadge(studentId, 'first_skip');
  await recordActivity(studentId).catch(() => { });
  await evaluateAchievements(studentId);
  return checkChapterAutoComplete({ lessonId: attempt.lesson_id, studentId });
}

/**
 * POST /api/skip-tests/:id/check   { question_id, answer }
 * Grades ONE served question so the app can show right/wrong (and the right answer) as the student
 * goes, like the practice quiz's /check. Persists nothing — /submit still grades the whole attempt.
 */
router.post('/:id/check', authenticateToken, async (req, res) => {
  try {
    const { question_id: questionId, answer } = req.body || {};
    if (!questionId) return res.status(400).json({ success: false, error: 'question_id is required' });

    const { data: attempt } = await supabase
      .from('skip_test_attempts').select('id, question_ids, submitted_at').eq('id', req.params.id).eq('student_id', req.user.userId).maybeSingle();
    if (!attempt) return res.status(404).json({ success: false, error: 'Skip test not found' });
    if (attempt.submitted_at) return res.status(409).json({ success: false, error: 'This skip test was already submitted' });
    // Only questions this attempt actually served can be looked up.
    if (!attempt.question_ids.includes(String(questionId))) {
      return res.status(400).json({ success: false, error: 'That question is not part of this skip test' });
    }

    const { data: q } = await supabase
      .from('quiz_questions').select('id, correct_answer, explanation, question_type').eq('id', questionId).maybeSingle();
    if (!q) return res.status(404).json({ success: false, error: 'Question not found' });

    res.json({
      success: true,
      data: {
        question_id: q.id,
        is_correct: answersMatch(answer ?? null, q.correct_answer, q.question_type),
        correct_answer: q.correct_answer,
        explanation: q.explanation || null,
      },
    });
  } catch (err) {
    console.error('Skip-test check error:', err);
    res.status(500).json({ success: false, error: 'Failed to check answer' });
  }
});

router.post('/:id/submit', authenticateToken, async (req, res) => {
  try {
    const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};

    const { data: attempt } = await supabase
      .from('skip_test_attempts').select('*').eq('id', req.params.id).eq('student_id', req.user.userId).maybeSingle();
    if (!attempt) return res.status(404).json({ success: false, error: 'Skip test not found' });
    if (attempt.submitted_at) return res.status(409).json({ success: false, error: 'This skip test was already submitted' });

    const { data: questions } = await supabase
      .from('quiz_questions')
      .select('id, question, correct_answer, explanation, question_type')
      .in('id', attempt.question_ids);
    const byId = Object.fromEntries((questions || []).map(q => [q.id, q]));

    // Grade exactly the questions that were served; an unanswered one is a mistake.
    const review = attempt.question_ids.map(qid => {
      const q = byId[qid];
      const studentAnswer = answers[qid] ?? null;
      return {
        question_id: qid,
        question: q?.question || '',
        student_answer: studentAnswer,
        correct_answer: q?.correct_answer ?? null,
        is_correct: !!q && answersMatch(studentAnswer, q.correct_answer, q.question_type),
        explanation: q?.explanation || null,
      };
    });
    const total = review.length;
    const correct = review.filter(r => r.is_correct).length;
    const mistakes = total - correct;
    const passed = mistakes <= attempt.max_mistakes;
    const score = total > 0 ? Math.round((correct / total) * 100) : 0;

    // Claim the attempt first so a double submit can't apply the skip twice.
    const { data: claimed } = await supabase
      .from('skip_test_attempts')
      .update({ submitted_at: new Date(), score, passed })
      .eq('id', attempt.id)
      .is('submitted_at', null)
      .select('id');
    if (!claimed || claimed.length === 0) {
      return res.status(409).json({ success: false, error: 'This skip test was already submitted' });
    }

    let chapterCompleted = false;
    if (passed) {
      const { data: lesson } = await supabase.from('lessons').select('course_id').eq('id', attempt.lesson_id).maybeSingle();
      chapterCompleted = await applySkip({ attempt, courseId: lesson?.course_id || null, score, studentId: req.user.userId });
    }

    res.json({
      success: true,
      data: {
        passed,
        score,
        correct,
        total,
        mistakes,
        max_mistakes: attempt.max_mistakes,
        scope: attempt.scope,
        lesson_id: attempt.lesson_id,
        skipped_unit_ids: passed ? attempt.unit_ids : [],
        chapter_completed: chapterCompleted,
        gold: await getGold(req.user.userId),
        review,
      },
    });
  } catch (err) {
    console.error('Skip-test submit error:', err);
    res.status(500).json({ success: false, error: 'Failed to submit the skip test' });
  }
});

module.exports = router;
