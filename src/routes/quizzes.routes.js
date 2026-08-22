const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, isTeacher } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
 
/**
 * POST /api/quizzes
 * Create a new quiz (Teacher only)
 */
router.post('/', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { course_id, title, description, pass_percentage, time_limit } = req.body;
 
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
        error: 'You can only create quizzes for your own courses'
      });
    }
 
    const quizId = uuidv4();
    const { data: newQuiz, error } = await supabase
      .from('quizzes')
      .insert({
        id: quizId,
        course_id,
        title,
        description: description || '',
        pass_percentage: pass_percentage || 70,
        time_limit: time_limit || 60,
        created_at: new Date()
      })
      .select()
      .single();
 
    if (error) throw error;
 
    res.status(201).json({
      success: true,
      message: 'Quiz created successfully',
      data: { quiz: newQuiz }
    });
  } catch (error) {
    console.error('Quiz creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create quiz: ' + error.message
    });
  }
});
 
/**
 * POST /api/quizzes/:id/questions
 * Add question to quiz (Teacher only)
 */
router.post('/:id/questions', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { question, options, correct_answer, question_type } = req.body;
 
    if (!question || !options || !correct_answer) {
      return res.status(400).json({
        success: false,
        error: 'Question, options, and correct answer are required'
      });
    }
 
    // Verify quiz ownership
    const { data: quiz } = await supabase
      .from('quizzes')
      .select('courses(teacher_id)')
      .eq('id', id)
      .single();
 
    if (quiz?.courses?.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only add questions to your own quizzes'
      });
    }
 
    // Get question count to set order
    const { data: questions } = await supabase
      .from('quiz_questions')
      .select('order_number')
      .eq('quiz_id', id);
 
    const nextOrder = (questions?.length || 0) + 1;
 
    const questionId = uuidv4();
    const { data: newQuestion, error } = await supabase
      .from('quiz_questions')
      .insert({
        id: questionId,
        quiz_id: id,
        question,
        options: JSON.stringify(options),
        correct_answer,
        question_type: question_type || 'multiple_choice',
        order_number: nextOrder
      })
      .select()
      .single();
 
    if (error) throw error;
 
    res.status(201).json({
      success: true,
      message: 'Question added successfully',
      data: {
        question: {
          ...newQuestion,
          options: JSON.parse(newQuestion.options)
        }
      }
    });
  } catch (error) {
    console.error('Question creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add question: ' + error.message
    });
  }
});
 
/**
 * GET /api/quizzes/:id
 * Get quiz details with all questions
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
 
    const { data: quiz, error } = await supabase
      .from('quizzes')
      .select('*')
      .eq('id', id)
      .single();
 
    if (error || !quiz) {
      return res.status(404).json({
        success: false,
        error: 'Quiz not found'
      });
    }
 
    // Get questions
    const { data: questions } = await supabase
      .from('quiz_questions')
      .select('*')
      .eq('quiz_id', id)
      .order('order_number', { ascending: true });
 
    const questionsWithParsedOptions = questions.map(q => ({
      ...q,
      options: JSON.parse(q.options)
    }));
 
    res.json({
      success: true,
      data: {
        quiz: {
          ...quiz,
          questions: questionsWithParsedOptions,
          total_questions: questionsWithParsedOptions.length
        }
      }
    });
  } catch (error) {
    console.error('Quiz fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch quiz: ' + error.message
    });
  }
});
 
/**
 * GET /api/quizzes/course/:courseId
 * Get all quizzes for a course
 */
router.get('/course/:courseId', authenticateToken, async (req, res) => {
  try {
    const { courseId } = req.params;
 
    const { data: quizzes, error } = await supabase
      .from('quizzes')
      .select('*')
      .eq('course_id', courseId)
      .order('created_at', { ascending: false });
 
    if (error) throw error;
 
    res.json({
      success: true,
      data: { quizzes }
    });
  } catch (error) {
    console.error('Course quizzes error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch quizzes: ' + error.message
    });
  }
});
 
/**
 * POST /api/quizzes/:id/submit
 * Submit quiz answers (Student)
 */
router.post('/:id/submit', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { answers } = req.body; // answers: { question_id: answer_text }
 
    if (!answers) {
      return res.status(400).json({
        success: false,
        error: 'Answers are required'
      });
    }
 
    // Get quiz and questions
    const { data: quiz } = await supabase
      .from('quizzes')
      .select('*')
      .eq('id', id)
      .single();
 
    if (!quiz) {
      return res.status(404).json({
        success: false,
        error: 'Quiz not found'
      });
    }
 
    const { data: questions } = await supabase
      .from('quiz_questions')
      .select('*')
      .eq('quiz_id', id);
 
    // Calculate score
    let correctCount = 0;
    let totalCount = questions.length;
 
    questions.forEach(question => {
      if (answers[question.id] === question.correct_answer) {
        correctCount++;
      }
    });
 
    const score = Math.round((correctCount / totalCount) * 100);
    const passed = score >= quiz.pass_percentage;
 
    // Save submission
    const submissionId = uuidv4();
    const { data: submission, error } = await supabase
      .from('quiz_submissions')
      .insert({
        id: submissionId,
        quiz_id: id,
        student_id: req.user.userId,
        answers: JSON.stringify(answers),
        score,
        passed,
        submitted_at: new Date()
      })
      .select()
      .single();
 
    if (error) throw error;
 
    res.json({
      success: true,
      message: passed ? 'Quiz passed!' : 'Quiz failed. Try again.',
      data: {
        submission: {
          ...submission,
          correct_answers: correctCount,
          total_questions: totalCount,
          answers: JSON.parse(submission.answers)
        }
      }
    });
  } catch (error) {
    console.error('Quiz submission error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit quiz: ' + error.message
    });
  }
});
 
/**
 * GET /api/quizzes/:id/results
 * Get quiz results for a student
 */
router.get('/:id/results', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
 
    const { data: submission } = await supabase
      .from('quiz_submissions')
      .select('*')
      .eq('quiz_id', id)
      .eq('student_id', req.user.userId)
      .order('submitted_at', { ascending: false })
      .single();
 
    if (!submission) {
      return res.status(404).json({
        success: false,
        error: 'No submission found for this quiz'
      });
    }
 
    res.json({
      success: true,
      data: {
        submission: {
          ...submission,
          answers: JSON.parse(submission.answers)
        }
      }
    });
  } catch (error) {
    console.error('Quiz results error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch results: ' + error.message
    });
  }
});
 
module.exports = router;