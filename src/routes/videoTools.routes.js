const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { ZipArchive } = require('archiver');
const ffmpegPath = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');

/**
 * Video trimming / splitting — a standalone tool (not tied to any course
 * content), so any signed-in user may use it, see /tools/trim-video.
 *
 *   POST /api/video-tools/trim   multipart: video, segments (JSON)
 *       -> one video file (one segment) or a .zip (2+ segments)
 *
 * Runs on the server with a real ffmpeg binary (ffmpeg-static bundles the
 * binary itself — no manual server install) using stream-copy (`-c copy`):
 * no re-encoding, so it is fast (seconds, regardless of the source's length)
 * and lossless. The trade-off is a cut can land up to a couple of seconds off
 * the requested point — ffmpeg snaps `-ss` to the nearest keyframe when
 * copying rather than re-encoding — which is fine for minute-level splitting
 * but not frame-accurate editing.
 *
 * The video is uploaded to THIS server (unlike course video uploads, which go
 * straight to Supabase Storage — see lessons.routes.js) because ffmpeg has to
 * run somewhere, and doing this in the browser (ffmpeg.wasm) doesn't hold up
 * for the file sizes this app already produces (an hour-long class recording
 * can be 1-2GB — see utils/browserRecorder.js on the client). Streamed
 * straight to a temp file on disk (never buffered in memory) and deleted once
 * the response finishes, whether it succeeded or not.
 */

const ALLOWED_VIDEO_EXT = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-m4v': '.m4v', 'video/x-matroska': '.mkv' };
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024 * 1024; // 3GB — long class recordings
const MAX_SEGMENTS = 20;

const extFor = (file) => ALLOWED_VIDEO_EXT[file.mimetype] || path.extname(file.originalname).toLowerCase() || '.mp4';

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => cb(null, `vt-in-${uuidv4()}${extFor(file)}`)
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_VIDEO_EXT[file.mimetype] || /\.(mp4|mov|webm|m4v|mkv)$/i.test(file.originalname)) cb(null, true);
    else cb(Object.assign(new Error('Unsupported video type. Use MP4, MOV, WebM, M4V or MKV.'), { status: 400 }));
  }
});

const clampNonNegative = (n) => Math.max(0, Number(n) || 0);

const fmtClock = (totalSeconds) => {
  const s = Math.max(0, Math.round(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}-${mm}-${ss}`;
};

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`Video processing failed: ${stderr.slice(-1000).trim() || `ffmpeg exited with code ${code}`}`), { status: 422 }));
    });
  });
}

const cleanup = (paths) => paths.filter(Boolean).forEach((p) => fs.unlink(p, () => {}));

router.post('/trim', authenticateToken, upload.single('video'), async (req, res, next) => {
  const inputPath = req.file?.path;
  const outputPaths = [];
  try {
    if (!inputPath) return res.status(400).json({ success: false, error: 'A video file is required' });

    let segments;
    try {
      segments = JSON.parse(req.body.segments || '[]');
    } catch {
      return res.status(400).json({ success: false, error: '`segments` must be JSON: [{ start, end }, ...] in seconds' });
    }
    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one segment is required' });
    }
    if (segments.length > MAX_SEGMENTS) {
      return res.status(400).json({ success: false, error: `Split into at most ${MAX_SEGMENTS} clips at a time` });
    }

    const ext = path.extname(inputPath) || '.mp4';
    const args = ['-y', '-i', inputPath];
    const names = [];
    segments.forEach((seg, i) => {
      const start = clampNonNegative(seg.start);
      const end = Number(seg.end);
      if (!Number.isFinite(end) || end <= start) {
        throw Object.assign(new Error(`Clip ${i + 1}: the end time must be after the start time`), { status: 400 });
      }
      const outPath = path.join(os.tmpdir(), `vt-out-${uuidv4()}${ext}`);
      outputPaths.push(outPath);
      names.push(`clip-${String(i + 1).padStart(2, '0')}-${fmtClock(start)}_to_${fmtClock(end)}${ext}`);
      // Per-output options (placed after -i, before this output's path) apply
      // to that output only — this cuts every segment in one ffmpeg run.
      args.push('-ss', String(start), '-to', String(end), '-c', 'copy', '-avoid_negative_ts', 'make_zero', outPath);
    });

    await runFfmpeg(args);

    if (outputPaths.length === 1) {
      res.setHeader('Content-Disposition', `attachment; filename="${names[0]}"`);
      res.setHeader('Content-Type', `video/${ext.slice(1)}`);
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(outputPaths[0]);
        stream.on('error', reject);
        res.on('finish', resolve);
        res.on('error', reject);
        stream.pipe(res);
      });
    } else {
      res.setHeader('Content-Disposition', 'attachment; filename="clips.zip"');
      res.setHeader('Content-Type', 'application/zip');
      await new Promise((resolve, reject) => {
        const archive = new ZipArchive({ zlib: { level: 6 } });
        archive.on('error', reject);
        res.on('finish', resolve);
        res.on('error', reject);
        archive.pipe(res);
        outputPaths.forEach((p, i) => archive.file(p, { name: names[i] }));
        archive.finalize();
      });
    }
  } catch (err) {
    if (res.headersSent) res.destroy(err);
    else next(err);
  } finally {
    // Runs on every path — including the early 400 returns above — so an
    // uploaded file is never left behind in the temp dir.
    cleanup([inputPath, ...outputPaths]);
  }
});

module.exports = router;
