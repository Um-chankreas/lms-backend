const supabase = require('../config/supabase');
const { createNotifications } = require('./notifications');

// UTC YYYY-MM-DD — matches activity_days.day and how streak.js/xp_events
// already key "today" (see utils/streak.js dayKey()), so this stays
// consistent with the data it's reading rather than inventing a second
// definition of "today".
function dayKey(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Atomically claims today's digest run — the same "insert wins" pattern as
 * class_schedule_notifications (sql/039): whichever scheduler tick is first
 * to reach 19:00+ local today inserts the row and proceeds; every other
 * tick (today, or a server restart later today) gets the unique-violation
 * and does nothing.
 */
async function claimDigestDay(dateStr) {
  const { error } = await supabase
    .from('daily_digest_log')
    .insert({ day: dateStr });
  if (!error) return true;
  if (error.code === '23505') return false; // already sent today
  console.warn('claimDigestDay failed:', error.message);
  return false;
}

/** { studentId, count } for whoever completed the most lessons+quizzes
 * today, or null if nobody did anything. "Most active" = total completions,
 * not XP — a student grinding several short quizzes counts more than one
 * big lesson, on purpose. */
async function computeMostActiveToday(dateStr) {
  const startOfDay = `${dateStr}T00:00:00.000Z`;
  const [{ data: lessons }, { data: quizzes }] = await Promise.all([
    supabase.from('lesson_completions').select('student_id').gte('completed_at', startOfDay),
    supabase.from('quiz_submissions').select('student_id').gte('submitted_at', startOfDay),
  ]);

  const counts = new Map();
  const bump = (id) => { if (id) counts.set(id, (counts.get(id) || 0) + 1); };
  (lessons || []).forEach(r => bump(r.student_id));
  (quizzes || []).forEach(r => bump(r.student_id));
  if (counts.size === 0) return null;

  let topId = null;
  let topCount = 0;
  for (const [id, count] of counts) {
    if (count > topCount) { topId = id; topCount = count; }
  }
  return { studentId: topId, count: topCount };
}

/** Everyone gets a shout-out naming today's most active student — a public
 * daily moment, not a targeted "you're #1" DM. No-op if nobody did anything
 * today (nothing to celebrate). */
async function sendDailyChampionShoutout(dateStr) {
  const top = await computeMostActiveToday(dateStr);
  if (!top) return null;

  const { data: champion } = await supabase
    .from('users').select('id, name').eq('id', top.studentId).maybeSingle();
  if (!champion) return null;

  const { data: students } = await supabase
    .from('users').select('id').eq('role', 'student').eq('is_active', true);
  const recipients = (students || []).map(s => s.id);
  if (recipients.length === 0) return { champion, count: top.count };

  const activityWord = top.count === 1 ? 'lesson or quiz' : 'lessons and quizzes';
  await createNotifications(recipients.map(uid => ({
    user_id: uid,
    type: 'daily_champion',
    title: `🏆 Today's most active: ${champion.name}`,
    body: `${champion.name} finished ${top.count} ${activityWord} today. Can you top that tomorrow?`,
    data: { student_id: champion.id, count: top.count, day: dateStr }
  })));

  return { champion, count: top.count };
}

/** A "come learn" nudge to every active student account that did nothing
 * today (no activity_days row for today) — sent to everyone who qualifies,
 * every day, by design. */
async function sendInactivityReminders(dateStr) {
  const [{ data: students }, { data: activeToday }] = await Promise.all([
    supabase.from('users').select('id').eq('role', 'student').eq('is_active', true),
    supabase.from('activity_days').select('student_id').eq('day', dateStr),
  ]);

  const activeIds = new Set((activeToday || []).map(r => r.student_id));
  const inactiveIds = (students || []).map(s => s.id).filter(id => !activeIds.has(id));
  if (inactiveIds.length === 0) return 0;

  await createNotifications(inactiveIds.map(uid => ({
    user_id: uid,
    type: 'daily_reminder',
    title: '📚 Come learn something today!',
    body: "You haven't studied yet today — even 10 minutes keeps your streak alive.",
    data: { day: dateStr }
  })));
  return inactiveIds.length;
}

/** Runs both parts of the digest for `dateStr`, after the caller has already
 * won the claim for today (see claimDigestDay). Best-effort: a failure in
 * one half must not block the other. */
async function runDailyDigest(dateStr) {
  try {
    const champion = await sendDailyChampionShoutout(dateStr);
    if (champion) {
      await supabase
        .from('daily_digest_log')
        .update({ champion_student_id: champion.champion.id, champion_count: champion.count })
        .eq('day', dateStr);
    }
  } catch (e) {
    console.warn('sendDailyChampionShoutout failed:', e.message);
  }

  try {
    await sendInactivityReminders(dateStr);
  } catch (e) {
    console.warn('sendInactivityReminders failed:', e.message);
  }
}

module.exports = { dayKey, claimDigestDay, runDailyDigest };
