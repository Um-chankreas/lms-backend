/**
 * Turning a `Formula` filename into shelf metadata.
 *
 * A third convention, different again from the textbooks and the past papers:
 *
 *   00000136-chemistry-formulas-g12-khmer.pdf
 *   00003344-math-formulas-g10-g12-khmer.pdf
 *   00003791-physics-formulas-summary-g12-khmer-v2.pdf
 *   00003792-physics-formulas-and-solutions-g12-study-club-khmer.pdf
 *
 * Shape: <8-digit id>-<subject>-formulas[-qualifier]-g<NN>[-g<NN>][-source]-<language>[-v<N>]
 *
 * Two things stop this being a positional split. Qualifiers appear on either
 * side of the grade ("...-and-solutions-g12-study-club-khmer"), and the grade
 * may be a range rather than one value. So rather than reading fields by
 * position, the structural tokens — grade, language, version, source — are
 * pulled out wherever they sit and whatever is left over is the qualifier.
 *
 * The leading number is an upload id, not a reading order: it's stable and
 * unique, so it anchors the id, but sorting by it would shuffle subjects
 * together and the route sorts by subject and grade instead.
 */

const { SUBJECTS } = require('./textbookNames');

const KHMER_DIGITS = '០១២៣៤៥៦៧៨៩';
const toKhmerNumber = (n) => String(n).replace(/\d/g, (d) => KHMER_DIGITS[+d]);

const LANGUAGES = new Set(['khmer', 'english']);

// Where a sheet came from, when the name says so.
const SOURCES = {
  'study-club': { km: 'ក្លឹបសិក្សា', en: 'Study Club' },
};

// What the sheet is, beyond the bare formulas.
const QUALIFIERS = {
  'and-solutions': { km: 'និងដំណោះស្រាយ', en: 'with Solutions' },
  'summary':       { km: 'សង្ខេប',        en: 'Summary' },
};

const GRADE = /^g(\d{1,2})$/;
const VERSION = /^v(\d+)$/;

const prettify = (slug) => slug
  .split('-')
  .map(w => w.charAt(0).toUpperCase() + w.slice(1))
  .join(' ');

/** "ថ្នាក់ទី១២" or "ថ្នាក់ទី១០-១២" */
const gradeLabelKm = (from, to) => from == null
  ? null
  : `ថ្នាក់ទី${toKhmerNumber(from)}${to !== from ? `-${toKhmerNumber(to)}` : ''}`;

const gradeLabelEn = (from, to) => from == null
  ? null
  : `Grade ${from}${to !== from ? `-${to}` : ''}`;

/**
 * Parse one filename. Returns null for anything that isn't a PDF.
 *
 * A PDF that doesn't fit the convention is still returned, with its stem as
 * the title, so a mis-named upload looks wrong in the app rather than
 * disappearing from it.
 */
function parseFormulaName(filename) {
  if (!/\.pdf$/i.test(filename)) return null;

  const stem = filename.replace(/\.pdf$/i, '');
  const match = /^(\d{6,})-(.+)$/.exec(stem);

  if (!match) {
    return {
      id: stem, filename, upload_id: null,
      subject_slug: null, subject_km: null, subject_en: null,
      grade_from: null, grade_to: null,
      qualifier_slug: null, source_slug: null, source_en: null,
      language: null, version: 1,
      title: prettify(stem), subtitle: null,
    };
  }

  const [, uploadId, rest] = match;
  let tokens = rest.toLowerCase().split('-').filter(Boolean);

  // Pull the structural tokens out wherever they sit, rather than by position.
  const grades = [];
  let language = null;
  let version = 1;

  tokens = tokens.filter((t) => {
    const g = GRADE.exec(t);
    if (g) { grades.push(parseInt(g[1], 10)); return false; }
    const v = VERSION.exec(t);
    if (v) { version = parseInt(v[1], 10); return false; }
    if (LANGUAGES.has(t)) { language = t; return false; }
    return true;
  });

  // The subject leads; "formulas" is the same for every file in the bucket.
  const subjectSlug = tokens.shift() || null;
  const subject = subjectSlug ? SUBJECTS[subjectSlug] : null;
  tokens = tokens.filter(t => t !== 'formulas');

  // A multi-word source sits inside what's left — lift it out before the
  // remainder becomes the qualifier.
  let sourceSlug = null;
  const remainder = tokens.join('-');
  for (const slug of Object.keys(SOURCES)) {
    if (remainder === slug || remainder.includes(slug)) { sourceSlug = slug; break; }
  }
  const qualifierSlug = (sourceSlug
    ? remainder.replace(sourceSlug, '').replace(/^-|-$/g, '').replace(/--+/g, '-')
    : remainder) || null;

  const source = sourceSlug ? SOURCES[sourceSlug] : null;
  const qualifier = qualifierSlug ? QUALIFIERS[qualifierSlug] : null;

  const gradeFrom = grades.length ? Math.min(...grades) : null;
  const gradeTo = grades.length ? Math.max(...grades) : null;

  const subjectKm = subject ? subject.km : subjectSlug;
  const subjectEn = subject ? subject.en : subjectSlug;

  // "រូបមន្តរូបវិទ្យា ថ្នាក់ទី១២ (សង្ខេប)"
  const titleKm = [
    `រូបមន្ត${subjectKm || ''}`,
    gradeLabelKm(gradeFrom, gradeTo),
    qualifier ? `(${qualifier.km})` : qualifierSlug ? `(${prettify(qualifierSlug)})` : null,
    version > 1 ? `កំណែទី${toKhmerNumber(version)}` : null,
  ].filter(Boolean).join(' ');

  const subtitleEn = [
    `${subjectEn || ''} Formulas`.trim(),
    gradeLabelEn(gradeFrom, gradeTo),
    qualifier ? `(${qualifier.en})` : qualifierSlug ? `(${prettify(qualifierSlug)})` : null,
    version > 1 ? `v${version}` : null,
    source ? source.en : null,
  ].filter(Boolean).join(' · ');

  return {
    id: stem,
    filename,
    upload_id: uploadId,
    subject_slug: subjectSlug,
    subject_km: subjectKm,
    subject_en: subjectEn,
    grade_from: gradeFrom,
    grade_to: gradeTo,
    qualifier_slug: qualifierSlug,
    source_slug: sourceSlug,
    source_en: source ? source.en : null,
    language,
    version,
    title: titleKm,
    subtitle: subtitleEn,
  };
}

module.exports = { parseFormulaName, toKhmerNumber, QUALIFIERS, SOURCES };
