const supabase = require('../config/supabase');
const tg = require('./telegram');
const { liveClassRecipients } = require('./notifyEvents');

// One-off live classes (live_classes.scheduled_at) get a Telegram reminder
// ~15 minutes ahead. Recurring class_schedules slots are handled by
// classScheduler.js through notifyClassScheduleReminder. Same in-process
// setInterval approach as the other schedulers: the API runs as one
// always-on pm2 process, so there is no separate cron to maintain.
const POLL_MS = 60 * 1000;
const LEAD_MIN_MINUTES = 14;
const LEAD_MAX_MINUTES = 16;

async function sendDueReminders() {
  if (!tg.enabled()) return;
  const now = Date.now();
  const { data: classes, error } = await supabase
    .from('live_classes')
    .select('id, title, course_id, scheduled_at, courses(title, live_enabled)')
    .eq('status', 'scheduled')
    .gte('scheduled_at', new Date(now + LEAD_MIN_MINUTES * 60000).toISOString())
    .lte('scheduled_at', new Date(now + LEAD_MAX_MINUTES * 60000).toISOString());
  if (error || !classes || classes.length === 0) return;

  for (const lc of classes) {
    if (lc.courses?.live_enabled === false) continue;
    const studentIds = await liveClassRecipients(lc.course_id);
    const reachable = await tg.reachableStudents(studentIds);
    if (reachable.length === 0) continue;

    const { data: already } = await supabase
      .from('telegram_reminder_log').select('user_id').eq('live_class_id', lc.id);
    const sent = new Set((already || []).map(r => r.user_id));
    const todo = reachable.filter(r => !sent.has(r.user_id));
    if (todo.length === 0) continue;

    // Claim first: a second tick (or second server) then skips these students.
    const { error: claimError } = await supabase.from('telegram_reminder_log')
      .upsert(todo.map(r => ({ live_class_id: lc.id, user_id: r.user_id })), { onConflict: 'live_class_id,user_id', ignoreDuplicates: true });
    if (claimError) { console.warn('[telegram] reminder claim failed:', claimError.message); continue; }

    const text =
      `<b>⏰ ថ្នាក់រៀនផ្ទាល់ចាប់ផ្តើមក្នុង ១៥ នាទី</b>\n` +
      `<b>${tg.escapeHtml(lc.title)}</b>\n` +
      (lc.courses?.title ? `${tg.escapeHtml(lc.courses.title)}\n` : '') +
      `🕒 ${tg.phnomPenhTime(new Date(lc.scheduled_at))}\n\n` +
      `Live class starts in 15 minutes.`;
    await tg.sendToStudents(todo, () => ({ text, button: { text: tg.JOIN_LABEL, url: tg.joinUrl(lc.id) } }));
  }
}

function startTelegramReminderScheduler() {
  if (!tg.enabled()) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — reminders disabled');
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await sendDueReminders(); } catch (e) { console.warn('[telegram] reminder tick failed:', e.message); }
    running = false;
  };
  setInterval(tick, POLL_MS);
  console.log('[telegram] reminder scheduler started');
}

module.exports = { startTelegramReminderScheduler };
