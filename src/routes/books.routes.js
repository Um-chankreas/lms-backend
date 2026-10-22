const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { optionalAuth } = require('../middleware/auth');

/**
 * The Library tab's shelf — standalone reading material (scanned textbook
 * chapters), separate from the course path's own lesson PDFs. See
 * sql/045_books.sql.
 *
 *   GET /api/books        the shelf, newest subject grouping left to the client
 *   GET /api/books/:id    one book
 *
 * Browsing is open (optionalAuth): the PDFs live in the public
 * `course-materials` bucket, so gating the listing would only hide the shelf,
 * not the files. Adding a book is still a manual insert until the portal
 * grows an upload screen.
 */

const publicUrl = (path) => path
  ? `${process.env.SUPABASE_URL}/storage/v1/object/public/course-materials/${path}`
  : null;

const toPublic = (book) => ({
  id: book.id,
  title: book.title,
  subtitle: book.subtitle,
  subject: book.subject,
  source: book.source,
  file_url: publicUrl(book.file_url),
  cover_url: publicUrl(book.cover_url),
  page_count: book.page_count,
});

// The table ships in a migration the deploy may not have run yet — an empty
// shelf reads better there than a 500 behind a brand-new tab. PostgREST
// answers PGRST205 from its schema cache; 42P01 is postgres itself, in case
// the request gets through before the cache reloads.
const MISSING_TABLE = new Set(['PGRST205', '42P01']);

/**
 * GET /api/books?subject=
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    let query = supabase
      .from('books')
      .select('*')
      .eq('is_published', true)
      .order('subject', { ascending: true })
      .order('order_number', { ascending: true });

    if (req.query.subject) query = query.eq('subject', String(req.query.subject));

    const { data, error } = await query;
    if (error) {
      if (MISSING_TABLE.has(error.code)) {
        console.warn('books table missing — run sql/045_books.sql');
        return res.json({ success: true, data: { books: [] } });
      }
      throw error;
    }

    res.json({ success: true, data: { books: (data || []).map(toPublic) } });
  } catch (error) {
    console.error('Book list error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch books: ' + error.message });
  }
});

/**
 * GET /api/books/:id
 */
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { data: book, error } = await supabase
      .from('books')
      .select('*')
      .eq('id', req.params.id)
      .eq('is_published', true)
      .maybeSingle();

    if (error && !MISSING_TABLE.has(error.code)) throw error;
    if (!book) return res.status(404).json({ success: false, error: 'Book not found' });

    res.json({ success: true, data: { book: toPublic(book) } });
  } catch (error) {
    console.error('Book fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch book: ' + error.message });
  }
});

module.exports = router;
