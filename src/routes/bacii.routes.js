const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, isStudent } = require('../middleware/auth');
const content = require('../data/baciiContent.json');
// Khmer text for the commits and question banks (same keys; English stays the source of truth).
const contentKh = require('../data/baciiContent.kh.json');

/**
 * BACII onboarding + tutoring passes. See sql/051_bacii_onboarding.sql and
 * src/data/baciiContent.json (the editable subjects / chapters / question
 * banks the teachers replace).
 *
 *   GET  /api/bacii/config              goals, subjects, chapters, commitments
 *   POST /api/bacii/check/next          next question of the 3-question check
 *   GET  /api/bacii/profile             the student's plan + passes
 *   PUT  /api/bacii/profile             save onboarding answers
 *   POST /api/bacii/check/complete      grade the check, store the level
 *   GET  /api/bacii/passes              passes balance
 *   POST /api/bacii/passes/reserve      take tonight's seat (costs a pass; once a day)
 *   POST /api/bacii/passes/cancel       give today's seat back
 *   POST /api/bacii/passes/earn         one-off pass (kind: 'follow')
 */

// Passes every student starts with, and the most they can earn per week from
// practice sets and re-checks combined.
const START_PASSES = 3;
const WEEKLY_EARN_CAP = 2;
const CHECK_QUESTIONS = 3;
const CHECK_START_STEP = 2;
const CHECK_MAX_STEP = 4;

const GOAL_LETTERS = content.goals.map((g) => g.letter);
const TRACKS = Object.keys(content.subjects);
const STUDY_TIMES = ['eve', 'late', 'wknd', 'var'];
const PURPOSES = ['self_practice', 'live_tutoring', 'video_lessons', 'past_papers', 'daily_challenge', 'library'];
const TEST_QUESTIONS = 3;

/** ISO week key like '2026-W42' (UTC), used to cap weekly earnings. */
function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 864e5 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The question a student faces at `step` of `bankKey` (answer key stripped). */
function questionAt(bankKey, step) {
  const q = (content.bank[bankKey] || []).find((x) => x.step === step);
  if (!q) return null;
  const kh = contentKh.bank?.[bankKey]?.[String(step)];
  return {
    step: q.step, prompt: q.prompt, question: q.question, options: q.options,
    // Display-only Khmer; answers are still sent back as the English `options` value.
    prompt_kh: kh?.prompt ?? q.prompt, question_kh: kh?.question ?? q.question, options_kh: kh?.options ?? q.options,
  };
}

const topicKh = (bankKey, step, fallback) => contentKh.bank?.[bankKey]?.[String(step)]?.topic ?? fallback;

/**
 * Replays a check from the student's answers. The ladder starts at step 2,
 * moves one step per answer (up if right, down if wrong, kept within 1..4)
 * and the check ends after 3 answers; the level is the highest step answered
 * correctly. Done on the server so the answer key never reaches the client.
 */
function runCheck(bankKey, rawAnswers) {
  const bank = content.bank[bankKey];
  if (!bank) return { error: 'Unknown question set' };
  const answers = Array.isArray(rawAnswers) ? rawAnswers.slice(0, CHECK_QUESTIONS) : [];

  let ladder = CHECK_START_STEP;
  const graded = [];
  for (const a of answers) {
    const q = bank.find((x) => x.step === ladder);
    if (!q) return { error: 'Question set is incomplete' };
    const right = a && a.option === q.answer;
    graded.push({ step: ladder, right: !!right, topic: q.topic, topic_kh: topicKh(bankKey, ladder, q.topic) });
    ladder = Math.max(1, Math.min(CHECK_MAX_STEP, right ? ladder + 1 : ladder - 1));
  }

  if (graded.length < CHECK_QUESTIONS) {
    return { done: false, number: graded.length + 1, graded, question: questionAt(bankKey, ladder) };
  }
  const level = graded.reduce((best, g) => (g.right && g.step > best ? g.step : best), 0);
  const wrong = graded.filter((g) => !g.right);
  const missed = [...new Set(wrong.map((g) => g.topic))];
  const missed_kh = missed.map((t) => wrong.find((g) => g.topic === t).topic_kh);
  return { done: true, level, graded, missed, missed_kh };
}

async function loadPassState(studentId) {
  const [{ data: events }, { data: profile }] = await Promise.all([
    supabase.from('bacii_pass_events').select('kind, delta, week_key, created_at').eq('student_id', studentId).order('created_at', { ascending: true }),
    supabase.from('bacii_profiles').select('unlimited_until').eq('student_id', studentId).maybeSingle(),
  ]);
  const rows = events || [];
  const thisWeek = weekKey();
  const sum = rows.reduce((n, e) => n + e.delta, 0);
  const earnedThisWeek = rows.filter(
    (e) => e.week_key === thisWeek && (e.kind === 'practice' || e.kind === 'recheck')
  ).length;
  // Today's seat: the latest reserve/cancel event today decides.
  const today = new Date().toISOString().slice(0, 10);
  const seatEvents = rows.filter(
    (e) => (e.kind === 'class_use' || e.kind === 'class_cancel') && String(e.created_at).slice(0, 10) === today
  );
  const lastSeat = seatEvents[seatEvents.length - 1] || null;
  const unlimitedUntil = profile?.unlimited_until || null;
  const unlimited = !!unlimitedUntil && new Date(unlimitedUntil) > new Date();
  return {
    tutoring_left: Math.max(0, START_PASSES + sum),
    recordings: 'unlimited',
    unlimited,
    unlimited_until: unlimited ? unlimitedUntil : null,
    earned_this_week: earnedThisWeek,
    weekly_earn_cap: WEEKLY_EARN_CAP,
    followed: rows.some((e) => e.kind === 'follow'),
    reserved_today: !!lastSeat && lastSeat.kind === 'class_use',
    // What today's seat cost (a pass, or nothing in an unlimited week); cancelling gives it back.
    reserved_cost: lastSeat && lastSeat.kind === 'class_use' ? -lastSeat.delta : 0,
    earned_kinds_this_week: rows.filter((e) => e.week_key === thisWeek && e.delta > 0).map((e) => e.kind),
  };
}

async function addPassEvent(studentId, kind, delta) {
  const { error } = await supabase.from('bacii_pass_events').insert({
    id: uuidv4(), student_id: studentId, kind, delta, week_key: weekKey(),
  });
  if (error) throw error;
}

const fail = (res, e, what) => {
  console.error(`bacii ${what}:`, e);
  res.status(500).json({ success: false, error: `Failed to ${what}` });
};

/** GET /api/bacii/config */
router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: {
      goals: content.goals,
      subjects: content.subjects,
      chapters: content.chapters,
      commits: content.commits.map((c) => {
        const kh = contentKh.commits?.[String(c.minutes)] || {};
        return { ...c, label_kh: kh.label ?? c.label, tag_kh: kh.tag ?? c.tag, note_kh: kh.note ?? c.note, plan_kh: kh.plan ?? c.plan };
      }),
      // Bank keys that have a full question set, so the app can skip the check
      // offer for chapters whose questions aren't written yet.
      banks: Object.keys(content.bank),
      check: { questions: CHECK_QUESTIONS, start_step: CHECK_START_STEP, max_step: CHECK_MAX_STEP },
      start_passes: START_PASSES,
    },
  });
});

/** POST /api/bacii/check/next  { bank, answers: [{ option }] } */
router.post('/check/next', (req, res) => {
  const { bank, answers } = req.body || {};
  if (typeof bank !== 'string') return res.status(400).json({ success: false, error: 'bank is required' });
  const result = runCheck(bank, answers);
  if (result.error) return res.status(400).json({ success: false, error: result.error });
  res.json({ success: true, data: result });
});

/** GET /api/bacii/profile */
router.get('/profile', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const [{ data: profile, error }, passes] = await Promise.all([
      supabase.from('bacii_profiles').select('*').eq('student_id', studentId).maybeSingle(),
      loadPassState(studentId),
    ]);
    if (error) throw error;
    res.json({ success: true, data: { profile: profile || null, passes } });
  } catch (e) { fail(res, e, 'load BACII profile'); }
});

/** PUT /api/bacii/profile — partial update of the onboarding answers. */
router.put('/profile', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const b = req.body || {};
    const row = { student_id: studentId, updated_at: new Date() };

    if (b.goal !== undefined) {
      if (!GOAL_LETTERS.includes(b.goal)) return res.status(400).json({ success: false, error: 'Invalid goal' });
      row.goal = b.goal;
    }
    if (b.track !== undefined) {
      if (!TRACKS.includes(b.track)) return res.status(400).json({ success: false, error: 'Invalid track' });
      row.track = b.track;
    }
    if (b.subjects !== undefined) {
      if (!Array.isArray(b.subjects) || b.subjects.some((s) => typeof s !== 'string')) {
        return res.status(400).json({ success: false, error: 'Invalid subjects' });
      }
      row.subjects = b.subjects.slice(0, 12);
    }
    if (b.subject_key !== undefined) row.subject_key = b.subject_key;
    if (b.chapter !== undefined) row.chapter = b.chapter;
    if (b.chapter_bank !== undefined) row.chapter_bank = b.chapter_bank;
    if (b.ready !== undefined) {
      if (!Number.isInteger(b.ready) || b.ready < 1 || b.ready > 5) {
        return res.status(400).json({ success: false, error: 'Invalid readiness' });
      }
      row.ready = b.ready;
    }
    if (b.study_time !== undefined) {
      if (!STUDY_TIMES.includes(b.study_time)) return res.status(400).json({ success: false, error: 'Invalid study time' });
      row.study_time = b.study_time;
    }
    if (b.commit_minutes !== undefined) {
      if (!content.commits.some((c) => c.minutes === b.commit_minutes)) {
        return res.status(400).json({ success: false, error: 'Invalid commitment' });
      }
      row.commit_minutes = b.commit_minutes;
    }
    if (b.purposes !== undefined) {
      if (!Array.isArray(b.purposes) || b.purposes.some((p) => !PURPOSES.includes(p))) {
        return res.status(400).json({ success: false, error: 'Invalid purposes' });
      }
      row.purposes = [...new Set(b.purposes)];
    }
    if (b.plan_saved === true) row.plan_saved_at = new Date();

    const { data, error } = await supabase
      .from('bacii_profiles').upsert(row, { onConflict: 'student_id' }).select().single();
    if (error) throw error;
    res.json({ success: true, data: { profile: data } });
  } catch (e) { fail(res, e, 'save BACII profile'); }
});

/** POST /api/bacii/check/complete  { bank, answers, recheck? } */
router.post('/check/complete', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const { bank, answers, recheck } = req.body || {};
    const result = runCheck(bank, answers);
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    if (!result.done) return res.status(400).json({ success: false, error: 'The check is not finished' });

    const { data: before } = await supabase
      .from('bacii_profiles').select('check_level, checked').eq('student_id', studentId).maybeSingle();

    // A re-check that climbs a step earns one pass, once a week.
    let earnedPass = false;
    if (recheck && before?.checked && before.check_level != null && result.level > before.check_level) {
      const state = await loadPassState(studentId);
      if (state.earned_this_week < WEEKLY_EARN_CAP && !state.earned_kinds_this_week.includes('recheck')) {
        await addPassEvent(studentId, 'recheck', 1);
        earnedPass = true;
      }
    }

    const { error } = await supabase.from('bacii_profiles').upsert(
      { student_id: studentId, chapter_bank: bank, check_level: result.level, checked: true, updated_at: new Date() },
      { onConflict: 'student_id' }
    );
    if (error) throw error;

    res.json({
      success: true,
      data: { ...result, previous_level: before?.checked ? before.check_level : null, earned_pass: earnedPass },
    });
  } catch (e) { fail(res, e, 'complete the check'); }
});

// ---------------------------------------------------------------------------
// Chapter self-test: 3 random questions from a chapter's published quizzes.
// Graded here (the answer key never goes out before the student answers), and
// a miss points the student back to that chapter's lesson.
// ---------------------------------------------------------------------------

const KHMER_DIGITS = { '០': '0', '១': '1', '២': '2', '៣': '3', '៤': '4', '៥': '5', '៦': '6', '៧': '7', '៨': '8', '៩': '9' };
const normNumber = (v) => String(v == null ? '' : v).replace(/[០-៩]/g, (d) => KHMER_DIGITS[d]).replace(/[\s,]/g, '').replace(/^\+/, '').trim();
function answerIsRight(answer, correct, type) {
  if (answer == null) return false;
  if (type === 'number_input') {
    const a = normNumber(answer);
    const b = normNumber(correct);
    if (!a) return false;
    return a === b || (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Number(a) === Number(b));
  }
  return answer === correct;
}

function pickRandom(arr, n) {
  const pool = [...arr];
  const out = [];
  while (pool.length && out.length < n) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

/** Courses the student can reach: enrolled ones plus every free course. */
async function reachableCourseIds(studentId) {
  const [{ data: enrollments }, { data: free }] = await Promise.all([
    supabase.from('course_enrollments').select('course_id').eq('student_id', studentId),
    supabase.from('courses').select('id').eq('is_free', true),
  ]);
  return [...new Set([...(enrollments || []).map((e) => e.course_id), ...(free || []).map((c) => c.id)])];
}

/** GET /api/bacii/test/chapters — chapters that have enough questions to test, with the latest result. */
router.get('/test/chapters', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const courseIds = await reachableCourseIds(studentId);
    if (!courseIds.length) return res.json({ success: true, data: { chapters: [] } });

    const { data: quizzes, error: qErr } = await supabase
      .from('quizzes').select('id, lesson_id, course_id')
      .in('course_id', courseIds).eq('status', 'published').not('lesson_id', 'is', null);
    if (qErr) throw qErr;
    const quizIds = (quizzes || []).map((q) => q.id);
    if (!quizIds.length) return res.json({ success: true, data: { chapters: [] } });

    const { data: questions, error: nErr } = await supabase
      .from('quiz_questions').select('id, quiz_id').in('quiz_id', quizIds);
    if (nErr) throw nErr;
    const lessonOfQuiz = new Map(quizzes.map((q) => [q.id, q.lesson_id]));
    const counts = new Map();
    for (const q of questions || []) {
      const lid = lessonOfQuiz.get(q.quiz_id);
      counts.set(lid, (counts.get(lid) || 0) + 1);
    }
    const lessonIds = [...counts.keys()].filter((id) => counts.get(id) >= 1);
    if (!lessonIds.length) return res.json({ success: true, data: { chapters: [] } });

    const [{ data: lessons }, { data: results }] = await Promise.all([
      supabase.from('lessons').select('id, title, course_id, order_number, courses(title, color)').in('id', lessonIds),
      supabase.from('bacii_test_results').select('lesson_id, correct, total, created_at')
        .eq('student_id', studentId).in('lesson_id', lessonIds).order('created_at', { ascending: false }),
    ]);
    const latest = new Map();
    for (const r of results || []) if (!latest.has(r.lesson_id)) latest.set(r.lesson_id, r);

    const chapters = (lessons || [])
      .sort((a, b) => String(a.course_id).localeCompare(String(b.course_id)) || (a.order_number ?? 0) - (b.order_number ?? 0))
      .map((l) => ({
        lesson_id: l.id,
        title: l.title,
        course_id: l.course_id,
        course_title: l.courses?.title || '',
        color: l.courses?.color || null,
        questions: counts.get(l.id) || 0,
        last: latest.has(l.id)
          ? { correct: latest.get(l.id).correct, total: latest.get(l.id).total, at: latest.get(l.id).created_at }
          : null,
      }));
    res.json({ success: true, data: { chapters } });
  } catch (e) { fail(res, e, 'load test chapters'); }
});

/** POST /api/bacii/test/start { lesson_id } — 3 random questions, no answers. */
router.post('/test/start', authenticateToken, isStudent, async (req, res) => {
  try {
    const { lesson_id: lessonId } = req.body || {};
    if (typeof lessonId !== 'string') return res.status(400).json({ success: false, error: 'lesson_id is required' });
    const courseIds = await reachableCourseIds(req.user.userId);

    const { data: lesson } = await supabase
      .from('lessons').select('id, title, course_id, courses(title)').eq('id', lessonId).maybeSingle();
    if (!lesson || !courseIds.includes(lesson.course_id)) {
      return res.status(404).json({ success: false, error: 'Chapter not found' });
    }
    const { data: quizzes } = await supabase
      .from('quizzes').select('id').eq('lesson_id', lessonId).eq('status', 'published');
    const quizIds = (quizzes || []).map((q) => q.id);
    const { data: pool } = quizIds.length
      ? await supabase.from('quiz_questions').select('id, question, options, question_type').in('quiz_id', quizIds)
      : { data: [] };
    if (!pool || !pool.length) return res.status(404).json({ success: false, error: 'No questions for this chapter yet' });

    const questions = pickRandom(pool, TEST_QUESTIONS).map((q) => ({
      id: q.id,
      question: q.question,
      options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
      question_type: q.question_type,
    }));
    res.json({
      success: true,
      data: { lesson: { id: lesson.id, title: lesson.title, course_id: lesson.course_id, course_title: lesson.courses?.title || '' }, questions },
    });
  } catch (e) { fail(res, e, 'start the chapter test'); }
});

/** POST /api/bacii/test/grade { lesson_id, answers: { [questionId]: answer } } */
router.post('/test/grade', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const { lesson_id: lessonId, answers } = req.body || {};
    if (typeof lessonId !== 'string' || !answers || typeof answers !== 'object') {
      return res.status(400).json({ success: false, error: 'lesson_id and answers are required' });
    }
    const ids = Object.keys(answers).slice(0, TEST_QUESTIONS);
    if (!ids.length) return res.status(400).json({ success: false, error: 'No answers' });

    const { data: rows, error } = await supabase
      .from('quiz_questions')
      .select('id, question, correct_answer, explanation, question_type, quizzes!inner(lesson_id, course_id)')
      .in('id', ids);
    if (error) throw error;
    const valid = (rows || []).filter((r) => r.quizzes?.lesson_id === lessonId);
    if (valid.length !== ids.length) return res.status(400).json({ success: false, error: 'Questions do not belong to this chapter' });

    const review = valid.map((r) => ({
      question_id: r.id,
      question: r.question,
      student_answer: answers[r.id] ?? null,
      correct_answer: r.correct_answer,
      is_correct: answerIsRight(answers[r.id], r.correct_answer, r.question_type),
      explanation: r.explanation || null,
    }));
    const correct = review.filter((r) => r.is_correct).length;
    const courseId = valid[0].quizzes.course_id;

    const { data: lesson } = await supabase.from('lessons').select('id, title').eq('id', lessonId).maybeSingle();
    const { data: prev } = await supabase
      .from('bacii_test_results').select('correct, total')
      .eq('student_id', studentId).eq('lesson_id', lessonId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    await supabase.from('bacii_test_results').insert({
      student_id: studentId, lesson_id: lessonId, course_id: courseId, correct, total: review.length,
    });

    res.json({
      success: true,
      data: {
        correct,
        total: review.length,
        previous: prev ? { correct: prev.correct, total: prev.total } : null,
        review,
        // Anything missed sends the student to this chapter's lesson.
        recommendation: correct < review.length
          ? { lesson_id: lessonId, lesson_title: lesson?.title || '', course_id: courseId, missed: review.length - correct }
          : null,
      },
    });
  } catch (e) { fail(res, e, 'grade the chapter test'); }
});

/**
 * GET /api/bacii/test/summary — chapters to work on next.
 * Each weak chapter carries how far through it the student is and a `stage`:
 *   'learn'  — they still need to study it (or tested again and still missed)
 *   'retest' — they finished the chapter after that test; time to confirm it
 * A chapter leaves `weak` only when its latest test is all correct.
 */
router.get('/test/summary', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const { data: rows, error } = await supabase
      .from('bacii_test_results')
      .select('lesson_id, course_id, correct, total, created_at, lessons(title)')
      .eq('student_id', studentId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    const latest = new Map();
    for (const r of rows || []) if (!latest.has(r.lesson_id)) latest.set(r.lesson_id, r);
    const results = [...latest.values()].map((r) => ({
      lesson_id: r.lesson_id, course_id: r.course_id, title: r.lessons?.title || '',
      correct: r.correct, total: r.total, at: r.created_at,
    }));
    const weakRows = results.filter((r) => r.correct < r.total);

    let weak = [];
    if (weakRows.length) {
      const lessonIds = weakRows.map((r) => r.lesson_id);
      const [{ data: units }, { data: lessonDone }] = await Promise.all([
        supabase.from('lesson_units').select('id, lesson_id').in('lesson_id', lessonIds),
        supabase.from('lesson_completions').select('lesson_id, completed_at').eq('student_id', studentId).in('lesson_id', lessonIds),
      ]);
      const unitIds = (units || []).map((u) => u.id);
      const { data: unitDone } = unitIds.length
        ? await supabase.from('unit_completions').select('unit_id, completed_at').eq('student_id', studentId).in('unit_id', unitIds)
        : { data: [] };
      const doneAt = new Map((unitDone || []).map((u) => [u.unit_id, u.completed_at]));
      const lessonDoneAt = new Map((lessonDone || []).map((l) => [l.lesson_id, l.completed_at]));

      weak = weakRows.map((r) => {
        const mine = (units || []).filter((u) => u.lesson_id === r.lesson_id);
        const doneUnits = mine.filter((u) => doneAt.has(u.id));
        const testedAt = new Date(r.at).getTime();
        // Finished since the test: the chapter is marked complete after it, or
        // every unit was read and the last of them was after it.
        const completedAfter = lessonDoneAt.has(r.lesson_id) && new Date(lessonDoneAt.get(r.lesson_id)).getTime() > testedAt;
        const lastUnit = doneUnits.reduce((m, u) => Math.max(m, new Date(doneAt.get(u.id)).getTime()), 0);
        const allUnitsAfter = mine.length > 0 && doneUnits.length === mine.length && lastUnit > testedAt;
        return {
          ...r,
          units_total: mine.length,
          units_done: doneUnits.length,
          stage: completedAfter || allUnitsAfter ? 'retest' : 'learn',
        };
      }).sort((a, b) =>
        (a.stage === b.stage ? 0 : a.stage === 'learn' ? -1 : 1) || a.correct / a.total - b.correct / b.total);
    }
    res.json({ success: true, data: { tested: results.length, weak, results } });
  } catch (e) { fail(res, e, 'load test summary'); }
});

/** GET /api/bacii/passes */
router.get('/passes', authenticateToken, isStudent, async (req, res) => {
  try {
    res.json({ success: true, data: await loadPassState(req.user.userId) });
  } catch (e) { fail(res, e, 'load passes'); }
});

/** POST /api/bacii/passes/reserve — take a seat in tonight's tutoring session. */
router.post('/passes/reserve', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const state = await loadPassState(studentId);
    // One seat per day: reserving again just reports it.
    if (!state.reserved_today) {
      if (!state.unlimited && state.tutoring_left <= 0) {
        return res.status(409).json({ success: false, code: 'NO_PASSES', error: 'No tutoring passes left' });
      }
      await addPassEvent(studentId, 'class_use', state.unlimited ? 0 : -1);
    }
    res.json({ success: true, data: await loadPassState(studentId) });
  } catch (e) { fail(res, e, 'reserve a seat'); }
});

/** POST /api/bacii/passes/cancel — give today's seat (and its pass) back. */
router.post('/passes/cancel', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const state = await loadPassState(studentId);
    if (state.reserved_today) {
      await addPassEvent(studentId, 'class_cancel', state.reserved_cost);
    }
    res.json({ success: true, data: await loadPassState(studentId) });
  } catch (e) { fail(res, e, 'cancel the seat'); }
});

/** POST /api/bacii/passes/earn  { kind: 'follow' } — one pass, once. */
router.post('/passes/earn', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    if (req.body?.kind !== 'follow') {
      return res.status(400).json({ success: false, error: 'This pass cannot be claimed here' });
    }
    const state = await loadPassState(studentId);
    if (!state.followed) await addPassEvent(studentId, 'follow', 1);
    res.json({ success: true, data: await loadPassState(studentId) });
  } catch (e) { fail(res, e, 'claim the pass'); }
});

module.exports = router;
