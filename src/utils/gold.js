const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');

// Gold earned alongside an XP event, keyed by the XP event's reason. Reasons
// not listed here earn no gold. Gold is a second reward currency (see
// sql/057_gold.sql); earn-only for now.
const GOLD_BY_REASON = {
  quiz_pass: 5,
  lesson_complete: 5,
  path_chest: 15,
  daily_quiz: 5,
  daily_challenge: 5,
  daily_challenge_retake: 2,
  daily_challenge_streak: 20,   // 7 / 14 / 30-day Daily Challenge streak bonus
  mistake_review: 3,
  assignment_ontime: 10,
  assignment_late: 3,
  live_class: 5,
};

const GOLD_TEST_OUT = 10;       // extra, for skipping a topic by passing its quiz

/**
 * Add gold to a student: ledger row + running users.gold total. Best-effort
 * (never throws) so a missing migration or a hiccup can't break the action
 * that earned it.
 */
async function awardGold(studentId, amount, reason = 'other', courseId = null) {
  if (!studentId || !amount) return;
  try {
    const { error: ledgerError } = await supabase.from('gold_transactions').insert({
      id: uuidv4(), student_id: studentId, amount, reason, course_id: courseId || null, created_at: new Date()
    });
    if (ledgerError) { console.warn('gold_transactions insert failed:', ledgerError.message); return; }

    const { data: user } = await supabase.from('users').select('gold').eq('id', studentId).maybeSingle();
    await supabase.from('users').update({ gold: (user?.gold || 0) + amount }).eq('id', studentId);
  } catch (e) {
    console.warn('awardGold failed:', e.message);
  }
}

/** Current gold balance (0 if the column doesn't exist yet). */
async function getGold(studentId) {
  try {
    const { data } = await supabase.from('users').select('gold').eq('id', studentId).maybeSingle();
    return data?.gold || 0;
  } catch {
    return 0;
  }
}

module.exports = { awardGold, getGold, GOLD_BY_REASON, GOLD_TEST_OUT };
