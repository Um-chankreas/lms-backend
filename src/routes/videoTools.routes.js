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
const { requireFeature } = require('../utils/permissions');

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

router.post('/trim', authenticateToken, requireFeature('trim_video'), upload.single('video'), async (req, res, next) => {
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

/**
 * POST /api/video-tools/compress   multipart: video, quality?
 *       -> the compressed video file, with X-Original-Size / X-Compressed-Size
 *          headers so the client can show the size reduction.
 *
 * Re-encodes with libx264 (unlike /trim's `-c copy`, this is NOT lossless —
 * that's the point, it's what actually shrinks the file). `quality` picks a
 * CRF (lower = larger/better) and a resolution cap; the codec never upscales
 * a smaller source. `-movflags +faststart` moves the moov atom to the front
 * so the result streams/seeks immediately once served from Supabase Storage,
 * matching how lesson/unit videos are already served.
 */
const QUALITY_PRESETS = {
  high: { crf: 20, maxHeight: null },     // near-lossless, still shrinks a lot vs. a raw phone/OBS export
  balanced: { crf: 23, maxHeight: 1080 }, // default — the standard "visually lossless" CRF
  small: { crf: 28, maxHeight: 720 }      // smallest file, noticeable softening on fast motion
};

router.post('/compress', authenticateToken, requireFeature('compress_video'), upload.single('video'), async (req, res, next) => {
  const inputPath = req.file?.path;
  let outputPath;
  try {
    if (!inputPath) return res.status(400).json({ success: false, error: 'A video file is required' });

    const preset = QUALITY_PRESETS[req.body.quality] || QUALITY_PRESETS.balanced;
    const originalSize = req.file.size;

    outputPath = path.join(os.tmpdir(), `vt-out-${uuidv4()}.mp4`);
    const args = ['-y', '-i', inputPath];
    if (preset.maxHeight) args.push('-vf', `scale=-2:'min(ih,${preset.maxHeight})'`);
    args.push(
      '-c:v', 'libx264', '-crf', String(preset.crf), '-preset', 'medium',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath
    );

    await runFfmpeg(args);

    const compressedSize = fs.statSync(outputPath).size;
    const name = path.basename(req.file.originalname, path.extname(req.file.originalname)) + '-compressed.mp4';

    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('X-Original-Size', String(originalSize));
    res.setHeader('X-Compressed-Size', String(compressedSize));
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(outputPath);
      stream.on('error', reject);
      res.on('finish', resolve);
      res.on('error', reject);
      stream.pipe(res);
    });
  } catch (err) {
    if (res.headersSent) res.destroy(err);
    else next(err);
  } finally {
    cleanup([inputPath, outputPath]);
  }
});

/**
 * POST /api/video-tools/merge   multipart: videos (2..MAX_MERGE_FILES, in order)
 *       -> one .mp4 with the inputs joined end to end.
 *
 * When every input has the same video codec, resolution and audio layout
 * (the usual case: one recording split into parts) the parts are joined with
 * the concat demuxer and `-c copy` — seconds, lossless. Otherwise (different
 * cameras/phones/resolutions) they're re-encoded through the concat filter,
 * scaled and letterboxed to the first video's size. That path uses a low CRF
 * so the editor's optional compress step afterwards doesn't stack two lossy
 * passes' worth of damage. Gated by trim_video — it's the same "editing"
 * permission; there's no separate merge feature key.
 */
const MAX_MERGE_FILES = 10;

// ffmpeg-static ships no ffprobe, so read `ffmpeg -i`'s stream summary off
// stderr instead (it exits non-zero for "no output file", which is expected).
function probe(file) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const video = stderr.match(/Stream #\S+.*?Video: (\w+).*?, (\d{2,5})x(\d{2,5})/);
      const audio = stderr.match(/Stream #\S+.*?Audio: (\w+).*?, (\d+) Hz, ([\w.()]+)/);
      const dur = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
      if (!video) return resolve(null);
      resolve({
        duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
        vcodec: video[1], width: Number(video[2]), height: Number(video[3]),
        acodec: audio?.[1] || null, arate: audio ? Number(audio[2]) : null, alayout: audio?.[3] || null
      });
    });
  });
}

router.post('/merge', authenticateToken, requireFeature('trim_video'), upload.array('videos', MAX_MERGE_FILES), async (req, res, next) => {
  const inputPaths = (req.files || []).map((f) => f.path);
  let outputPath;
  let listPath;
  try {
    if (inputPaths.length < 2) return res.status(400).json({ success: false, error: 'Pick at least two videos to merge' });

    const infos = await Promise.all(inputPaths.map(probe));
    const bad = infos.findIndex((i) => !i);
    if (bad !== -1) return res.status(422).json({ success: false, error: `Video ${bad + 1} (“${req.files[bad].originalname}”) couldn’t be read` });

    const [first] = infos;
    const sameShape = infos.every((i) =>
      i.vcodec === first.vcodec && i.width === first.width && i.height === first.height
      && i.acodec === first.acodec && i.arate === first.arate && i.alayout === first.alayout);
    const hasAudio = infos.some((i) => i.acodec);

    outputPath = path.join(os.tmpdir(), `vt-out-${uuidv4()}.mp4`);
    let args;
    if (sameShape && ['h264', 'hevc'].includes(first.vcodec)) {
      listPath = path.join(os.tmpdir(), `vt-list-${uuidv4()}.txt`);
      fs.writeFileSync(listPath, inputPaths.map((p) => `file '${p.replace(/'/g, `'\\''`)}'`).join('\n'));
      args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', outputPath];
    } else {
      // Even dimensions for libx264.
      const W = first.width - (first.width % 2);
      const H = first.height - (first.height % 2);
      args = ['-y'];
      inputPaths.forEach((p) => args.push('-i', p));
      // A silent track stands in for any input that has no audio, so the
      // concat filter always gets one audio pad per segment.
      if (hasAudio) args.push('-f', 'lavfi', '-t', '1', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      const silentIdx = inputPaths.length;
      const parts = [];
      const pads = [];
      infos.forEach((info, i) => {
        parts.push(`[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`);
        if (hasAudio) {
          if (info.acodec) parts.push(`[${i}:a:0]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`);
          // No audio track: loop the 1s silence out to this segment's length.
          else parts.push(`[${silentIdx}:a]aloop=loop=-1:size=48000,atrim=duration=${info.duration.toFixed(3)}[a${i}]`);
          pads.push(`[v${i}][a${i}]`);
        } else {
          pads.push(`[v${i}]`);
        }
      });
      parts.push(`${pads.join('')}concat=n=${inputPaths.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`);
      args.push('-filter_complex', parts.join(';'), '-map', '[v]');
      if (hasAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
      args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-movflags', '+faststart', outputPath);
    }

    await runFfmpeg(args);

    res.setHeader('Content-Disposition', 'attachment; filename="merged.mp4"');
    res.setHeader('Content-Type', 'video/mp4');
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(outputPath);
      stream.on('error', reject);
      res.on('finish', resolve);
      res.on('error', reject);
      stream.pipe(res);
    });
  } catch (err) {
    if (res.headersSent) res.destroy(err);
    else next(err);
  } finally {
    cleanup([...inputPaths, outputPath, listPath]);
  }
});

module.exports = router;
