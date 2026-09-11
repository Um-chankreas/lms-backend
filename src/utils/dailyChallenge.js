const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { levelInfo, DAILY_CHALLENGE_XP_BY_DIFFICULTY } = require('./xp');

// ─────────────────────────────────────────────────────────────────────────────
// Daily Challenge: a personalized, difficulty-tiered daily challenge (see
// sql/029_daily_challenges.sql). All 5 challenge types are synthesized from
// the existing quiz_questions bank (there's no separate riddle/matching
// content model, and no request to build teachers one) — grading is uniform
// across every type: one correct string, compared for exact equality. Only
// the *presentation* differs client-side (timer emphasis, riddle framing,
// paired columns, True/False).
// ─────────────────────────────────────────────────────────────────────────────

const QUESTIONS_PER_CHALLENGE = 10;
// Of the questions drawn, roughly this share is remedial (from quizzes the
// student failed) and this share is reinforcement (from lessons/units they
// most recently completed) — the rest fills randomly from the wider pool.
const FAILED_SHARE = 0.4;
const RECENT_SHARE = 0.3;
const RECENT_LOOKBACK = 10; // most recent N lesson/unit completions each
// MATCHING deliberately excluded from the daily rotation (2026-09-11, at the
// user's request) — every other type is a plain "pick an option or type a
// number" QCM-style interaction; Matching's two-column board is a different
// enough interaction that it's opted out for now. synthesizeQuestions() below
// still knows how to build a MATCHING challenge if this list changes again.
const CHALLENGE_TYPES = ['MULTIPLE_CHOICE', 'SPEED', 'PUZZLE', 'TRUE_FALSE'];

function pickRandom(arr, n) {
  const pool = [...arr];
  const picked = [];
  while (pool.length > 0 && picked.length < n) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

function dayKey(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Every category `studentId` was active in (lesson finished, unit finished,
 * or a quiz submitted) on their single most recent active day — across
 * lessons/units/quizzes, not just this feature. Returns `null` when there's
 * no activity at all in the lookback window (brand-new student).
 */
async function mostRecentActiveCategories(studentId) {
  const [{ data: lessonRows }, { data: unitRows }, { data: quizRows }] = await Promise.all([
    supabase
      .from('lesson_completions')
      .select('completed_at, lessons(courses(category))')
      .eq('student_id', studentId)
      .order('completed_at', { ascending: false })
      .limit(20),
    supabase
      .from('unit_completions')
      .select('completed_at, lesson_units(lessons(courses(category)))')
      .eq('student_id', studentId)
      .order('completed_at', { ascending: false })
      .limit(20),
    supabase
      .from('quiz_submissions')
      .select('submitted_at, quizzes(courses(category))')
      .eq('student_id', studentId)
      .order('submitted_at', { ascending: false })
      .limit(20),
  ]);

  const events = [
    ...(lessonRows || []).map(r => ({ day: dayKey(r.completed_at), category: r.lessons?.courses?.category })),
    ...(unitRows || []).map(r => ({ day: dayKey(r.completed_at), category: r.lesson_units?.lessons?.courses?.category })),
    ...(quizRows || []).map(r => ({ day: dayKey(r.submitted_at), category: r.quizzes?.courses?.category })),
  ].filter(e => e.category);
  if (events.length === 0) return null;

  const mostRecentDay = events.reduce((max, e) => (e.day > max ? e.day : max), events[0].day);
  return [...new Set(events.filter(e => e.day === mostRecentDay).map(e => e.category))];
}

/** Categories the student can reach at all (enrolled + free courses) — the
 * pool a random single subject is drawn from when there's no activity signal. */
async function reachableCategories(studentId) {
  const [{ data: enrollments }, { data: freeCourses }] = await Promise.all([
    supabase.from('course_enrollments').select('courses(category)').eq('student_id', studentId),
    supabase.from('courses').select('category').eq('is_free', true),
  ]);
  return [...new Set([
    ...(enrollments || []).map(e => e.courses?.category).filter(Boolean),
    ...(freeCourses || []).map(c => c.category).filter(Boolean),
  ])];
}

/**
 * Difficulty + subject mix for `studentId`'s next challenge.
 *
 * Subjects mirror how broad their most recent day of activity was: active in
 * 2+ categories (e.g. did Math and History) -> mix both again; active in
 * exactly one -> stay on that one; no signal at all (brand-new, or nothing in
 * the lookback window) -> one category picked at random. Never force a
 * second subject that wasn't actually there.
 *
 * Difficulty factors (per the brief): recent quiz average (last 5
 * quiz_submissions), yesterday's challenge score, and level (from lifetime
 * XP — there's no separate stored student.level).
 */
async function computeDifficultyAndSubjects(studentId) {
  const { data: recentSubs } = await supabase
    .from('quiz_submissions')
    .select('score')
    .eq('student_id', studentId)
    .order('submitted_at', { ascending: false })
    .limit(5);
  const recentScores = (recentSubs || []).map(s => s.score).filter(Number.isFinite);
  const recentAvg = recentScores.length ? recentScores.reduce((a, b) => a + b, 0) / recentScores.length : null;

  const recentActive = await mostRecentActiveCategories(studentId);
  let subjects;
  if (recentActive && recentActive.length >= 2) {
    subjects = pickRandom(recentActive, 2);
  } else if (recentActive && recentActive.length === 1) {
    subjects = recentActive;
  } else {
    const available = await reachableCategories(studentId);
    subjects = available.length ? pickRandom(available, 1) : [];
  }

  const yesterday = dayKey(new Date(Date.now() - 86400000));
  const { data: prevChallenge } = await supabase
    .from('daily_challenges')
    .select('best_score')
    .eq('student_id', studentId)
    .eq('challenge_date', yesterday)
    .maybeSingle();

  const { data: userRow } = await supabase.from('users').select('xp').eq('id', studentId).maybeSingle();
  const level = levelInfo(userRow?.xp || 0).level;

  // Blend recent quiz performance with yesterday's challenge score when both
  // exist; fall back to whichever one is available.
  let effectiveAvg = recentAvg;
  if (effectiveAvg == null) effectiveAvg = prevChallenge?.best_score ?? null;
  else if (prevChallenge?.best_score != null) effectiveAvg = (effectiveAvg * 2 + prevChallenge.best_score) / 3;

  let difficulty;
  if (effectiveAvg == null) {
    difficulty = level <= 2 ? 'EASY' : 'MEDIUM'; // brand-new student — ease them in
  } else if (effectiveAvg >= 95) difficulty = 'EXPERT';
  else if (effectiveAvg >= 90) difficulty = 'HARD';
  else if (effectiveAvg >= 75) difficulty = 'MEDIUM';
  else difficulty = 'EASY';

  return { difficulty, xpBase: DAILY_CHALLENGE_XP_BY_DIFFICULTY[difficulty], subjects };
}

/**
 * The pool of QCM quiz_questions this student can draw from: every course
 * they can reach (enrolled + free, same rule hasCourseAccess uses elsewhere),
 * narrowed to `subjects` and to `difficulty`'s tier when there's enough
 * tagged content — quiz_questions.difficulty only goes up to 'Hard', so
 * EXPERT reuses the Hard tier. Falls back a step at a time so a course with
 * untagged/single-subject content still gets a full challenge.
 *
 * Each row is also tagged `isFailed` (its quiz is one the student has failed
 * — remedial practice) and `isRecent` (its quiz belongs to a lesson/unit they
 * completed in their last {@link RECENT_LOOKBACK} — reinforcement while it's
 * fresh); selectChallengeQuestions() uses these to weight the draw.
 */
async function buildQuestionPool(studentId, subjects, difficulty) {
  const [{ data: enrollments }, { data: freeCourses }] = await Promise.all([
    supabase.from('course_enrollments').select('course_id').eq('student_id', studentId),
    supabase.from('courses').select('id').eq('is_free', true),
  ]);
  const courseIds = [...new Set([
    ...(enrollments || []).map(e => e.course_id),
    ...(freeCourses || []).map(c => c.id),
  ])];
  if (courseIds.length === 0) return [];

  const { data: courses } = await supabase.from('courses').select('id, category').in('id', courseIds);
  const categoryByCourse = Object.fromEntries((courses || []).map(c => [c.id, c.category]));

  const subjectCourseIds = (subjects || []).length
    ? courseIds.filter(id => subjects.includes(categoryByCourse[id]))
    : [];
  const poolCourseIds = subjectCourseIds.length ? subjectCourseIds : courseIds;

  const { data: quizzes } = await supabase
    .from('quizzes')
    .select('id, course_id, lesson_id, unit_id, title')
    .in('course_id', poolCourseIds)
    .eq('status', 'published');
  const quizIds = (quizzes || []).map(q => q.id);
  if (quizIds.length === 0) return [];
  const quizById = Object.fromEntries((quizzes || []).map(q => [q.id, q]));

  const [{ data: questions }, { data: recentLessons }, { data: recentUnits }, { data: failedSubs }] = await Promise.all([
    supabase
      .from('quiz_questions')
      .select('id, quiz_id, question, options, correct_answer, explanation, difficulty, question_type')
      .in('quiz_id', quizIds)
      .in('question_type', ['QCM', 'number_input']),
    supabase
      .from('lesson_completions')
      .select('lesson_id, completed_at')
      .eq('student_id', studentId)
      .order('completed_at', { ascending: false })
      .limit(RECENT_LOOKBACK),
    supabase
      .from('unit_completions')
      .select('unit_id, completed_at')
      .eq('student_id', studentId)
      .order('completed_at', { ascending: false })
      .limit(RECENT_LOOKBACK),
    supabase
      .from('quiz_submissions')
      .select('quiz_id')
      .eq('student_id', studentId)
      .eq('passed', false),
  ]);

  const recentLessonIds = new Set((recentLessons || []).map(r => r.lesson_id));
  const recentUnitIds = new Set((recentUnits || []).map(r => r.unit_id));
  const failedQuizIds = new Set((failedSubs || []).map(r => r.quiz_id));

  const rows = (questions || [])
    .map(q => {
      const quiz = quizById[q.quiz_id];
      const category = categoryByCourse[quiz?.course_id] || null;
      const rawOptions = typeof q.options === 'string' ? JSON.parse(q.options) : q.options;
      return {
        ...q,
        options: Array.isArray(rawOptions) ? rawOptions : [], // number_input rows carry none
        category,
        // Shown as a small tag above the question — which lesson/chapter this
        // is testing, same idea as the old daily-quiz screen's quiz_title tag.
        sourceLabel: quiz?.title || category || null,
        isFailed: failedQuizIds.has(q.quiz_id),
        isRecent: !!quiz && (recentLessonIds.has(quiz.lesson_id) || recentUnitIds.has(quiz.unit_id)),
      };
    })
    .filter(q => q.correct_answer && (
      q.question_type === 'number_input' || (Array.isArray(q.options) && q.options.length >= 2)
    ));

  if (rows.length === 0) return [];

  const targetTier = difficulty === 'EXPERT' ? 'hard' : String(difficulty).toLowerCase();
  const tiered = rows.filter(q => q.difficulty && q.difficulty.toLowerCase() === targetTier);
  return tiered.length >= QUESTIONS_PER_CHALLENGE ? tiered : rows;
}

/**
 * Draws `count` questions from `pool`, weighted toward material worth
 * revisiting: ~{@link FAILED_SHARE} from quizzes the student has failed
 * (remedial) and ~{@link RECENT_SHARE} from lessons/units they most recently
 * completed (reinforcement), topping up the rest at random from whatever's
 * left. Falls back to a plain random draw when the pool is too small for the
 * split to matter.
 */
function selectChallengeQuestions(pool, count) {
  if (pool.length <= count) return [...pool];

  const failed = pool.filter(q => q.isFailed);
  const recent = pool.filter(q => q.isRecent && !q.isFailed);
  const rest = pool.filter(q => !q.isFailed && !q.isRecent);

  const picked = pickRandom(failed, Math.min(failed.length, Math.round(count * FAILED_SHARE)));
  picked.push(...pickRandom(recent, Math.min(recent.length, Math.round(count * RECENT_SHARE))));

  const pickedIds = new Set(picked.map(q => q.id));
  const fillPool = pool.filter(q => !pickedIds.has(q.id));
  picked.push(...pickRandom(fillPool, count - picked.length));

  return picked;
}

/**
 * Turns a pool of quiz_questions (QCM and/or number_input) into `count`
 * Question objects of the given challenge type. Grading is exact-match
 * everywhere (see the module comment above), except a NUMBER answerType
 * compares numerically (see gradeAnswers) the same way the regular quiz
 * screens tolerate "1955" vs "1,955".
 *
 * MATCHING and TRUE_FALSE need discrete options to build pairs/statements
 * from, so they only draw from QCM source questions; MULTIPLE_CHOICE/SPEED/
 * PUZZLE can present either shape — a number_input source becomes a
 * `answerType: 'NUMBER'` question (client shows a text field, no options).
 */
function synthesizeQuestions(type, pool, count = QUESTIONS_PER_CHALLENGE) {
  const sourcePool = (type === 'MATCHING' || type === 'TRUE_FALSE')
    ? pool.filter(q => q.question_type === 'QCM')
    : pool;
  const drawn = selectChallengeQuestions(sourcePool, Math.min(count, sourcePool.length));

  if (type === 'MATCHING') {
    // One shared right-hand column (every source's correct answer); each
    // question is "which right-hand item matches this left-hand one".
    const rightColumn = drawn.map(q => q.correct_answer);
    return drawn.map(q => ({
      id: uuidv4(),
      text: q.question,
      type,
      answerType: 'OPTIONS',
      options: rightColumn,
      correctAnswer: q.correct_answer,
      explanation: q.explanation || null,
      learningResource: null,
      sourceLabel: q.sourceLabel || null,
    }));
  }

  if (type === 'TRUE_FALSE') {
    return drawn.map(q => {
      const wrongOptions = q.options.filter(o => o !== q.correct_answer);
      const useCorrect = wrongOptions.length === 0 || Math.random() < 0.5;
      const statement = useCorrect ? q.correct_answer : wrongOptions[Math.floor(Math.random() * wrongOptions.length)];
      return {
        id: uuidv4(),
        text: q.question,
        // Kept separate from `text` — a client that renders both math and
        // plain text side-by-side (this app's MathText) doesn't honor an
        // embedded newline between them, so cramming "question\nstatement"
        // into one string put them on the same visual line. The client
        // renders this as its own distinct block instead.
        statement,
        type,
        answerType: 'OPTIONS',
        options: ['True', 'False'],
        correctAnswer: statement === q.correct_answer ? 'True' : 'False',
        explanation: q.explanation || null,
        learningResource: null,
        sourceLabel: q.sourceLabel || null,
      };
    });
  }

  // MULTIPLE_CHOICE, SPEED, PUZZLE — identical shape; only the client's
  // presentation differs (timer emphasis, riddle framing). A number_input
  // source has no options — the client renders a text field instead.
  return drawn.map(q => ({
    id: uuidv4(),
    text: q.question,
    type,
    answerType: q.question_type === 'number_input' ? 'NUMBER' : 'OPTIONS',
    options: q.options,
    correctAnswer: q.correct_answer,
    explanation: q.explanation || null,
    learningResource: null,
    sourceLabel: q.sourceLabel || null,
  }));
}

// Khmer digits → Arabic, then strip spaces / thousands separators / a
// leading +, same tolerance the regular quiz screens give a number_input
// answer (see quizzes.routes.js's normNumber).
const KHMER_DIGITS = { '០': '0', '១': '1', '២': '2', '៣': '3', '៤': '4', '៥': '5', '៦': '6', '៧': '7', '៨': '8', '៩': '9' };
const normNumber = (v) => String(v == null ? '' : v)
  .replace(/[០-៩]/g, d => KHMER_DIGITS[d])
  .replace(/[\s,]/g, '')
  .replace(/^\+/, '')
  .trim();

function answersMatch(studentAnswer, correctAnswer, answerType) {
  if (studentAnswer == null) return false;
  if (answerType === 'NUMBER') {
    const a = normNumber(studentAnswer);
    const b = normNumber(correctAnswer);
    if (!a) return false;
    if (a === b) return true;
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
  }
  return studentAnswer === correctAnswer;
}

/** Grades `answers` ({ [questionId]: studentAnswer }) against `questions`. */
function gradeAnswers(questions, answers) {
  let correctCount = 0;
  const perQuestion = questions.map(q => {
    const studentAnswer = answers?.[q.id];
    const isCorrect = answersMatch(studentAnswer, q.correctAnswer, q.answerType);
    if (isCorrect) correctCount++;
    return { questionId: q.id, studentAnswer: studentAnswer ?? null, isCorrect };
  });
  const total = questions.length;
  const score = total > 0 ? Math.round((correctCount / total) * 100) : 0;
  return { correctCount, total, score, perQuestion };
}

// ── Streak (own to Daily Challenge — separate from the general activity
//    streak in utils/streak.js) ──────────────────────────────────────────

async function getChallengeStreak(studentId) {
  const { data } = await supabase
    .from('daily_challenge_streaks')
    .select('*')
    .eq('student_id', studentId)
    .maybeSingle();
  return data || { student_id: studentId, current_streak: 0, longest_streak: 0, last_completed_date: null };
}

/**
 * Call once, the first time a challenge is completed for `dateStr` (never on
 * a retake — a retake doesn't move the streak). Returns the updated summary
 * plus `milestone` (7 | 14 | 30 | null) when this completion newly reached one.
 */
async function bumpStreakOnComplete(studentId, dateStr) {
  const existing = await getChallengeStreak(studentId);
  const last = existing.last_completed_date ? String(existing.last_completed_date).slice(0, 10) : null;
  const yesterday = dayKey(new Date(new Date(dateStr + 'T00:00:00Z').getTime() - 86400000));

  let current;
  if (last === dateStr) current = existing.current_streak || 1; // already recorded (shouldn't normally happen)
  else if (last === yesterday) current = (existing.current_streak || 0) + 1;
  else current = 1; // first ever, or the streak had broken

  const longest = Math.max(existing.longest_streak || 0, current);

  const { error } = await supabase.from('daily_challenge_streaks').upsert({
    student_id: studentId,
    current_streak: current,
    longest_streak: longest,
    last_completed_date: dateStr,
    updated_at: new Date(),
  }, { onConflict: 'student_id' });
  if (error) console.warn('daily_challenge_streaks upsert failed:', error.message);

  const milestone = [30, 14, 7].find(m => current === m) || null;
  return { current_streak: current, longest_streak: longest, milestone };
}

module.exports = {
  CHALLENGE_TYPES,
  QUESTIONS_PER_CHALLENGE,
  pickRandom,
  dayKey,
  computeDifficultyAndSubjects,
  buildQuestionPool,
  selectChallengeQuestions,
  synthesizeQuestions,
  gradeAnswers,
  getChallengeStreak,
  bumpStreakOnComplete,
};
