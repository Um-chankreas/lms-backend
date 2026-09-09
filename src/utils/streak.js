const supabase = require('../config/supabase');
const { awardXp } = require('./xp');

// Flat bonus for the first XP-worthy thing a student does each day, while
// their streak is alive. Shown as "+10 Combo XP" on the quiz-complete screen.
const COMBO_XP = 10;
const DAY_MS = 86400000;

// UTC YYYY-MM-DD — matches how quiz_date / daily keys are written elsewhere.
function dayKey(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}

// Consecutive active days ending today (or yesterday, if today isn't done yet).
function computeStreak(daySet, tKey) {
  let cursor = new Date(tKey + 'T00:00:00Z');
  if (!daySet.has(dayKey(cursor))) {
    cursor = new Date(cursor.getTime() - DAY_MS);
    if (!daySet.has(dayKey(cursor))) return 0;
  }
  let streak = 0;
  while (daySet.has(dayKey(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return streak;
}

// Mon..Sun of the week containing today (UTC).
function weekDays(daySet, today = new Date()) {
  const tKey = dayKey(today);
  const t = new Date(tKey + 'T00:00:00Z');
  const mondayOffset = (t.getUTCDay() + 6) % 7; // Mon = 0
  const monday = new Date(t.getTime() - mondayOffset * DAY_MS);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return labels.map((weekday, i) => {
    const key = dayKey(new Date(monday.getTime() + i * DAY_MS));
    return { weekday, date: key, active: daySet.has(key), today: key === tKey };
  });
}

async function loadDays(studentId) {
  const since = dayKey(new Date(Date.now() - 60 * DAY_MS));
  const { data } = await supabase
    .from('activity_days')
    .select('day')
    .eq('student_id', studentId)
    .gte('day', since);
  return new Set((data || []).map(r => (typeof r.day === 'string' ? r.day.slice(0, 10) : dayKey(r.day))));
}

async function comboAwardedToday(studentId, tKey) {
  const { data } = await supabase
    .from('xp_events')
    .select('id')
    .eq('student_id', studentId)
    .eq('reason', 'streak_combo')
    .gte('created_at', `${tKey}T00:00:00.000Z`)
    .limit(1);
  return (data || []).length > 0;
}

async function summarise(studentId, justAwardedCombo = false) {
  const tKey = dayKey();
  const daySet = await loadDays(studentId);
  const comboToday = justAwardedCombo || (await comboAwardedToday(studentId, tKey));
  return {
    current: computeStreak(daySet, tKey),
    week: weekDays(daySet),
    combo_xp: COMBO_XP,
    combo_earned_today: comboToday,
    combo_awarded: justAwardedCombo, // was it granted on THIS request
  };
}

/**
 * Mark today as an active day for `studentId` and, once per day, grant the
 * flat combo bonus. Safe to call from any completion path (idempotent).
 * Returns the streak summary for the quiz-complete screen.
 */
async function recordActivity(studentId) {
  const tKey = dayKey();
  const { error } = await supabase
    .from('activity_days')
    .upsert({ student_id: studentId, day: tKey }, { onConflict: 'student_id,day' });
  if (error) console.warn('activity_days upsert failed:', error.message);

  let justAwardedCombo = false;
  if (!(await comboAwardedToday(studentId, tKey))) {
    await awardXp(studentId, COMBO_XP, 'streak_combo');
    justAwardedCombo = true;
  }
  return summarise(studentId, justAwardedCombo);
}

// Read-only summary (no writes) — for endpoints that only display the streak.
async function getStreakSummary(studentId) {
  return summarise(studentId);
}

module.exports = { recordActivity, getStreakSummary, COMBO_XP };
