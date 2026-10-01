/**
 * Turning a `textbook-chapters` filename into shelf metadata.
 *
 * Unlike `course-materials` — where uploads sanitize down to
 * `<uuid>-<ts>-_.pdf` and every scrap of metadata has to live in the `books`
 * table (see sql/045_books.sql) — the textbook chapters were uploaded by hand
 * with meaningful names, so the file IS the record:
 *
 *   01-grade01-khmer-khmer.pdf     order 1, grade 1, Khmer, in Khmer
 *   01-grade12-math-basic-khmer.pdf         grade 12, maths (basic track)
 *   03-grade10-math-part2-khmer.pdf         grade 10, maths, part 2
 *   02-grade12-english.pdf                  grade 12, English, no language tag
 *
 * Shape: <order>-grade<NN>-<subject>[-<variant>…][-<language>].pdf
 *
 * The trailing language tag is optional, which makes it ambiguous with a
 * one-word subject: `english.pdf` is the subject, `math-khmer.pdf` is subject
 * + language, and `khmer-khmer.pdf` is both. The rule that settles all three:
 * only treat a trailing token as the language when something is left in front
 * of it to be the subject.
 */

// Tokens that are a language tag when they trail a subject, not a subject.
const LANGUAGES = new Set(['khmer', 'english']);

// Subject slug -> how it reads on a shelf. The Khmer name is what the app
// shows (ApiBook.subject is rendered raw as the shelf heading, and the seeded
// rows in `books` are already Khmer), the English one goes in the subtitle.
const SUBJECTS = {
  khmer:      { km: 'ភាសាខ្មែរ',      en: 'Khmer' },
  math:       { km: 'គណិតវិទ្យា',      en: 'Mathematics' },
  science:    { km: 'វិទ្យាសាស្ត្រ',     en: 'Science' },
  social:     { km: 'សិក្សាសង្គម',     en: 'Social Studies' },
  history:    { km: 'ប្រវត្តិវិទ្យា',     en: 'History' },
  geography:  { km: 'ភូមិវិទ្យា',       en: 'Geography' },
  english:    { km: 'ភាសាអង់គ្លេស',    en: 'English' },
  pe:         { km: 'អប់រំកាយ',       en: 'Physical Education' },
  biology:    { km: 'ជីវវិទ្យា',        en: 'Biology' },
  chemistry:  { km: 'គីមីវិទ្យា',       en: 'Chemistry' },
  physics:    { km: 'រូបវិទ្យា',        en: 'Physics' },
  earth:      { km: 'ផែនដីវិទ្យា',      en: 'Earth Science' },
  moral:      { km: 'សីលធម៌-ពលរដ្ឋ',  en: 'Moral & Civics' },
  ict:        { km: 'ព័ត៌មានវិទ្យា',     en: 'ICT' },
};

// Edition/part suffixes seen in the bucket. An unmapped one still shows —
// as its own slug — rather than being silently dropped from the title.
const VARIANTS = {
  basic:    { km: 'មូលដ្ឋាន', en: 'Basic' },
  advanced: { km: 'កម្រិតខ្ពស់', en: 'Advanced' },
  part1:    { km: 'ភាគ១',    en: 'Part 1' },
  part2:    { km: 'ភាគ២',    en: 'Part 2' },
  part3:    { km: 'ភាគ៣',    en: 'Part 3' },
  homework: { km: 'លំហាត់',   en: 'Homework' },
  teacher:  { km: 'សៀវភៅគ្រូ', en: "Teacher's Book" },
};

const KHMER_DIGITS = '០១២៣៤៥៦៧៨៩';
const toKhmerNumber = (n) => String(n).replace(/\d/g, (d) => KHMER_DIGITS[+d]);

/**
 * Parse one filename. Returns null for anything that isn't a PDF — folder
 * placeholders and stray uploads shouldn't reach the shelf.
 *
 * A PDF whose name doesn't fit the convention is still returned, with
 * grade/subject null and its stem as the title: a mis-named upload should
 * look wrong in the app, not vanish from it.
 */
function parseTextbookName(filename) {
  if (!/\.pdf$/i.test(filename)) return null;

  const stem = filename.replace(/\.pdf$/i, '');
  const match = /^(\d+)-grade(\d+)-(.+)$/i.exec(stem);

  if (!match) {
    return {
      id: stem, filename,
      order_number: 0, grade: null,
      subject_slug: null, subject_km: null, subject_en: null,
      variant_slug: null, language: null,
      title: stem, subtitle: null,
    };
  }

  const [, order, grade, rest] = match;
  const tokens = rest.toLowerCase().split('-').filter(Boolean);

  // Only a trailing token with a subject still in front of it is a language.
  const language = tokens.length > 1 && LANGUAGES.has(tokens[tokens.length - 1])
    ? tokens.pop()
    : null;

  const subjectSlug = tokens.shift() || null;
  const subject = SUBJECTS[subjectSlug] || null;
  const variantSlug = tokens.length ? tokens.join('-') : null;
  const variant = variantSlug ? VARIANTS[variantSlug] : null;

  const gradeNum = parseInt(grade, 10);
  // An unknown subject falls back to its own slug so the book still shelves
  // somewhere readable instead of under "null".
  const subjectKm = subject ? subject.km : subjectSlug;
  const subjectEn = subject ? subject.en : subjectSlug;

  const suffixKm = variant ? ` (${variant.km})` : variantSlug ? ` (${variantSlug})` : '';
  const suffixEn = variant ? ` (${variant.en})` : variantSlug ? ` (${variantSlug})` : '';

  return {
    id: stem,
    filename,
    order_number: parseInt(order, 10),
    grade: gradeNum,
    subject_slug: subjectSlug,
    subject_km: subjectKm,
    subject_en: subjectEn,
    variant_slug: variantSlug,
    language,
    title: `${subjectKm} ថ្នាក់ទី${toKhmerNumber(gradeNum)}${suffixKm}`,
    subtitle: `${subjectEn} · Grade ${gradeNum}${suffixEn}`,
  };
}

module.exports = { parseTextbookName, toKhmerNumber, SUBJECTS };
