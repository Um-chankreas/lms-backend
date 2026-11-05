const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { getGold } = require('../utils/gold');
const { authenticateToken, isStudent } = require('../middleware/auth');
const { getStreak } = require('../utils/achievements');
const { levelInfo, getXpBreakdown } = require('../utils/xp');

// Order badges appear in the "Achievements" grid (earned + locked alike).
const BADGE_DISPLAY_ORDER = [
  'first_step', 'quick_learner', 'knowledge_seeker',
  'fast_finisher', 'quiz_grinder', 'streak_master', 'rising_star'
];

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Monday 00:00 (local) of the week `weeksAgo` weeks before the current one.
function weekStartMonday(weeksAgo = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const mondayOffset = (d.getDay() + 6) % 7; // Sun=0 -> 6, Mon=1 -> 0
  d.setDate(d.getDate() - mondayOffset - weeksAgo * 7);
  return d;
}

/**
 * XP earned per day for one week — powers the "This Week" bar chart.
 * `weeksAgo` 0 = current week, 1 = last week, ...
 */
async function weeklyActivity(studentId, weeksAgo = 0) {
  const start = weekStartMonday(weeksAgo);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  const { data: events } = await supabase
    .from('xp_events')
    .select('amount, created_at')
    .eq('student_id', studentId)
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());

  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const days = labels.map((weekday, i) => {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    return { date: ymd(date), weekday, xp: 0, events: 0 };
  });

  (events || []).forEach(e => {
    const dt = new Date(e.created_at);
    dt.setHours(0, 0, 0, 0);
    const idx = Math.round((dt.getTime() - start.getTime()) / 86400000);
    if (idx >= 0 && idx < 7) {
      days[idx].xp += e.amount || 0;
      days[idx].events += 1;
    }
  });

  return {
    week_start: ymd(start),
    weeks_ago: weeksAgo,
    total_xp: days.reduce((sum, d) => sum + d.xp, 0),
    days
  };
}

/**
 * GET /api/profile
 * The authenticated student's own profile screen.
 */
router.get('/', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id, name, avatar_url, bio, role, xp, created_at')
      .eq('id', studentId)
      .single();
    if (userErr || !user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Enrolled courses -> overall lesson completion %
    const { data: enrollments } = await supabase
      .from('course_enrollments')
      .select('course_id')
      .eq('student_id', studentId);
    const courseIds = (enrollments || []).map(e => e.course_id);

    let totalLessons = 0;
    if (courseIds.length > 0) {
      const { count } = await supabase
        .from('lessons')
        .select('id', { count: 'exact', head: true })
        .in('course_id', courseIds);
      totalLessons = count || 0;
    }

    const [lessonsRes, streak, activity, badgesRes, earnedRes, xpBreakdown] = await Promise.all([
      supabase.from('lesson_completions').select('id', { count: 'exact', head: true }).eq('student_id', studentId),
      getStreak(studentId),
      weeklyActivity(studentId, 0),
      supabase.from('badges').select('code, label, description'),
      supabase.from('achievements').select('badge_code, earned_at').eq('student_id', studentId),
      getXpBreakdown(studentId)
    ]);

    const lessonsCompleted = lessonsRes.count || 0;
    const completePercentage = totalLessons > 0
      ? Math.round((lessonsCompleted / totalLessons) * 100)
      : 0;

    const earnedAt = Object.fromEntries((earnedRes.data || []).map(r => [r.badge_code, r.earned_at]));
    const orderIdx = code => {
      const i = BADGE_DISPLAY_ORDER.indexOf(code);
      return i === -1 ? BADGE_DISPLAY_ORDER.length : i;
    };
    const allBadges = (badgesRes.data || []).slice().sort((a, b) => orderIdx(a.code) - orderIdx(b.code));

    const achievements = {
      earned: allBadges
        .filter(b => earnedAt[b.code])
        .map(b => ({ ...b, earned_at: earnedAt[b.code] })),
      locked: allBadges.filter(b => !earnedAt[b.code])
    };

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          name: user.name,
          avatar_url: user.avatar_url,
          bio: user.bio || null,
          role: user.role,
          created_at: user.created_at
        },
        summary: {
          xp: user.xp || 0,
          gold: await getGold(studentId),
          level: levelInfo(user.xp || 0),
          day_streak: streak,
          complete_percentage: completePercentage
        },
        learning_stats: {
          lessons_completed: lessonsCompleted,
          courses_enrolled: courseIds.length,
          total_xp: user.xp || 0,
          saved_lessons: 0 // no bookmark feature yet
        },
        xp_breakdown: xpBreakdown,
        achievements,
        activity
      }
    });
  } catch (error) {
    console.error('Profile screen error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch profile: ' + error.message });
  }
});

/**
 * GET /api/profile/activity?weeks_ago=0
 * Just the weekly bar-chart data, for the ‹ Weekly › navigation.
 */
router.get('/activity', authenticateToken, isStudent, async (req, res) => {
  try {
    let weeksAgo = parseInt(req.query.weeks_ago, 10);
    if (!Number.isFinite(weeksAgo) || weeksAgo < 0) weeksAgo = 0;
    weeksAgo = Math.min(weeksAgo, 520); // ~10 years, sanity cap

    const activity = await weeklyActivity(req.user.userId, weeksAgo);
    res.json({ success: true, data: activity });
  } catch (error) {
    console.error('Profile activity error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch activity: ' + error.message });
  }
});

const PROVINCE_MAX = 60;
const SCHOOL_MAX = 80;
const VISIBILITY = ['teachers', 'friends', 'nobody'];

/**
 * GET /api/profile/private
 * The student's own private details: school, province and Telegram state. Only the
 * student can read this; teachers get the Telegram username through
 * GET /api/telegram/students/:id/contact, and only if the student allows it.
 */
router.get('/private', authenticateToken, isStudent, async (req, res) => {
  try {
    const { data: row, error } = await supabase
      .from('student_private').select('*').eq('user_id', req.user.userId).maybeSingle();
    // Migration 064 not run yet: behave as "nothing saved" rather than failing the screen.
    if (error && !/student_private/.test(error.message || '')) throw error;
    const r = row || {};
    res.json({
      success: true,
      data: {
        school: r.school || null,
        province: r.province || null,
        telegram: {
          connected: !!r.telegram_chat_id,
          username: r.telegram_username || null,
          first_name: r.telegram_first_name || null,
          blocked: !!r.telegram_blocked_at,
          reminders: r.telegram_reminders !== false,
          visibility: r.telegram_visibility || 'teachers',
          xp_awarded: !!r.telegram_xp_awarded,
          linked_at: r.telegram_linked_at || null
        }
      }
    });
  } catch (error) {
    console.error('Profile private error:', error);
    res.status(500).json({ success: false, error: 'Failed to load private details' });
  }
});

/**
 * PUT /api/profile/private   { school?, province?, telegram_reminders?, telegram_visibility? }
 * Only these fields can be set from the app. The Telegram ids and username are written
 * by the bot webhook alone, so a student can never claim someone else's chat.
 */
router.put('/private', authenticateToken, isStudent, async (req, res) => {
  try {
    const { school, province, telegram_reminders, telegram_visibility } = req.body || {};
    const updates = { user_id: req.user.userId, updated_at: new Date().toISOString() };

    if (school !== undefined) {
      const v = String(school ?? '').trim();
      if (v.length > SCHOOL_MAX) return res.status(400).json({ success: false, error: 'School name is too long' });
      updates.school = v || null;
    }
    if (province !== undefined) {
      const v = String(province ?? '').trim();
      if (v.length > PROVINCE_MAX) return res.status(400).json({ success: false, error: 'Invalid province' });
      updates.province = v || null;
    }
    if (telegram_reminders !== undefined) {
      if (typeof telegram_reminders !== 'boolean') return res.status(400).json({ success: false, error: 'Invalid telegram_reminders' });
      updates.telegram_reminders = telegram_reminders;
    }
    if (telegram_visibility !== undefined) {
      if (!VISIBILITY.includes(telegram_visibility)) return res.status(400).json({ success: false, error: 'Invalid telegram_visibility' });
      updates.telegram_visibility = telegram_visibility;
    }

    const { error } = await supabase.from('student_private').upsert(updates, { onConflict: 'user_id' });
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Profile private update error:', error);
    res.status(500).json({ success: false, error: 'Failed to save private details' });
  }
});

/**
 * GET /api/profile/tour
 * Has this student finished (or skipped) the guided tour? Saved per account, so a
 * new phone or a reinstall doesn't show it again. Students only: teachers never see it.
 */
router.get('/tour', authenticateToken, isStudent, async (req, res) => {
  try {
    const { data: row, error } = await supabase
      .from('student_private').select('tour_completed_at').eq('user_id', req.user.userId).maybeSingle();
    if (error) throw error;
    res.json({ success: true, data: { tour_completed_at: row?.tour_completed_at || null } });
  } catch (error) {
    console.error('Tour status error:', error);
    res.status(500).json({ success: false, error: 'Failed to load tour status' });
  }
});

/**
 * POST /api/profile/tour
 * Mark the tour done. Keeps the first completion time if it was already set.
 */
router.post('/tour', authenticateToken, isStudent, async (req, res) => {
  try {
    const { data: row, error: readErr } = await supabase
      .from('student_private').select('tour_completed_at').eq('user_id', req.user.userId).maybeSingle();
    if (readErr) throw readErr;
    if (row?.tour_completed_at) return res.json({ success: true, data: { tour_completed_at: row.tour_completed_at } });
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('student_private')
      .upsert({ user_id: req.user.userId, tour_completed_at: now, updated_at: now }, { onConflict: 'user_id' });
    if (error) throw error;
    res.json({ success: true, data: { tour_completed_at: now } });
  } catch (error) {
    console.error('Tour save error:', error);
    res.status(500).json({ success: false, error: 'Failed to save tour status' });
  }
});

module.exports = router;
