const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { totalXpForLevel } = require('./xp');

// Which badge to show when a student has earned several (first match wins).
const BADGE_PRIORITY = [
  'streak_30', 'streak_14', 'streak_7', 'streak_master',
  'level_10', 'quiz_master', 'quiz_grinder', 'assignment_champion',
  'knowledge_seeker', 'fast_finisher', 'quick_learner', 'rising_star',
  'first_hundred', 'first_step'
];

const RISING_STAR_XP = 50;        // XP in the last 7 days
const QUIZ_GRINDER_COUNT = 5;     // distinct quizzes passed
const QUIZ_MASTER_COUNT = 10;     // distinct quizzes passed
const STREAK_MASTER_DAYS = 3;     // consecutive daily-quiz days
const ASSIGNMENT_CHAMPION_COUNT = 5;  // assignments turned in on time
const RISING_SCHOLAR_LEVEL = 10;  // level for the 'level_10' badge

// Consecutive daily-quiz-day milestones: { code: days required }
const STREAK_MILESTONES = { streak_7: 7, streak_14: 14, streak_30: 30 };

// Lesson-count milestone badges: { code: lessons required }
const LESSON_MILESTONES = {
  first_step: 1,
  quick_learner: 5,
  knowledge_seeker: 10
};

function daysBetween(a, b) {
  const ms = new Date(b).setHours(0, 0, 0, 0) - new Date(a).setHours(0, 0, 0, 0);
  return Math.round(ms / 86400000);
}

/**
 * Longest run of consecutive calendar days (ending today or yesterday) on
 * which the student completed the daily quiz.
 */
function currentStreak(completedDates) {
  const days = [...new Set(completedDates)].sort().reverse(); // newest first, unique
  if (days.length === 0) return 0;

  const gapFromToday = daysBetween(days[0], new Date());
  if (gapFromToday > 1) return 0; // streak already broken

  let streak = 1;
  for (let i = 1; i < days.length; i++) {
    if (daysBetween(days[i], days[i - 1]) === 1) streak++;
    else break;
  }
  return streak;
}

/**
 * The student's current daily-quiz streak, read straight from
 * daily_quiz_attempts. Returns 0 if they've missed today and yesterday.
 */
async function getStreak(studentId) {
  const { data: attempts } = await supabase
    .from('daily_quiz_attempts')
    .select('quiz_date, completed_at')
    .eq('student_id', studentId)
    .not('completed_at', 'is', null);
  return currentStreak((attempts || []).map(a => a.quiz_date));
}

async function grantBadge(studentId, badgeCode) {
  const { error } = await supabase
    .from('achievements')
    .insert({ id: uuidv4(), student_id: studentId, badge_code: badgeCode, earned_at: new Date() });
  // 23505 = unique violation (already earned) — expected, ignore.
  if (error && error.code !== '23505') {
    console.warn(`grantBadge(${badgeCode}) failed:`, error.message);
  }
}

/**
 * Re-evaluate every badge for a student and grant any newly earned ones.
 * Best-effort: never throws into the caller's request path.
 */
async function evaluateAchievements(studentId) {
  try {
    const { data: earnedRows } = await supabase
      .from('achievements')
      .select('badge_code')
      .eq('student_id', studentId);
    const earned = new Set((earnedRows || []).map(r => r.badge_code));

    const toCheck = [
      'fast_finisher', 'quiz_grinder', 'quiz_master', 'streak_master', 'rising_star',
      'first_hundred', 'assignment_champion', 'level_10',
      ...Object.keys(STREAK_MILESTONES),
      ...Object.keys(LESSON_MILESTONES)
    ].filter(code => !earned.has(code));
    if (toCheck.length === 0) return;

    const need = (...codes) => codes.some(c => toCheck.includes(c));

    // lesson_completions count (drives the lesson milestone badges)
    let lessonsCompleted = 0;
    if (Object.keys(LESSON_MILESTONES).some(code => toCheck.includes(code))) {
      const { count } = await supabase
        .from('lesson_completions')
        .select('id', { count: 'exact', head: true })
        .eq('student_id', studentId);
      lessonsCompleted = count || 0;
    }

    // quiz_submissions: perfect score + distinct passed quizzes
    let perfectScore = false;
    let passedQuizCount = 0;
    if (need('fast_finisher', 'quiz_grinder', 'quiz_master')) {
      const { data: subs } = await supabase
        .from('quiz_submissions')
        .select('quiz_id, score, passed')
        .eq('student_id', studentId);
      perfectScore = (subs || []).some(s => s.score === 100);
      passedQuizCount = new Set((subs || []).filter(s => s.passed).map(s => s.quiz_id)).size;
    }

    // daily-quiz streak
    let streak = 0;
    if (need('streak_master', ...Object.keys(STREAK_MILESTONES))) {
      const { data: attempts } = await supabase
        .from('daily_quiz_attempts')
        .select('quiz_date, completed_at')
        .eq('student_id', studentId)
        .not('completed_at', 'is', null);
      streak = currentStreak((attempts || []).map(a => a.quiz_date));
    }

    // Lifetime XP + level (first_hundred, level_10)
    let lifetimeXp = 0;
    if (need('rising_star', 'first_hundred', 'level_10')) {
      const { data: userRow } = await supabase
        .from('users').select('xp').eq('id', studentId).maybeSingle();
      lifetimeXp = userRow?.xp || 0;
    }

    // XP in the last 7 days
    let weekXp = 0;
    if (toCheck.includes('rising_star')) {
      const since = new Date();
      since.setDate(since.getDate() - 7);
      const { data: events } = await supabase
        .from('xp_events')
        .select('amount')
        .eq('student_id', studentId)
        .gte('created_at', since.toISOString());
      weekXp = (events || []).reduce((sum, e) => sum + (e.amount || 0), 0);
    }

    // On-time assignment submissions (assignment_champion)
    let ontimeAssignments = 0;
    if (toCheck.includes('assignment_champion')) {
      const { count } = await supabase
        .from('xp_events')
        .select('id', { count: 'exact', head: true })
        .eq('student_id', studentId)
        .eq('reason', 'assignment_ontime');
      ontimeAssignments = count || 0;
    }

    const grants = [];
    if (toCheck.includes('fast_finisher') && perfectScore) grants.push('fast_finisher');
    if (toCheck.includes('quiz_grinder') && passedQuizCount >= QUIZ_GRINDER_COUNT) grants.push('quiz_grinder');
    if (toCheck.includes('quiz_master') && passedQuizCount >= QUIZ_MASTER_COUNT) grants.push('quiz_master');
    if (toCheck.includes('streak_master') && streak >= STREAK_MASTER_DAYS) grants.push('streak_master');
    if (toCheck.includes('rising_star') && weekXp >= RISING_STAR_XP) grants.push('rising_star');
    if (toCheck.includes('first_hundred') && lifetimeXp >= 100) grants.push('first_hundred');
    if (toCheck.includes('level_10') && lifetimeXp >= totalXpForLevel(RISING_SCHOLAR_LEVEL)) grants.push('level_10');
    if (toCheck.includes('assignment_champion') && ontimeAssignments >= ASSIGNMENT_CHAMPION_COUNT) grants.push('assignment_champion');
    for (const [code, required] of Object.entries(STREAK_MILESTONES)) {
      if (toCheck.includes(code) && streak >= required) grants.push(code);
    }
    for (const [code, required] of Object.entries(LESSON_MILESTONES)) {
      if (toCheck.includes(code) && lessonsCompleted >= required) grants.push(code);
    }

    for (const code of grants) await grantBadge(studentId, code);
  } catch (err) {
    console.warn('evaluateAchievements failed:', err.message);
  }
}

/**
 * Map { studentId -> best badge {code,label} } for a set of students, using
 * BADGE_PRIORITY to pick one when a student has several.
 */
async function bestBadgeByStudent(studentIds) {
  const result = {};
  if (!studentIds || studentIds.length === 0) return result;

  const [{ data: rows }, { data: badges }] = await Promise.all([
    supabase.from('achievements').select('student_id, badge_code').in('student_id', studentIds),
    supabase.from('badges').select('code, label')
  ]);

  const labelByCode = Object.fromEntries((badges || []).map(b => [b.code, b.label]));
  const byStudent = {};
  (rows || []).forEach(r => {
    (byStudent[r.student_id] = byStudent[r.student_id] || []).push(r.badge_code);
  });

  for (const [studentId, codes] of Object.entries(byStudent)) {
    const best = BADGE_PRIORITY.find(c => codes.includes(c)) || codes[0];
    result[studentId] = { code: best, label: labelByCode[best] || best };
  }
  return result;
}

module.exports = { evaluateAchievements, grantBadge, bestBadgeByStudent, getStreak, BADGE_PRIORITY };
