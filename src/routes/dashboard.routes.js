const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, isStudent } = require('../middleware/auth');
const { getStreak } = require('../utils/achievements');

// This week's XP / quiz / assignment / live-class targets shown on the home
// screen "This Week" card. Static for now — no per-student goal setting yet.
const WEEK_GOALS = { xp: 100, quizzes: 3, assignments: 2, live_classes: 2 };

// Monday 00:00 (server local) of the week containing `now`.
function weekStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Sun->6, Mon->0, ...
  return d;
}

/**
 * GET /api/dashboard
 * Student home screen summary: XP, lessons completed, overall progress,
 * daily-quiz streak, quizzes passed, and this-week activity vs. goals.
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

    // Streak, total quizzes passed, and this-week counters.
    const sinceIso = weekStart().toISOString();
    const [
      streak,
      { data: passedSubs },
      { data: weekXpRows },
      { data: weekQuizRows },
      { data: weekAssignRows },
      { data: weekLiveRows },
    ] = await Promise.all([
      getStreak(studentId),
      supabase.from('quiz_submissions').select('quiz_id').eq('student_id', studentId).eq('passed', true),
      supabase.from('xp_events').select('amount').eq('student_id', studentId).gte('created_at', sinceIso),
      supabase.from('quiz_submissions').select('id').eq('student_id', studentId).gte('submitted_at', sinceIso),
      supabase.from('assignment_submissions').select('id').eq('student_id', studentId).gte('submitted_at', sinceIso),
      supabase.from('live_class_participants').select('id').eq('user_id', studentId).gte('joined_at', sinceIso),
    ]);

    const quizzesPassed = new Set((passedSubs || []).map(s => s.quiz_id)).size;
    const weekXp = (weekXpRows || []).reduce((sum, r) => sum + (r.amount || 0), 0);

    res.json({
      success: true,
      data: {
        xp: userRow.xp || 0,
        lessons_completed: completedLessons,
        quizzes_passed: quizzesPassed,
        streak,
        progress: {
          completed_lessons: completedLessons,
          total_lessons: totalLessons,
          percentage
        },
        week: {
          xp_earned: weekXp,
          quizzes_attempted: (weekQuizRows || []).length,
          assignments_submitted: (weekAssignRows || []).length,
          live_classes_attended: (weekLiveRows || []).length,
          goals: WEEK_GOALS
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

/**
 * GET /api/dashboard/activity?limit=8
 * A small "friend activity" feed for the home screen: recent milestones of
 * students the caller shares a course with (same set the friends leaderboard
 * uses) — quizzes passed, chests opened, lessons finished, badges earned.
 * Sorted newest-first. Nothing is stored; it's assembled from the ledgers.
 */
router.get('/activity', authenticateToken, isStudent, async (req, res) => {
  try {
    const me = req.user.userId;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 30);

    const { data: myEnr } = await supabase
      .from('course_enrollments').select('course_id').eq('student_id', me);
    const courseIds = (myEnr || []).map(e => e.course_id);
    if (courseIds.length === 0) return res.json({ success: true, data: { activity: [] } });

    const { data: peers } = await supabase
      .from('course_enrollments').select('student_id').in('course_id', courseIds);
    const peerIds = [...new Set((peers || []).map(p => p.student_id))].filter(id => id !== me);
    if (peerIds.length === 0) return res.json({ success: true, data: { activity: [] } });

    const sinceIso = new Date(Date.now() - 14 * 86400000).toISOString();
    const MEANINGFUL_XP = ['quiz_pass', 'path_chest', 'daily_quiz'];

    const [{ data: xpRows }, { data: lessonRows }, { data: badgeRows }, { data: users }] = await Promise.all([
      supabase.from('xp_events').select('student_id, amount, reason, created_at')
        .in('student_id', peerIds).in('reason', MEANINGFUL_XP)
        .gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(40),
      supabase.from('lesson_completions').select('student_id, lesson_id, completed_at')
        .in('student_id', peerIds).gte('completed_at', sinceIso)
        .order('completed_at', { ascending: false }).limit(20),
      supabase.from('achievements').select('student_id, badge_code, earned_at')
        .in('student_id', peerIds).gte('earned_at', sinceIso)
        .order('earned_at', { ascending: false }).limit(20),
      supabase.from('users').select('id, name, avatar_url').in('id', peerIds),
    ]);

    const userById = Object.fromEntries((users || []).map(u => [u.id, u]));
    const lessonIds = [...new Set((lessonRows || []).map(r => r.lesson_id))];
    const { data: lessons } = lessonIds.length
      ? await supabase.from('lessons').select('id, title').in('id', lessonIds)
      : { data: [] };
    const lessonTitle = Object.fromEntries((lessons || []).map(l => [l.id, l.title]));

    const actor = (id) => {
      const u = userById[id];
      return u ? { id: u.id, name: u.name, avatar_url: u.avatar_url } : null;
    };

    const items = [];
    (xpRows || []).forEach(r => {
      const a = actor(r.student_id);
      if (a) items.push({ type: 'xp', actor: a, amount: r.amount, reason: r.reason, at: r.created_at });
    });
    (lessonRows || []).forEach(r => {
      const a = actor(r.student_id);
      if (a) items.push({ type: 'lesson', actor: a, lesson_title: lessonTitle[r.lesson_id] || null, at: r.completed_at });
    });
    (badgeRows || []).forEach(r => {
      const a = actor(r.student_id);
      if (a) items.push({ type: 'badge', actor: a, badge_code: r.badge_code, at: r.earned_at });
    });

    items.sort((x, y) => new Date(y.at) - new Date(x.at));
    res.json({ success: true, data: { activity: items.slice(0, limit) } });
  } catch (error) {
    console.error('Dashboard activity error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch activity: ' + error.message });
  }
});

module.exports = router;
