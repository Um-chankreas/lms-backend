const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const textbookStorage = require('../config/textbookStorage');
const { optionalAuth } = require('../middleware/auth');
const { parseFormulaName } = require('../utils/formulaNames');

/**
 * Formula sheets — the `Formula` bucket's revision summaries.
 *
 *   GET /api/formulas                   every sheet
 *   GET /api/formulas?subject=physics   one subject (slug, not the Khmer)
 *   GET /api/formulas?grade=11          every sheet covering that grade
 *   GET /api/formulas/:id               one sheet, by filename stem
 *
 * No table here either — the bucket is the catalogue (see
 * utils/formulaNames.js) — but it differs from /api/textbooks and
 * /api/past-papers in one way that matters: this bucket is PRIVATE. There is
 * no public URL to hand out; Supabase answers its public endpoint with
 * NoSuchBucket. So each file_url is a presigned S3 URL, which keeps the app
 * fetching PDFs straight from storage instead of streaming 21 MB through
 * this server.
 *
 * Only the parsed listing is cached, never the URLs — they are signed per
 * request so a response never carries a part-spent one. `file_url_expires_at`
 * is a refresh deadline for the client, not a guarantee from storage:
 * Supabase ignores the expiry we sign in and enforces its own window of
 * roughly 12-18 hours (see config/textbookStorage.js). Refreshing by that
 * timestamp is always safe; assuming the old link is dead by then is not.
 *
 * Browsing is open (optionalAuth), matching the other shelves — which means
 * a guest can obtain a link that keeps working for most of a day. That is
 * fine for revision sheets, but it does mean this bucket being private buys
 * no real access control as wired up here. If these files are meant to be
 * gated, swap optionalAuth for authenticateToken.
 */

const BUCKET = 'Formula';
const URL_TTL_SECONDS = 6 * 60 * 60;

// Only the names are cached; see the note above on why the URLs are not.
const TTL_MS = 60 * 1000;
let cache = { at: 0, sheets: null };

const isMissingBucket = (error) =>
  /NoSuchBucket/i.test(error.code || '') || /bucket not found/i.test(error.message || '');

/** Parsed entries, without URLs. */
async function listAll() {
  if (cache.sheets && Date.now() - cache.at < TTL_MS) return cache.sheets;

  if (!textbookStorage.isConfigured()) {
    console.warn('TEXTBOOK_S3_* not configured — serving an empty formula shelf');
    cache = { at: Date.now(), sheets: [] };
    return [];
  }

  let entries;
  try {
    entries = await textbookStorage.listBucket(BUCKET);
  } catch (error) {
    if (isMissingBucket(error)) {
      console.warn(`${BUCKET} bucket missing — serving an empty formula shelf`);
      cache = { at: Date.now(), sheets: [] };
      return [];
    }
    throw error;
  }

  const sheets = [];
  for (const entry of entries) {
    const parsed = parseFormulaName(entry.name);
    if (!parsed) continue;
    sheets.push({ parsed, size: entry.size ?? null });
  }

  // The leading number is an upload id, so it would interleave subjects —
  // subject then grade is the order a student would look for.
  sheets.sort((a, b) =>
    (a.parsed.subject_slug || '').localeCompare(b.parsed.subject_slug || '') ||
    (a.parsed.grade_from ?? 99) - (b.parsed.grade_from ?? 99) ||
    a.parsed.id.localeCompare(b.parsed.id));

  cache = { at: Date.now(), sheets };
  return sheets;
}

// Cover thumbnails — page one of each sheet, rendered and uploaded by
// scripts/make-covers.js. They sit in THIS project's public course-materials
// bucket: the Formula bucket is private, so a cover stored beside the PDF
// would itself need signing on every request.
const COVER_BUCKET = 'course-materials';
const COVER_PREFIX = 'formula-covers';

const coverUrl = (id) =>
  `${process.env.SUPABASE_URL}/storage/v1/object/public/${COVER_BUCKET}/${COVER_PREFIX}/${encodeURIComponent(id)}.jpg`;

/** Ids that actually have a cover, so the app is never handed a 404. */
async function coveredIds() {
  const ids = new Set();
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await supabase.storage
      .from(COVER_BUCKET)
      .list(COVER_PREFIX, { limit: 100, offset });
    if (error) {
      console.warn('could not list formula covers:', error.message);
      break;
    }
    for (const f of data || []) ids.add(f.name.replace(/\.jpg$/, ''));
    if (!data || data.length < 100) break;
  }
  return ids;
}

/** Add a freshly signed URL. Signing is local crypto — no round trip. */
function toPublic({ parsed, size }, covers) {
  const expiresAt = new Date(Date.now() + URL_TTL_SECONDS * 1000).toISOString();
  return {
    id: parsed.id,
    title: parsed.title,
    subtitle: parsed.subtitle,
    subject: parsed.subject_km,
    subject_slug: parsed.subject_slug,
    subject_en: parsed.subject_en,
    grade_from: parsed.grade_from,
    grade_to: parsed.grade_to,
    qualifier_slug: parsed.qualifier_slug,
    source: parsed.source_en,
    language: parsed.language,
    version: parsed.version,
    // Presigned: private bucket, so this is the only way in — and it lapses.
    file_url: textbookStorage.presignedUrl(BUCKET, parsed.filename, URL_TTL_SECONDS),
    file_url_expires_at: expiresAt,
    cover_url: covers && covers.has(parsed.id) ? coverUrl(parsed.id) : null,
    page_count: null,
    file_size: size,
  };
}

/**
 * GET /api/formulas?subject=&grade=
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    let sheets = await listAll();

    if (req.query.subject) {
      const subject = String(req.query.subject).toLowerCase();
      sheets = sheets.filter(s => s.parsed.subject_slug === subject);
    }

    if (req.query.grade) {
      const grade = parseInt(req.query.grade, 10);
      if (Number.isNaN(grade)) {
        return res.status(400).json({ success: false, error: 'grade must be a number' });
      }
      // A sheet spanning g10-g12 answers for any grade inside the range.
      sheets = sheets.filter(s =>
        s.parsed.grade_from !== null &&
        grade >= s.parsed.grade_from && grade <= s.parsed.grade_to);
    }

    const covers = await coveredIds();
    res.json({ success: true, data: { formulas: sheets.map(s => toPublic(s, covers)) } });
  } catch (error) {
    console.error('Formula list error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch formulas: ' + error.message });
  }
});

/**
 * GET /api/formulas/:id  — id is the filename without its .pdf
 */
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const sheets = await listAll();
    const sheet = sheets.find(s => s.parsed.id === req.params.id);
    if (!sheet) {
      return res.status(404).json({ success: false, error: 'Formula sheet not found' });
    }
    res.json({ success: true, data: { formula: toPublic(sheet, await coveredIds()) } });
  } catch (error) {
    console.error('Formula fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch formula: ' + error.message });
  }
});

module.exports = router;
