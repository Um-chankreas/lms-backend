const supabase = require('../config/supabase');
const { v4: uuidv4 } = require('uuid');
const { notifyClassScheduleReminder } = require('./notifyEvents');

// Polls class_schedules (see sql/039_class_schedules.sql) every POLL_MS and
// fires a "starting soon" reminder for any slot whose next occurrence falls
// inside the [REMINDER_MIN_MINUTES, REMINDER_MAX_MINUTES] lead window. This
// project has no external cron runner (no pg_cron / hosted scheduler set up)
// — everything else that needs periodic work does it with an in-process
// `setInterval` (see sweepTeacherPresence in realtime/liveClassSocket.js), so
// this follows the same pattern rather than adding new infra.
const POLL_MS = 60 * 1000; // every 1 minute — narrower than the reminder
                            // window below, so nothing gets skipped between ticks.
const REMINDER_MIN_MINUTES = 10;
const REMINDER_MAX_MINUTES = 15;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * "Now" as wall-clock date/time/weekday IN THE GIVEN TIMEZONE, using the
 * schedule's own timezone rather than the server's — a schedule set for
 * 3:00 PM Asia/Phnom_Penh must fire at 3:00 PM there, regardless of where
 * this Node process happens to be running.
 */
function localNow(timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());

  const get = (type) => parts.find(p => p.type === type)?.value;
  const weekday = DAY_NAMES.indexOf(get('weekday'));
  const hour = get('hour') === '24' ? 0 : Number(get('hour'));
  return {
    weekday,
    minutesSinceMidnight: hour * 60 + Number(get('minute')),
    dateStr: `${get('year')}-${get('month')}-${get('day')}`
  };
}

function toMinutes(hhmmss) {
  const [h, m] = hhmmss.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Atomically "claims" the reminder for one schedule occurrence: inserts into
 * class_schedule_notifications, relying on its (schedule_id, occurrence_date)
 * unique constraint to make this safe against the same schedule matching on
 * back-to-back ticks within the reminder window. Returns true only for the
 * tick that actually wins the claim — that's the one that should notify.
 */
async function claimOccurrence(scheduleId, occurrenceDate) {
  const { error } = await supabase
    .from('class_schedule_notifications')
    .insert({ id: uuidv4(), schedule_id: scheduleId, occurrence_date: occurrenceDate });

  if (!error) return true;
  if (error.code === '23505') return false; // already claimed by an earlier tick
  console.warn('claimOccurrence failed:', error.message);
  return false;
}

async function checkSchedules() {
  const { data: schedules, error } = await supabase
    .from('class_schedules')
    .select('*')
    .eq('is_active', true);

  if (error) {
    console.warn('classScheduler: failed to load schedules:', error.message);
    return;
  }

  for (const schedule of schedules || []) {
    try {
      const { weekday, minutesSinceMidnight, dateStr } = localNow(schedule.timezone || 'Asia/Phnom_Penh');
      if (!(schedule.days_of_week || []).includes(weekday)) continue;

      const minutesUntilStart = toMinutes(schedule.start_time) - minutesSinceMidnight;
      if (minutesUntilStart < REMINDER_MIN_MINUTES || minutesUntilStart > REMINDER_MAX_MINUTES) continue;

      const won = await claimOccurrence(schedule.id, dateStr);
      if (!won) continue;

      await notifyClassScheduleReminder(schedule);
    } catch (e) {
      console.warn(`classScheduler: schedule ${schedule.id} failed:`, e.message);
    }
  }
}

let started = false;
function startClassScheduler() {
  if (started) return;
  started = true;
  setInterval(() => checkSchedules().catch(e => console.warn('classScheduler tick failed:', e.message)), POLL_MS).unref();
}

module.exports = { startClassScheduler };
