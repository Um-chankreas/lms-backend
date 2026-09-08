
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, optionalAuth, isTeacher, isStudent } = require('../middleware/auth');
const { hasCourseAccess, ensureEnrolled } = require('../utils/access');
const { awardXp, XP_VALUES } = require('../utils/xp');
const { starsForScore } = require('../utils/progress');
const { GUEST_FREE_STEPS } = require('../utils/guest');
const { v4: uuidv4 } = require('uuid');

/**
 * POST /api/courses
 * Create a new course (Teacher only)
 */
router.post('/', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { title, description, category, color, icon, cover_image, is_free } = req.body;

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
        is_free: typeof is_free === 'boolean' ? is_free : false,
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
        joinUrl: `/join/${classCode}`
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
 * - Students and guests see all available courses
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    let query = supabase
      .from('courses')
      .select('*, course_enrollments(count), students:course_enrollments(enrolled_at, users(id, name, avatar_url))')
      .order('enrolled_at', { ascending: true, referencedTable: 'students' })
      .limit(2, { referencedTable: 'students' });

    // Teachers see only their courses
    if (req.user?.role === 'teacher') {
      query = query.eq('teacher_id', req.user.userId);
    }

    const { data: courses, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;

    // Flatten the embedded aggregates: a total student_count plus a short
    // preview list of up to 2 students.
    const coursesWithCounts = (courses || []).map(({ course_enrollments, students, ...course }) => ({
      ...course,
      student_count: course_enrollments?.[0]?.count || 0,
      students: (students || []).map(s => s.users).filter(Boolean)
    }));

    res.json({
      success: true,
      data: { courses: coursesWithCounts, total: coursesWithCounts.length }
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
router.get('/:id', optionalAuth, async (req, res) => {
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
      .order('order_number', { ascending: true })
      .order('created_at', { ascending: true });

    if (lessonsError) throw lessonsError;

    // Get teacher info
    const { data: teacher } = await supabase
      .from('users')
      .select('id, name, email,avatar_url')
      .eq('id', course.teacher_id)
      .single();

    // Any student viewing a course counts as engaging with it — see
    // ensureEnrolled for why this must run before hasCourseAccess.
    await ensureEnrolled({ supabase, course, user: req.user });

    // A course-wide pass (free course, owning teacher, or enrolled student)
    // unlocks every lesson; otherwise each lesson falls back to its own
    // is_free flag (paid course with free preview lessons).
    const courseAccess = await hasCourseAccess({ supabase, course, user: req.user });

    // Number of enrolled students in this class, plus a preview of up to 2
    const { count: studentCount } = await supabase
      .from('course_enrollments')
      .select('id', { count: 'exact', head: true })
      .eq('course_id', id);

    const { data: studentPreviewRows } = await supabase
      .from('course_enrollments')
      .select('enrolled_at, users:student_id (id, name, avatar_url)')
      .eq('course_id', id)
      .order('enrolled_at', { ascending: true })
      .limit(2);
    const studentPreview = (studentPreviewRows || []).map(r => r.users).filter(Boolean);

    let completedLessonIds = new Set();
    if (req.user?.role === 'student' && lessons.length > 0) {
      const { data: completions } = await supabase
        .from('lesson_completions')
        .select('lesson_id')
        .eq('student_id', req.user.userId)
        .in('lesson_id', lessons.map(l => l.id));

      completedLessonIds = new Set((completions || []).map(c => c.lesson_id));
    }

    // Lightweight quiz metadata per lesson — id/title/status/question count
    // only. Full questions (and correct_answer) stay behind GET
    // /api/quizzes/:id, fetched only when the student actually opens one.
    const quizzesByLesson = {};
    if (lessons.length > 0) {
      // Chapter-level quizzes only. Per-unit practice quizzes (unit_id set) are
      // managed from the chapter reader, not this list.
      let quizQuery = supabase
        .from('quizzes')
        .select('id, lesson_id, unit_id, title, status, quiz_questions(count)')
        .eq('course_id', id)
        .not('lesson_id', 'is', null)
        .is('unit_id', null);

      if (req.user?.role !== 'teacher') {
        quizQuery = quizQuery.eq('status', 'published');
      }

      const { data: quizzes } = await quizQuery;

      (quizzes || []).forEach(quiz => {
        if (!quizzesByLesson[quiz.lesson_id]) quizzesByLesson[quiz.lesson_id] = [];
        quizzesByLesson[quiz.lesson_id].push({
          id: quiz.id,
          title: quiz.title,
          status: quiz.status,
          unit_id: quiz.unit_id || null,
          total_questions: quiz.quiz_questions?.[0]?.count || 0
        });
      });
    }

    const materialsBase = `${process.env.SUPABASE_URL}/storage/v1/object/public/course-materials/`;
    const lessonsWithAccess = lessons.map(lesson => {
      const unlocked = courseAccess || lesson.is_free;
      return {
        ...lesson,
        locked: !unlocked,
        completed: completedLessonIds.has(lesson.id),
        file_url: unlocked && lesson.file_url ? materialsBase + lesson.file_url : null,
        video_url: unlocked && lesson.video_url ? materialsBase + lesson.video_url : null,
        thumbnail_url: lesson.thumbnail_url ? materialsBase + lesson.thumbnail_url : null,
        has_video: !!lesson.video_url,
        text_content: unlocked ? lesson.text_content : '',
        quizzes: quizzesByLesson[lesson.id] || [],
      };
    });

    const totalLessons = lessons.length;
    const completedLessons = completedLessonIds.size;

    res.json({
      success: true,
      data: {
        course: {
          ...course,
          teacher: teacher,
          has_access: courseAccess,
          student_count: studentCount || 0,
          students: studentPreview,
          lessons_count: lessonsWithAccess.length,
          lessons: lessonsWithAccess,
          progress: req.user?.role === 'student'
            ? {
                completed_lessons: completedLessons,
                total_lessons: totalLessons,
                percentage: totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0
              }
            : null
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
    const { title, description, category, color, icon, cover_image, code, is_free } = req.body;

    // Verify ownership
    const { data: course } = await supabase
      .from('courses')
      .select('teacher_id')
      .eq('id', id)
      .single();

    if (!course) {
      return res.status(404).json({
        success: false,
        error: 'Course not found'
      });
    }

    if (course.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only update your own courses'
      });
    }

    // Only update fields actually present in the request, so a partial
    // update doesn't null out columns the client didn't send.
    const updatePayload = {};
    if (title !== undefined) updatePayload.title = title;
    if (description !== undefined) updatePayload.description = description;
    if (category !== undefined) updatePayload.category = category;
    if (color !== undefined) updatePayload.color = color;
    if (icon !== undefined) updatePayload.icon = icon;
    if (cover_image !== undefined) updatePayload.cover_image = cover_image;
    if (code !== undefined) updatePayload.code = code;
    if (typeof is_free === 'boolean') updatePayload.is_free = is_free;

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No fields to update'
      });
    }

    // Update course
    const { data: updatedCourse, error } = await supabase
      .from('courses')
      .update(updatePayload)
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

    // Verify course exists and ownership
    const { data: course } = await supabase
      .from('courses')
      .select('teacher_id')
      .eq('id', id)
      .single();

    if (!course) {
      return res.status(404).json({
        success: false,
        error: 'Course not found'
      });
    }

    if (course.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only delete your own courses'
      });
    }

    // Quizzes (course-level and lesson-level) -> questions & submissions
    const { data: quizzes } = await supabase
      .from('quizzes')
      .select('id')
      .eq('course_id', id);
    const quizIds = (quizzes || []).map(q => q.id);

    if (quizIds.length > 0) {
      await supabase.from('quiz_questions').delete().in('quiz_id', quizIds);
      await supabase.from('quiz_submissions').delete().in('quiz_id', quizIds);
    }
    await supabase.from('quizzes').delete().eq('course_id', id);

    // Lessons -> completions & uploaded files
    const { data: lessons } = await supabase
      .from('lessons')
      .select('id, file_url')
      .eq('course_id', id);
    const lessonIds = (lessons || []).map(l => l.id);

    if (lessonIds.length > 0) {
      await supabase.from('lesson_completions').delete().in('lesson_id', lessonIds);

      const lessonFileUrls = lessons.filter(l => l.file_url).map(l => l.file_url);
      if (lessonFileUrls.length > 0) {
        await supabase.storage.from('course-materials').remove(lessonFileUrls);
      }
    }
    await supabase.from('lessons').delete().eq('course_id', id);

    // Assignments -> submissions & uploaded files
    const { data: assignments } = await supabase
      .from('assignments')
      .select('id')
      .eq('course_id', id);
    const assignmentIds = (assignments || []).map(a => a.id);

    if (assignmentIds.length > 0) {
      const { data: submissions } = await supabase
        .from('assignment_submissions')
        .select('file_url')
        .in('assignment_id', assignmentIds);

      const submissionFileUrls = (submissions || []).filter(s => s.file_url).map(s => s.file_url);
      if (submissionFileUrls.length > 0) {
        await supabase.storage.from('assignments').remove(submissionFileUrls);
      }

      await supabase.from('assignment_submissions').delete().in('assignment_id', assignmentIds);
    }
    await supabase.from('assignments').delete().eq('course_id', id);

    // Enrollments
    await supabase.from('course_enrollments').delete().eq('course_id', id);

    // Live classes -> participants
    const { data: liveClasses } = await supabase
      .from('live_classes')
      .select('id')
      .eq('course_id', id);
    const liveClassIds = (liveClasses || []).map(lc => lc.id);

    if (liveClassIds.length > 0) {
      await supabase.from('live_class_participants').delete().in('live_class_id', liveClassIds);
    }
    await supabase.from('live_classes').delete().eq('course_id', id);

    // Finally, delete the course itself
    const { error } = await supabase
      .from('courses')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Course and all related content deleted successfully'
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

// ── Learning path — OUTER, course-level (drawer body: "pick a lesson") ───
// One node per LESSON, in order, with its own "surprise box" chest right
// after it — claiming a chest is what unlocks the next lesson. This is the
// list a student picks a lesson from; tapping one opens its own granular
// step-by-step path: GET /api/lessons/:id/path (units, their quizzes, then
// the same chest again for confirmation).

/**
 * GET /api/courses/:id/path
 */
router.get('/:id/path', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const isGuest = !req.user;
    const studentId = req.user?.userId || null;

    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('*')
      .eq('id', id)
      .single();
    if (courseError || !course) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    let courseAccess = false;
    if (!isGuest) {
      await ensureEnrolled({ supabase, course, user: req.user });
      courseAccess = await hasCourseAccess({ supabase, course, user: req.user });
    }

    const { data: lessons, error: lErr } = await supabase
      .from('lessons')
      .select('id, title, is_free, order_number, thumbnail_url')
      .eq('course_id', id)
      .order('order_number', { ascending: true })
      .order('created_at', { ascending: true });
    if (lErr) throw lErr;

    if (!lessons || lessons.length === 0) {
      return res.json({ success: true, data: { course: { id: course.id, title: course.title }, progress: null, nodes: [] } });
    }

    const lessonIds = lessons.map(l => l.id);

    const [{ data: completions }, { data: quizzes }, { data: claims }] = await Promise.all([
      studentId
        ? supabase.from('lesson_completions').select('lesson_id').eq('student_id', studentId).in('lesson_id', lessonIds)
        : Promise.resolve({ data: [] }),
      // Published quizzes tied to any of these lessons — a unit quiz still
      // carries its parent lesson_id, so this naturally includes both.
      supabase.from('quizzes').select('id, lesson_id').eq('course_id', id).eq('status', 'published').in('lesson_id', lessonIds),
      studentId
        ? supabase.from('path_chest_claims').select('chest_index').eq('student_id', studentId).eq('course_id', id)
        : Promise.resolve({ data: [] })
    ]);

    const completedSet = new Set((completions || []).map(c => c.lesson_id));
    const claimedSet = new Set((claims || []).map(c => c.chest_index));

    const quizIds = (quizzes || []).map(q => q.id);
    const quizIdsByLesson = new Map();
    (quizzes || []).forEach(q => {
      if (!quizIdsByLesson.has(q.lesson_id)) quizIdsByLesson.set(q.lesson_id, []);
      quizIdsByLesson.get(q.lesson_id).push(q.id);
    });

    const bestScoreByQuiz = new Map();
    if (quizIds.length > 0 && studentId) {
      const { data: submissions } = await supabase
        .from('quiz_submissions').select('quiz_id, score')
        .eq('student_id', studentId).in('quiz_id', quizIds);
      (submissions || []).forEach(s => {
        const prev = bestScoreByQuiz.get(s.quiz_id);
        if (prev == null || s.score > prev) bestScoreByQuiz.set(s.quiz_id, s.score);
      });
    }

    let previousDone = true; // lesson 1 is always reachable (subject to access)
    let currentAssigned = false;
    let starsEarned = 0, starsPossible = 0;

    const nodes = [];
    lessons.forEach((lesson, idx) => {
      const lessonAccess = isGuest || courseAccess || lesson.is_free;
      const positioned = idx === 0 || previousDone;
      const locked = !lessonAccess || !positioned;

      const completed = completedSet.has(lesson.id);
      const quizIdsHere = quizIdsByLesson.get(lesson.id) || [];
      const scores = quizIdsHere.map(qid => bestScoreByQuiz.get(qid)).filter(s => s != null);
      const quizAvg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

      let status = 'locked';
      let stars = 0;
      if (!locked) {
        if (completed) status = 'completed';
        else if (!currentAssigned) { status = 'current'; currentAssigned = true; }
        else status = 'available';
        if (completed) stars = quizAvg == null ? 3 : (starsForScore(quizAvg) ?? 1);
      }
      starsPossible += 3;
      starsEarned += stars;

      // A guest can only ever open lesson 1 (they can't complete it to unlock
      // the next); mark everything else, and every chest, guest-walled.
      const guestWalled = isGuest && (idx > 0);
      nodes.push({
        type: 'lesson',
        id: lesson.id,
        order_number: lesson.order_number ?? idx + 1,
        title: lesson.title,
        thumbnail_url: lesson.thumbnail_url || null,
        status: guestWalled ? 'locked' : status,
        ...(guestWalled ? { lock_reason: 'guest_wall' } : {}),
        stars,        // 0-3
        has_quiz: quizIdsHere.length > 0,
        quiz_best_avg: quizAvg
      });

      nodes.push({
        type: 'chest',
        chest_index: idx,
        lesson_id: lesson.id,
        status: claimedSet.has(idx) ? 'claimed' : (!isGuest && completed) ? 'unlocked' : 'locked',
        ...(isGuest ? { lock_reason: 'guest_wall' } : {}),
        xp_reward: XP_VALUES.PATH_CHEST
      });

      previousDone = completed;
    });

    const completedLessons = lessons.filter(l => completedSet.has(l.id)).length;

    res.json({
      success: true,
      data: {
        course: { id: course.id, title: course.title, is_free: course.is_free, has_access: courseAccess },
        guest: isGuest ? { free_steps: GUEST_FREE_STEPS } : undefined,
        progress: {
          completed_lessons: completedLessons,
          total_lessons: lessons.length,
          percentage: Math.round((completedLessons / lessons.length) * 100),
          stars_earned: starsEarned,
          stars_possible: starsPossible
        },
        nodes
      }
    });
  } catch (error) {
    console.error('Course path error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch course path: ' + error.message });
  }
});

/**
 * POST /api/courses/:id/path/chest/:chestIndex/claim
 * Claim a chest's XP reward. chest_index === that chapter's position in the
 * course. A chapter is "done" iff it has a lesson_completions row — which is
 * either the manual chapter mark-complete (legacy, no units) or the
 * auto-complete in utils/progress.js (every unit + unit quiz done) — so this
 * check is a single source of truth either way.
 */
router.post('/:id/path/chest/:chestIndex/claim', authenticateToken, isStudent, async (req, res) => {
  try {
    const { id } = req.params;
    const chestIndex = parseInt(req.params.chestIndex, 10);
    if (!Number.isFinite(chestIndex) || chestIndex < 0) {
      return res.status(400).json({ success: false, error: 'Invalid chest index' });
    }
    const studentId = req.user.userId;

    const { data: existingClaim } = await supabase
      .from('path_chest_claims')
      .select('chest_index')
      .eq('student_id', studentId)
      .eq('course_id', id)
      .eq('chest_index', chestIndex)
      .maybeSingle();
    if (existingClaim) {
      return res.status(409).json({ success: false, error: 'This chest has already been claimed' });
    }

    const { data: chapters } = await supabase
      .from('lessons')
      .select('id')
      .eq('course_id', id)
      .order('order_number', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(chestIndex + 1);

    if (!chapters || chapters.length <= chestIndex) {
      return res.status(400).json({ success: false, error: 'This chest is not reachable yet' });
    }

    const chapter = chapters[chestIndex];
    const { data: completion } = await supabase
      .from('lesson_completions')
      .select('id')
      .eq('student_id', studentId)
      .eq('lesson_id', chapter.id)
      .maybeSingle();

    if (!completion) {
      return res.status(403).json({ success: false, error: 'Finish this chapter first' });
    }

    const { error: claimError } = await supabase
      .from('path_chest_claims')
      .insert({ student_id: studentId, course_id: id, chest_index: chestIndex });
    if (claimError) throw claimError;

    await awardXp(studentId, XP_VALUES.PATH_CHEST, 'path_chest', id);

    res.status(201).json({
      success: true,
      message: `Chest opened! +${XP_VALUES.PATH_CHEST} XP`,
      data: { xp_awarded: XP_VALUES.PATH_CHEST }
    });
  } catch (error) {
    console.error('Chest claim error:', error);
    res.status(500).json({ success: false, error: 'Failed to claim chest: ' + error.message });
  }
});

module.exports = router;