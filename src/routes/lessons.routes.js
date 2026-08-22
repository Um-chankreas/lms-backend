const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../config/supabase');
const { authenticateToken, isTeacher } = require('../middleware/auth');
const pdfParse = require('pdf-parse');
const { v4: uuidv4 } = require('uuid');
 
// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 52428800 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'video/mp4', 'video/avi', 'video/quicktime', 
                         'image/jpeg', 'image/png', 'application/msword',
                         'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    
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
router.post('/', authenticateToken, isTeacher, upload.single('file'), async (req, res) => {
  try {
    const { course_id, title, description, order_number } = req.body;
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
 
    const lessonId = uuidv4();
    let fileUrl = null;
    let textContent = '';
 
    // Upload file to Supabase storage if provided
    if (file) {
      const fileName = `${lessonId}-${Date.now()}-${file.originalname}`;
      const folderPath = file.mimetype.startsWith('video') ? 'videos' : 'pdfs';
 
      const { data: uploadData, error: uploadError } = await supabase
        .storage
        .from('course-materials')
        .upload(`${folderPath}/${fileName}`, file.buffer, {
          contentType: file.mimetype
        });
 
      if (uploadError) throw uploadError;
 
      fileUrl = `${folderPath}/${fileName}`;
 
      // Extract text from PDF for searchability
      if (file.mimetype === 'application/pdf') {
        try {
          const pdfData = await pdfParse(file.buffer);
          textContent = pdfData.text;
        } catch (pdfError) {
          console.warn('Could not extract PDF text:', pdfError.message);
          textContent = '';
        }
      }
    }
 
    // Create lesson in database
    const { data: newLesson, error } = await supabase
      .from('lessons')
      .insert({
        id: lessonId,
        course_id,
        title,
        description: description || '',
        file_url: fileUrl,
        file_type: file ? file.mimetype.split('/')[0] : null,
        text_content: textContent,
        order_number: order_number || 0,
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
          file_url: fileUrl ? `${process.env.SUPABASE_URL}/storage/v1/object/public/course-materials/${fileUrl}` : null
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
      .select('*')
      .eq('id', id)
      .single();
 
    if (error || !lesson) {
      return res.status(404).json({
        success: false,
        error: 'Lesson not found'
      });
    }
 
    // Get course info
    const { data: course } = await supabase
      .from('courses')
      .select('id, title')
      .eq('id', lesson.course_id)
      .single();
 
    res.json({
      success: true,
      data: {
        lesson: {
          ...lesson,
          file_url: lesson.file_url ? `${process.env.SUPABASE_URL}/storage/v1/object/public/course-materials/${lesson.file_url}` : null,
          course
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
      .order('order_number', { ascending: true });
 
    if (error) throw error;
 
    // Add full file URLs
    const lessonsWithUrls = lessons.map(lesson => ({
      ...lesson,
      file_url: lesson.file_url ? `${process.env.SUPABASE_URL}/storage/v1/object/public/course-materials/${lesson.file_url}` : null
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
    const { title, description, order_number } = req.body;
 
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
      .update({ title, description, order_number })
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
      .select('courses(teacher_id), file_url')
      .eq('id', id)
      .single();
 
    if (lesson?.courses?.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only delete your own lessons'
      });
    }
 
    // Delete file from storage if exists
    if (lesson.file_url) {
      await supabase.storage
        .from('course-materials')
        .remove([lesson.file_url]);
    }
 
    // Delete lesson
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
 
/**
 * POST /api/lessons/:id/mark-complete
 * Mark lesson as complete (Student)
 */
router.post('/:id/mark-complete', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
 
    const { data: completion, error } = await supabase
      .from('lesson_completions')
      .insert({
        id: uuidv4(),
        lesson_id: id,
        student_id: req.user.userId,
        completed_at: new Date()
      })
      .select()
      .single();
 
    if (error) throw error;
 
    res.json({
      success: true,
      message: 'Lesson marked as complete',
      data: { completion }
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