const supabase = require('../config/supabase');
const { cambodiaNow, QUIET_FROM_MIN, markNudgeOutcomes } = require('./nudges');
const { runAssignmentDueSoon, runDailyReminders, runStreakAtRisk, runDailyChampion } = require('./dailyDigest');

// Runs the automatic nudge jobs on their daily schedule (Asia/Phnom_Penh time).
// Same in-process setInterval approach as classScheduler.js — this project has
// no external cron runner.
//
//   every hour  assignment_due_soon   students with work due in 12-24h
//   17:00       comeback / daily_reminder   (one or the other per student)
//   20:00       daily_champion
//   20:30       streak_at_risk
//   every tick  mark whether recent nudges worked (success flag)
//
// A job whose window has passed (server was down) is skipped, not run late:
// quiet hours begin at 21:30 and a stale "17:00" reminder at 21:00 helps nobody.
const POLL_MS = 60 * 1000;
const MIN = (h, m = 0) => h * 60 + m;

const JOBS = [
  { name: 'assignment_due_soon', key: ({ dateStr, minutes }) => `${dateStr}T${String(Math.floor(minutes / 60)).padStart(2, '0')}`, due: () => true, run: runAssignmentDueSoon },
  { name: 'daily_17', key: ({ dateStr }) => dateStr, due: ({ minutes }) => minutes >= MIN(17) && minutes < MIN(19), run: runDailyReminders },
  { name: 'daily_champion', key: ({ dateStr }) => dateStr, due: ({ minutes }) => minutes >= MIN(20) && minutes < QUIET_FROM_MIN, run: runDailyChampion },
  { name: 'streak_at_risk', key: ({ dateStr }) => dateStr, due: ({ minutes }) => minutes >= MIN(20, 30) && minutes < QUIET_FROM_MIN, run: runStreakAtRisk },
];

// If notification_job_log isn't there yet (sql/055 not run), claims fall back
// to memory: still once per run while the process stays up.
const memoryClaims = new Set();
const OUTCOME_EVERY_MS = 10 * 60 * 1000;
let lastOutcomeRun = 0;

/** "Insert wins": true only for the tick that gets to run this job for this key. */
async function claimJob(job, runKey) {
  const { error } = await supabase.from('notification_job_log').insert({ job, run_key: runKey });
  if (!error) return true;
  if (error.code === '23505') return false;                 // already ran
  const tableMissing = error.code === '42P01' || error.code === 'PGRST205' || /notification_job_log/.test(error.message || '');
  if (tableMissing) {
    const k = `${job}:${runKey}`;
    if (memoryClaims.has(k)) return false;
    memoryClaims.add(k);
    return true;
  }
  console.warn('claimJob failed:', error.message);
  return false;
}

async function tick(now = new Date()) {
  const cn = cambodiaNow(now);
  for (const job of JOBS) {
    if (!job.due(cn)) continue;
    if (!(await claimJob(job.name, job.key(cn)))) continue;
    try {
      const result = await job.run(now);
      console.log(`notification job ${job.name}:`, JSON.stringify(result));
    } catch (e) {
      console.warn(`notification job ${job.name} failed:`, e.message);
    }
  }
  // Judging whether a nudge worked only needs to happen now and then.
  if (now.getTime() - lastOutcomeRun >= OUTCOME_EVERY_MS) {
    lastOutcomeRun = now.getTime();
    await markNudgeOutcomes(now).catch(e => console.warn('markNudgeOutcomes failed:', e.message));
  }
}

let started = false;
function startDailyDigestScheduler() {
  if (started) return;
  started = true;
  setInterval(() => tick().catch(e => console.warn('nudge scheduler tick failed:', e.message)), POLL_MS).unref();
}

module.exports = { startDailyDigestScheduler, tick, claimJob, JOBS };
