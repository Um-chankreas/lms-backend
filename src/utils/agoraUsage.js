const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');

// Agora free plan: 10,000 minutes / month. Override per plan in .env.
const FREE_MINUTES = parseInt(process.env.AGORA_FREE_MINUTES, 10) || 10000;
// Agora weights video minutes by resolution (HD counts as more than one
// billable minute). 1 = count wall-clock minutes; raise it if your classes
// run HD video and you want the estimate to track the console.
const MINUTES_MULTIPLIER = parseFloat(process.env.AGORA_MINUTES_MULTIPLIER) || 1;
// A stay with no leave/end event (crash, killed app) is cut off after this.
const MAX_SESSION_MS = (parseFloat(process.env.AGORA_SESSION_MAX_HOURS) || 6) * 3600 * 1000;

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

// Metering must never break joining a class, so every write swallows errors.

/** Start a metered stay unless this user already has an open one (token renewals re-hit /token). */
async function openSession({ liveClassId, userId = null, kind, account = 'env' }) {
  try {
    let q = supabase.from('agora_usage_sessions').select('id')
      .eq('live_class_id', liveClassId).eq('kind', kind).is('ended_at', null);
    q = userId ? q.eq('user_id', userId) : q.is('user_id', null);
    const { data: open } = await q.limit(1).maybeSingle();
    if (open) return;
    await supabase.from('agora_usage_sessions').insert({
      id: uuidv4(), live_class_id: liveClassId, user_id: userId, kind, agora_account: account, started_at: new Date(),
    });
  } catch (err) {
    console.error('Agora usage openSession failed:', err.message);
  }
}

/** End a user's open stay(s) in a class (leave / disconnect). */
async function closeUserSessions(liveClassId, userId) {
  try {
    await supabase.from('agora_usage_sessions').update({ ended_at: new Date() })
      .eq('live_class_id', liveClassId).eq('user_id', userId).is('ended_at', null);
  } catch (err) {
    console.error('Agora usage closeUserSessions failed:', err.message);
  }
}

/** End everyone's open stay in a class (class ended), including the recorder. */
async function closeClassSessions(liveClassId, at = new Date()) {
  try {
    await supabase.from('agora_usage_sessions').update({ ended_at: at })
      .eq('live_class_id', liveClassId).is('ended_at', null);
  } catch (err) {
    console.error('Agora usage closeClassSessions failed:', err.message);
  }
}

/**
 * Close stays that never got a leave event: those in a completed class end
 * when the class did; any others are capped at MAX_SESSION_MS.
 */
async function sweepStaleSessions() {
  try {
    const { data: open } = await supabase.from('agora_usage_sessions')
      .select('id, live_class_id, started_at').is('ended_at', null);
    if (!open?.length) return;

    const ids = [...new Set(open.map((s) => s.live_class_id))];
    const { data: classes } = await supabase.from('live_classes')
      .select('id, status, ended_at').in('id', ids);
    const byId = new Map((classes || []).map((c) => [c.id, c]));

    const now = Date.now();
    for (const s of open) {
      const cls = byId.get(s.live_class_id);
      const started = new Date(s.started_at).getTime();
      let end = null;
      if (!cls || cls.status === 'completed') {
        end = cls?.ended_at ? new Date(cls.ended_at.endsWith?.('Z') ? cls.ended_at : `${cls.ended_at}Z`).getTime() : now;
      } else if (now - started > MAX_SESSION_MS) {
        end = started + MAX_SESSION_MS;
      }
      if (end != null) {
        await supabase.from('agora_usage_sessions')
          .update({ ended_at: new Date(Math.max(end, started)) }).eq('id', s.id);
      }
    }
  } catch (err) {
    console.error('Agora usage sweep failed:', err.message);
  }
}

function startUsageSweeper() {
  sweepStaleSessions();
  setInterval(sweepStaleSessions, 5 * MIN_MS).unref();
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Minutes used in [fromMs, toMs): each stay is cut at midnight (UTC) and every
 * day's slice rounded up to a whole minute, like per-minute billing. Open
 * stays count up to now.
 */
async function getUsage(fromMs, toMs, account = null) {
  const now = Date.now();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('agora_usage_sessions')
      .select('live_class_id, user_id, kind, started_at, ended_at')
      .lt('started_at', new Date(toMs).toISOString())
      .or(`ended_at.is.null,ended_at.gte.${new Date(fromMs).toISOString()}`);
    if (account) q = q.eq('agora_account', account);
    const { data, error } = await q.order('started_at').range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const daily = new Map();
  const byClass = new Map();
  const byKind = {};
  let total = 0;
  let activeNow = 0;

  for (const s of rows) {
    const start = new Date(s.started_at).getTime();
    const open = !s.ended_at;
    const end = open ? now : new Date(s.ended_at).getTime();
    if (open) activeNow += 1;
    const cls = byClass.get(s.live_class_id) || { live_class_id: s.live_class_id, minutes: 0, users: new Set() };
    byClass.set(s.live_class_id, cls);
    if (s.user_id) cls.users.add(s.user_id);

    let cursor = Math.max(start, fromMs);
    const stop = Math.min(end, toMs);
    while (cursor < stop) {
      const dayEnd = (Math.floor(cursor / DAY_MS) + 1) * DAY_MS;
      const sliceEnd = Math.min(stop, dayEnd);
      const minutes = Math.ceil((sliceEnd - cursor) / MIN_MS) * MINUTES_MULTIPLIER;
      daily.set(ymd(cursor), (daily.get(ymd(cursor)) || 0) + minutes);
      cls.minutes += minutes;
      byKind[s.kind] = (byKind[s.kind] || 0) + minutes;
      total += minutes;
      cursor = sliceEnd;
    }
  }

  return { rows, daily, byClass, byKind, total, activeNow };
}

// Manual "sync with the Agora console" adjustment for an account's month (0 if none).
async function getAdjustment(account, month) {
  try {
    const { data } = await supabase.from('agora_usage_adjustments')
      .select('minutes').eq('agora_account', account).eq('month', month).maybeSingle();
    return data?.minutes || 0;
  } catch (err) {
    console.error('Agora usage adjustment read failed:', err.message);
    return 0;
  }
}

module.exports = {
  getAdjustment,
  FREE_MINUTES, MINUTES_MULTIPLIER, DAY_MS,
  openSession, closeUserSessions, closeClassSessions, startUsageSweeper, getUsage, ymd,
};
