const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken } = require('../middleware/auth');
const { requireFeature } = require('../utils/permissions');
const { imageToLatex, ReadConfigError } = require('../utils/imageToLatex');

/**
 * The LaTeX to Text tool (/tools/latex-to-text) — same access rule as the page.
 *
 *   POST /api/latex-tools/image-to-text   multipart: image (JPEG / PNG / WebP, up to 8 MB)
 *       -> { text }   Markdown with the maths as LaTeX, a draft to check
 */

const IMAGE_TYPES = { 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp' };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

router.post('/image-to-text', authenticateToken, requireFeature('latex_to_text'), (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'That photo is over 8 MB. Use a smaller one.' : err.message;
      return res.status(400).json({ success: false, error: message });
    }
    try {
      const file = req.file;
      if (!file || !IMAGE_TYPES[file.mimetype]) {
        return res.status(400).json({ success: false, error: 'Choose a photo (JPEG, PNG or WebP).' });
      }
      const text = await imageToLatex({ buffer: file.buffer, mime: IMAGE_TYPES[file.mimetype] });
      res.json({ success: true, data: { text } });
    } catch (error) {
      if (error instanceof ReadConfigError) return res.status(503).json({ success: false, error: error.message });
      console.error('Latex image-to-text error:', error);
      res.status(502).json({ success: false, error: error.message });
    }
  });
});

module.exports = router;
