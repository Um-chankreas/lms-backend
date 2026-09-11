const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, isStudent } = require('../middleware/auth');
const { awardXp, XP_VALUES, levelInfo } = require('../utils/xp');
const { recordActivity } = require('../utils/streak');
const { createNotification } = require('../utils/notifications');
const {
  CHALLENGE_TYPES,
  QUESTIONS_PER_CHALLENGE,
  pickRandom,
  dayKey,
  computeDifficultyAndSubjects,
  buildQuestionPool,
  synthesizeQuestions,
  gradeAnswers,
  getChallengeStreak,
  bumpStreakOnComplete,
} = require('../utils/dailyChallenge');

/**
 * Daily Challenge — one personalized, difficulty-tiered challenge per student
 * per calendar day. See sql/029_daily_challenges.sql and utils/dailyChallenge.js.
 * Distinct from the older flat daily-practice set at /api/quizzes/daily.
 *
 *   GET  /api/daily-challenge/today            today's challenge (creates it on first visit)
 *   POST /api/daily-challenge/submit           first attempt
 *   POST /api/daily-challenge/retake           any attempt after the first — reveals answers
 *   GET  /api/daily-challenge/history          last 7 days
 *   GET  /api/daily-challenge/result/:attemptId  one past attempt, full detail once revealed
 */

// Question shape sent for *playing* — never the answer key.
const forPlay = (q) => ({
  id: q.id, text: q.text, type: q.type, answerType: q.answerType || 'OPTIONS',
  options: q.options, statement: q.statement || null, sourceLabel: q.sourceLabel || null,
});

// Question shape sent once an attempt's answers may be shown.
const forReview = (q, answer) => ({
  questionId: q.id,
  text: q.text,
  statement: q.statement || null,
  options: q.options,
  studentAnswer: answer?.studentAnswer ?? null,
  isCorrect: !!answer?.isCorrect,
  correctAnswer: q.correctAnswer,
  explanation: q.explanation || null,
  learningResource: q.learningResource || null,
});

// Review with the answer key stripped — first-attempt result before any retake.
const forHiddenReview = (q, answer) => ({
  questionId: q.id,
  text: q.text,
  options: q.options,
  studentAnswer: answer?.studentAnswer ?? null,
  isCorrect: !!answer?.isCorrect,
});

async function loadTodayChallenge(studentId, today) {
  const { data } = await supabase
    .from('daily_challenges')
    .select('*')
    .eq('student_id', studentId)
    .eq('challenge_date', today)
    .maybeSingle();
  return data;
}

async function createTodayChallenge(studentId, today) {
  const { difficulty, xpBase, subjects } = await computeDifficultyAndSubjects(studentId);
  const type = pickRandom(CHALLENGE_TYPES, 1)[0];
  const pool = await buildQuestionPool(studentId, subjects, difficulty);
  const questions = pool.length > 0 ? synthesizeQuestions(type, pool, QUESTIONS_PER_CHALLENGE) : [];

  const { data, error } = await supabase
    .from('daily_challenges')
    .insert({
      id: uuidv4(),
      student_id: studentId,
      challenge_date: today,
      type,
      difficulty,
      subjects,
      questions,
      xp_base: xpBase,
      status: 'NOT_STARTED',
      created_at: new Date(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * GET /api/daily-challenge/today
 */
router.get('/today', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const today = dayKey();

    let challenge = await loadTodayChallenge(studentId, today);
    // Self-heal a stuck empty challenge (e.g. created before the student had
    // any reachable course) — same idea as the older /api/quizzes/daily.
    const emptyUnstarted = challenge && challenge.status === 'NOT_STARTED'
      && (!Array.isArray(challenge.questions) || challenge.questions.length === 0);
    if (!challenge || emptyUnstarted) {
      if (emptyUnstarted) await supabase.from('daily_challenges').delete().eq('id', challenge.id);
      challenge = await createTodayChallenge(studentId, today);
    }

    const [{ data: attempts }, streak] = await Promise.all([
      supabase
        .from('daily_challenge_attempts')
        .select('attempt_number, score, correct_count, total_questions, time_spent_seconds, xp_earned, created_at')
        .eq('challenge_id', challenge.id)
        .order('attempt_number', { ascending: true }),
      getChallengeStreak(studentId),
    ]);

    const questions = Array.isArray(challenge.questions) ? challenge.questions : [];
    const latestAttempt = (attempts || [])[attempts.length - 1] || null;

    let review = [];
    if (latestAttempt) {
      // The latest attempt's per-question answers, for either the hidden or
      // fully-revealed shape depending on whether a retake has happened yet.
      const { data: fullAttempt } = await supabase
        .from('daily_challenge_attempts')
        .select('answers')
        .eq('challenge_id', challenge.id)
        .eq('attempt_number', latestAttempt.attempt_number)
        .single();
      const answerById = Object.fromEntries((fullAttempt?.answers || []).map(a => [a.questionId, a]));
      review = questions.map(q =>
        challenge.revealed ? forReview(q, answerById[q.id]) : forHiddenReview(q, answerById[q.id])
      );
    }

    res.json({
      success: true,
      data: {
        id: challenge.id,
        date: challenge.challenge_date,
        type: challenge.type,
        difficulty: challenge.difficulty,
        subjects: challenge.subjects || [],
        xp_base: challenge.xp_base,
        total_questions: questions.length,
        questions: questions.map(forPlay),
        status: challenge.status,
        best_score: challenge.best_score,
        retake_count: challenge.retake_count,
        revealed: challenge.revealed,
        review,
        attempts: attempts || [],
        streak: { current: streak.current_streak, longest: streak.longest_streak },
      },
    });
  } catch (error) {
    console.error('Daily challenge fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch today\'s challenge: ' + error.message });
  }
});

/**
 * POST /api/daily-challenge/submit   Body: { answers, time_spent_seconds? }
 * First attempt only — answers are hidden in the response either way.
 */
router.post('/submit', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const today = dayKey();
    const { answers, time_spent_seconds } = req.body;
    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ success: false, error: 'answers is required' });
    }

    const challenge = await loadTodayChallenge(studentId, today);
    if (!challenge) {
      return res.status(404).json({ success: false, error: 'No challenge found for today. Fetch it first.' });
    }
    if (challenge.status !== 'NOT_STARTED') {
      return res.status(400).json({ success: false, error: 'Already completed today\'s challenge — use retake instead.' });
    }

    const questions = Array.isArray(challenge.questions) ? challenge.questions : [];
    const { correctCount, total, score, perQuestion } = gradeAnswers(questions, answers);

    const timeSpent = Number.isFinite(Number(time_spent_seconds)) ? Number(time_spent_seconds) : null;
    let xpEarned = challenge.xp_base;
    if (score === 100) xpEarned += XP_VALUES.DAILY_CHALLENGE_PERFECT_BONUS;
    if (timeSpent != null && timeSpent > 0 && timeSpent < 600) xpEarned += XP_VALUES.DAILY_CHALLENGE_SPEED_BONUS;

    const { error: attemptError } = await supabase.from('daily_challenge_attempts').insert({
      id: uuidv4(),
      challenge_id: challenge.id,
      student_id: studentId,
      attempt_number: 1,
      answers: perQuestion,
      score,
      correct_count: correctCount,
      total_questions: total,
      time_spent_seconds: timeSpent,
      xp_earned: xpEarned,
      created_at: new Date(),
    });
    if (attemptError) throw attemptError;

    const { error: updateError } = await supabase
      .from('daily_challenges')
      .update({ status: 'COMPLETED', best_score: score })
      .eq('id', challenge.id);
    if (updateError) throw updateError;

    if (xpEarned > 0) await awardXp(studentId, xpEarned, 'daily_challenge');
    await recordActivity(studentId).catch(() => {}); // general app-wide activity streak

    const streak = await bumpStreakOnComplete(studentId, today);
    let streakBonusXp = 0;
    if (streak.milestone) {
      streakBonusXp = XP_VALUES[`DAILY_CHALLENGE_STREAK_${streak.milestone}`] || 0;
      if (streakBonusXp > 0) await awardXp(studentId, streakBonusXp, 'daily_challenge_streak');
      await createNotification(studentId, 'daily_challenge_streak', {
        title: `🔥 ${streak.milestone}-day streak!`,
        body: `You've completed the Daily Challenge ${streak.milestone} days in a row — +${streakBonusXp} XP!`,
        data: { streak: streak.milestone },
      });
    }

    const { data: userXpRow } = await supabase.from('users').select('xp').eq('id', studentId).single();

    res.json({
      success: true,
      message: 'Daily challenge submitted',
      data: {
        score,
        correct_count: correctCount,
        total_questions: total,
        xp_awarded: xpEarned,
        streak_bonus_xp: streakBonusXp,
        streak: { current: streak.current_streak, longest: streak.longest_streak, milestone: streak.milestone },
        level: levelInfo(userXpRow?.xp || 0),
        revealed: false,
        review: questions.map(q => forHiddenReview(q, perQuestion.find(a => a.questionId === q.id))),
      },
    });
  } catch (error) {
    console.error('Daily challenge submit error:', error);
    res.status(500).json({ success: false, error: 'Failed to submit challenge: ' + error.message });
  }
});

/**
 * POST /api/daily-challenge/retake   Body: { answers, time_spent_seconds? }
 * Unlimited retakes, same question set. Only bonus XP (no double-counting
 * the base/perfect/speed rewards); reveals correct answers + explanations
 * from here on for today's challenge.
 */
router.post('/retake', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const today = dayKey();
    const { answers, time_spent_seconds } = req.body;
    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ success: false, error: 'answers is required' });
    }

    const challenge = await loadTodayChallenge(studentId, today);
    if (!challenge || challenge.status === 'NOT_STARTED') {
      return res.status(400).json({ success: false, error: 'Complete today\'s challenge once before retaking it.' });
    }

    const questions = Array.isArray(challenge.questions) ? challenge.questions : [];
    const { correctCount, total, score, perQuestion } = gradeAnswers(questions, answers);

    const { count: attemptCount } = await supabase
      .from('daily_challenge_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('challenge_id', challenge.id);
    const attemptNumber = (attemptCount || 0) + 1;

    const timeSpent = Number.isFinite(Number(time_spent_seconds)) ? Number(time_spent_seconds) : null;
    const improved = score > (challenge.best_score ?? 0);
    const xpEarned = improved ? XP_VALUES.DAILY_CHALLENGE_RETAKE_IMPROVED : 0;

    const { error: attemptError } = await supabase.from('daily_challenge_attempts').insert({
      id: uuidv4(),
      challenge_id: challenge.id,
      student_id: studentId,
      attempt_number: attemptNumber,
      answers: perQuestion,
      score,
      correct_count: correctCount,
      total_questions: total,
      time_spent_seconds: timeSpent,
      xp_earned: xpEarned,
      created_at: new Date(),
    });
    if (attemptError) throw attemptError;

    const { error: updateError } = await supabase
      .from('daily_challenges')
      .update({
        status: 'RETAKEN',
        revealed: true,
        retake_count: (challenge.retake_count || 0) + 1,
        best_score: Math.max(challenge.best_score ?? 0, score),
      })
      .eq('id', challenge.id);
    if (updateError) throw updateError;

    if (xpEarned > 0) await awardXp(studentId, xpEarned, 'daily_challenge_retake');

    const { data: userXpRow } = await supabase.from('users').select('xp').eq('id', studentId).single();

    res.json({
      success: true,
      message: 'Retake submitted',
      data: {
        score,
        correct_count: correctCount,
        total_questions: total,
        xp_awarded: xpEarned,
        improved,
        best_score: Math.max(challenge.best_score ?? 0, score),
        level: levelInfo(userXpRow?.xp || 0),
        revealed: true,
        review: questions.map(q => forReview(q, perQuestion.find(a => a.questionId === q.id))),
      },
    });
  } catch (error) {
    console.error('Daily challenge retake error:', error);
    res.status(500).json({ success: false, error: 'Failed to submit retake: ' + error.message });
  }
});

/**
 * GET /api/daily-challenge/history
 * The last 7 calendar days (including today), oldest first.
 */
router.get('/history', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const since = dayKey(new Date(Date.now() - 6 * 86400000));

    const { data: rows, error } = await supabase
      .from('daily_challenges')
      .select('challenge_date, status, best_score, type, difficulty, retake_count')
      .eq('student_id', studentId)
      .gte('challenge_date', since);
    if (error) throw error;

    const byDate = Object.fromEntries((rows || []).map(r => [String(r.challenge_date).slice(0, 10), r]));
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const date = dayKey(new Date(Date.now() - i * 86400000));
      const row = byDate[date];
      days.push({
        date,
        completed: !!row && row.status !== 'NOT_STARTED',
        retaken: !!row && row.retake_count > 0,
        score: row?.best_score ?? null,
        type: row?.type ?? null,
        difficulty: row?.difficulty ?? null,
      });
    }

    res.json({ success: true, data: { days } });
  } catch (error) {
    console.error('Daily challenge history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch history: ' + error.message });
  }
});

/**
 * GET /api/daily-challenge/result/:attemptId
 * One past attempt for this student, in full — correct answers/explanations
 * only if its challenge has been revealed (i.e. retaken at least once).
 */
router.get('/result/:attemptId', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const { data: attempt, error } = await supabase
      .from('daily_challenge_attempts')
      .select('*, daily_challenges(*)')
      .eq('id', req.params.attemptId)
      .eq('student_id', studentId)
      .single();
    if (error || !attempt) {
      return res.status(404).json({ success: false, error: 'Attempt not found' });
    }

    const challenge = attempt.daily_challenges;
    const questions = Array.isArray(challenge?.questions) ? challenge.questions : [];
    const answerById = Object.fromEntries((attempt.answers || []).map(a => [a.questionId, a]));
    const revealed = !!challenge?.revealed;

    res.json({
      success: true,
      data: {
        attempt_number: attempt.attempt_number,
        score: attempt.score,
        correct_count: attempt.correct_count,
        total_questions: attempt.total_questions,
        time_spent_seconds: attempt.time_spent_seconds,
        xp_earned: attempt.xp_earned,
        created_at: attempt.created_at,
        revealed,
        review: questions.map(q => (revealed ? forReview(q, answerById[q.id]) : forHiddenReview(q, answerById[q.id]))),
      },
    });
  } catch (error) {
    console.error('Daily challenge result error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch attempt: ' + error.message });
  }
});

module.exports = router;
