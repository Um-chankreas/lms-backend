const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const supabase = require('../config/supabase');
const { authenticateToken, isTeacher } = require('../middleware/auth');
const { awardXp, XP_VALUES } = require('../utils/xp');
const { evaluateAchievements } = require('../utils/achievements');
const { v4: uuidv4 } = require('uuid');
const { parseQuestionRows } = require('../utils/csvQuestions');
const { notifyAssignmentPublished } = require('../utils/notifyEvents');

// Configure multer for submission file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 52428800 }, // 50MB
});

// Configure multer for MCQ question CSV imports — same limit quizzes uses.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

/**
 * POST /api/assignments
 * Create a new assignment (Teacher only)
 */
router.post('/', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { course_id, title, description, due_date, type, status, points } = req.body;

    if (!course_id || !title) {
      return res.status(400).json({
        success: false,
        error: 'Course ID and title are required'
      });
    }

    const pointsValue = Number.isFinite(Number(points)) && Number(points) > 0 ? Math.round(Number(points)) : 100;

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

    // Publishing straight from creation (no draft step) skips PUT /:id's
    // question-count guard, so it's only allowed for file-type assignments —
    // a brand-new quiz-type one can't have any questions yet to satisfy it.
    const isPublished = status === 'published' && type !== 'quiz';

    const assignmentId = uuidv4();
    const { data: newAssignment, error } = await supabase
      .from('assignments')
      .insert({
        id: assignmentId,
        course_id,
        title,
        description: description || '',
        due_date: due_date || null,
        type: type === 'quiz' ? 'quiz' : 'file',
        points: pointsValue,
        status: isPublished ? 'published' : 'draft',
        published_at: isPublished ? new Date() : null,
        created_at: new Date()
      })
      .select()
      .single();

    if (error) throw error;

    if (isPublished) notifyAssignmentPublished(assignmentId); // best-effort, not awaited

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

// Shared ownership check for the per-question endpoints below: the
// assignment must exist and belong (via its course) to the calling teacher.
// Mirrors quizzes.routes.js's loadOwnedQuiz.
async function loadOwnedAssignment(assignmentId, teacherId) {
  const { data: assignment } = await supabase
    .from('assignments')
    .select('id, type, status, course_id, courses(teacher_id)')
    .eq('id', assignmentId)
    .single();
  if (!assignment) return { error: { status: 404, message: 'Assignment not found' } };
  if (assignment.courses?.teacher_id !== teacherId) return { error: { status: 403, message: 'Unauthorized assignment access' } };
  return { assignment };
}

/**
 * PUT /api/assignments/:id
 * Update title/description/due_date, and — the one action that matters
 * here — flip status from 'draft' to 'published' (Teacher only). Publishing
 * is the single moment students get notified; every other save (draft, or
 * editing an already-published assignment) is silent. A quiz-type
 * assignment needs at least one question before it can be published.
 */
router.put('/:id', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { error: ownError, assignment } = await loadOwnedAssignment(id, req.user.userId);
    if (ownError) return res.status(ownError.status).json({ success: false, error: ownError.message });

    const { title, description, due_date, status, points } = req.body;
    if (title !== undefined && !String(title).trim()) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }
    if (points !== undefined && !(Number.isFinite(Number(points)) && Number(points) > 0)) {
      return res.status(400).json({ success: false, error: 'points must be a positive number' });
    }

    const updatePayload = {};
    if (title !== undefined) updatePayload.title = String(title).trim();
    if (description !== undefined) updatePayload.description = description || '';
    if (due_date !== undefined) updatePayload.due_date = due_date || null;
    if (points !== undefined) updatePayload.points = Math.round(Number(points));

    const isPublishing = status === 'published' && assignment.status !== 'published';
    if (isPublishing) {
      if (assignment.type === 'quiz') {
        const { count } = await supabase
          .from('assignment_questions')
          .select('id', { count: 'exact', head: true })
          .eq('assignment_id', id);
        if (!count) {
          return res.status(400).json({ success: false, error: 'Add at least one question before publishing' });
        }
      }
      updatePayload.status = 'published';
      updatePayload.published_at = new Date();
    }

    const { data: updated, error } = await supabase
      .from('assignments')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    if (isPublishing) notifyAssignmentPublished(id); // best-effort, not awaited

    res.json({ success: true, data: { assignment: updated } });
  } catch (error) {
    console.error('Update assignment error:', error);
    res.status(500).json({ success: false, error: 'Failed to update assignment: ' + error.message });
  }
});

// Once any student has submitted, the question bank locks — every
// student's score has to stay comparable. No unlock escape hatch for v1.
async function assertQuestionsEditable(assignmentId, res) {
  const { count } = await supabase
    .from('assignment_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('assignment_id', assignmentId);
  if ((count || 0) > 0) {
    res.status(409).json({ success: false, error: 'Cannot edit questions after students have started submitting' });
    return false;
  }
  return true;
}

/**
 * POST /api/assignments/:id/questions
 * Add ONE MCQ question to a quiz-type assignment (Teacher only).
 */
router.post('/:id/questions', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { error: ownError, assignment } = await loadOwnedAssignment(id, req.user.userId);
    if (ownError) return res.status(ownError.status).json({ success: false, error: ownError.message });
    if (assignment.type !== 'quiz') {
      return res.status(400).json({ success: false, error: 'This assignment is not a quiz-type assignment' });
    }
    if (!(await assertQuestionsEditable(id, res))) return;

    const { question, options, correct_answer, explanation } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ success: false, error: 'question is required' });
    }

    const { data: lastQuestion } = await supabase
      .from('assignment_questions')
      .select('order_number')
      .eq('assignment_id', id)
      .order('order_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: created, error } = await supabase
      .from('assignment_questions')
      .insert({
        id: uuidv4(),
        assignment_id: id,
        question,
        options: Array.isArray(options) ? options : [],
        correct_answer,
        explanation: explanation || null,
        question_type: 'QCM',
        order_number: (lastQuestion?.order_number || 0) + 1,
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ success: true, data: { question: created } });
  } catch (error) {
    console.error('Add assignment question error:', error);
    res.status(500).json({ success: false, error: 'Failed to add question: ' + error.message });
  }
});

/**
 * PUT /api/assignments/:id/questions/:questionId
 * Update ONE question in place (Teacher only).
 */
router.put('/:id/questions/:questionId', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id, questionId } = req.params;
    const { error: ownError } = await loadOwnedAssignment(id, req.user.userId);
    if (ownError) return res.status(ownError.status).json({ success: false, error: ownError.message });
    if (!(await assertQuestionsEditable(id, res))) return;

    const { question, options, correct_answer, explanation } = req.body;
    const updatePayload = {};
    if (question !== undefined) updatePayload.question = question;
    if (options !== undefined) updatePayload.options = Array.isArray(options) ? options : [];
    if (correct_answer !== undefined) updatePayload.correct_answer = correct_answer;
    if (explanation !== undefined) updatePayload.explanation = explanation || null;

    const { data: updated, error } = await supabase
      .from('assignment_questions')
      .update(updatePayload)
      .eq('id', questionId)
      .eq('assignment_id', id)
      .select()
      .single();
    if (error) throw error;
    if (!updated) return res.status(404).json({ success: false, error: 'Question not found in this assignment' });

    res.json({ success: true, data: { question: updated } });
  } catch (error) {
    console.error('Update assignment question error:', error);
    res.status(500).json({ success: false, error: 'Failed to update question: ' + error.message });
  }
});

/**
 * DELETE /api/assignments/:id/questions/:questionId
 * Remove ONE question (Teacher only).
 */
router.delete('/:id/questions/:questionId', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id, questionId } = req.params;
    const { error: ownError } = await loadOwnedAssignment(id, req.user.userId);
    if (ownError) return res.status(ownError.status).json({ success: false, error: ownError.message });
    if (!(await assertQuestionsEditable(id, res))) return;

    const { error } = await supabase
      .from('assignment_questions')
      .delete()
      .eq('id', questionId)
      .eq('assignment_id', id);
    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Delete assignment question error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete question: ' + error.message });
  }
});

/**
 * GET /api/assignments/questions/import/template
 * Download the CSV template used for bulk-importing MCQ assignment questions.
 */
router.get('/questions/import/template', authenticateToken, isTeacher, (req, res) => {
  res.download(
    path.join(__dirname, '../../templates/assignment_questions_template.csv'),
    'assignment_questions_template.csv'
  );
});

/**
 * POST /api/assignments/:id/questions/import
 * Bulk-import MCQ questions for a quiz-type assignment from a CSV file
 * (Teacher only). Shares its parser with quizzes.routes.js's own CSV
 * import — see utils/csvQuestions.js — but assignments are MCQ-only: a
 * number_input row (no options, per the template's "correct" column) is
 * rejected rather than imported, unlike the quiz importer.
 */
router.post('/:id/questions/import', authenticateToken, isTeacher, csvUpload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'CSV file is required (form field name: "file")' });
    }

    const { error: ownError, assignment } = await loadOwnedAssignment(id, req.user.userId);
    if (ownError) return res.status(ownError.status).json({ success: false, error: ownError.message });
    if (assignment.type !== 'quiz') {
      return res.status(400).json({ success: false, error: 'This assignment is not a quiz-type assignment' });
    }
    if (!(await assertQuestionsEditable(id, res))) return;

    let parsed;
    try {
      parsed = parseQuestionRows(req.file.buffer);
    } catch (parseError) {
      return res.status(400).json({ success: false, error: 'Failed to parse CSV file: ' + parseError.message });
    }

    if (parsed.rowErrors.length > 0) {
      return res.status(400).json({ success: false, error: 'CSV contains invalid rows', data: { rowErrors: parsed.rowErrors } });
    }
    if (parsed.questions.length === 0) {
      return res.status(400).json({ success: false, error: 'CSV file has no data rows' });
    }
    const numericRows = parsed.questions
      .map((q, idx) => ({ q, row: idx + 2 }))
      .filter(({ q }) => q.question_type === 'number_input');
    if (numericRows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Assignments only support multiple-choice questions',
        data: { rowErrors: numericRows.map(({ row }) => ({ row, error: 'number_input questions are not supported for assignments — add answer options instead' })) },
      });
    }

    const { data: lastQuestion } = await supabase
      .from('assignment_questions')
      .select('order_number')
      .eq('assignment_id', id)
      .order('order_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    const startOrder = lastQuestion?.order_number || 0;

    const questionsToInsert = parsed.questions.map((q, idx) => ({
      id: uuidv4(),
      assignment_id: id,
      question: q.question,
      options: q.options,
      correct_answer: q.correct_answer,
      explanation: q.explanation,
      question_type: 'QCM',
      order_number: startOrder + idx + 1,
    }));

    const { data: insertedQuestions, error } = await supabase
      .from('assignment_questions')
      .insert(questionsToInsert)
      .select();
    if (error) throw error;

    res.status(201).json({
      success: true,
      message: `${insertedQuestions.length} question(s) imported successfully`,
      data: { questions: insertedQuestions },
    });
  } catch (error) {
    console.error('Assignment question import error:', error);
    res.status(500).json({ success: false, error: 'Failed to import questions: ' + error.message });
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
      supabase.from('assignments').select('*').in('course_id', courseIds).eq('status', 'published'),
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
 * Get all assignments for a course. The course's own teacher sees drafts
 * too (they're authoring them); everyone else — students, other teachers —
 * only sees published ones.
 */
router.get('/course/:courseId', authenticateToken, async (req, res) => {
  try {
    const { courseId } = req.params;

    const { data: course } = await supabase
      .from('courses')
      .select('teacher_id')
      .eq('id', courseId)
      .maybeSingle();
    const isOwner = req.user.role === 'teacher' && course?.teacher_id === req.user.userId;

    let query = supabase
      .from('assignments')
      .select('*')
      .eq('course_id', courseId)
      .order('created_at', { ascending: false });
    if (!isOwner) query = query.eq('status', 'published');

    const { data: assignments, error } = await query;

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

    const { data: course } = await supabase
      .from('courses')
      .select('id, title, color, icon, teacher_id')
      .eq('id', assignment.course_id)
      .maybeSingle();
    const isOwner = req.user.role === 'teacher' && course?.teacher_id === req.user.userId;

    // A draft is invisible to everyone but its own teacher — hide its
    // existence entirely rather than a 403, same as a nonexistent id.
    if (assignment.status !== 'published' && !isOwner) {
      return res.status(404).json({ success: false, error: 'Assignment not found' });
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

    // Quiz-type only: the question bank — answer key stripped for a student
    // who hasn't submitted yet (same pattern GET /api/quizzes/:id uses), but
    // revealed once they have, so the detail screen can mark right/wrong —
    // and, for the teacher, a full roster — every enrolled student, not just
    // the ones who've already submitted (which is all `submissions` above
    // can ever show).
    let questions;
    let roster;
    if (assignment.type === 'quiz') {
      const { data: qs } = await supabase
        .from('assignment_questions')
        .select('*')
        .eq('assignment_id', id)
        .order('order_number', { ascending: true });

      const revealAnswerKey = req.user.role === 'teacher' || submissions.length > 0;
      questions = revealAnswerKey
        ? (qs || [])
        : (qs || []).map(({ correct_answer, explanation, ...safe }) => safe);

      if (req.user.role === 'teacher') {
        const { data: enrollments } = await supabase
          .from('course_enrollments')
          .select('student_id, users(id, name, email, avatar_url)')
          .eq('course_id', assignment.course_id);
        const subByStudent = Object.fromEntries(submissions.map(s => [s.student_id, s]));
        roster = (enrollments || []).map(e => ({
          student: e.users,
          submission: subByStudent[e.student_id] || null,
        }));
      }
    }

    res.json({
      success: true,
      data: {
        assignment: {
          ...assignment,
          course: course || { id: assignment.course_id, title: null, color: null, icon: null },
          submission: submissions.find(s => s.student_id === req.user.userId) || null,
          submissions,
          questions,
          roster,
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
    const file = req.file;

    // Check if assignment exists
    const { data: assignment } = await supabase
      .from('assignments')
      .select('id, course_id, due_date, type, status')
      .eq('id', id)
      .single();

    if (!assignment || assignment.status !== 'published') {
      return res.status(404).json({
        success: false,
        error: 'Assignment not found'
      });
    }

    if (assignment.type === 'quiz') {
      const { answers } = req.body;
      if (!answers || typeof answers !== 'object') {
        return res.status(400).json({ success: false, error: 'Answers are required' });
      }

      // One submission per student, final — no resubmission, before or
      // after the deadline. The mobile UI locks the options the moment a
      // submission exists, so this is the server-side backstop.
      const { data: existing } = await supabase
        .from('assignment_submissions')
        .select('id')
        .eq('assignment_id', id)
        .eq('student_id', req.user.userId)
        .maybeSingle();
      if (existing) {
        return res.status(409).json({ success: false, error: 'You have already submitted this assignment' });
      }

      const isPastDue = assignment.due_date && new Date() > new Date(assignment.due_date);
      if (isPastDue) {
        return res.status(409).json({ success: false, error: 'The deadline for this assignment has passed' });
      }

      const { data: questions } = await supabase
        .from('assignment_questions')
        .select('id, correct_answer')
        .eq('assignment_id', id);

      const totalCount = questions?.length || 0;
      const correctCount = (questions || []).filter(q => answers[q.id] === q.correct_answer).length;
      const score = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;

      // grade mirrors score so the existing manual-grade display/edit path
      // (PUT .../submissions/:id/grade) keeps working unchanged — a teacher
      // can still override it or add feedback on top of the auto-score.
      const { data: submission, error: insertError } = await supabase
        .from('assignment_submissions')
        .insert({
          id: uuidv4(),
          assignment_id: id,
          student_id: req.user.userId,
          submission_text: '',
          file_url: null,
          feedback: null,
          answers,
          score,
          grade: score,
          submitted_at: new Date(),
        })
        .select()
        .single();
      if (insertError) throw insertError;

      const onTime = !assignment.due_date || new Date() <= new Date(assignment.due_date);
      const xpAwarded = onTime ? XP_VALUES.ASSIGNMENT_ONTIME : XP_VALUES.ASSIGNMENT_LATE;
      await awardXp(req.user.userId, xpAwarded, onTime ? 'assignment_ontime' : 'assignment_late', assignment.course_id || null);
      await evaluateAchievements(req.user.userId);

      return res.status(201).json({
        success: true,
        message: 'Assignment submitted successfully',
        data: { xp_awarded: xpAwarded, submission },
      });
    }

    const { submission_text } = req.body;

    if (!submission_text && !file) {
      return res.status(400).json({
        success: false,
        error: 'Submission text or file is required'
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

    // XP on the FIRST submission only (re-submits don't re-award). On time =
    // before the due date, or the assignment has no due date.
    let xpAwarded = 0;
    if (!existing) {
      const onTime = !assignment.due_date || new Date() <= new Date(assignment.due_date);
      xpAwarded = onTime ? XP_VALUES.ASSIGNMENT_ONTIME : XP_VALUES.ASSIGNMENT_LATE;
      await awardXp(req.user.userId, xpAwarded, onTime ? 'assignment_ontime' : 'assignment_late', assignment.course_id || null);
      await evaluateAchievements(req.user.userId);
    }

    res.status(201).json({
      success: true,
      message: 'Assignment submitted successfully',
      data: {
        xp_awarded: xpAwarded,
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