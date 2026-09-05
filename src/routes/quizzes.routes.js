const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const supabase = require('../config/supabase');
const { authenticateToken, isTeacher, isStudent } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { awardXp, XP_VALUES } = require('../utils/xp');
const { evaluateAchievements } = require('../utils/achievements');
const { hasCourseAccess, ensureEnrolled } = require('../utils/access');

// Configure multer for quiz question CSV imports
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

// Picks up to n random items from arr without repeats
function pickRandom(arr, n) {
  const pool = [...arr];
  const picked = [];
  while (pool.length > 0 && picked.length < n) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

/**
 * POST /api/quizzes
 * Create a new quiz (Teacher only)
 */
router.post('/', authenticateToken, isTeacher, async (req, res) => {
  try {
    let { course_id, lesson_id, unit_id, title, description, pass_percentage, time_limit, status, questions } = req.body;

    if (!course_id || !title) {
      return res.status(400).json({
        success: false,
        error: 'Course ID and title are required'
      });
    }

    // Verify course ownership
    const { data: course } = await supabase
      .from('courses')
      .select('teacher_id')
      .eq('id', course_id)
      .single();

    if (course?.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only create quizzes for your own courses'
      });
    }

    // A unit quiz implies its chapter — resolve/verify lesson_id from it.
    if (unit_id) {
      const { data: unit } = await supabase
        .from('lesson_units')
        .select('id, lesson_id, lessons(course_id)')
        .eq('id', unit_id)
        .single();

      if (!unit || unit.lessons?.course_id !== course_id) {
        return res.status(400).json({
          success: false,
          error: 'Specified unit does not exist in this course'
        });
      }
      lesson_id = unit.lesson_id;
    } else if (lesson_id) {
      // Optional: Verify lesson belongs to course
      const { data: lesson } = await supabase
        .from('lessons')
        .select('id, course_id')
        .eq('id', lesson_id)
        .single();

      if (!lesson || lesson.course_id !== course_id) {
        return res.status(400).json({
          success: false,
          error: 'Specified lesson does not exist in this course'
        });
      }
    }

    const quizId = uuidv4();
    const { data: newQuiz, error } = await supabase
      .from('quizzes')
      .insert({
        id: quizId,
        course_id,
        lesson_id: lesson_id || null,
        unit_id: unit_id || null,
        title,
        description: description || '',
        pass_percentage: pass_percentage || 70,
        time_limit: time_limit || 60,
        status: status || 'draft', // 'draft' or 'published'
        created_at: new Date()
      })
      .select()
      .single();

    if (error) throw error;

    // Insert questions if provided at creation time
    let insertedQuestions = [];
    if (Array.isArray(questions) && questions.length > 0) {
      const questionsToInsert = questions.map((q, idx) => ({
        id: q.id && typeof q.id === 'string' && q.id.length > 10 ? q.id : uuidv4(),
        quiz_id: quizId,
        question: q.question,
        options: typeof q.options === 'string' ? q.options : JSON.stringify(q.options),
        correct_answer: q.correct_answer,
        explanation: q.explanation || null,
        question_type: normalizeQuestionType(q.question_type) || 'QCM',
        difficulty: q.difficulty || null,
        order_number: idx + 1
      }));

      const { data: newQuestions, error: qError } = await supabase
        .from('quiz_questions')
        .insert(questionsToInsert)
        .select();

      if (qError) throw qError;
      insertedQuestions = newQuestions || [];
    }

    res.status(201).json({
      success: true,
      message: 'Quiz created successfully',
      data: { quiz: { ...newQuiz, questions: insertedQuestions } }
    });
  } catch (error) {
    console.error('Quiz creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create quiz: ' + error.message
    });
  }
});

/**
 * GET /api/quizzes/questions/import/template
 * Download the CSV template used for bulk-importing quiz questions
 */
router.get('/questions/import/template', authenticateToken, isTeacher, (req, res) => {
  res.download(
    path.join(__dirname, '../../templates/quiz_questions_template.csv'),
    'quiz_questions_template.csv'
  );
});

// ── Shared quiz-question CSV parsing ─────────────────────────────────────

const LETTER_INDEX = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5 };

// First non-empty value among the given column names.
const pickCol = (row, ...names) => {
  for (const n of names) {
    if (row[n] != null && String(row[n]).trim() !== '') return String(row[n]).trim();
  }
  return '';
};

const normalizeTier = (v) => {
  const t = String(v || '').trim().toLowerCase();
  if (t.startsWith('e')) return 'Easy';
  if (t.startsWith('m')) return 'Medium';
  if (t.startsWith('h')) return 'Hard';
  return null;
};

// Canonical question types stored in quiz_questions.question_type:
//   'QCM'          multiple choice
//   'number_input' the student types a number
// Accepts a range of spellings; returns null when nothing recognisable is
// given (caller then infers from whether options are present).
const normalizeQuestionType = (v) => {
  const t = String(v || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!t) return null;
  if (['qcm', 'mcq', 'mcq4', 'multiplechoice', 'choice', 'mc'].includes(t)) return 'QCM';
  if (['numberinput', 'numericentry', 'numeric', 'number', 'input', 'num'].includes(t)) return 'number_input';
  return null;
};

// Khmer digits → Arabic, then strip spaces / thousands separators / a leading +.
const KHMER_DIGITS = { '០': '0', '១': '1', '២': '2', '៣': '3', '៤': '4', '៥': '5', '៦': '6', '៧': '7', '៨': '8', '៩': '9' };
const normNumber = (v) => String(v == null ? '' : v)
  .replace(/[០-៩]/g, d => KHMER_DIGITS[d])
  .replace(/[\s,]/g, '')
  .replace(/^\+/, '')
  .trim();

/**
 * Whether a student's answer counts as correct. QCM is an exact match;
 * number_input tolerates Khmer digits, spaces, thousands separators and
 * equivalent numeric forms ("1955" == "1,955" == "1955.0").
 */
const answersMatch = (studentAnswer, correctAnswer, questionType) => {
  if (studentAnswer == null) return false;
  if (questionType === 'number_input') {
    const a = normNumber(studentAnswer);
    const b = normNumber(correctAnswer);
    if (!a) return false;
    if (a === b) return true;
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
  }
  return studentAnswer === correctAnswer;
};

/**
 * Parse a quiz-question CSV into normalized rows. Accepts the clean teacher
 * template — question, option_a..f, correct, tier, explanation — and the
 * richer exports (stem in khmer, option a.., correct answer, what each wrong
 * option catches, unit id, ...).
 *
 * question_type column: "QCM" or "number_input" (aliases accepted). When
 * absent it is inferred — options present → QCM, none → number_input.
 * A number_input row has no options; `correct` is the number.
 *
 * Returns { questions: [{ unitNo?, question, options, correct_answer,
 * explanation, difficulty, question_type }], rowErrors }.
 * With opts.requireUnit, every row must carry a Unit ID (U1 / 1 / ...).
 */
function parseQuestionRows(buffer, opts = {}) {
  const records = parseCsv(buffer.toString('utf8'), {
    bom: true,
    columns: header => header.map(h => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true
  });

  const questions = [];
  const rowErrors = [];

  records.forEach((r, idx) => {
    const rowNumber = idx + 2; // +1 header, +1 for 1-based
    const question = pickCol(r, 'question', 'stem in khmer', 'stem', 'question text');
    const explanation = pickCol(r, 'explanation', 'what each wrong option catches') || null;
    const difficulty = normalizeTier(pickCol(r, 'tier', 'difficulty', 'level'));

    const letterOpts = ['a', 'b', 'c', 'd', 'e', 'f'].map(l => pickCol(r, `option_${l}`, `option ${l}`, `option${l}`));
    const numberOpts = [1, 2, 3, 4, 5, 6].map(n => pickCol(r, `option_${n}`, `option ${n}`, `option${n}`));
    const options = (letterOpts.some(Boolean) ? letterOpts : numberOpts).filter(v => v && v.length > 0);

    let unitNo;
    if (opts.requireUnit) {
      const unitRaw = pickCol(r, 'unit id', 'unit', 'unit_id', 'unit no');
      unitNo = parseInt(unitRaw.replace(/\D/g, ''), 10);
      if (!Number.isFinite(unitNo) || unitNo < 1) {
        rowErrors.push({ row: rowNumber, error: `Unrecognised Unit "${unitRaw}"` });
        return;
      }
    }

    if (!question) { rowErrors.push({ row: rowNumber, error: 'Question text is required' }); return; }

    const declaredType = normalizeQuestionType(pickCol(r, 'question_type', 'question type', 'type'));
    const isNumeric = declaredType === 'number_input' || (declaredType == null && options.length === 0);

    // number_input reads its answer from `input_answer` (falls back to `correct`);
    // QCM reads from `correct`.
    const correctRaw = isNumeric
      ? pickCol(r, 'input_answer', 'input answer', 'input_anwser', 'numeric_answer', 'correct', 'correct answer', 'correct_answer', 'answer')
      : pickCol(r, 'correct', 'correct answer', 'correct_answer', 'answer');

    if (!correctRaw) {
      rowErrors.push({ row: rowNumber, error: isNumeric ? 'input_answer is required' : 'Correct answer is required' });
      return;
    }

    if (isNumeric) {
      // number_input has no options; the answer is the number in input_answer.
      questions.push({
        unitNo, question, options: [],
        correct_answer: correctRaw.replace(/[\s,]/g, ''),
        explanation, difficulty, question_type: 'number_input'
      });
      return;
    }

    if (options.length < 2) {
      rowErrors.push({ row: rowNumber, error: 'A QCM question needs at least 2 options' });
      return;
    }

    // correct may be a letter (A/B/C/…) or the full option text
    let correctText = null;
    const asLetter = correctRaw.toLowerCase();
    if (asLetter.length === 1 && asLetter in LETTER_INDEX && LETTER_INDEX[asLetter] < options.length) {
      correctText = options[LETTER_INDEX[asLetter]];
    } else if (options.includes(correctRaw)) {
      correctText = correctRaw;
    }
    if (!correctText) {
      rowErrors.push({ row: rowNumber, error: `Correct answer "${correctRaw}" is not a valid option letter or text` });
      return;
    }

    questions.push({
      unitNo, question, options,
      correct_answer: correctText, explanation, difficulty,
      question_type: 'QCM'
    });
  });

  return { questions, rowErrors };
}

/**
 * POST /api/quizzes/:id/questions/import
 * Bulk-import questions for an existing quiz from a CSV file (Teacher only).
 * New questions are appended after any questions the quiz already has.
 *
 * CSV columns (see templates/quiz_questions_template.csv):
 *   question, option_a … option_f, correct (letter or text), tier, explanation
 * A row with no options and a value in `correct` is a numeric-entry question.
 */
router.post('/:id/questions/import', authenticateToken, isTeacher, csvUpload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'CSV file is required (form field name: "file")'
      });
    }

    // Verify ownership
    const { data: quiz } = await supabase
      .from('quizzes')
      .select('id, courses(teacher_id)')
      .eq('id', id)
      .single();

    if (!quiz) {
      return res.status(404).json({ success: false, error: 'Quiz not found' });
    }
    if (quiz.courses?.teacher_id !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Unauthorized quiz access' });
    }

    let parsed;
    try {
      parsed = parseQuestionRows(req.file.buffer);
    } catch (parseError) {
      return res.status(400).json({ success: false, error: 'Failed to parse CSV file: ' + parseError.message });
    }

    if (parsed.rowErrors.length > 0) {
      return res.status(400).json({ success: false, error: 'CSV contains invalid rows', data: { rowErrors: parsed.rowErrors } });
    }
    if (parsed.questions.length === 0) {
      return res.status(400).json({ success: false, error: 'CSV file has no data rows' });
    }

    // Continue numbering after any questions the quiz already has
    const { data: lastQuestion } = await supabase
      .from('quiz_questions')
      .select('order_number')
      .eq('quiz_id', id)
      .order('order_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    const startOrder = lastQuestion?.order_number || 0;

    const questionsToInsert = parsed.questions.map((q, idx) => ({
      id: uuidv4(),
      quiz_id: id,
      question: q.question,
      options: JSON.stringify(q.options),
      correct_answer: q.correct_answer,
      explanation: q.explanation,
      question_type: q.question_type,
      difficulty: q.difficulty,
      order_number: startOrder + idx + 1
    }));

    const { data: insertedQuestions, error } = await supabase
      .from('quiz_questions')
      .insert(questionsToInsert)
      .select();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: `${insertedQuestions.length} question(s) imported successfully`,
      data: { questions: insertedQuestions }
    });
  } catch (error) {
    console.error('Quiz question import error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to import quiz questions: ' + error.message
    });
  }
});

// ── Unit practice quizzes ────────────────────────────────────────────────
// One CSV holds a whole chapter's practice bank; each row carries a "Unit
// ID" (U1, U2, …). We split by unit and populate one quiz per unit.

/**
 * GET /api/quizzes/import/units/template
 * Download the CSV template for unit-practice imports.
 */
router.get('/import/units/template', authenticateToken, isTeacher, (req, res) => {
  res.download(
    path.join(__dirname, '../../templates/unit_practice_template.csv'),
    'unit_practice_template.csv'
  );
});

/**
 * GET /api/quizzes/unit/:unitId
 * Quizzes attached to a unit (students see published only).
 */
router.get('/unit/:unitId', authenticateToken, async (req, res) => {
  try {
    let query = supabase
      .from('quizzes')
      .select('*, quiz_questions(count)')
      .eq('unit_id', req.params.unitId);

    if (req.user.role !== 'teacher') query = query.eq('status', 'published');

    const { data: quizzes, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    res.json({ success: true, data: { quizzes } });
  } catch (error) {
    console.error('Unit quizzes error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch quizzes for unit: ' + error.message });
  }
});

/**
 * POST /api/quizzes/import/units
 * Bulk-import a whole chapter's practice bank. multipart/form-data:
 *   file          the CSV (field name "file")
 *   lesson_id     the chapter the CSV belongs to
 *   publish       "true" to publish the quizzes (default: draft)
 *   replace       "true" to wipe each unit quiz's existing questions first
 *   pass_percentage, time_limit   optional, applied to newly-created quizzes
 * One quiz is created per unit that has rows (reused if the unit already has one).
 */
router.post('/import/units', authenticateToken, isTeacher, csvUpload.single('file'), async (req, res) => {
  try {
    const { lesson_id, publish, replace, pass_percentage, time_limit } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'CSV file is required (form field name: "file")' });
    }
    if (!lesson_id) {
      return res.status(400).json({ success: false, error: 'lesson_id (the chapter) is required' });
    }

    // Verify chapter ownership
    const { data: chapter } = await supabase
      .from('lessons')
      .select('id, title, course_id, courses(teacher_id)')
      .eq('id', lesson_id)
      .single();

    if (!chapter) return res.status(404).json({ success: false, error: 'Chapter not found' });
    if (chapter.courses?.teacher_id !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'You can only import into your own courses' });
    }

    // Units of this chapter, keyed by their 1-based position (U1 -> order 1).
    const { data: units } = await supabase
      .from('lesson_units')
      .select('id, title, order_number')
      .eq('lesson_id', lesson_id)
      .order('order_number', { ascending: true });

    if (!units || units.length === 0) {
      return res.status(400).json({ success: false, error: 'This chapter has no units yet — add units before importing their quizzes' });
    }
    const unitByNo = new Map(units.map((u, i) => [u.order_number || i + 1, u]));

    let parsed;
    try {
      parsed = parseQuestionRows(req.file.buffer, { requireUnit: true });
    } catch (parseError) {
      return res.status(400).json({ success: false, error: 'Failed to parse CSV: ' + parseError.message });
    }
    if (parsed.rowErrors.length > 0) {
      return res.status(400).json({ success: false, error: 'CSV contains invalid rows', data: { rowErrors: parsed.rowErrors } });
    }
    if (parsed.questions.length === 0) {
      return res.status(400).json({ success: false, error: 'CSV has no usable rows' });
    }

    // Group questions by unit number
    const byUnitNo = new Map();
    for (const q of parsed.questions) {
      if (!byUnitNo.has(q.unitNo)) byUnitNo.set(q.unitNo, []);
      byUnitNo.get(q.unitNo).push(q);
    }

    const status = String(publish) === 'true' ? 'published' : 'draft';
    const doReplace = String(replace) === 'true';
    const results = [];
    const skippedUnits = [];

    for (const [unitNo, unitQuestions] of byUnitNo) {
      const unit = unitByNo.get(unitNo);
      if (!unit) {
        skippedUnits.push({ unit_no: unitNo, reason: 'no matching unit in this chapter', questions: unitQuestions.length });
        continue;
      }

      // Reuse an existing unit quiz or create one.
      let { data: quiz } = await supabase
        .from('quizzes')
        .select('id')
        .eq('unit_id', unit.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      let created = false;
      if (!quiz) {
        const { data: newQuiz, error: quizErr } = await supabase
          .from('quizzes')
          .insert({
            id: uuidv4(),
            course_id: chapter.course_id,
            lesson_id: chapter.id,
            unit_id: unit.id,
            title: `${unit.title} — Practice`,
            description: '',
            pass_percentage: parseInt(pass_percentage, 10) || 70,
            time_limit: parseInt(time_limit, 10) || 15,
            status,
            created_at: new Date()
          })
          .select('id')
          .single();
        if (quizErr) throw quizErr;
        quiz = newQuiz;
        created = true;
      } else if (doReplace) {
        await supabase.from('quiz_questions').delete().eq('quiz_id', quiz.id);
      }

      const { data: last } = await supabase
        .from('quiz_questions')
        .select('order_number')
        .eq('quiz_id', quiz.id)
        .order('order_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      const startOrder = last?.order_number || 0;

      const rows = unitQuestions.map((q, i) => ({
        id: uuidv4(),
        quiz_id: quiz.id,
        question: q.question,
        options: JSON.stringify(q.options),
        correct_answer: q.correct_answer,
        explanation: q.explanation,
        question_type: q.question_type,
        difficulty: q.difficulty,
        order_number: startOrder + i + 1
      }));

      const { error: insErr } = await supabase.from('quiz_questions').insert(rows);
      if (insErr) throw insErr;

      results.push({
        unit_id: unit.id,
        unit_title: unit.title,
        quiz_id: quiz.id,
        quiz_created: created,
        questions_added: rows.length
      });
    }

    res.status(201).json({
      success: true,
      message: `Imported ${parsed.questions.length} question(s) into ${results.length} unit quiz(zes)`,
      data: { chapter: { id: chapter.id, title: chapter.title }, status, results, skipped_units: skippedUnits }
    });
  } catch (error) {
    console.error('Unit practice import error:', error);
    res.status(500).json({ success: false, error: 'Failed to import unit quizzes: ' + error.message });
  }
});

/**
 * PUT /api/quizzes/:id
 * Update quiz & sync questions (Teacher only) - Used for Draft Autosaves and Publishing
 */
router.put('/:id', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, pass_percentage, time_limit, status, questions } = req.body;

    // Verify ownership
    const { data: quiz } = await supabase
      .from('quizzes')
      .select('courses(teacher_id)')
      .eq('id', id)
      .single();

    if (quiz?.courses?.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized quiz access'
      });
    }

    // Update Quiz main record
    const updatePayload = { updated_at: new Date() };
    if (title !== undefined) updatePayload.title = title;
    if (description !== undefined) updatePayload.description = description;
    if (pass_percentage !== undefined) updatePayload.pass_percentage = pass_percentage;
    if (time_limit !== undefined) updatePayload.time_limit = time_limit;
    if (status !== undefined) updatePayload.status = status;

    const { data: updatedQuiz, error: quizError } = await supabase
      .from('quizzes')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (quizError) throw quizError;

    // Sync Questions if provided in request
    if (Array.isArray(questions)) {
      // 1. Delete existing questions
      await supabase.from('quiz_questions').delete().eq('quiz_id', id);

      // 2. Re-insert payload questions
      if (questions.length > 0) {
        const questionsToInsert = questions.map((q, idx) => ({
          id: q.id && typeof q.id === 'string' && q.id.length > 10 ? q.id : uuidv4(),
          quiz_id: id,
          question: q.question,
          options: typeof q.options === 'string' ? q.options : JSON.stringify(q.options),
          correct_answer: q.correct_answer,
          explanation: q.explanation || null,
          question_type: normalizeQuestionType(q.question_type) || 'QCM',
          difficulty: q.difficulty || null,
          order_number: idx + 1
        }));

        const { error: qError } = await supabase
          .from('quiz_questions')
          .insert(questionsToInsert);

        if (qError) throw qError;
      }
    }

    res.json({
      success: true,
      message: `Quiz ${status === 'published' ? 'published' : 'draft saved'} successfully`,
      data: { quiz: updatedQuiz }
    });
  } catch (error) {
    console.error('Quiz update error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update quiz: ' + error.message
    });
  }
});

/**
 * DELETE /api/quizzes/:id
 * Delete a quiz and its questions (Teacher only, must own the course).
 */
router.delete('/:id', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: quiz } = await supabase
      .from('quizzes')
      .select('id, courses(teacher_id)')
      .eq('id', id)
      .single();

    if (!quiz) {
      return res.status(404).json({ success: false, error: 'Quiz not found' });
    }
    if (quiz.courses?.teacher_id !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'You can only delete your own quizzes' });
    }

    // Remove questions first in case there's no ON DELETE CASCADE.
    await supabase.from('quiz_questions').delete().eq('quiz_id', id);
    await supabase.from('quiz_submissions').delete().eq('quiz_id', id);

    const { error } = await supabase.from('quizzes').delete().eq('id', id);
    if (error) throw error;

    res.json({ success: true, message: 'Quiz deleted' });
  } catch (error) {
    console.error('Quiz delete error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete quiz: ' + error.message });
  }
});

/**
 * GET /api/quizzes/lesson/:lessonId
 * Get quizzes for a specific lesson
 */
router.get('/lesson/:lessonId', authenticateToken, async (req, res) => {
  try {
    const { lessonId } = req.params;

    // Chapter-level quizzes only — unit practice quizzes are fetched via
    // GET /api/quizzes/unit/:unitId.
    let query = supabase
      .from('quizzes')
      .select('*')
      .eq('lesson_id', lessonId)
      .is('unit_id', null);

    // Filter out drafts for students
    if (req.user.role !== 'teacher') {
      query = query.eq('status', 'published');
    }

    const { data: quizzes, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: { quizzes }
    });
  } catch (error) {
    console.error('Lesson quizzes error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch quizzes for lesson: ' + error.message
    });
  }
});

/**
 * GET /api/quizzes/course/:courseId
 * Get all quizzes for a course (Teachers see drafts, students see published only)
 */
router.get('/course/:courseId', authenticateToken, async (req, res) => {
  try {
    const { courseId } = req.params;

    let query = supabase
      .from('quizzes')
      .select('*, quiz_questions(count)')
      .eq('course_id', courseId);

    if (req.user.role !== 'teacher') {
      query = query.eq('status', 'published');
    }

    const { data: quizzes, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: { quizzes }
    });
  } catch (error) {
    console.error('Course quizzes error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch quizzes: ' + error.message
    });
  }
});

/**
 * GET /api/quizzes/daily
 * Get today's daily quiz for a student: up to 5 random questions drawn from
 * published quizzes across their enrolled courses. The same set is returned
 * all day (stored on first fetch); a fresh set is picked once per calendar
 * day per student. If fewer than 5 questions are available, all of them are
 * returned.
 */
router.get('/daily', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const today = new Date().toISOString().slice(0, 10);

    const { data: existingAttempt } = await supabase
      .from('daily_quiz_attempts')
      .select('*')
      .eq('student_id', studentId)
      .eq('quiz_date', today)
      .maybeSingle();

    let attempt = existingAttempt;

    if (!attempt) {
      const { data: enrollments } = await supabase
        .from('course_enrollments')
        .select('course_id')
        .eq('student_id', studentId);
      const courseIds = (enrollments || []).map(e => e.course_id);

      let questionPool = [];
      if (courseIds.length > 0) {
        const { data: quizzes } = await supabase
          .from('quizzes')
          .select('id')
          .in('course_id', courseIds)
          .eq('status', 'published');
        const quizIds = (quizzes || []).map(q => q.id);

        if (quizIds.length > 0) {
          const { data: questions } = await supabase
            .from('quiz_questions')
            .select('id')
            .in('quiz_id', quizIds);
          questionPool = questions || [];
        }
      }

      const questionIds = pickRandom(questionPool, 5).map(q => q.id);

      const { data: newAttempt, error } = await supabase
        .from('daily_quiz_attempts')
        .insert({
          id: uuidv4(),
          student_id: studentId,
          quiz_date: today,
          question_ids: questionIds,
          created_at: new Date()
        })
        .select()
        .single();

      if (error) throw error;
      attempt = newAttempt;
    }

    const questionIds = Array.isArray(attempt.question_ids) ? attempt.question_ids : [];
    const isCompleted = !!attempt.completed_at;
    const storedAnswers = (attempt.answers && typeof attempt.answers === 'object') ? attempt.answers : {};
    let questions = [];
    let review = [];

    if (questionIds.length > 0) {
      // correct_answer / explanation are only selected here so they can be
      // returned in `review` AFTER completion — never in `questions`.
      const { data: questionRows } = await supabase
        .from('quiz_questions')
        .select('id, quiz_id, question, options, correct_answer, explanation, question_type, order_number, quizzes(title, course_id)')
        .in('id', questionIds);

      const byId = new Map((questionRows || []).map(q => [q.id, q]));
      const ordered = questionIds.map(qid => byId.get(qid)).filter(Boolean);

      questions = ordered.map(q => ({
        id: q.id,
        quiz_id: q.quiz_id,
        quiz_title: q.quizzes?.title || null,
        course_id: q.quizzes?.course_id || null,
        question: q.question,
        options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
        question_type: q.question_type
      }));

      if (isCompleted) {
        review = ordered.map(q => {
          const studentAnswer = storedAnswers[q.id];
          return {
            question_id: q.id,
            question: q.question,
            student_answer: studentAnswer ?? null,
            correct_answer: q.correct_answer,
            is_correct: answersMatch(studentAnswer, q.correct_answer, q.question_type),
            explanation: q.explanation || null
          };
        });
      }
    }

    res.json({
      success: true,
      data: {
        date: today,
        total_questions: questions.length,
        completed: isCompleted,
        score: attempt.score,
        correct_count: attempt.correct_count,
        questions,
        review
      }
    });
  } catch (error) {
    console.error('Daily quiz error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch daily quiz: ' + error.message
    });
  }
});

/**
 * POST /api/quizzes/daily/submit
 * Submit answers for today's daily quiz (Student). Can only be submitted
 * once per day; grading is against the exact questions picked for today.
 */
router.post('/daily/submit', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const { answers } = req.body;
    const today = new Date().toISOString().slice(0, 10);

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Answers are required'
      });
    }

    const { data: attempt } = await supabase
      .from('daily_quiz_attempts')
      .select('*')
      .eq('student_id', studentId)
      .eq('quiz_date', today)
      .maybeSingle();

    if (!attempt) {
      return res.status(404).json({
        success: false,
        error: 'No daily quiz found for today. Fetch it first.'
      });
    }

    if (attempt.completed_at) {
      return res.status(400).json({
        success: false,
        error: "You already completed today's daily quiz"
      });
    }

    const questionIds = Array.isArray(attempt.question_ids) ? attempt.question_ids : [];
    let correctCount = 0;
    const totalCount = questionIds.length;
    let review = [];

    if (totalCount > 0) {
      const { data: questions } = await supabase
        .from('quiz_questions')
        .select('id, question, correct_answer, explanation, question_type')
        .in('id', questionIds);

      const byId = new Map((questions || []).map(q => [q.id, q]));
      review = questionIds
        .filter(qid => byId.has(qid))
        .map(qid => {
          const q = byId.get(qid);
          const studentAnswer = answers[q.id];
          const isCorrect = answersMatch(studentAnswer, q.correct_answer, q.question_type);
          if (isCorrect) correctCount++;
          return {
            question_id: q.id,
            question: q.question,
            student_answer: studentAnswer ?? null,
            correct_answer: q.correct_answer,
            is_correct: isCorrect,
            explanation: q.explanation || null
          };
        });
    }

    const score = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
    const xpAwarded = correctCount * XP_VALUES.DAILY_QUIZ_PER_CORRECT;

    const { data: updatedAttempt, error } = await supabase
      .from('daily_quiz_attempts')
      .update({
        answers,
        correct_count: correctCount,
        total_count: totalCount,
        score,
        completed_at: new Date()
      })
      .eq('id', attempt.id)
      .select()
      .single();

    if (error) throw error;

    if (xpAwarded > 0) {
      await awardXp(studentId, xpAwarded, 'daily_quiz');
    }
    await evaluateAchievements(studentId);

    res.json({
      success: true,
      message: 'Daily quiz submitted successfully',
      data: {
        correct_count: correctCount,
        total_questions: totalCount,
        score,
        xp_awarded: xpAwarded,
        review,
        attempt: updatedAttempt
      }
    });
  } catch (error) {
    console.error('Daily quiz submission error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit daily quiz: ' + error.message
    });
  }
});

/**
 * GET /api/quizzes/:id
 * Get quiz details with questions
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: quiz, error } = await supabase
      .from('quizzes')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !quiz) {
      return res.status(404).json({
        success: false,
        error: 'Quiz not found'
      });
    }

    const { data: questions } = await supabase
      .from('quiz_questions')
      .select('*')
      .eq('quiz_id', id)
      .order('order_number', { ascending: true });

    const questionsWithParsedOptions = (questions || []).map(q => ({
      ...q,
      options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options
    }));

    res.json({
      success: true,
      data: {
        quiz: {
          ...quiz,
          questions: questionsWithParsedOptions,
          total_questions: questionsWithParsedOptions.length
        }
      }
    });
  } catch (error) {
    console.error('Quiz fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch quiz: ' + error.message
    });
  }
});

/**
 * POST /api/quizzes/:id/submit
 * Submit quiz answers (Student)
 */
router.post('/:id/submit', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { answers } = req.body;

    if (!answers) {
      return res.status(400).json({
        success: false,
        error: 'Answers are required'
      });
    }

    const { data: quiz } = await supabase
      .from('quizzes')
      .select('*, courses(*)')
      .eq('id', id)
      .single();

    if (!quiz || quiz.status !== 'published') {
      return res.status(404).json({
        success: false,
        error: 'Quiz is not available'
      });
    }

    let lessonIsFree = false;
    if (quiz.lesson_id) {
      const { data: lesson } = await supabase
        .from('lessons')
        .select('is_free')
        .eq('id', quiz.lesson_id)
        .maybeSingle();
      lessonIsFree = !!lesson?.is_free;
    }

    await ensureEnrolled({ supabase, course: quiz.courses, user: req.user });
    const courseAccess = await hasCourseAccess({ supabase, course: quiz.courses, user: req.user });
    if (!courseAccess && !lessonIsFree) {
      return res.status(403).json({
        success: false,
        error: 'You do not have access to this quiz yet'
      });
    }

    const { data: questions } = await supabase
      .from('quiz_questions')
      .select('*')
      .eq('quiz_id', id);

    let correctCount = 0;
    const totalCount = questions?.length || 0;

    // Per-question breakdown returned to the student so the client can show
    // the correct answer and its explanation when they check their answers.
    const review = (questions || [])
      .slice()
      .sort((a, b) => (a.order_number || 0) - (b.order_number || 0))
      .map(question => {
        const studentAnswer = answers[question.id];
        const isCorrect = answersMatch(studentAnswer, question.correct_answer, question.question_type);
        if (isCorrect) correctCount++;
        return {
          question_id: question.id,
          question: question.question,
          student_answer: studentAnswer ?? null,
          correct_answer: question.correct_answer,
          is_correct: isCorrect,
          explanation: question.explanation || null
        };
      });

    const score = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
    const passed = score >= quiz.pass_percentage;

    // Only award XP the first time this student passes this quiz, so
    // retaking an already-passed quiz doesn't farm infinite XP.
    let xpAwarded = 0;
    if (passed) {
      const { data: priorPass } = await supabase
        .from('quiz_submissions')
        .select('id')
        .eq('quiz_id', id)
        .eq('student_id', req.user.userId)
        .eq('passed', true)
        .limit(1)
        .maybeSingle();

      if (!priorPass) {
        xpAwarded = XP_VALUES.QUIZ_PASS;
      }
    }

    const submissionId = uuidv4();
    const { data: submission, error } = await supabase
      .from('quiz_submissions')
      .insert({
        id: submissionId,
        quiz_id: id,
        student_id: req.user.userId,
        answers: typeof answers === 'string' ? answers : JSON.stringify(answers),
        score,
        passed,
        submitted_at: new Date()
      })
      .select()
      .single();

    if (error) throw error;

    if (xpAwarded > 0) {
      await awardXp(req.user.userId, xpAwarded, 'quiz_pass');
    }
    await evaluateAchievements(req.user.userId);

    res.json({
      success: true,
      message: passed ? 'Quiz passed!' : 'Quiz failed. Try again.',
      data: {
        submission: {
          ...submission,
          correct_answers: correctCount,
          total_questions: totalCount,
          answers: typeof submission.answers === 'string' ? JSON.parse(submission.answers) : submission.answers
        },
        review,
        xp_awarded: xpAwarded
      }
    });
  } catch (error) {
    console.error('Quiz submission error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit quiz: ' + error.message
    });
  }
});

/**
 * GET /api/quizzes/:id/results
 * Get quiz results for student
 */
router.get('/:id/results', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: submission } = await supabase
      .from('quiz_submissions')
      .select('*')
      .eq('quiz_id', id)
      .eq('student_id', req.user.userId)
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!submission) {
      return res.status(404).json({
        success: false,
        error: 'No submission found for this quiz'
      });
    }

    const submittedAnswers = typeof submission.answers === 'string'
      ? JSON.parse(submission.answers)
      : (submission.answers || {});

    const { data: questions } = await supabase
      .from('quiz_questions')
      .select('id, question, correct_answer, explanation, order_number, question_type')
      .eq('quiz_id', id)
      .order('order_number', { ascending: true });

    const review = (questions || []).map(question => {
      const studentAnswer = submittedAnswers[question.id];
      return {
        question_id: question.id,
        question: question.question,
        student_answer: studentAnswer ?? null,
        correct_answer: question.correct_answer,
        is_correct: answersMatch(studentAnswer, question.correct_answer, question.question_type),
        explanation: question.explanation || null
      };
    });

    res.json({
      success: true,
      data: {
        submission: {
          ...submission,
          answers: submittedAnswers
        },
        review
      }
    });
  } catch (error) {
    console.error('Quiz results error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch results: ' + error.message
    });
  }
});


module.exports = router;