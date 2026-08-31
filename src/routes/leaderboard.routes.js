const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const { bestBadgeByStudent, getStreak } = require('../utils/achievements');
const { levelInfo } = require('../utils/xp');

const NEW_SCHOLAR_DAYS = 14;
const TOP_COMPETITOR_RANK = 3;

// Monday 00:00 of the current week (local server time).
function weekStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const mondayOffset = (d.getDay() + 6) % 7; // Sun=0 -> 6, Mon=1 -> 0, ...
  d.setDate(d.getDate() - mondayOffset);
  return d;
}

/**
 * GET /api/leaderboard?scope=global|friends&period=weekly|all&limit=50
 *
 * - scope=global : all students
 * - scope=friends: students enrolled in at least one course in common with
 *   the caller (plus the caller)
 * - period=weekly: XP summed from xp_events since Monday (default)
 * - period=all   : lifetime users.xp
 *
 * Response: ranked `entries` (top `limit`) + a `me` card with the caller's
 * own rank and percentile.
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const me = req.user.userId;
    const scope = req.query.scope === 'friends' ? 'friends' : 'global';
    const period = req.query.period === 'all' ? 'all' : 'weekly';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

    // 1. Participant set. null => every student.
    let studentIds = null;
    if (scope === 'friends') {
      const { data: myEnrollments } = await supabase
        .from('course_enrollments')
        .select('course_id')
        .eq('student_id', me);
      const courseIds = (myEnrollments || []).map(e => e.course_id);

      const set = new Set([me]);
      if (courseIds.length > 0) {
        const { data: peers } = await supabase
          .from('course_enrollments')
          .select('student_id')
          .in('course_id', courseIds);
        (peers || []).forEach(p => set.add(p.student_id));
      }
      studentIds = [...set];
    }

    // 2. Student rows in the set.
    let userQuery = supabase
      .from('users')
      .select('id, name, avatar_url, xp')
      .eq('role', 'student');
    if (studentIds) userQuery = userQuery.in('id', studentIds);
    const { data: students } = await userQuery;
    const byId = Object.fromEntries((students || []).map(u => [u.id, u]));

    // 3. XP for the chosen period.
    const xpById = {};
    let weekStartStr = null;
    if (period === 'weekly') {
      const ws = weekStart();
      const pad = n => String(n).padStart(2, '0');
      weekStartStr = `${ws.getFullYear()}-${pad(ws.getMonth() + 1)}-${pad(ws.getDate())}`;

      let eventsQuery = supabase
        .from('xp_events')
        .select('student_id, amount')
        .gte('created_at', ws.toISOString());
      if (studentIds) eventsQuery = eventsQuery.in('student_id', studentIds);

      const { data: events } = await eventsQuery;
      (events || []).forEach(e => {
        if (byId[e.student_id]) {
          xpById[e.student_id] = (xpById[e.student_id] || 0) + (e.amount || 0);
        }
      });
    } else {
      Object.values(byId).forEach(u => { xpById[u.id] = u.xp || 0; });
    }

    // 4. Rank. Weekly hides students with no XP this week; all-time keeps everyone.
    const ranked = Object.keys(byId)
      .map(id => ({ id, xp: xpById[id] || 0 }))
      .filter(r => period === 'all' || r.xp > 0)
      .sort((a, b) =>
        b.xp - a.xp ||
        (byId[a.id].name || '').localeCompare(byId[b.id].name || '')
      );
    ranked.forEach((r, i) => { r.rank = i + 1; });

    const topIds = ranked.slice(0, limit).map(r => r.id);
    const badges = await bestBadgeByStudent([...new Set([...topIds, me])]);

    const entries = ranked.slice(0, limit).map(r => ({
      rank: r.rank,
      xp: r.xp,
      student: {
        id: r.id,
        name: byId[r.id].name,
        avatar_url: byId[r.id].avatar_url
      },
      badge: badges[r.id] || null
    }));

    // 5. The caller's own card.
    let meCard = null;
    if (byId[me]) {
      const meRow = ranked.find(r => r.id === me);
      const participants = ranked.length;
      const rank = meRow ? meRow.rank : null;
      meCard = {
        rank,
        xp: meRow ? meRow.xp : 0,
        total_xp: byId[me].xp || 0,
        participants,
        top_percent: rank && participants
          ? Math.max(1, Math.ceil((rank / participants) * 100))
          : null,
        student: {
          id: me,
          name: byId[me].name,
          avatar_url: byId[me].avatar_url
        },
        badge: badges[me] || null
      };
    }

    res.json({
      success: true,
      data: {
        scope,
        period,
        week_start: weekStartStr,
        entries,
        me: meCard
      }
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch leaderboard: ' + error.message
    });
  }
});

/**
 * GET /api/leaderboard/profile/:studentId   (studentId may be the literal "me")
 *
 * The "Scholars Profile" screen: rank, level, XP, activity summary, and the
 * student's earned + still-locked badges.
 */
router.get('/profile/:studentId', authenticateToken, async (req, res) => {
  try {
    const studentId = req.params.studentId === 'me' ? req.user.userId : req.params.studentId;

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id, name, avatar_url, xp, role, created_at')
      .eq('id', studentId)
      .single();

    if (userErr || !user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // All-time global rank among students, by lifetime XP.
    const { data: allStudents } = await supabase
      .from('users')
      .select('id, xp, name')
      .eq('role', 'student');
    const ordered = (allStudents || []).sort((a, b) =>
      (b.xp || 0) - (a.xp || 0) || (a.name || '').localeCompare(b.name || ''));
    const rankIdx = ordered.findIndex(u => u.id === studentId);
    const rank = rankIdx >= 0 ? rankIdx + 1 : null;

    // Activity summary
    const [lessonsRes, passedSubsRes, streak] = await Promise.all([
      supabase.from('lesson_completions').select('id', { count: 'exact', head: true }).eq('student_id', studentId),
      supabase.from('quiz_submissions').select('quiz_id').eq('student_id', studentId).eq('passed', true),
      getStreak(studentId)
    ]);
    const challengesMastered = new Set((passedSubsRes.data || []).map(s => s.quiz_id)).size;

    // Badges: earned (with earned_at, newest first) + still-locked
    const [badgesRes, earnedRes] = await Promise.all([
      supabase.from('badges').select('code, label, description'),
      supabase.from('achievements').select('badge_code, earned_at').eq('student_id', studentId)
    ]);
    const earnedAt = Object.fromEntries((earnedRes.data || []).map(r => [r.badge_code, r.earned_at]));
    const allBadges = badgesRes.data || [];
    const badges = {
      earned: allBadges
        .filter(b => earnedAt[b.code])
        .map(b => ({ ...b, earned_at: earnedAt[b.code] }))
        .sort((a, b) => new Date(b.earned_at) - new Date(a.earned_at)),
      locked: allBadges.filter(b => !earnedAt[b.code])
    };

    // Header status tags — computed, not stored.
    const tags = [];
    if (rank && rank <= TOP_COMPETITOR_RANK) tags.push('Top Competitor');
    const ageDays = (Date.now() - new Date(user.created_at).getTime()) / 86400000;
    if (ageDays <= NEW_SCHOLAR_DAYS) tags.push('New Scholar');

    res.json({
      success: true,
      data: {
        student: {
          id: user.id,
          name: user.name,
          avatar_url: user.avatar_url,
          tagline: 'Learning actively on Romduol Scholars.'
        },
        rank,
        total_students: ordered.length,
        xp: user.xp || 0,
        ...levelInfo(user.xp),
        tags,
        activity: {
          current_streak: streak,
          lessons_completed: lessonsRes.count || 0,
          challenges_mastered: challengesMastered
        },
        badges
      }
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch profile: ' + error.message });
  }
});

module.exports = router;
