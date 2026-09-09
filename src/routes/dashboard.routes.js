const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, isStudent } = require('../middleware/auth');
const { getStreakSummary } = require('../utils/streak');
const { levelInfo, getXpBreakdown, awardXp } = require('../utils/xp');

// This week's XP / quiz / assignment / live-class targets shown on the home
// screen "This Week" card. Static for now — no per-student goal setting yet.
const WEEK_GOALS = { xp: 100, quizzes: 3, assignments: 2, live_classes: 2 };

// The three daily targets on the home screen. Fixed for everyone; each is
// satisfied by something already tracked. Completing all three grants a one-off
// bonus (once per day). Labels + per-task XP live in the mobile i18n.
const DAILY_TARGET_KEYS = ['daily_challenge', 'pass_quiz', 'finish_lesson'];
const DAILY_TARGETS_BONUS_XP = 50;

// Monday 00:00 (server local) of the week containing `now`.
function weekStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Sun->6, Mon->0, ...
  return d;
}

// 00:00 (server local) today.
function dayStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

// YYYY-MM-DD for "today", matching how daily_quiz_attempts.quiz_date is written.
function todayKey() {
  return new Date().toISOString().slice(0, 10);
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
    // Per-course progress + "current chapter" for the home "Continue Learning" list.
    let dashboardCourses = [];
    // Unit-level totals across every enrolled course (drives the hero ring).
    let overallUnitsDone = 0;
    let overallUnitsTotal = 0;

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

      // Unit-level completion — progress % is counted per unit (a unit-less
      // chapter counts as one unit, done when the chapter is complete), so the
      // number moves with real work instead of only when a whole chapter closes.
      let unitRows = [];
      if (lessonIds.length > 0) {
        const { data: u } = await supabase
          .from('lesson_units')
          .select('id, lesson_id')
          .in('lesson_id', lessonIds);
        unitRows = u || [];
      }
      const unitIds = unitRows.map(u => u.id);
      let completedUnitIds = new Set();
      if (unitIds.length > 0) {
        const { data: uc } = await supabase
          .from('unit_completions')
          .select('unit_id')
          .eq('student_id', studentId)
          .in('unit_id', unitIds);
        completedUnitIds = new Set((uc || []).map(r => r.unit_id));
      }
      const unitsByLesson = {};
      unitRows.forEach(u => {
        (unitsByLesson[u.lesson_id] = unitsByLesson[u.lesson_id] || []).push(u.id);
      });

      // Figure out which lesson to resume: prefer the course the student
      // most recently completed a lesson in, otherwise fall back to their
      // most recently enrolled course. Then take the first lesson (in
      // playback order) in that course they haven't finished yet.
      const courseIdByLesson = {};
      lessons.forEach(l => { courseIdByLesson[l.id] = l.course_id; });
      const completedLessonIds = new Set(completions.map(c => c.lesson_id));

      // { done, total } units for one chapter.
      const chapterUnitProgress = (lesson) => {
        const units = unitsByLesson[lesson.id];
        if (units && units.length > 0) {
          return { done: units.filter(id => completedUnitIds.has(id)).length, total: units.length };
        }
        return { done: completedLessonIds.has(lesson.id) ? 1 : 0, total: 1 };
      };
      lessons.forEach(l => {
        const p = chapterUnitProgress(l);
        overallUnitsDone += p.done;
        overallUnitsTotal += p.total;
      });

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

      // Course metadata for every enrolled course (one query, reused below).
      const { data: courseMetaRows } = await supabase
        .from('courses')
        .select('id, title, color, icon, cover_image')
        .in('id', courseIds);
      const courseMetaById = {};
      (courseMetaRows || []).forEach(c => { courseMetaById[c.id] = c; });

      if (candidate) {
        const meta = courseMetaById[candidate.course_id];
        continueLesson = {
          lesson_id: candidate.id,
          lesson_title: candidate.title,
          course_id: candidate.course_id,
          course_title: meta?.title || null,
          course_color: meta?.color || null,
          course_icon: meta?.icon || null,
          course_cover_image: meta?.cover_image || null
        };
      }

      // One row per enrolled course that has chapters: unit-level % and the
      // first chapter the student hasn't finished yet. Ordered by most recent
      // activity, then enrollment.
      dashboardCourses = courseIds
        .map(cid => {
          const list = lessonsByCourse[cid] || [];
          if (list.length === 0) return null;
          let done = 0;
          let total = 0;
          list.forEach(l => { const p = chapterUnitProgress(l); done += p.done; total += p.total; });
          const cur = firstIncomplete(cid);
          const meta = courseMetaById[cid] || {};
          return {
            course_id: cid,
            title: meta.title || null,
            color: meta.color || null,
            icon: meta.icon || null,
            percentage: total > 0 ? Math.round((done / total) * 100) : 0,
            current_chapter_title: cur ? cur.title : null,
            current_lesson_id: cur ? cur.id : null,
          };
        })
        .filter(Boolean)
        .sort((a, b) => {
          const ta = lastCompletedAtByCourse[a.course_id] || enrolledAtByCourse[a.course_id] || '';
          const tb = lastCompletedAtByCourse[b.course_id] || enrolledAtByCourse[b.course_id] || '';
          return tb.localeCompare(ta);
        });
    }

    // Unit-level overall progress (moves with each unit, not only whole chapters).
    const percentage = overallUnitsTotal > 0
      ? Math.round((overallUnitsDone / overallUnitsTotal) * 100)
      : (totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0);

    // Streak, total quizzes passed, and this-week counters.
    const sinceIso = weekStart().toISOString();
    const [
      streakSummary,
      { data: passedSubs },
      { data: weekXpRows },
      { data: weekQuizRows },
      { data: weekAssignRows },
      { data: weekLiveRows },
    ] = await Promise.all([
      getStreakSummary(studentId),
      supabase.from('quiz_submissions').select('quiz_id').eq('student_id', studentId).eq('passed', true),
      supabase.from('xp_events').select('amount').eq('student_id', studentId).gte('created_at', sinceIso),
      supabase.from('quiz_submissions').select('id').eq('student_id', studentId).gte('submitted_at', sinceIso),
      supabase.from('assignment_submissions').select('id').eq('student_id', studentId).gte('submitted_at', sinceIso),
      supabase.from('live_class_participants').select('id').eq('user_id', studentId).gte('joined_at', sinceIso),
    ]);

    const quizzesPassed = new Set((passedSubs || []).map(s => s.quiz_id)).size;
    const weekXp = (weekXpRows || []).reduce((sum, r) => sum + (r.amount || 0), 0);
    const xpBreakdown = await getXpBreakdown(studentId);

    // Home-screen extras: study time, quiz bank size, upcoming assignments,
    // and today's daily-target state.
    const todayIso = dayStart().toISOString();
    const tKey = todayKey();
    const enrolledFilter = courseIds.length > 0 ? courseIds : null;

    const [
      { data: studyRows },
      { data: quizBankRows },
      { data: assignmentRows },
      { data: assignmentSubRows },
      { data: dailyChallengeRows },
      { data: passTodayRows },
      { data: lessonTodayRows },
      { data: unitTodayRows },
      { data: bonusRows },
    ] = await Promise.all([
      supabase.from('study_minutes').select('minutes').eq('student_id', studentId),
      enrolledFilter
        ? supabase.from('quizzes').select('id').in('course_id', enrolledFilter).eq('status', 'published')
        : Promise.resolve({ data: [] }),
      enrolledFilter
        ? supabase.from('assignments').select('id, due_date').in('course_id', enrolledFilter)
        : Promise.resolve({ data: [] }),
      supabase.from('assignment_submissions').select('assignment_id').eq('student_id', studentId),
      supabase.from('daily_quiz_attempts').select('completed_at').eq('student_id', studentId).eq('quiz_date', tKey),
      supabase.from('quiz_submissions').select('id').eq('student_id', studentId).eq('passed', true).gte('submitted_at', todayIso).limit(1),
      supabase.from('lesson_completions').select('lesson_id').eq('student_id', studentId).gte('completed_at', todayIso).limit(1),
      supabase.from('unit_completions').select('unit_id').eq('student_id', studentId).gte('completed_at', todayIso).limit(1),
      supabase.from('xp_events').select('id').eq('student_id', studentId).eq('reason', 'daily_targets').gte('created_at', todayIso).limit(1),
    ]);

    const studyMinutes = (studyRows || []).reduce((sum, r) => sum + (r.minutes || 0), 0);
    const quizzesTotal = (quizBankRows || []).length;

    const submittedAssignmentIds = new Set((assignmentSubRows || []).map(r => r.assignment_id));
    const now = Date.now();
    const assignmentsUpcoming = (assignmentRows || []).filter(a =>
      a.due_date && Date.parse(a.due_date) > now && !submittedAssignmentIds.has(a.id)
    ).length;

    const targetDone = {
      daily_challenge: (dailyChallengeRows || []).some(r => r.completed_at),
      pass_quiz: (passTodayRows || []).length > 0,
      finish_lesson: (lessonTodayRows || []).length > 0 || (unitTodayRows || []).length > 0,
    };
    const doneCount = DAILY_TARGET_KEYS.filter(k => targetDone[k]).length;
    const allDone = doneCount === DAILY_TARGET_KEYS.length;
    let bonusAwarded = (bonusRows || []).length > 0;

    let xp = userRow.xp || 0;
    // Grant the all-three bonus once per day. Idempotent via the xp_events check
    // above; on a cold read after the third task this is where it lands.
    if (allDone && !bonusAwarded) {
      await awardXp(studentId, DAILY_TARGETS_BONUS_XP, 'daily_targets');
      xp += DAILY_TARGETS_BONUS_XP;
      bonusAwarded = true;
    }

    res.json({
      success: true,
      data: {
        xp,
        level: levelInfo(xp),
        lessons_completed: completedLessons,
        quizzes_passed: quizzesPassed,
        quizzes_total: quizzesTotal,
        streak: streakSummary.current,
        streak_week: streakSummary.week,
        study_minutes: studyMinutes,
        assignments_upcoming: assignmentsUpcoming,
        xp_breakdown: xpBreakdown,
        progress: {
          completed_lessons: completedLessons,
          total_lessons: totalLessons,
          units_completed: overallUnitsDone,
          units_total: overallUnitsTotal,
          percentage
        },
        week: {
          xp_earned: weekXp,
          quizzes_attempted: (weekQuizRows || []).length,
          assignments_submitted: (weekAssignRows || []).length,
          live_classes_attended: (weekLiveRows || []).length,
          goals: WEEK_GOALS
        },
        courses: dashboardCourses,
        daily_targets: {
          items: DAILY_TARGET_KEYS.map(key => ({ key, done: targetDone[key] })),
          done_count: doneCount,
          all_done: allDone,
          bonus_xp: DAILY_TARGETS_BONUS_XP,
          bonus_awarded: bonusAwarded,
        },
        continue_lesson: continueLesson,
        all_caught_up: overallUnitsTotal > 0 && overallUnitsDone === overallUnitsTotal
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
 * POST /api/dashboard/study-time   body: { minutes }
 * The mobile app posts elapsed foreground time from learning screens; this
 * adds it to today's row in `study_minutes`. Best-effort, non-atomic.
 */
router.post('/study-time', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const raw = Number(req.body && req.body.minutes);
    if (!Number.isFinite(raw) || raw < 1) {
      return res.status(400).json({ success: false, error: 'minutes must be a positive number' });
    }
    const minutes = Math.min(180, Math.round(raw)); // clamp clock-skew / junk
    const day = todayKey();

    const { data: existing } = await supabase
      .from('study_minutes')
      .select('minutes')
      .eq('student_id', studentId)
      .eq('day', day)
      .maybeSingle();

    const { error } = await supabase
      .from('study_minutes')
      .upsert(
        { student_id: studentId, day, minutes: (existing?.minutes || 0) + minutes, updated_at: new Date() },
        { onConflict: 'student_id,day' }
      );
    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Study-time error:', error);
    res.status(500).json({ success: false, error: 'Failed to record study time: ' + error.message });
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
    const MEANINGFUL_XP = ['quiz_pass', 'path_chest', 'daily_quiz', 'assignment_ontime', 'assignment_late', 'live_class'];

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
