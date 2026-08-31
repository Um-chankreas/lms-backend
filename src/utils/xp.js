const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');

const XP_VALUES = {
  LESSON_COMPLETE: 10,
  QUIZ_PASS: 20,
  DAILY_QUIZ_PER_CORRECT: 5
};

const XP_PER_LEVEL = 100;

// Level 1 = 0-99 XP, level 2 = 100-199, ... Also returns progress within the
// current level so the client can draw a progress ring.
function levelInfo(xp) {
  const total = Math.max(0, xp || 0);
  const level = Math.floor(total / XP_PER_LEVEL) + 1;
  const intoLevel = total % XP_PER_LEVEL;
  return {
    level,
    xp_into_level: intoLevel,
    xp_for_next_level: XP_PER_LEVEL,
    xp_to_next_level: XP_PER_LEVEL - intoLevel
  };
}

/**
 * Award XP to a student: appends a row to the xp_events ledger (used for
 * time-windowed leaderboards) and bumps the running users.xp lifetime total.
 * `reason` is a short tag: 'lesson_complete' | 'quiz_pass' | 'daily_quiz'.
 */
async function awardXp(studentId, amount, reason = 'other') {
  if (!amount) return;

  // Ledger row first — if the total update below fails we'd rather have an
  // over-count recoverable from the ledger than silently lose the event.
  const { error: ledgerError } = await supabase
    .from('xp_events')
    .insert({
      id: uuidv4(),
      student_id: studentId,
      amount,
      reason,
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

module.exports = { awardXp, XP_VALUES, levelInfo, XP_PER_LEVEL };
