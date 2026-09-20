const { parse: parseCsv } = require('csv-parse/sync');

// Shared quiz-question CSV parsing — used by quizzes.routes.js (question
// bank + unit-practice bulk import) and assignments.routes.js (MCQ
// assignment question import). Extracted so both stay in sync rather than
// drifting as two copies.

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

module.exports = { LETTER_INDEX, pickCol, normalizeTier, normalizeQuestionType, parseQuestionRows };
