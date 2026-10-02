const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const textbookStorage = require('../config/textbookStorage');
const { optionalAuth } = require('../middleware/auth');
const { parseTextbookName } = require('../utils/textbookNames');

/**
 * The national textbook shelf — every scanned MoEYS chapter in the
 * `textbook-chapters` bucket, grades 1-12.
 *
 *   GET /api/textbooks                  every book
 *   GET /api/textbooks?grade=4          one grade
 *   GET /api/textbooks?subject=math     one subject (slug, not the Khmer name)
 *   GET /api/textbooks/:id              one book, by filename stem
 *
 * Unlike /api/books this is backed by no table at all: the bucket IS the
 * catalogue and each filename carries its own metadata (see
 * utils/textbookNames.js). Dropping a PDF into the bucket publishes it — no
 * migration, no insert, no redeploy.
 *
 * The bucket lives in a different Supabase project from this server's
 * database, so the listing goes through config/textbookStorage.js rather than
 * the usual supabase client. The bucket is public, so the PDFs themselves are
 * handed over as plain URLs and never proxied through here.
 *
 * Browsing is open (optionalAuth), for the same reason /api/books is: the
 * bucket is public, so gating the listing would hide the shelf, not the PDFs.
 */

const BUCKET = 'textbook-chapters';

// Auto-generated cover thumbnails — page one of each book, rendered and uploaded by
// scripts/make-textbook-covers.js. They live in THIS project's public
// course-materials bucket rather than beside the PDFs, because the textbook
// project's credentials here are read-only and images among the PDFs would
// show up in the shelf listing.
const COVER_BUCKET = 'course-materials';
const COVER_PREFIX = 'textbook-covers';

const generatedCoverUrl = (id) =>
  `${process.env.SUPABASE_URL}/storage/v1/object/public/${COVER_BUCKET}/${COVER_PREFIX}/${encodeURIComponent(id)}.jpg`;

/** Ids that actually have a cover — asking avoids handing the app URLs that
 * 404 while the render job is still working through the shelf. */
async function coveredIds() {
  const ids = new Set();
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await supabase.storage
      .from(COVER_BUCKET)
      .list(COVER_PREFIX, { limit: 100, offset });
    if (error) {
      console.warn('could not list textbook covers:', error.message);
      break;
    }
    for (const f of data || []) ids.add(f.name.replace(/\.jpg$/, ''));
    if (!data || data.length < 100) break;
  }
  return ids;
}

// The bucket changes only when someone uploads by hand, but the app asks for
// the shelf on every cold open. A short TTL keeps that to one storage round
// trip a minute without making new uploads wait long to appear.
const TTL_MS = 60 * 1000;
let cache = { at: 0, books: null };

const publicUrl = (name) => textbookStorage.publicUrl(BUCKET, name);

// A machine without the textbook credentials, or a project where the bucket
// hasn't been created, should serve an empty shelf rather than a 500.
const isMissingBucket = (error) =>
  /NoSuchBucket/i.test(error.code || '') || /bucket not found/i.test(error.message || '');

// `uploaded` = covers picked in the web portal (<id>.jpg beside the PDF);
// `generated` = page-one renders. An uploaded cover wins.
const toPublic = (entry, uploaded, generated) => {
  const parsed = parseTextbookName(entry.name);
  if (!parsed) return null;
  return {
    id: parsed.id,
    title: parsed.title,
    subtitle: parsed.subtitle,
    // Khmer display name: what the Library shelf prints as its heading.
    subject: parsed.subject_km,
    // Stable slug for filtering — the Khmer name is for reading, not matching.
    subject_slug: parsed.subject_slug,
    subject_en: parsed.subject_en,
    variant_slug: parsed.variant_slug,
    grade: parsed.grade,
    language: parsed.language,
    order_number: parsed.order_number,
    file_url: publicUrl(entry.name),
    // An optional <id>.jpg uploaded from the web portal wins; otherwise the
    // auto-rendered page one, if the render job has reached this book.
    cover_url: textbookStorage.coverUrl(BUCKET, parsed.id, uploaded)
      || (generated && generated.has(parsed.id) ? generatedCoverUrl(parsed.id) : null),
    // The bucket carries no page counts; the reader learns them on open.
    page_count: null,
    source: null,
    file_size: entry.size ?? null,
  };
};

/** Every PDF in the bucket, newest listing cached for TTL_MS. */
async function listAll() {
  if (cache.books && Date.now() - cache.at < TTL_MS) return cache.books;

  if (!textbookStorage.isConfigured()) {
    console.warn('TEXTBOOK_S3_* not configured — serving an empty textbook shelf');
    cache = { at: Date.now(), books: [] };
    return [];
  }

  let entries;
  try {
    entries = await textbookStorage.listBucket(BUCKET);
  } catch (error) {
    if (isMissingBucket(error)) {
      console.warn(`${BUCKET} bucket missing — serving an empty textbook shelf`);
      cache = { at: Date.now(), books: [] };
      return [];
    }
    throw error;
  }

  const uploaded = textbookStorage.coverIndex(entries);
  const generated = await coveredIds();

  const books = [];
  for (const entry of entries) {
    const book = toPublic(entry, uploaded, generated);
    if (book) books.push(book);
  }

  // Grade first, then the number the uploader put at the front of the name.
  books.sort((a, b) =>
    (a.grade ?? 99) - (b.grade ?? 99) ||
    a.order_number - b.order_number ||
    a.id.localeCompare(b.id));

  cache = { at: Date.now(), books };
  return books;
}

/**
 * GET /api/textbooks?grade=&subject=
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    let books = await listAll();

    if (req.query.grade) {
      const grade = parseInt(req.query.grade, 10);
      if (Number.isNaN(grade)) {
        return res.status(400).json({ success: false, error: 'grade must be a number' });
      }
      books = books.filter(b => b.grade === grade);
    }

    if (req.query.subject) {
      const subject = String(req.query.subject).toLowerCase();
      books = books.filter(b => b.subject_slug === subject);
    }

    res.json({ success: true, data: { textbooks: books } });
  } catch (error) {
    console.error('Textbook list error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch textbooks: ' + error.message });
  }
});

/**
 * GET /api/textbooks/:id  — id is the filename without its .pdf
 */
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const books = await listAll();
    const textbook = books.find(b => b.id === req.params.id);
    if (!textbook) {
      return res.status(404).json({ success: false, error: 'Textbook not found' });
    }
    res.json({ success: true, data: { textbook } });
  } catch (error) {
    console.error('Textbook fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch textbook: ' + error.message });
  }
});

// Called by library.routes.js after an upload so the new book shows at once
// instead of after the TTL.
router.clearCache = () => { cache = { at: 0, books: null }; };

module.exports = router;
