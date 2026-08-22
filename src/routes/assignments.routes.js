
const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../config/supabase');
const { authenticateToken, isTeacher } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
 
// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 52428800 }, // 50MB
});
 
/**
 * POST /api/assignments
 * Create a new assignment (Teacher only)
 */
router.post('/', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { course_id, title, description, due_date } = req.body;
 
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
        error: 'You can only create assignments for your own courses'
      });
    }
 
    const assignmentId = uuidv4();
    const { data: newAssignment, error } = await supabase
      .from('assignments')
      .insert({
        id: assignmentId,
        course_id,
        title,
        description: description || '',
        due_date: due_date || null,
        created_at: new Date()
      })
      .select()
      .single();
 
    if (error) throw error;
 
    res.status(201).json({
      success: true,
      message: 'Assignment created successfully',
      data: { assignment: newAssignment }
    });
  } catch (error) {
    console.error('Assignment creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create assignment: ' + error.message
    });
  }
});
 
/**
 * GET /api/assignments/course/:courseId
 * Get all assignments for a course
 */
router.get('/course/:courseId', authenticateToken, async (req, res) => {
  try {
    const { courseId } = req.params;
 
    const { data: assignments, error } = await supabase
      .from('assignments')
      .select('*')
      .eq('course_id', courseId)
      .order('created_at', { ascending: false });
 
    if (error) throw error;
 
    res.json({
      success: true,
      data: { assignments }
    });
  } catch (error) {
    console.error('Course assignments error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch assignments: ' + error.message
    });
  }
});
 
/**
 * GET /api/assignments/:id
 * Get assignment details with submissions
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
 
    const { data: assignment, error } = await supabase
      .from('assignments')
      .select('*')
      .eq('id', id)
      .single();
 
    if (error || !assignment) {
      return res.status(404).json({
        success: false,
        error: 'Assignment not found'
      });
    }
 
    // Get submissions if teacher
    let submissions = [];
    if (req.user.role === 'teacher') {
      const { data: subs } = await supabase
        .from('assignment_submissions')
        .select('*, users(name, email)')
        .eq('assignment_id', id);
      submissions = subs || [];
    } else {
      // If student, get only their submission
      const { data: subs } = await supabase
        .from('assignment_submissions')
        .select('*')
        .eq('assignment_id', id)
        .eq('student_id', req.user.userId);
      submissions = subs || [];
    }
 
    res.json({
      success: true,
      data: {
        assignment: {
          ...assignment,
          submissions
        }
      }
    });
  } catch (error) {
    console.error('Assignment fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch assignment: ' + error.message
    });
  }
});
 
/**
 * POST /api/assignments/:id/submit
 * Submit assignment (Student)
 */
router.post('/:id/submit', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    const { submission_text } = req.body;
    const file = req.file;
 
    if (!submission_text && !file) {
      return res.status(400).json({
        success: false,
        error: 'Submission text or file is required'
      });
    }
 
    // Check if assignment exists
    const { data: assignment } = await supabase
      .from('assignments')
      .select('id')
      .eq('id', id)
      .single();
 
    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: 'Assignment not found'
      });
    }
 
    let fileUrl = null;
 
    // Upload file if provided
    if (file) {
      const fileName = `${id}-${req.user.userId}-${Date.now()}-${file.originalname}`;
      const { data: uploadData, error: uploadError } = await supabase
        .storage
        .from('assignments')
        .upload(`submissions/${fileName}`, file.buffer, {
          contentType: file.mimetype
        });
 
      if (uploadError) throw uploadError;
      fileUrl = `submissions/${fileName}`;
    }
 
    // Create submission
    const submissionId = uuidv4();
    const { data: submission, error } = await supabase
      .from('assignment_submissions')
      .insert({
        id: submissionId,
        assignment_id: id,
        student_id: req.user.userId,
        submission_text: submission_text || '',
        file_url: fileUrl,
        submitted_at: new Date(),
        grade: null,
        feedback: null
      })
      .select()
      .single();
 
    if (error) throw error;
 
    res.status(201).json({
      success: true,
      message: 'Assignment submitted successfully',
      data: {
        submission: {
          ...submission,
          file_url: fileUrl ? `${process.env.SUPABASE_URL}/storage/v1/object/public/assignments/${fileUrl}` : null
        }
      }
    });
  } catch (error) {
    console.error('Assignment submission error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit assignment: ' + error.message
    });
  }
});
 
/**
 * PUT /api/assignments/:id/submissions/:submissionId/grade
 * Grade assignment submission (Teacher only)
 */
router.put('/:id/submissions/:submissionId/grade', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id, submissionId } = req.params;
    const { grade, feedback } = req.body;
 
    if (grade === undefined && !feedback) {
      return res.status(400).json({
        success: false,
        error: 'Grade or feedback is required'
      });
    }
 
    // Verify teacher owns the assignment
    const { data: assignment } = await supabase
      .from('assignments')
      .select('courses(teacher_id)')
      .eq('id', id)
      .single();
 
    if (assignment?.courses?.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only grade assignments in your courses'
      });
    }
 
    const { data: updatedSubmission, error } = await supabase
      .from('assignment_submissions')
      .update({ grade, feedback, graded_at: new Date() })
      .eq('id', submissionId)
      .select()
      .single();
 
    if (error) throw error;
 
    res.json({
      success: true,
      message: 'Assignment graded successfully',
      data: { submission: updatedSubmission }
    });
  } catch (error) {
    console.error('Grading error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to grade assignment: ' + error.message
    });
  }
});
 
module.exports = router;