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
 * GET /api/assignments/mine
 * Every assignment across the courses the current student is enrolled in,
 * each with its course and the student's own submission (or null). Sorted by
 * due date (soonest first; undated last), then newest.
 */
router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const studentId = req.user.userId;

    const { data: enrollments } = await supabase
      .from('course_enrollments')
      .select('course_id')
      .eq('student_id', studentId);

    const courseIds = [...new Set((enrollments || []).map(e => e.course_id))];
    if (courseIds.length === 0) {
      return res.json({ success: true, data: { assignments: [] } });
    }

    const [{ data: assignments, error }, { data: courses }] = await Promise.all([
      supabase.from('assignments').select('*').in('course_id', courseIds),
      supabase.from('courses').select('id, title, color, icon').in('id', courseIds),
    ]);
    if (error) throw error;

    const courseById = Object.fromEntries((courses || []).map(c => [c.id, c]));

    const assignmentIds = (assignments || []).map(a => a.id);
    let submissionByAssignment = {};
    if (assignmentIds.length > 0) {
      const { data: subs } = await supabase
        .from('assignment_submissions')
        .select('id, assignment_id, submission_text, file_url, grade, feedback, submitted_at, graded_at')
        .eq('student_id', studentId)
        .in('assignment_id', assignmentIds);
      submissionByAssignment = Object.fromEntries((subs || []).map(s => [s.assignment_id, s]));
    }

    const withMeta = (assignments || []).map(a => {
      const s = submissionByAssignment[a.id] || null;
      return {
        ...a,
        course: courseById[a.course_id] || { id: a.course_id, title: null, color: null, icon: null },
        submission: s
          ? {
              ...s,
              file_url: s.file_url
                ? `${process.env.SUPABASE_URL}/storage/v1/object/public/assignments/${s.file_url}`
                : null
            }
          : null
      };
    });

    withMeta.sort((x, y) => {
      const dx = x.due_date ? Date.parse(x.due_date) : Infinity;
      const dy = y.due_date ? Date.parse(y.due_date) : Infinity;
      if (dx !== dy) return dx - dy;
      return Date.parse(y.created_at) - Date.parse(x.created_at);
    });

    res.json({ success: true, data: { assignments: withMeta } });
  } catch (error) {
    console.error('My assignments error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch assignments: ' + error.message });
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

    const resolveFileUrl = (fileUrl) =>
      fileUrl ? `${process.env.SUPABASE_URL}/storage/v1/object/public/assignments/${fileUrl}` : null;

    // Get submissions if teacher
    let submissions = [];
    if (req.user.role === 'teacher') {
      const { data: subs } = await supabase
        .from('assignment_submissions')
        .select('*, users(name, email)')
        .eq('assignment_id', id);
      submissions = (subs || []).map(s => ({ ...s, file_url: resolveFileUrl(s.file_url) }));
    } else {
      // If student, get only their submission
      const { data: subs } = await supabase
        .from('assignment_submissions')
        .select('*')
        .eq('assignment_id', id)
        .eq('student_id', req.user.userId);
      submissions = (subs || []).map(s => ({ ...s, file_url: resolveFileUrl(s.file_url) }));
    }

    const { data: course } = await supabase
      .from('courses')
      .select('id, title, color, icon')
      .eq('id', assignment.course_id)
      .maybeSingle();

    res.json({
      success: true,
      data: {
        assignment: {
          ...assignment,
          course: course || { id: assignment.course_id, title: null, color: null, icon: null },
          submission: submissions.find(s => s.student_id === req.user.userId) || null,
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
      // Sanitize filename - remove special characters
      const sanitizedName = file.originalname
        .replace(/[^a-zA-Z0-9.-]/g, '_') // Replace non-alphanumeric with underscore
        .replace(/_{2,}/g, '_') // Replace multiple underscores with single
        .toLowerCase();

      const fileName = `${id}-${req.user.userId}-${Date.now()}-${sanitizedName}`;
      const { data: uploadData, error: uploadError } = await supabase
        .storage
        .from('assignments')
        .upload(`submissions/${fileName}`, file.buffer, {
          contentType: file.mimetype
        });

      if (uploadError) throw uploadError;
      fileUrl = `submissions/${fileName}`;
    }

    // One submission per student per assignment: update the existing one
    // (re-submit before the deadline / before it's graded) instead of
    // inserting a duplicate.
    const { data: existing } = await supabase
      .from('assignment_submissions')
      .select('id, grade')
      .eq('assignment_id', id)
      .eq('student_id', req.user.userId)
      .maybeSingle();

    if (existing && existing.grade !== null && existing.grade !== undefined) {
      return res.status(409).json({
        success: false,
        error: 'This assignment has already been graded and can no longer be changed'
      });
    }

    let submission;
    if (existing) {
      const patch = {
        submission_text: submission_text || '',
        submitted_at: new Date()
      };
      if (fileUrl) patch.file_url = fileUrl;
      const { data, error } = await supabase
        .from('assignment_submissions')
        .update(patch)
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      submission = data;
    } else {
      const { data, error } = await supabase
        .from('assignment_submissions')
        .insert({
          id: uuidv4(),
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
      submission = data;
    }

    res.status(201).json({
      success: true,
      message: 'Assignment submitted successfully',
      data: {
        submission: {
          ...submission,
          file_url: submission.file_url
            ? `${process.env.SUPABASE_URL}/storage/v1/object/public/assignments/${submission.file_url}`
            : null
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