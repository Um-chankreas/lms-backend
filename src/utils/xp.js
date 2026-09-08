const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');

// Base XP awards. Quiz and assignment awards are computed (see helpers below).
const XP_VALUES = {
  LESSON_COMPLETE: 15,
  UNIT_COMPLETE: 5,
  QUIZ_PASS_MIN: 10,          // a barely-passing quiz
  QUIZ_PASS_MAX: 50,          // a perfect quiz
  DAILY_QUIZ_COMPLETE: 50,    // flat, for finishing the daily practice set
  ASSIGNMENT_ONTIME: 75,
  ASSIGNMENT_LATE: 25,
  LIVE_CLASS_ATTEND: 20,
  PATH_CHEST: 30,
};

/**
 * XP for passing a quiz, scaled 10..50 by the score (0..100). Only ever
 * called when the student actually passed.
 */
function xpForQuizScore(score) {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  const { QUIZ_PASS_MIN: min, QUIZ_PASS_MAX: max } = XP_VALUES;
  return Math.round(min + (s / 100) * (max - min));
}

// ── Levels ────────────────────────────────────────────────────────────
// Accelerating curve: level 2 needs 80 XP, and each subsequent level needs
// 40 more than the last (level 3 at 200, level 4 at 360, …). Kept in sync
// with the mobile client's lib/gamification.ts so the number never disagrees.
function totalXpForLevel(level) {
  let total = 0;
  for (let i = 1; i < level; i += 1) total += 80 + (i - 1) * 40;
  return total;
}

const LEVEL_TITLES = [
  'New Scholar', 'Curious Learner', 'Focused Student',
  'Top Performer', 'BACII Challenger', 'Romduol Champion',
];

function levelInfo(xp) {
  const total = Math.max(0, xp || 0);
  let level = 1;
  while (total >= totalXpForLevel(level + 1)) level += 1;

  const base = totalXpForLevel(level);
  const next = totalXpForLevel(level + 1);
  const span = Math.max(next - base, 1);
  const intoLevel = total - base;

  return {
    level,
    title: LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)],
    xp_into_level: intoLevel,
    xp_for_next_level: span,
    xp_to_next_level: Math.max(span - intoLevel, 0),
    xp_total_for_level: base,
    xp_total_for_next_level: next,
    progress: Math.min(Math.max(intoLevel / span, 0), 1),
  };
}

/**
 * Award XP to a student: appends a row to the xp_events ledger (used for
 * time-windowed leaderboards and the per-subject breakdown) and bumps the
 * running users.xp lifetime total.
 *
 * @param {string}  studentId
 * @param {number}  amount
 * @param {string}  reason     short tag: 'lesson_complete' | 'quiz_pass' |
 *                             'daily_quiz' | 'assignment' | 'live_class' | …
 * @param {string?} courseId   course the XP came from, or null for
 *                             course-agnostic XP (daily practice)
 */
async function awardXp(studentId, amount, reason = 'other', courseId = null) {
  if (!amount) return;

  const { error: ledgerError } = await supabase
    .from('xp_events')
    .insert({
      id: uuidv4(),
      student_id: studentId,
      amount,
      reason,
      course_id: courseId || null,
      created_at: new Date()
    });
  if (ledgerError) console.warn('xp_events insert failed:', ledgerError.message);

  const { data: user } = await supabase
    .from('users')
    .select('xp')
    .eq('id', studentId)
    .single();

  const currentXp = user?.xp || 0;

  await supabase
    .from('users')
    .update({ xp: currentXp + amount })
    .eq('id', studentId);
}

/**
 * Per-subject XP for a student, from the xp_events ledger: one entry per
 * course they've earned XP in (newest-earned first), plus a `general` bucket
 * for course-agnostic XP (daily practice). Used by the home + profile
 * "subject breakdown" and by a friend's public profile.
 *
 * Returns { total, general, courses: [{ course_id, title, category, icon,
 * color, xp }] }.
 */
async function getXpBreakdown(studentId) {
  const { data: events } = await supabase
    .from('xp_events')
    .select('amount, course_id')
    .eq('student_id', studentId);

  const rows = events || [];
  const total = rows.reduce((s, e) => s + (e.amount || 0), 0);

  const byCourse = new Map();
  let general = 0;
  for (const e of rows) {
    if (!e.course_id) { general += e.amount || 0; continue; }
    byCourse.set(e.course_id, (byCourse.get(e.course_id) || 0) + (e.amount || 0));
  }

  const courseIds = [...byCourse.keys()];
  let courseMeta = [];
  if (courseIds.length > 0) {
    const { data: courses } = await supabase
      .from('courses')
      .select('id, title, category, icon, color')
      .in('id', courseIds);
    courseMeta = courses || [];
  }
  const metaById = Object.fromEntries(courseMeta.map(c => [c.id, c]));

  const courses = courseIds
    .map(id => ({
      course_id: id,
      title: metaById[id]?.title || null,
      category: metaById[id]?.category || null,
      icon: metaById[id]?.icon || null,
      color: metaById[id]?.color || null,
      xp: byCourse.get(id)
    }))
    .sort((a, b) => b.xp - a.xp);

  return { total, general, courses };
}

module.exports = { awardXp, XP_VALUES, xpForQuizScore, levelInfo, totalXpForLevel, getXpBreakdown };
