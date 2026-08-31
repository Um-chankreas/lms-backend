const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, isStudent } = require('../middleware/auth');

/**
 * GET /api/dashboard
 * Student home screen summary: XP, lessons completed, and overall progress
 * across enrolled courses.
 */
router.get('/', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;

    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('xp')
      .eq('id', studentId)
      .single();

    if (userError) throw userError;

    const { data: enrollments, error: enrollError } = await supabase
      .from('course_enrollments')
      .select('course_id, enrolled_at')
      .eq('student_id', studentId);

    if (enrollError) throw enrollError;
    const courseIds = (enrollments || []).map(e => e.course_id);
    const enrolledAtByCourse = {};
    (enrollments || []).forEach(e => { enrolledAtByCourse[e.course_id] = e.enrolled_at; });

    let totalLessons = 0;
    let completedLessons = 0;
    let continueLesson = null;

    if (courseIds.length > 0) {
      const { data: courseLessons, error: lessonsError } = await supabase
        .from('lessons')
        .select('id, course_id, title')
        .in('course_id', courseIds)
        .order('order_number', { ascending: true })
        .order('created_at', { ascending: true });

      if (lessonsError) throw lessonsError;
      const lessons = courseLessons || [];
      totalLessons = lessons.length;
      const lessonIds = lessons.map(l => l.id);

      let completions = [];
      if (lessonIds.length > 0) {
        const { data: completionRows, error: completionsError } = await supabase
          .from('lesson_completions')
          .select('lesson_id, completed_at')
          .eq('student_id', studentId)
          .in('lesson_id', lessonIds);

        if (completionsError) throw completionsError;
        completions = completionRows || [];
      }
      completedLessons = completions.length;

      // Figure out which lesson to resume: prefer the course the student
      // most recently completed a lesson in, otherwise fall back to their
      // most recently enrolled course. Then take the first lesson (in
      // playback order) in that course they haven't finished yet.
      const courseIdByLesson = {};
      lessons.forEach(l => { courseIdByLesson[l.id] = l.course_id; });
      const completedLessonIds = new Set(completions.map(c => c.lesson_id));

      const lastCompletedAtByCourse = {};
      completions.forEach(c => {
        const courseId = courseIdByLesson[c.lesson_id];
        if (!courseId) return;
        if (!lastCompletedAtByCourse[courseId] || c.completed_at > lastCompletedAtByCourse[courseId]) {
          lastCompletedAtByCourse[courseId] = c.completed_at;
        }
      });

      const coursesWithActivity = Object.keys(lastCompletedAtByCourse);
      let activeCourseId = coursesWithActivity.length > 0
        ? coursesWithActivity.reduce((best, cid) =>
            !best || lastCompletedAtByCourse[cid] > lastCompletedAtByCourse[best] ? cid : best, null)
        : courseIds.reduce((best, cid) =>
            !best || enrolledAtByCourse[cid] > enrolledAtByCourse[best] ? cid : best, null);

      const lessonsByCourse = {};
      lessons.forEach(l => {
        if (!lessonsByCourse[l.course_id]) lessonsByCourse[l.course_id] = [];
        lessonsByCourse[l.course_id].push(l);
      });
      const firstIncomplete = (cid) =>
        (lessonsByCourse[cid] || []).find(l => !completedLessonIds.has(l.id)) || null;

      let candidate = activeCourseId ? firstIncomplete(activeCourseId) : null;

      // Active course is fully done — look for the next enrolled course
      // (oldest enrollment first) that still has something left.
      if (!candidate) {
        const orderedCourseIds = [...courseIds].sort((a, b) =>
          new Date(enrolledAtByCourse[a]) - new Date(enrolledAtByCourse[b]));
        for (const cid of orderedCourseIds) {
          const found = firstIncomplete(cid);
          if (found) { candidate = found; break; }
        }
      }

      if (candidate) {
        const { data: courseRow } = await supabase
          .from('courses')
          .select('id, title, color, icon, cover_image')
          .eq('id', candidate.course_id)
          .single();

        continueLesson = {
          lesson_id: candidate.id,
          lesson_title: candidate.title,
          course_id: candidate.course_id,
          course_title: courseRow?.title || null,
          course_color: courseRow?.color || null,
          course_icon: courseRow?.icon || null,
          course_cover_image: courseRow?.cover_image || null
        };
      }
    }

    const percentage = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

    res.json({
      success: true,
      data: {
        xp: userRow.xp || 0,
        lessons_completed: completedLessons,
        progress: {
          completed_lessons: completedLessons,
          total_lessons: totalLessons,
          percentage
        },
        continue_lesson: continueLesson,
        all_caught_up: totalLessons > 0 && completedLessons === totalLessons
      }
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard: ' + error.message
    });
  }
});

module.exports = router;
