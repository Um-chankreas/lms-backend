// Quiz helpers shared by routes/quizzes.routes.js and routes/skipTests.routes.js.

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

// An explanation that names option letters ("B, A, C each alter the split
// ratio") only reads correctly against the order it was written for, so those
// questions keep their authored option order. Everything else gets shuffled.
const NAMES_OPTION_LETTERS = /(^|[^A-Za-z])[A-D]([^A-Za-z]|$)/;
const optionsFor = (question, options) =>
  Array.isArray(options) && options.length > 1
    && !(question.explanation && NAMES_OPTION_LETTERS.test(question.explanation))
    ? pickRandom(options, options.length)
    : options;

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

module.exports = { pickRandom, optionsFor, answersMatch };
