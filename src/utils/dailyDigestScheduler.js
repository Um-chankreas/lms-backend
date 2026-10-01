const { dayKey, claimDigestDay, runDailyDigest } = require('./dailyDigest');

// Fires the daily "today's most active" shout-out + "come learn" reminders
// once per day, the first tick after DIGEST_HOUR local time. Same
// in-process setInterval approach as classScheduler.js — this project has
// no external cron runner set up.
const POLL_MS = 5 * 60 * 1000; // every 5 minutes
const DIGEST_HOUR = 19; // 7 PM Asia/Phnom_Penh — after the school day, before bedtime
const TIMEZONE = 'Asia/Phnom_Penh';

/** The current hour (0-23), wall-clock, in the given timezone. */
function localHour(timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const hour = parts.find(p => p.type === 'hour')?.value;
  return hour === '24' ? 0 : Number(hour);
}

async function checkDigest() {
  if (localHour(TIMEZONE) < DIGEST_HOUR) return;

  // dayKey() (UTC date) matches how activity_days/xp_events already key
  // "today" — see dailyDigest.js's own comment on why this isn't the
  // Asia/Phnom_Penh calendar date. At DIGEST_HOUR (well into the Cambodia
  // afternoon/evening) the two agree anyway, so this is just consistency,
  // not a correctness fix.
  const dateStr = dayKey();
  const won = await claimDigestDay(dateStr);
  if (!won) return; // already ran today

  await runDailyDigest(dateStr);
}

let started = false;
function startDailyDigestScheduler() {
  if (started) return;
  started = true;
  setInterval(() => checkDigest().catch(e => console.warn('dailyDigestScheduler tick failed:', e.message)), POLL_MS).unref();
}

module.exports = { startDailyDigestScheduler };
