const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../config/supabase');
const { authenticateToken, isTeacher } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument } = require('pdf-lib');
const { awardXp, XP_VALUES } = require('../utils/xp');
const { evaluateAchievements } = require('../utils/achievements');
const { hasCourseAccess, ensureEnrolled } = require('../utils/access');

// Safe resolver for pdf-parse module interop issues
const rawPdfParse = require('pdf-parse');
const parsePdfText = typeof rawPdfParse === 'function'
  ? rawPdfParse
  : (rawPdfParse.default || rawPdfParse.pdfParse);

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 52428800 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'video/mp4',
      'video/avi',
      'video/quicktime',
      'image/jpeg',
      'image/png',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

/**
 * POST /api/lessons
 * Create a new lesson (Teacher only)
 */
/**
 * POST /api/lessons
 * Create a new lesson (Teacher only)
 */
router.post('/', authenticateToken, isTeacher, upload.single('file'), async (req, res) => {
  try {
    const { course_id, title, description, order_number, start_page, end_page, is_free } = req.body;
    const file = req.file;

    // Validation
    if (!course_id || !title) {
      return res.status(400).json({
        success: false,
        error: 'Course ID and title are required'
      });
    }

    // Verify course ownership
    const { data: course } = await supabase
      .from('courses')
      .select('teacher_id')
      .eq('id', course_id)
      .single();

    if (course?.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only add lessons to your own courses'
      });
    }

    // Determine order_number: use the explicit value if the caller sent one,
    // otherwise auto-assign the next slot so lessons play in upload order.
    let finalOrderNumber = order_number !== undefined && order_number !== null && order_number !== ''
      ? parseInt(order_number, 10)
      : NaN;

    if (Number.isNaN(finalOrderNumber)) {
      const { data: lastLesson } = await supabase
        .from('lessons')
        .select('order_number')
        .eq('course_id', course_id)
        .order('order_number', { ascending: false })
        .limit(1)
        .maybeSingle();

      finalOrderNumber = (lastLesson?.order_number || 0) + 1;
    }

    const lessonId = uuidv4();
    let fileUrl = null;
    let videoUrl = null;
    let textContent = '';
    let pageCount = 0;
    const isVideoUpload = !!file && file.mimetype.startsWith('video');

    // Small files can still be sent inline here; large videos should use the
    // POST /:id/video/upload-url flow (this path holds the whole file in RAM).
    if (file) {
      // Sanitize filename - remove special characters
      const sanitizedName = file.originalname
        .replace(/[^a-zA-Z0-9.-]/g, '_')
        .replace(/_{2,}/g, '_')
        .toLowerCase();

      const fileName = `${lessonId}-${Date.now()}-${sanitizedName}`;
      const folderPath = file.mimetype.startsWith('video') ? 'videos' : 'pdfs';

      console.log('📤 Uploading file:', fileName);

      const { data: uploadData, error: uploadError } = await supabase
        .storage
        .from('course-materials')
        .upload(`${folderPath}/${fileName}`, file.buffer, {
          contentType: file.mimetype
        });

      if (uploadError) throw uploadError;

      const storedPath = `${folderPath}/${fileName}`;
      if (isVideoUpload) {
        videoUrl = storedPath;
      } else {
        fileUrl = storedPath;
      }
      console.log('✅ File uploaded successfully:', storedPath);

      // Extract text and page count from PDF
      if (file.mimetype === 'application/pdf') {
        // 1. Get exact page count using pdf-lib
        try {
          console.log('📄 Counting PDF pages with pdf-lib...');
          const pdfDoc = await PDFDocument.load(file.buffer, { ignoreEncryption: true });
          pageCount = pdfDoc.getPageCount();
          console.log(`✅ Total pages (pdf-lib): ${pageCount}`);
        } catch (pdfLibErr) {
          console.warn('Could not read page count via pdf-lib:', pdfLibErr.message);
          pageCount = 0;
        }

        // 2. Extract text content for searchability
        try {
          console.log('📄 Extracting text content with pdf-parse...');
          const pdfData = await parsePdfText(file.buffer);
          textContent = pdfData.text || '';
          console.log(`✅ Text extracted: ${textContent.length} characters`);
        } catch (pdfError) {
          console.warn('Could not extract PDF text:', pdfError.message);
          textContent = '';
        }
      }
    }

    // Parse start and end page values from request or fallback to defaults
    const finalStartPage = start_page ? parseInt(start_page, 10) : (pageCount > 0 ? 1 : null);
    const finalEndPage = end_page ? parseInt(end_page, 10) : (pageCount > 0 ? pageCount : null);

    // Create lesson in database
    const { data: newLesson, error } = await supabase
      .from('lessons')
      .insert({
        id: lessonId,
        course_id,
        title,
        description: description || '',
        file_url: fileUrl,
        video_url: videoUrl,
        file_type: file ? file.mimetype.split('/')[0] : null,
        text_content: textContent,
        total_pages: pageCount,
        start_page: finalStartPage,
        end_page: finalEndPage,
        order_number: finalOrderNumber,
        // multipart form fields arrive as strings, not real booleans
        is_free: is_free === true || is_free === 'true',
        created_at: new Date()
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Lesson created successfully',
      data: {
        lesson: {
          ...newLesson,
          file_url: fileUrl ? `${process.env.SUPABASE_URL}/storage/v1/object/public/course-materials/${fileUrl}` : null,
          video_url: videoUrl ? `${process.env.SUPABASE_URL}/storage/v1/object/public/course-materials/${videoUrl}` : null
        }
      }
    });
  } catch (error) {
    console.error('Lesson creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create lesson: ' + error.message
    });
  }
});

/**
 * GET /api/lessons/:id
 * Get lesson details
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: lesson, error } = await supabase
      .from('lessons')
      .select('*, courses(*)')
      .eq('id', id)
      .single();

    if (error || !lesson) {
      return res.status(404).json({
        success: false,
        error: 'Lesson not found'
      });
    }

    const { courses: course, ...lessonFields } = lesson;

    await ensureEnrolled({ supabase, course, user: req.user });
    const courseAccess = await hasCourseAccess({ supabase, course, user: req.user });
    if (!courseAccess && !lesson.is_free) {
      return res.status(403).json({
        success: false,
        error: 'Enroll in this course to access this lesson'
      });
    }

    const { data: attachments } = await supabase
      .from('lesson_attachments')
      .select('id, file_url, title, content_type, size_bytes, order_number')
      .eq('lesson_id', id)
      .order('order_number', { ascending: true });

    const toPublic = (p) => p
      ? `${process.env.SUPABASE_URL}/storage/v1/object/public/course-materials/${p}`
      : null;

    res.json({
      success: true,
      data: {
        lesson: {
          ...lessonFields,
          file_url: toPublic(lesson.file_url),
          video_url: toPublic(lesson.video_url),
          thumbnail_url: toPublic(lesson.thumbnail_url),
          attachments: (attachments || []).map(a => ({ ...a, file_url: toPublic(a.file_url) })),
          course: { id: course.id, title: course.title }
        }
      }
    });
  } catch (error) {
    console.error('Lesson fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch lesson: ' + error.message
    });
  }
});

/**
 * GET /api/lessons/course/:courseId
 * Get all lessons for a course
 */
router.get('/course/:courseId', authenticateToken, async (req, res) => {
  try {
    const { courseId } = req.params;

    const { data: lessons, error } = await supabase
      .from('lessons')
      .select('*')
      .eq('course_id', courseId)
      .order('order_number', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Add full file URLs
    const base = `${process.env.SUPABASE_URL}/storage/v1/object/public/course-materials/`;
    const lessonsWithUrls = lessons.map(lesson => ({
      ...lesson,
      file_url: lesson.file_url ? base + lesson.file_url : null,
      video_url: lesson.video_url ? base + lesson.video_url : null,
      thumbnail_url: lesson.thumbnail_url ? base + lesson.thumbnail_url : null
    }));

    res.json({
      success: true,
      data: { lessons: lessonsWithUrls }
    });
  } catch (error) {
    console.error('Course lessons error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch lessons: ' + error.message
    });
  }
});

/**
 * PUT /api/lessons/:id
 * Update lesson (Teacher only)
 */
router.put('/:id', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, order_number, is_free } = req.body;

    // Verify ownership
    const { data: lesson } = await supabase
      .from('lessons')
      .select('courses(teacher_id)')
      .eq('id', id)
      .single();

    if (lesson?.courses?.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only update your own lessons'
      });
    }

    const { data: updatedLesson, error } = await supabase
      .from('lessons')
      .update({
        title, description, order_number,
        ...(typeof is_free === 'boolean' ? { is_free } : {}),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Lesson updated successfully',
      data: { lesson: updatedLesson }
    });
  } catch (error) {
    console.error('Lesson update error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update lesson: ' + error.message
    });
  }
});

/**
 * DELETE /api/lessons/:id
 * Delete lesson (Teacher only)
 */
router.delete('/:id', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;

    // Get lesson to verify ownership
    const { data: lesson } = await supabase
      .from('lessons')
      .select('courses(teacher_id), file_url, video_url')
      .eq('id', id)
      .single();

    if (lesson?.courses?.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only delete your own lessons'
      });
    }

    // Remove every stored file: reading, video, and all attachments.
    const { data: attachments } = await supabase
      .from('lesson_attachments')
      .select('file_url')
      .eq('lesson_id', id);

    const storagePaths = [
      lesson.file_url,
      lesson.video_url,
      ...(attachments || []).map(a => a.file_url)
    ].filter(Boolean);

    if (storagePaths.length > 0) {
      await supabase.storage.from('course-materials').remove(storagePaths);
    }

    // Delete lesson (lesson_attachments rows cascade via FK)
    const { error } = await supabase
      .from('lessons')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Lesson deleted successfully'
    });
  } catch (error) {
    console.error('Lesson deletion error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete lesson: ' + error.message
    });
  }
});

// ============================================================================
// Lesson media: a lesson can carry a reading (file_url, unchanged), a video
// (video_url), and any number of extra attachments (lesson_attachments).
//
// Big files never stream through the API server (multer memoryStorage would
// hold the whole file in RAM). The teacher's client instead:
//   1. POST .../upload-url  -> a signed Supabase upload URL
//   2. uploads the file DIRECTLY to Supabase with that URL
//   3. POST .../video | .../attachments  -> records the storage path
// ============================================================================

const VIDEO_CONTENT_TYPES = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/x-matroska': 'mkv'
};

const IMAGE_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

const publicUrl = (path) =>
  `${process.env.SUPABASE_URL}/storage/v1/object/public/course-materials/${path}`;

// supabase-js may return `signedUrl` as a full URL or as a bare path
// (/object/upload/sign/...), depending on version. Normalise to an absolute
// URL so a plain HTTP PUT client (no supabase-js) can use it directly.
const absoluteUploadUrl = (signedUrl) => {
  if (/^https?:\/\//i.test(signedUrl)) return signedUrl;
  const base = signedUrl.startsWith('/storage/v1')
    ? process.env.SUPABASE_URL
    : `${process.env.SUPABASE_URL}/storage/v1`;
  return `${base}${signedUrl.startsWith('/') ? '' : '/'}${signedUrl}`;
};

const sanitizeName = (name) =>
  String(name || 'file')
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .replace(/_{2,}/g, '_')
    .toLowerCase()
    .slice(-80);

/** Load a lesson + confirm the caller owns its course. */
async function loadOwnedLesson(lessonId, userId) {
  const { data: lesson } = await supabase
    .from('lessons')
    .select('id, course_id, file_url, file_type, video_url, thumbnail_url, courses(teacher_id)')
    .eq('id', lessonId)
    .single();

  if (!lesson) return { error: { status: 404, message: 'Lesson not found' } };
  if (lesson.courses?.teacher_id !== userId) {
    return { error: { status: 403, message: 'You can only edit your own lessons' } };
  }
  return { lesson };
}

/** true if `path` exists in the given bucket folder. */
async function storageObjectExists(folder, path) {
  const { data } = await supabase
    .storage
    .from('course-materials')
    .list(folder, { search: path.slice(folder.length + 1) });
  return !!(data && data.length);
}

/**
 * POST /api/lessons/:id/video/upload-url
 * body: { content_type: "video/mp4" }
 * -> { path, token, signed_url, public_url }
 * Client uploads to `signed_url` (HTTP PUT raw body, or supabase-js
 * `uploadToSignedUrl(path, token, file)`), then calls POST /:id/video.
 */
router.post('/:id/video/upload-url', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const ext = VIDEO_CONTENT_TYPES[req.body?.content_type];
    if (!ext) {
      return res.status(400).json({
        success: false,
        error: 'content_type must be one of: ' + Object.keys(VIDEO_CONTENT_TYPES).join(', ')
      });
    }

    const { lesson, error } = await loadOwnedLesson(id, req.user.userId);
    if (error) return res.status(error.status).json({ success: false, error: error.message });

    const path = `videos/${lesson.id}-${Date.now()}.${ext}`;
    const { data, error: signError } = await supabase
      .storage.from('course-materials').createSignedUploadUrl(path);
    if (signError) throw signError;

    res.json({
      success: true,
      data: {
        path,
        token: data.token,
        signed_url: data.signedUrl,
        upload_url: absoluteUploadUrl(data.signedUrl),
        public_url: publicUrl(path)
      }
    });
  } catch (err) {
    console.error('Video upload-url error:', err);
    res.status(500).json({ success: false, error: 'Failed to create upload URL: ' + err.message });
  }
});

/**
 * POST /api/lessons/:id/video/thumbnail/upload-url
 * body: { content_type: "image/jpeg" }
 * -> { path, token, signed_url, upload_url, public_url }
 * The client generates a poster frame from the video (see below) and uploads
 * it here, then passes `path` as `thumbnail_path` to POST /:id/video, or to
 * POST /:id/video/thumbnail to change it later.
 */
router.post('/:id/video/thumbnail/upload-url', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const ext = IMAGE_CONTENT_TYPES[req.body?.content_type];
    if (!ext) {
      return res.status(400).json({
        success: false,
        error: 'content_type must be one of: ' + Object.keys(IMAGE_CONTENT_TYPES).join(', ')
      });
    }

    const { lesson, error } = await loadOwnedLesson(id, req.user.userId);
    if (error) return res.status(error.status).json({ success: false, error: error.message });

    const path = `thumbnails/${lesson.id}-${Date.now()}.${ext}`;
    const { data, error: signError } = await supabase
      .storage.from('course-materials').createSignedUploadUrl(path);
    if (signError) throw signError;

    res.json({
      success: true,
      data: {
        path,
        token: data.token,
        signed_url: data.signedUrl,
        upload_url: absoluteUploadUrl(data.signedUrl),
        public_url: publicUrl(path)
      }
    });
  } catch (err) {
    console.error('Thumbnail upload-url error:', err);
    res.status(500).json({ success: false, error: 'Failed to create upload URL: ' + err.message });
  }
});

/**
 * POST /api/lessons/:id/video
 * body: { path, duration_seconds?, thumbnail_path? }
 * Attaches (or replaces) the lesson video after the direct upload finished.
 */
router.post('/:id/video', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { path, duration_seconds, thumbnail_path } = req.body || {};

    if (!path || !path.startsWith(`videos/${id}-`)) {
      return res.status(400).json({
        success: false,
        error: 'A valid `path` from /video/upload-url is required'
      });
    }
    if (thumbnail_path && !thumbnail_path.startsWith(`thumbnails/${id}-`)) {
      return res.status(400).json({
        success: false,
        error: '`thumbnail_path` must come from /video/thumbnail/upload-url'
      });
    }

    const { lesson, error } = await loadOwnedLesson(id, req.user.userId);
    if (error) return res.status(error.status).json({ success: false, error: error.message });

    if (!(await storageObjectExists('videos', path))) {
      return res.status(409).json({
        success: false,
        error: 'Upload not found in storage — finish the upload before calling this'
      });
    }
    if (thumbnail_path && !(await storageObjectExists('thumbnails', thumbnail_path))) {
      return res.status(409).json({
        success: false,
        error: 'Thumbnail upload not found in storage'
      });
    }

    const patch = {
      video_url: path,
      duration_seconds: duration_seconds ? parseInt(duration_seconds, 10) : null
    };
    if (thumbnail_path) patch.thumbnail_url = thumbnail_path;

    const { data: updated, error: updateError } = await supabase
      .from('lessons')
      .update(patch)
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    const stale = [
      lesson.video_url && lesson.video_url !== path ? lesson.video_url : null,
      thumbnail_path && lesson.thumbnail_url && lesson.thumbnail_url !== thumbnail_path ? lesson.thumbnail_url : null
    ].filter(Boolean);
    if (stale.length) await supabase.storage.from('course-materials').remove(stale);

    res.json({
      success: true,
      message: 'Video attached to lesson',
      data: {
        lesson: {
          ...updated,
          video_url: publicUrl(path),
          thumbnail_url: updated.thumbnail_url ? publicUrl(updated.thumbnail_url) : null
        }
      }
    });
  } catch (err) {
    console.error('Attach video error:', err);
    res.status(500).json({ success: false, error: 'Failed to attach video: ' + err.message });
  }
});

/**
 * POST /api/lessons/:id/video/thumbnail
 * body: { path }
 * Sets / replaces just the video poster image.
 */
router.post('/:id/video/thumbnail', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { path } = req.body || {};

    if (!path || !path.startsWith(`thumbnails/${id}-`)) {
      return res.status(400).json({
        success: false,
        error: 'A valid `path` from /video/thumbnail/upload-url is required'
      });
    }

    const { lesson, error } = await loadOwnedLesson(id, req.user.userId);
    if (error) return res.status(error.status).json({ success: false, error: error.message });

    if (!(await storageObjectExists('thumbnails', path))) {
      return res.status(409).json({ success: false, error: 'Upload not found in storage' });
    }

    const { data: updated, error: updateError } = await supabase
      .from('lessons')
      .update({ thumbnail_url: path })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    if (lesson.thumbnail_url && lesson.thumbnail_url !== path) {
      await supabase.storage.from('course-materials').remove([lesson.thumbnail_url]);
    }

    res.json({
      success: true,
      message: 'Thumbnail updated',
      data: { lesson: { ...updated, thumbnail_url: publicUrl(path) } }
    });
  } catch (err) {
    console.error('Set thumbnail error:', err);
    res.status(500).json({ success: false, error: 'Failed to set thumbnail: ' + err.message });
  }
});

/**
 * DELETE /api/lessons/:id/video
 */
router.delete('/:id/video', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { lesson, error } = await loadOwnedLesson(id, req.user.userId);
    if (error) return res.status(error.status).json({ success: false, error: error.message });

    const toRemove = [lesson.video_url, lesson.thumbnail_url].filter(Boolean);
    if (toRemove.length) {
      await supabase.storage.from('course-materials').remove(toRemove);
    }

    const { data: updated, error: updateError } = await supabase
      .from('lessons')
      .update({ video_url: null, duration_seconds: null, thumbnail_url: null })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({ success: true, message: 'Video removed', data: { lesson: updated } });
  } catch (err) {
    console.error('Remove video error:', err);
    res.status(500).json({ success: false, error: 'Failed to remove video: ' + err.message });
  }
});

/**
 * POST /api/lessons/:id/file
 * multipart: file  (PDF / doc / image, <= 50MB)
 * Adds or replaces the lesson's reading (file_url). Videos are rejected here —
 * use the /video flow for those.
 */
router.post('/:id/file', authenticateToken, isTeacher, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ success: false, error: 'A `file` is required' });
    }
    if (file.mimetype.startsWith('video')) {
      return res.status(400).json({
        success: false,
        error: 'Use the video upload flow for video files'
      });
    }

    const { lesson, error } = await loadOwnedLesson(id, req.user.userId);
    if (error) return res.status(error.status).json({ success: false, error: error.message });

    const fileName = `${id}-${Date.now()}-${sanitizeName(file.originalname)}`;
    const storedPath = `pdfs/${fileName}`;

    const { error: uploadError } = await supabase
      .storage.from('course-materials')
      .upload(storedPath, file.buffer, { contentType: file.mimetype });
    if (uploadError) throw uploadError;

    // Re-extract page count + text for PDFs so search / page ranges stay correct.
    let pageCount = 0;
    let textContent = '';
    if (file.mimetype === 'application/pdf') {
      try {
        const pdfDoc = await PDFDocument.load(file.buffer, { ignoreEncryption: true });
        pageCount = pdfDoc.getPageCount();
      } catch (e) {
        console.warn('pdf-lib page count failed:', e.message);
      }
      try {
        const pdfData = await parsePdfText(file.buffer);
        textContent = pdfData.text || '';
      } catch (e) {
        console.warn('pdf-parse text failed:', e.message);
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('lessons')
      .update({
        file_url: storedPath,
        file_type: file.mimetype.split('/')[0],
        text_content: textContent,
        total_pages: pageCount,
        start_page: pageCount > 0 ? 1 : null,
        end_page: pageCount > 0 ? pageCount : null
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    if (lesson.file_url && lesson.file_url !== storedPath) {
      await supabase.storage.from('course-materials').remove([lesson.file_url]);
    }

    res.json({
      success: true,
      message: 'Lesson file updated',
      data: { lesson: { ...updated, file_url: publicUrl(storedPath) } }
    });
  } catch (err) {
    console.error('Replace lesson file error:', err);
    res.status(500).json({ success: false, error: 'Failed to update lesson file: ' + err.message });
  }
});

/**
 * DELETE /api/lessons/:id/file
 */
router.delete('/:id/file', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { lesson, error } = await loadOwnedLesson(id, req.user.userId);
    if (error) return res.status(error.status).json({ success: false, error: error.message });

    if (lesson.file_url) {
      await supabase.storage.from('course-materials').remove([lesson.file_url]);
    }

    const { data: updated, error: updateError } = await supabase
      .from('lessons')
      .update({
        file_url: null,
        file_type: null,
        text_content: '',
        total_pages: 0,
        start_page: null,
        end_page: null
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({ success: true, message: 'Lesson file removed', data: { lesson: updated } });
  } catch (err) {
    console.error('Remove lesson file error:', err);
    res.status(500).json({ success: false, error: 'Failed to remove lesson file: ' + err.message });
  }
});

/**
 * POST /api/lessons/:id/attachments/upload-url
 * body: { filename, content_type }
 * -> { path, token, signed_url, public_url }
 */
router.post('/:id/attachments/upload-url', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { filename, content_type } = req.body || {};
    if (!filename) {
      return res.status(400).json({ success: false, error: '`filename` is required' });
    }

    const { error } = await loadOwnedLesson(id, req.user.userId);
    if (error) return res.status(error.status).json({ success: false, error: error.message });

    const path = `attachments/${id}/${Date.now()}-${sanitizeName(filename)}`;
    const { data, error: signError } = await supabase
      .storage.from('course-materials').createSignedUploadUrl(path);
    if (signError) throw signError;

    res.json({
      success: true,
      data: {
        path,
        token: data.token,
        signed_url: data.signedUrl,
        upload_url: absoluteUploadUrl(data.signedUrl),
        public_url: publicUrl(path),
        content_type: content_type || null
      }
    });
  } catch (err) {
    console.error('Attachment upload-url error:', err);
    res.status(500).json({ success: false, error: 'Failed to create upload URL: ' + err.message });
  }
});

/**
 * POST /api/lessons/:id/attachments
 * body: { path, title?, content_type?, size_bytes? }
 * Records an uploaded file as a lesson attachment.
 */
router.post('/:id/attachments', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { path, title, content_type, size_bytes } = req.body || {};

    if (!path || !path.startsWith(`attachments/${id}/`)) {
      return res.status(400).json({
        success: false,
        error: 'A valid `path` from /attachments/upload-url is required'
      });
    }

    const { error } = await loadOwnedLesson(id, req.user.userId);
    if (error) return res.status(error.status).json({ success: false, error: error.message });

    if (!(await storageObjectExists(`attachments/${id}`, path))) {
      return res.status(409).json({
        success: false,
        error: 'Upload not found in storage — finish the upload before calling this'
      });
    }

    const { data: last } = await supabase
      .from('lesson_attachments')
      .select('order_number')
      .eq('lesson_id', id)
      .order('order_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: attachment, error: insertError } = await supabase
      .from('lesson_attachments')
      .insert({
        id: uuidv4(),
        lesson_id: id,
        file_url: path,
        title: title || null,
        content_type: content_type || null,
        size_bytes: size_bytes ? parseInt(size_bytes, 10) : null,
        order_number: (last?.order_number || 0) + 1,
        created_at: new Date()
      })
      .select()
      .single();

    if (insertError) throw insertError;

    res.status(201).json({
      success: true,
      message: 'Attachment added',
      data: { attachment: { ...attachment, file_url: publicUrl(path) } }
    });
  } catch (err) {
    console.error('Add attachment error:', err);
    res.status(500).json({ success: false, error: 'Failed to add attachment: ' + err.message });
  }
});

/**
 * DELETE /api/lessons/:id/attachments/:attachmentId
 */
router.delete('/:id/attachments/:attachmentId', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id, attachmentId } = req.params;
    const { error } = await loadOwnedLesson(id, req.user.userId);
    if (error) return res.status(error.status).json({ success: false, error: error.message });

    const { data: attachment } = await supabase
      .from('lesson_attachments')
      .select('id, file_url')
      .eq('id', attachmentId)
      .eq('lesson_id', id)
      .maybeSingle();

    if (!attachment) {
      return res.status(404).json({ success: false, error: 'Attachment not found' });
    }

    await supabase.storage.from('course-materials').remove([attachment.file_url]);
    await supabase.from('lesson_attachments').delete().eq('id', attachmentId);

    res.json({ success: true, message: 'Attachment removed' });
  } catch (err) {
    console.error('Remove attachment error:', err);
    res.status(500).json({ success: false, error: 'Failed to remove attachment: ' + err.message });
  }
});

/**
 * POST /api/lessons/:id/mark-complete
 * Mark lesson as complete (Student)
 */
router.post('/:id/mark-complete', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const studentId = req.user.userId;

    const { data: lesson, error: lessonError } = await supabase
      .from('lessons')
      .select('id, is_free, courses(*)')
      .eq('id', id)
      .single();

    if (lessonError || !lesson) {
      return res.status(404).json({
        success: false,
        error: 'Lesson not found'
      });
    }

    await ensureEnrolled({ supabase, course: lesson.courses, user: req.user });
    const courseAccess = await hasCourseAccess({ supabase, course: lesson.courses, user: req.user });
    if (!courseAccess && !lesson.is_free) {
      return res.status(403).json({
        success: false,
        error: 'You do not have access to this lesson yet'
      });
    }

    const { data: existing } = await supabase
      .from('lesson_completions')
      .select('*')
      .eq('lesson_id', id)
      .eq('student_id', studentId)
      .maybeSingle();

    if (existing) {
      return res.json({
        success: true,
        message: 'Lesson already marked as complete',
        data: { completion: existing, xp_awarded: 0 }
      });
    }

    const { data: completion, error } = await supabase
      .from('lesson_completions')
      .insert({
        id: uuidv4(),
        lesson_id: id,
        student_id: studentId,
        completed_at: new Date()
      })
      .select()
      .single();

    if (error) throw error;

    await awardXp(studentId, XP_VALUES.LESSON_COMPLETE, 'lesson_complete');
    await evaluateAchievements(studentId);

    res.json({
      success: true,
      message: 'Lesson marked as complete',
      data: { completion, xp_awarded: XP_VALUES.LESSON_COMPLETE }
    });
  } catch (error) {
    console.error('Mark complete error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark lesson complete: ' + error.message
    });
  }
});

module.exports = router;