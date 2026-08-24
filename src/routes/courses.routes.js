
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, isTeacher } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

/**
 * POST /api/courses
 * Create a new course (Teacher only)
 */
router.post('/', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { title, description, category, color, icon, cover_image } = req.body;

    // Validation
    if (!title) {
      return res.status(400).json({
        success: false,
        error: 'Course title is required'
      });
    }

    const classCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    // Create course
    const courseId = uuidv4();
    const { data: newCourse, error } = await supabase
      .from('courses')
      .insert({
        id: courseId,
        teacher_id: req.user.userId,
        title,
        description: description || '',
        category: category || 'General',
        color: color || '#667eea',           // NEW! Color field
        icon: icon || '📚',                   // NEW! Icon field
        cover_image: cover_image || null,    // NEW! Cover image
        code: classCode,                      // NEW! Auto-generated code
        created_at: new Date()
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Course created successfully',
      data: {
        course: newCourse,
        classCode: classCode,                 // NEW! Return class code
        joinUrl: `/join/${classCode}`         // NEW! Join URL for students
      }
    });
  } catch (error) {
    console.error('Course creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create course: ' + error.message
    });
  }
});

/**
 * GET /api/courses
 * Get all courses
 * - Teachers see their own courses
 * - Students see all available courses
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    let query = supabase.from('courses').select('*');

    // Teachers see only their courses
    if (req.user.role === 'teacher') {
      query = query.eq('teacher_id', req.user.userId);
    }

    const { data: courses, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: { courses, total: courses.length }
    });
  } catch (error) {
    console.error('Courses fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch courses: ' + error.message
    });
  }
});

/**
 * GET /api/courses/:id
 * Get course details with lessons
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Get course
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('*')
      .eq('id', id)
      .single();

    if (courseError || !course) {
      return res.status(404).json({
        success: false,
        error: 'Course not found'
      });
    }

    // Get lessons
    const { data: lessons, error: lessonsError } = await supabase
      .from('lessons')
      .select('*')
      .eq('course_id', id)
      .order('order_number', { ascending: true });

    if (lessonsError) throw lessonsError;

    // Get teacher info
    const { data: teacher } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('id', course.teacher_id)
      .single();

    res.json({
      success: true,
      data: {
        course: {
          ...course,
          teacher: teacher,
          lessons_count: lessons.length,
          lessons
        }
      }
    });
  } catch (error) {
    console.error('Course details error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch course details: ' + error.message
    });
  }
});

/**
 * PUT /api/courses/:id
 * Update course (Teacher only)
 */
router.put('/:id', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, category } = req.body;

    // Verify ownership
    const { data: course } = await supabase
      .from('courses')
      .select('teacher_id')
      .eq('id', id)
      .single();

    if (course.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only update your own courses'
      });
    }

    // Update course
    const { data: updatedCourse, error } = await supabase
      .from('courses')
      .update({ title, description, category })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Course updated successfully',
      data: { course: updatedCourse }
    });
  } catch (error) {
    console.error('Course update error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update course: ' + error.message
    });
  }
});

/**
 * DELETE /api/courses/:id
 * Delete course (Teacher only)
 */
router.delete('/:id', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const { data: course } = await supabase
      .from('courses')
      .select('teacher_id')
      .eq('id', id)
      .single();

    if (course.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only delete your own courses'
      });
    }

    // Delete course (cascade will handle lessons)
    const { error } = await supabase
      .from('courses')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Course deleted successfully'
    });
  } catch (error) {
    console.error('Course deletion error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete course: ' + error.message
    });
  }
});

/**
 * GET /api/courses/:id/enroll
 * Enroll student in course
 */
router.post('/:id/enroll', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if course exists
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('id')
      .eq('id', id)
      .single();

    if (courseError || !course) {
      return res.status(404).json({
        success: false,
        error: 'Course not found'
      });
    }

    // Check if already enrolled
    const { data: existing } = await supabase
      .from('course_enrollments')
      .select('id')
      .eq('course_id', id)
      .eq('student_id', req.user.userId)
      .single();

    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Already enrolled in this course'
      });
    }

    // Enroll student
    const { data: enrollment, error } = await supabase
      .from('course_enrollments')
      .insert({
        id: uuidv4(),
        course_id: id,
        student_id: req.user.userId,
        enrolled_at: new Date()
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Enrolled in course successfully',
      data: { enrollment }
    });
  } catch (error) {
    console.error('Enrollment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to enroll: ' + error.message
    });
  }
});

module.exports = router;