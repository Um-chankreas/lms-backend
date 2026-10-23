const supabase = require('../config/supabase');
const { fetchAllIn, toMs } = require('./studentProgress');
const { createNotifications, userPrefs } = require('./notifications');
const { T, PRIORITY, renderTemplate, cambodiaParts } = require('./notificationCopy');

// The nudge engine: everything that decides WHETHER a nudge may go out
// (Notification System v2, section 1) and builds + stores it when it may.
//
//  - at most DAILY_CAP nudges per student per Cambodia day
//  - none during quiet hours (21:30 to 06:30); dropped, not queued
//  - when too many qualify, higher priority wins (see PRIORITY): a slot is kept
//    free for a more important nudge that is still due later today
//  - a template variant isn't repeated within ROTATION_DAYS
//  - students who ignored their last 5 nudges get one nudge every 2 days
//  - nobody gets nudged after 14 days of silence (except the last comeback)
//
// "Activity" = the student finished a lesson, unit, quiz or daily challenge, or
// earned XP. A student opening the bell also counts as having opened the app.

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const DAILY_CAP = 2;
const QUIET_FROM_MIN = 21 * 60 + 30;   // 21:30
const QUIET_TO_MIN = 6 * 60 + 30;      // 06:30
const ROTATION_DAYS = 5;
const BACKOFF_NUDGES = 5;
const BACKOFF_GAP_MS = 2 * DAY_MS;
const SILENT_DAYS = 14;
const STREAK_RISK_MIN = 20 * 60 + 30;  // streak_at_risk runs at 20:30

// ── Cambodia time ────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');

/** { dateStr: 'YYYY-MM-DD', minutes: since midnight, startMs: that day's 00:00 } in Cambodia time. */
function cambodiaNow(now = new Date()) {
  const p = cambodiaParts(now);
  const dateStr = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return { dateStr, minutes: p.hour * 60 + p.minute, startMs: Date.parse(`${dateStr}T00:00:00+07:00`) };
}
const cambodiaDateOf = (ms) => cambodiaNow(new Date(ms)).dateStr;
const isQuietHours = (now = new Date()) => {
  const { minutes } = cambodiaNow(now);
  return minutes >= QUIET_FROM_MIN || minutes < QUIET_TO_MIN;
};
const daysBetween = (fromDate, toDate) => Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS);
// Streaks and daily challenges are keyed by UTC date (see utils/dailyChallenge.js).
const utcDay = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

// ── Bulk data loaders (one pass for a whole job) ─────────────────────────
const ACTIVITY_SOURCES = [
  { table: 'lesson_completions', col: 'completed_at', finish: true },
  { table: 'unit_completions', col: 'completed_at', finish: true },
  { table: 'quiz_submissions', col: 'submitted_at', finish: true },
  { table: 'daily_challenge_attempts', col: 'created_at', finish: true },
  { table: 'xp_events', col: 'created_at', finish: false },
];

/**
 * When each student was active since `sinceMs`: Map(studentId -> ascending ms[]).
 * `finishOnly` leaves out plain XP events (used to judge whether a nudge worked).
 */
async function loadActivity(studentIds, sinceMs, { finishOnly = false } = {}) {
  const out = new Map();
  const since = new Date(sinceMs).toISOString();
  for (const src of ACTIVITY_SOURCES) {
    if (finishOnly && !src.finish) continue;
    const rows = await fetchAllIn(studentIds, chunk => supabase
      .from(src.table)
      .select(`id, student_id, ${src.col}`)
      .in('student_id', chunk)
      .gte(src.col, since)
      .order('id', { ascending: true }));
    rows.forEach(r => {
      const ms = toMs(r[src.col]);
      if (ms == null) return;
      if (!out.has(r.student_id)) out.set(r.student_id, []);
      out.get(r.student_id).push(ms);
    });
  }
  out.forEach(list => list.sort((a, b) => a - b));
  return out;
}

/** Daily Challenge streak per student: { streak, alive, doneToday }. alive = still running (completed today or yesterday). */
async function loadStreaks(studentIds, now = new Date()) {
  const today = utcDay(now);
  const yesterday = utcDay(new Date(now.getTime() - DAY_MS));
  const rows = await fetchAllIn(studentIds, chunk => supabase
    .from('daily_challenge_streaks')
    .select('student_id, current_streak, last_completed_date')
    .in('student_id', chunk)
    .order('student_id', { ascending: true }));
  const out = new Map();
  rows.forEach(r => {
    const last = r.last_completed_date ? String(r.last_completed_date).slice(0, 10) : null;
    const alive = last === today || last === yesterday;
    out.set(r.student_id, { streak: alive ? (r.current_streak || 0) : 0, alive, doneToday: last === today });
  });
  return out;
}

/** Everything we sent each student as a nudge in the last 30 days, newest first. */
async function loadNudgeHistory(studentIds, now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const rows = await fetchAllIn(studentIds, chunk => supabase
    .from('notifications')
    .select('id, user_id, template_key, variant_id, created_at, opened_at, push_sent, data')
    .in('user_id', chunk)
    .eq('kind', 'nudge')
    .gte('created_at', since)
    .order('id', { ascending: true }));
  const out = new Map();
  rows.forEach(r => {
    if (!out.has(r.user_id)) out.set(r.user_id, []);
    out.get(r.user_id).push(r);
  });
  out.forEach(list => list.sort((a, b) => toMs(b.created_at) - toMs(a.created_at)));
  return out;
}

/**
 * Assignments a student will be nudged about later today (due 12-24h from a
 * later run, before quiet hours) and hasn't been yet. Used to keep a daily-cap
 * slot free for that higher-priority nudge. Map(studentId -> true).
 */
async function loadDueSoonLater(studentIds, now, history) {
  const cn = cambodiaNow(now);
  const lastRunToday = new Date(cn.startMs + (QUIET_FROM_MIN - 1) * 60000);
  if (lastRunToday <= now) return new Set();
  const from = new Date(now.getTime() + 12 * HOUR_MS).toISOString();
  const to = new Date(lastRunToday.getTime() + 24 * HOUR_MS).toISOString();
  const { data: assignments } = await supabase
    .from('assignments')
    .select('id, course_id')
    .eq('status', 'published')
    .gt('due_date', from)
    .lte('due_date', to);
  if (!assignments || assignments.length === 0) return new Set();

  const courseIds = [...new Set(assignments.map(a => a.course_id))];
  const [enrollments, submissions] = await Promise.all([
    fetchAllIn(courseIds, chunk => supabase.from('course_enrollments').select('id, student_id, course_id').in('course_id', chunk).order('id', { ascending: true })),
    fetchAllIn(assignments.map(a => a.id), chunk => supabase.from('assignment_submissions').select('id, student_id, assignment_id').in('assignment_id', chunk).order('id', { ascending: true })),
  ]);
  const submitted = new Set(submissions.map(s => `${s.student_id}:${s.assignment_id}`));
  const wanted = new Set(studentIds);
  const out = new Set();
  assignments.forEach(a => {
    enrollments.filter(e => e.course_id === a.course_id && wanted.has(e.student_id)).forEach(e => {
      if (submitted.has(`${e.student_id}:${a.id}`)) return;
      const already = (history.get(e.student_id) || []).some(h => h.template_key === 'assignment_due_soon' && h.data?.assignment_id === a.id);
      if (!already) out.add(e.student_id);
    });
  });
  return out;
}

/**
 * Loads what the rules need for these students. `priority` is the priority of
 * the nudge about to be sent, so reservations for MORE important nudges only
 * get computed when they matter.
 */
async function buildContext(studentIds, { now = new Date(), priority = 99 } = {}) {
  const ids = [...new Set(studentIds)].filter(Boolean);
  const since = now.getTime() - 35 * DAY_MS;
  const [activity, history, streaks] = await Promise.all([
    loadActivity(ids, since),
    loadNudgeHistory(ids, now),
    loadStreaks(ids, now),
  ]);
  const cn = cambodiaNow(now);
  const dueLater = priority > PRIORITY.assignment_due_soon && cn.minutes < QUIET_FROM_MIN
    ? await loadDueSoonLater(ids, now, history)
    : new Set();
  return { now, nowMs: now.getTime(), cn, activity, history, streaks, dueLater, priority };
}

// ── The rules ────────────────────────────────────────────────────────────
const lastActivityMs = (ctx, id) => { const a = ctx.activity.get(id); return a && a.length ? a[a.length - 1] : null; };
const activeToday = (ctx, id) => (ctx.activity.get(id) || []).some(t => t >= ctx.cn.startMs);

/** Whole Cambodia days since the student last did anything (null = never). */
function daysSinceActive(ctx, id) {
  const last = lastActivityMs(ctx, id);
  return last == null ? null : daysBetween(cambodiaDateOf(last), ctx.cn.dateStr);
}

const pushNudgesToday = (ctx, id) => (ctx.history.get(id) || []).filter(h => h.push_sent !== false && toMs(h.created_at) >= ctx.cn.startMs).length;

/** True when the student ignored each of their last 5 nudges and hasn't studied since. */
function isBackedOff(ctx, id) {
  const sent = (ctx.history.get(id) || []).filter(h => h.push_sent !== false);
  if (sent.length < BACKOFF_NUDGES) return false;
  const last5 = sent.slice(0, BACKOFF_NUDGES);
  const acts = ctx.activity.get(id) || [];
  const newest = toMs(last5[0].created_at);
  if (acts.some(t => t > newest)) return false;   // studied since the last nudge: back to normal
  return last5.every(n => {
    const at = toMs(n.created_at);
    if (at + DAY_MS > ctx.nowMs) return false;    // under 24h old: no verdict yet
    const opened = toMs(n.opened_at);
    if (opened != null && opened <= at + DAY_MS) return false;
    return !acts.some(t => t > at && t <= at + DAY_MS);
  });
}

/** Slots kept free for nudges that outrank `priority` and are still due today. */
function reservedSlots(ctx, id, priority) {
  let n = 0;
  const sentToday = (ctx.history.get(id) || []).filter(h => toMs(h.created_at) >= ctx.cn.startMs).map(h => h.template_key);
  if (priority > PRIORITY.streak_at_risk && ctx.cn.minutes < STREAK_RISK_MIN) {
    const st = ctx.streaks.get(id);
    if (st && st.alive && st.streak >= 3 && !st.doneToday && !sentToday.includes('streak_at_risk')) n += 1;
  }
  if (priority > PRIORITY.assignment_due_soon && ctx.dueLater.has(id)) n += 1;
  return n;
}

/**
 * May this student receive a nudge of this template right now?
 * Returns null when yes, otherwise the reason ('quiet' | 'silent' | 'cap' | 'backoff').
 */
function blockedReason(ctx, id, templateKey) {
  if (isQuietHours(ctx.now)) return 'quiet';
  const since = daysSinceActive(ctx, id);
  if (since != null && since > SILENT_DAYS) return 'silent';
  if (since === SILENT_DAYS && templateKey !== 'comeback') return 'silent';

  const priority = PRIORITY[templateKey] ?? 99;
  const reserved = reservedSlots(ctx, id, priority);
  if (isBackedOff(ctx, id)) {
    const newest = (ctx.history.get(id) || []).find(h => h.push_sent !== false);
    if (newest && ctx.nowMs - toMs(newest.created_at) < BACKOFF_GAP_MS) return 'backoff';
    if (reserved > 0) return 'backoff';   // only the highest-priority nudge goes out
    return null;
  }
  if (pushNudgesToday(ctx, id) + reserved >= DAILY_CAP) return 'cap';
  return null;
}

/** Variant ids of `templateKey` this student received in the last 5 days. */
function recentVariantIds(ctx, id, templateKey) {
  const cutoff = ctx.nowMs - ROTATION_DAYS * DAY_MS;
  return (ctx.history.get(id) || [])
    .filter(h => h.template_key === templateKey && h.variant_id && toMs(h.created_at) >= cutoff)
    .map(h => h.variant_id);
}

/**
 * Apply the rules to a batch and store + push what passes.
 * items: [{ userId, vars: object | (lang) => object, groups?, data?, type? }]
 * Returns { sent, skipped: { quiet, silent, cap, backoff, inactive, nocopy } }.
 */
async function sendNudges(templateKey, items, { now = new Date(), random = Math.random } = {}) {
  const tpl = T[templateKey];
  const result = { sent: 0, skipped: { quiet: 0, silent: 0, cap: 0, backoff: 0, inactive: 0, nocopy: 0 } };
  if (!tpl || !items || items.length === 0) return result;
  if (isQuietHours(now) && tpl.push !== false) { result.skipped.quiet = items.length; return result; }

  const ids = items.map(i => i.userId);
  const bellOnly = tpl.push === false;
  const prefs = await userPrefs(ids);
  const ctx = bellOnly ? null : await buildContext(ids, { now, priority: PRIORITY[templateKey] ?? 99 });
  const rows = [];

  for (const item of items) {
    const pref = prefs.get(item.userId);
    if (!pref || !pref.isActive) { result.skipped.inactive += 1; continue; }
    if (!bellOnly) {
      const why = blockedReason(ctx, item.userId, templateKey);
      if (why) { result.skipped[why] += 1; continue; }
    }
    const vars = typeof item.vars === 'function' ? item.vars(pref.language, pref) : item.vars;
    const groups = typeof item.groups === 'function' ? item.groups(pref) : item.groups;
    const msg = renderTemplate(templateKey, pref.language, vars, {
      groups: groups || null,
      recentIds: ctx ? recentVariantIds(ctx, item.userId, templateKey) : [],
      random,
    });
    if (!msg) { result.skipped.nocopy += 1; continue; }
    rows.push({
      user_id: item.userId,
      type: item.type || templateKey,
      title: msg.title,
      body: msg.body,
      data: { ...(item.data || {}), ...(msg.cta ? { cta: msg.cta } : {}) },
      template_key: templateKey,
      variant_id: msg.id,
      kind: tpl.kind,
      push: !bellOnly,
    });
    // Count it right away so one batch can't push a student over the cap.
    if (ctx) {
      if (!ctx.history.has(item.userId)) ctx.history.set(item.userId, []);
      ctx.history.get(item.userId).unshift({ template_key: templateKey, variant_id: msg.id, created_at: now.toISOString(), push_sent: true, data: item.data || {} });
    }
  }
  result.sent = await createNotifications(rows);
  return result;
}

/**
 * Did the nudge work? Marks `success` on nudges older than 2 hours: true when
 * the student finished a lesson, unit, quiz or practice set within 2 hours of
 * it, false otherwise. Run regularly; cheap when there is nothing pending.
 */
async function markNudgeOutcomes(now = new Date()) {
  const olderThan = new Date(now.getTime() - 2 * HOUR_MS).toISOString();
  const newerThan = new Date(now.getTime() - 3 * DAY_MS).toISOString();
  const { data: pending, error } = await supabase
    .from('notifications')
    .select('id, user_id, created_at')
    .eq('kind', 'nudge')
    .eq('push_sent', true)
    .is('success', null)
    .lte('created_at', olderThan)
    .gte('created_at', newerThan)
    .limit(1000);
  if (error || !pending || pending.length === 0) return 0;

  const earliest = Math.min(...pending.map(n => toMs(n.created_at)));
  const finishes = await loadActivity(pending.map(n => n.user_id), earliest, { finishOnly: true });
  const won = [];
  const lost = [];
  pending.forEach(n => {
    const at = toMs(n.created_at);
    const ok = (finishes.get(n.user_id) || []).some(t => t > at && t <= at + 2 * HOUR_MS);
    (ok ? won : lost).push(n.id);
  });
  if (won.length) await supabase.from('notifications').update({ success: true }).in('id', won);
  if (lost.length) await supabase.from('notifications').update({ success: false }).in('id', lost);
  return pending.length;
}

module.exports = {
  DAILY_CAP, QUIET_FROM_MIN, QUIET_TO_MIN,
  cambodiaNow, cambodiaDateOf, isQuietHours, daysBetween, utcDay,
  loadActivity, loadStreaks, buildContext,
  activeToday, daysSinceActive, isBackedOff, reservedSlots, blockedReason,
  sendNudges, markNudgeOutcomes,
};
