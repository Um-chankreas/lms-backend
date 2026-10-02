const express = require('express');
const multer = require('multer');
const router = express.Router();
const textbookStorage = require('../config/textbookStorage');
const { authenticateToken, isAdmin } = require('../middleware/auth');
const { SUBJECTS, VARIANTS, LANGUAGES } = require('../utils/textbookNames');
const { TOPICS } = require('../utils/pastPaperNames');

/**
 * Uploading to the Library from the web portal.
 *
 *   GET  /api/library/options   the dropdown values the upload form needs
 *   POST /api/library/upload    multipart: file + kind + naming fields
 *
 * The shelves are driven by filenames (see utils/textbookNames.js and
 * utils/pastPaperNames.js), so the whole job here is building a correctly
 * formed name from form fields and putting the PDF under it — the uploader
 * never types a filename and can't get the convention wrong.
 *
 * Admin-only. Browsing stays on /api/textbooks and /api/past-papers.
 */

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_COVER_BYTES = 5 * 1024 * 1024;

// The portal crops and re-encodes every cover to a JPEG before sending it, so
// that's the only format accepted — one extension, one filename per book.
const isJpeg = (buf) => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
/** Returns an error message, or null when the file is an acceptable cover. */
const coverProblem = (file) => {
  if (!isJpeg(file.buffer)) return 'Cover must be a JPEG image';
  if (file.size > MAX_COVER_BYTES) return `Cover is larger than ${MAX_COVER_BYTES / 1024 / 1024} MB`;
  return null;
};

const upload = multer({
  storage: multer.memoryStorage(),
  // 2 = the PDF plus its optional cover on /upload. maxCount on each field
  // (and upload.single on the cover route) still caps every field at one.
  limits: { fileSize: MAX_PDF_BYTES, files: 2 },
});

const BUCKETS = { textbook: 'textbook-chapters', 'past-paper': 'past-papers' };
const PAPER_SUFFIX = { questions: '-key-questions', answers: '-answers', paper: '' };

const pad2 = (n) => String(n).padStart(2, '0');
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

class FormError extends Error {}

/** Build the bucket filename for the submitted fields, or throw FormError. */
function buildName(kind, f) {
  const order = parseInt(f.order, 10);
  if (!Number.isInteger(order) || order < 0 || order > 99) {
    throw new FormError('order must be a number from 0 to 99');
  }

  if (kind === 'textbook') {
    const grade = parseInt(f.grade, 10);
    if (!Number.isInteger(grade) || grade < 1 || grade > 12) {
      throw new FormError('grade must be 1-12');
    }
    const subject = String(f.subject || '').toLowerCase();
    if (!SUBJECTS[subject]) throw new FormError('Unknown subject');

    const parts = [`${pad2(order)}`, `grade${pad2(grade)}`, subject];
    const variant = String(f.variant || '').toLowerCase();
    if (variant) {
      if (!VARIANTS[variant]) throw new FormError('Unknown edition/part');
      parts.push(variant);
    }
    const language = String(f.language || '').toLowerCase();
    if (language) {
      if (!LANGUAGES.has(language)) throw new FormError('Unknown language');
      parts.push(language);
    }
    return `${parts.join('-')}.pdf`;
  }

  const topic = String(f.topic || '').trim().toLowerCase();
  if (!SLUG.test(topic)) {
    throw new FormError('topic must be lowercase letters, numbers and hyphens, e.g. khmer-republic');
  }
  const role = String(f.paper_kind || 'paper');
  if (!(role in PAPER_SUFFIX)) throw new FormError('paper_kind must be questions, answers or paper');
  return `${pad2(order)}-${topic}${PAPER_SUFFIX[role]}.pdf`;
}

router.get('/options', authenticateToken, isAdmin, (req, res) => {
  const pick = (map) => Object.entries(map).map(([slug, v]) => ({ slug, km: v.km, en: v.en }));
  res.json({
    success: true,
    data: {
      configured: textbookStorage.isConfigured(),
      max_bytes: MAX_PDF_BYTES,
      subjects: pick(SUBJECTS),
      variants: pick(VARIANTS),
      languages: [...LANGUAGES],
      topics: Object.entries(TOPICS).map(([slug, v]) => ({ slug, km: v.km, en: v.en })),
    },
  });
});

router.post('/upload', authenticateToken, isAdmin, (req, res) => {
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'cover', maxCount: 1 }])(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        success: false,
        error: tooBig ? `PDF is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB` : err.message,
      });
    }

    try {
      if (!textbookStorage.isConfigured()) {
        return res.status(503).json({
          success: false,
          error: 'Textbook storage is not configured on the server (TEXTBOOK_* in .env).',
        });
      }
      const file = req.files?.file?.[0];
      const cover = req.files?.cover?.[0];
      if (!file) return res.status(400).json({ success: false, error: 'Choose a PDF to upload' });
      // Check the bytes, not the browser-supplied mimetype or extension.
      if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return res.status(400).json({ success: false, error: 'That file is not a PDF' });
      }

      const kind = req.body.kind;
      if (!BUCKETS[kind]) {
        return res.status(400).json({ success: false, error: 'kind must be textbook or past-paper' });
      }

      if (cover) {
        const problem = coverProblem(cover);
        if (problem) return res.status(400).json({ success: false, error: problem });
      }

      let name;
      try {
        name = buildName(kind, req.body);
      } catch (e) {
        if (e instanceof FormError) return res.status(400).json({ success: false, error: e.message });
        throw e;
      }

      // S3 PUT overwrites silently; refuse unless the uploader asked to replace.
      const bucket = BUCKETS[kind];
      const existing = await textbookStorage.listBucket(bucket);
      if (existing.some(o => o.name === name) && req.body.overwrite !== 'true') {
        return res.status(409).json({
          success: false,
          error: `${name} already exists. Change the order number, or confirm to replace it.`,
          data: { name },
        });
      }

      const fileUrl = await textbookStorage.putObject(bucket, name, file.buffer, 'application/pdf');
      if (cover) {
        await textbookStorage.putObject(bucket, `${name.replace(/\.pdf$/, '')}.jpg`, cover.buffer, 'image/jpeg');
      }

      clearShelfCache(kind);

      res.status(201).json({ success: true, data: { name, file_url: fileUrl, size: file.size } });
    } catch (error) {
      console.error('Library upload error:', error);
      res.status(500).json({ success: false, error: 'Upload failed: ' + error.message });
    }
  });
});

const clearShelfCache = (kind) =>
  require(kind === 'textbook' ? './textbooks.routes' : './pastPapers.routes').clearCache();

/** Shared guard: configured storage, valid kind, and the file really exists. */
async function findExisting(req, res) {
  if (!textbookStorage.isConfigured()) {
    res.status(503).json({ success: false, error: 'Textbook storage is not configured on the server.' });
    return null;
  }
  const { kind, id } = req.params;
  if (!BUCKETS[kind]) {
    res.status(400).json({ success: false, error: 'kind must be textbook or past-paper' });
    return null;
  }
  const name = `${id}.pdf`;
  const existing = await textbookStorage.listBucket(BUCKETS[kind]);
  if (!existing.some(o => o.name === name)) {
    res.status(404).json({ success: false, error: 'File not found' });
    return null;
  }
  return { bucket: BUCKETS[kind], name, existing };
}

/**
 * PUT /api/library/:kind/:id  — change a file's grade/subject/order/etc.
 * S3 has no rename, so this copies the PDF to the new name and removes the old.
 * Body: the same naming fields as an upload (no file).
 */
router.put('/:kind/:id', authenticateToken, isAdmin, express.json(), async (req, res) => {
  try {
    const found = await findExisting(req, res);
    if (!found) return;

    let newName;
    try {
      newName = buildName(req.params.kind, req.body);
    } catch (e) {
      if (e instanceof FormError) return res.status(400).json({ success: false, error: e.message });
      throw e;
    }
    if (newName === found.name) {
      return res.json({ success: true, data: { name: newName, unchanged: true } });
    }
    if (found.existing.some(o => o.name === newName)) {
      return res.status(409).json({ success: false, error: `${newName} already exists. Pick a different order number.` });
    }

    const bytes = await textbookStorage.getPublicObject(found.bucket, found.name);
    const fileUrl = await textbookStorage.putObject(found.bucket, newName, bytes, 'application/pdf');
    await textbookStorage.deleteObject(found.bucket, found.name);

    // A cover is named after its PDF, so it has to follow the rename.
    const oldCover = `${req.params.id}.jpg`;
    if (found.existing.some(o => o.name === oldCover)) {
      const coverBytes = await textbookStorage.getPublicObject(found.bucket, oldCover);
      await textbookStorage.putObject(found.bucket, `${newName.replace(/\.pdf$/, '')}.jpg`, coverBytes, 'image/jpeg');
      await textbookStorage.deleteObject(found.bucket, oldCover);
    }
    clearShelfCache(req.params.kind);

    res.json({ success: true, data: { name: newName, file_url: fileUrl } });
  } catch (error) {
    console.error('Library edit error:', error);
    res.status(500).json({ success: false, error: 'Edit failed: ' + error.message });
  }
});

/** DELETE /api/library/:kind/:id — permanently removes the PDF from the shelf. */
router.delete('/:kind/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const found = await findExisting(req, res);
    if (!found) return;
    await textbookStorage.deleteObject(found.bucket, found.name);
    const cover = `${req.params.id}.jpg`;
    if (found.existing.some(o => o.name === cover)) await textbookStorage.deleteObject(found.bucket, cover);
    clearShelfCache(req.params.kind);
    res.json({ success: true, data: { name: found.name } });
  } catch (error) {
    console.error('Library delete error:', error);
    res.status(500).json({ success: false, error: 'Delete failed: ' + error.message });
  }
});

/** PUT /api/library/:kind/:id/cover — multipart `cover` (a cropped JPEG). */
router.put('/:kind/:id/cover', authenticateToken, isAdmin, (req, res) => {
  upload.single('cover')(req, res, async (err) => {
    if (err) return res.status(400).json({ success: false, error: err.message });
    try {
      const found = await findExisting(req, res);
      if (!found) return;
      if (!req.file) return res.status(400).json({ success: false, error: 'Choose a cover image' });
      const problem = coverProblem(req.file);
      if (problem) return res.status(400).json({ success: false, error: problem });

      const name = `${req.params.id}.jpg`;
      await textbookStorage.putObject(found.bucket, name, req.file.buffer, 'image/jpeg');
      clearShelfCache(req.params.kind);
      res.json({ success: true, data: { name } });
    } catch (error) {
      console.error('Library cover error:', error);
      res.status(500).json({ success: false, error: 'Cover upload failed: ' + error.message });
    }
  });
});

/** DELETE /api/library/:kind/:id/cover */
router.delete('/:kind/:id/cover', authenticateToken, isAdmin, async (req, res) => {
  try {
    const found = await findExisting(req, res);
    if (!found) return;
    await textbookStorage.deleteObject(found.bucket, `${req.params.id}.jpg`);
    clearShelfCache(req.params.kind);
    res.json({ success: true });
  } catch (error) {
    console.error('Library cover delete error:', error);
    res.status(500).json({ success: false, error: 'Cover delete failed: ' + error.message });
  }
});

module.exports = router;
