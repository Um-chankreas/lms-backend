/**
 * Turning a `past-papers` filename into shelf metadata.
 *
 * These names follow a different convention from the textbooks: no grade and
 * no subject token, just a running number and the topic itself.
 *
 *   01-french-period-key-questions.pdf
 *   02-french-period-answers.pdf
 *   03-sangkum-reastr-niyum.pdf
 *   12-bac-history-2014-2019.pdf
 *
 * Shape: <order>-<topic>[-key-questions|-answers].pdf
 *
 * A topic slug carries no Khmer in it, so unlike utils/textbookNames.js the
 * titles can't be derived — they're mapped below. The whole bucket is one
 * curated BacII history set, so a map of a dozen entries is the honest way to
 * do it; an unmapped topic still shelves, under its prettified slug, so a new
 * upload is never invisible — it just reads in English until someone adds a
 * line to TOPICS.
 *
 * The question/answer pairing is what the `-answers` suffix is for: stripping
 * it yields the same topic slug as the paper it answers (02 -> 01, 04 -> 03),
 * which is how pastPapers.routes.js links the two.
 */

const KHMER_DIGITS = '០១២៣៤៥៦៧៨៩';
const toKhmerNumber = (n) => String(n).replace(/\d/g, (d) => KHMER_DIGITS[+d]);

// Topic slug -> how it reads on the shelf. `subject` is here rather than in
// the filename because the names carry none: every paper in the bucket today
// is history, but saying so per-topic keeps a future maths upload honest
// instead of silently inheriting the wrong subject.
const TOPICS = {
  'french-period': {
    km: 'សម័យអាណានិគមបារាំង', en: 'The French Colonial Period', subject: 'history' },
  'sangkum-reastr-niyum': {
    km: 'សង្គមរាស្ត្រនិយម', en: 'Sangkum Reastr Niyum', subject: 'history' },
  'khmer-republic': {
    km: 'សាធារណរដ្ឋខ្មែរ', en: 'The Khmer Republic', subject: 'history' },
  'democratic-kampuchea': {
    km: 'កម្ពុជាប្រជាធិបតេយ្យ', en: 'Democratic Kampuchea', subject: 'history' },
  'peoples-republic-kampuchea': {
    km: 'សាធារណរដ្ឋប្រជាមានិតកម្ពុជា', en: "The People's Republic of Kampuchea", subject: 'history' },
  'second-kingdom': {
    km: 'ព្រះរាជាណាចក្រកម្ពុជាទីពីរ', en: 'The Second Kingdom', subject: 'history' },
  'cambodia-general-history': {
    km: 'ប្រវត្តិសាស្ត្រកម្ពុជាទូទៅ', en: 'General History of Cambodia', subject: 'history' },
  'regional-world-history': {
    km: 'ប្រវត្តិសាស្ត្រតំបន់ និងពិភពលោក', en: 'Regional & World History', subject: 'history' },
  'exam-prep-general': {
    km: 'ត្រៀមប្រឡងទូទៅ', en: 'General Exam Preparation', subject: 'history' },
  'bac-history-2014-2019': {
    km: 'វិញ្ញាសាបាក់ឌុប ប្រវត្តិវិទ្យា ២០១៤-២០១៩', en: 'BacII History Papers 2014-2019', subject: 'history' },
  'grade12-history-summary': {
    km: 'សង្ខេបប្រវត្តិវិទ្យា ថ្នាក់ទី១២', en: 'Grade 12 History Summary', subject: 'history' },
  'extra-paper': {
    km: 'វិញ្ញាសាបន្ថែម', en: 'Extra Paper', subject: 'history' },
};

const SUBJECTS = {
  history: { km: 'ប្រវត្តិវិទ្យា', en: 'History' },
};

// Trailing markers that say what the file is rather than what it's about.
// Order matters: the longest suffix has to be tested first.
const KINDS = [
  { suffix: '-key-questions', kind: 'questions', km: 'សំណួរគន្លឹះ', en: 'Key Questions' },
  { suffix: '-answers',       kind: 'answers',   km: 'ចម្លើយ',      en: 'Answers' },
];

// `bac-history-2014-2019` — the years are part of the topic, not an order.
const YEAR_RANGE = /(\d{4})-(\d{4})/;

/** "second-kingdom" -> "Second Kingdom", for a topic nobody has mapped yet. */
const prettify = (slug) => slug
  .split('-')
  .map(w => (/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
  .join(' ');

/**
 * Parse one filename. Returns null for anything that isn't a PDF — the
 * `.emptyFolderPlaceholder` Supabase leaves behind must not reach the shelf.
 *
 * A PDF that doesn't fit the convention is still returned, with order 0 and
 * its stem as the title: a mis-named upload should look wrong in the app,
 * not vanish from it.
 */
function parsePastPaperName(filename) {
  if (!/\.pdf$/i.test(filename)) return null;

  const stem = filename.replace(/\.pdf$/i, '');
  const match = /^(\d+)-(.+)$/.exec(stem);

  if (!match) {
    return {
      id: stem, filename, order_number: 0,
      topic_slug: null, kind: 'paper', is_answer_key: false,
      subject_slug: null, subject_km: null, subject_en: null,
      years: null, title: prettify(stem), subtitle: null,
    };
  }

  const [, order, rest] = match;

  const marker = KINDS.find(k => rest.endsWith(k.suffix));
  // Stripping the marker leaves the topic the paper shares with its pair.
  const topicSlug = marker ? rest.slice(0, -marker.suffix.length) : rest;
  const topic = TOPICS[topicSlug] || null;

  const subjectSlug = topic ? topic.subject : null;
  const subject = subjectSlug ? SUBJECTS[subjectSlug] : null;

  const titleKm = topic ? topic.km : prettify(topicSlug);
  const titleEn = topic ? topic.en : prettify(topicSlug);

  const years = YEAR_RANGE.exec(topicSlug);

  return {
    id: stem,
    filename,
    order_number: parseInt(order, 10),
    topic_slug: topicSlug,
    // 'questions' | 'answers' | 'paper' (a standalone paper with neither marker)
    kind: marker ? marker.kind : 'paper',
    is_answer_key: marker ? marker.kind === 'answers' : false,
    subject_slug: subjectSlug,
    subject_km: subject ? subject.km : null,
    subject_en: subject ? subject.en : null,
    years: years ? { from: parseInt(years[1], 10), to: parseInt(years[2], 10) } : null,
    title: marker ? `${titleKm} (${marker.km})` : titleKm,
    subtitle: marker ? `${titleEn} (${marker.en})` : titleEn,
  };
}

module.exports = { parsePastPaperName, toKhmerNumber, TOPICS, SUBJECTS };
