const cfgDefault = require('./followUpConfig');
const { evaluateStudent, urgency, PRIORITY } = require('./followUpRules');

// Everything about one student that the Follow-up list needs, from already-loaded rows. Pure.

const DAY = 86400000;
const toMs = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return v; const ms = Date.parse(/(?:[zZ]|[+-]\d\d(?::?\d\d)?)$/.test(String(v)) || String(v).length <= 10 ? v : `${v}Z`); return Number.isNaN(ms) ? null : ms; };
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const OUTREACH = new Set(['message', 'done', 'praise']);

function engagementOf(activeDays, cfg) {
  if (!activeDays) return 'none';
  if (activeDays >= cfg.engagement.high) return 'high';
  if (activeDays >= cfg.engagement.medium) return 'medium';
  return 'low';
}

/**
 * student: { id, name, avatar_url, phone, created_at, has_telegram }
 * subjects: [{ course_id, title, m }]   onboarding: row|null   logs: newest first   activeDays: number
 */
function buildEntry({ student, subjects, onboarding, logs, activeDays }, now = Date.now(), cfg = cfgDefault) {
  const ob = onboarding || { joined_at: student.created_at };
  const ev = evaluateStudent({ joined_at: ob.joined_at || student.created_at, onboarding: ob, subjects }, now, cfg);
  const mine = logs || [];
  const outreach = mine.filter(l => OUTREACH.has(l.kind));
  const lastOut = outreach[0] || null;
  const lastReason = (mine.find(l => l.reason && l.reason !== 'checked_in') || mine.find(l => l.reason) || {}).reason || null;

  // "Followed up" lasts a week. It ends sooner when a more urgent case than the one saved shows up.
  const lastDone = mine.find(l => l.kind === 'done' || l.kind === 'reopen');
  let followed = false;
  if (!ev.is_new && lastDone && lastDone.kind === 'done' && now - toMs(lastDone.created_at) < cfg.followedUpReturnDays * DAY) {
    const saved = PRIORITY[lastDone.case_code] || 0;
    const now_ = ev.main ? PRIORITY[ev.main.code] || 0 : 0;
    followed = now_ <= saved;
  }

  // Nobody to message: no phone, no linked bot and no Telegram contact the teacher may open. They get their own block.
  const unreachable = !student.phone && !student.has_telegram && !student.can_open_telegram;
  const needs = !ev.is_new && ev.cases.length > 0 && !followed && !unreachable;
  const lastOutMs = lastOut ? toMs(lastOut.created_at) : null;
  let nextAction = 'view';
  if (ev.is_new) {
    if (ev.new_case && (lastOutMs == null || now - lastOutMs >= cfg.welcomeCheckInDays * DAY)) nextAction = 'check_in';
    else if (!lastOut) nextAction = 'send_welcome';
  } else if (needs) nextAction = 'follow_up';
  else if (ev.doing_well && (lastOutMs == null || now - lastOutMs >= cfg.praiseEveryDays * DAY)) nextAction = 'send_praise';

  const steps = ev.steps;
  const nextStep = steps ? steps.find(s => s.state !== 'done') || null : null;
  return {
    student_id: student.id,
    name: student.name || '',
    avatar_url: student.avatar_url || null,
    phone: student.phone || null,
    has_telegram: !!student.has_telegram,
    can_open_telegram: !!student.can_open_telegram,
    unreachable,
    joined_at: ob.joined_at || student.created_at || null,
    is_new: ev.is_new, day: ev.day,
    steps, steps_done: steps ? steps.filter(s => s.state === 'done').length : 0, next_step: nextStep ? nextStep.key : null,
    new_case: ev.new_case, new_reasons: ev.new_reasons,
    subjects: ev.subjects.map((s, i) => ({ ...s, m: subjects[i].m })),
    cases: ev.cases, main: ev.main, extra: ev.extra, doing_well: ev.doing_well,
    followed, needs,
    active_days: activeDays || 0, engagement: engagementOf(activeDays, cfg),
    contact: { count: outreach.length, last_at: lastOut ? iso(lastOutMs) : null, last_reason: lastReason },
    next_action: nextAction,
    urgency: ev.is_new ? (ev.new_case ? 50 : 0) : urgency(ev),
  };
}

const TABS = {
  needs: e => e.needs,
  new: e => e.is_new,
  doing_well: e => !e.is_new && e.doing_well,
  followed: e => e.followed,
  unreachable: e => e.unreachable,
  all: () => true,
};

/** Does the entry satisfy the filters? With a subject picked only that subject is checked; otherwise any subject may match. */
function matchesFilters(e, f) {
  if (f.case) {
    if (f.case === '0' ? !e.new_case : !e.cases.some(c => c.code === f.case)) return false;
  }
  if (f.q && !String(e.name).toLowerCase().includes(String(f.q).toLowerCase())) return false;
  if (f.engagement && e.engagement !== f.engagement) return false;
  const subs = f.subject ? e.subjects.filter(s => s.course_id === f.subject) : e.subjects;
  if (f.subject && !subs.length) return false;
  const any = (fn) => subs.some(fn);
  if (f.attendance && !any(s => s.attendance === f.attendance)) return false;
  if (f.after) {
    const want = f.after === 'studied' ? true : f.after === 'not_studied' ? false : null;
    if (!any(s => s.studied_after === want)) return false;
  }
  if (f.progress && !any(s => s.progress === f.progress)) return false;
  return true;
}

const SORTS = {
  urgent: (a, b) => b.urgency - a.urgency || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  recent: (a, b) => String(b.contact.last_at || '').localeCompare(String(a.contact.last_at || '')) || a.name.localeCompare(b.name),
  newest: (a, b) => String(b.joined_at || '').localeCompare(String(a.joined_at || '')),
};

/** Counts for the case cards and tabs, over the scope the filters leave (course + search), ignoring tab and case. */
function summarize(entries) {
  const tabs = {};
  Object.entries(TABS).forEach(([k, fn]) => { tabs[k] = entries.filter(fn).length; });
  const cases = { '4': 0, '1': 0, '2': 0, '3': 0 };
  entries.filter(e => e.needs).forEach(e => { new Set(e.cases.map(c => c.code)).forEach(c => { cases[c] += 1; }); });
  const nw = entries.filter(e => e.is_new);
  return {
    tabs, cases,
    new_summary: {
      not_getting_started: nw.filter(e => e.new_case).length,
      behind: nw.filter(e => !e.new_case && e.steps.some(s => s.state === 'late')).length,
      on_track: nw.filter(e => !e.new_case && !e.steps.some(s => s.state === 'late')).length,
    },
  };
}

function page(entries, { tab = 'needs', filters = {}, sort = 'urgent', pageNo = 1, size = cfgDefault.pageSize }) {
  const tabFn = TABS[tab] || TABS.needs;
  const list = entries.filter(tabFn).filter(e => matchesFilters(e, filters)).sort(SORTS[sort] || SORTS.urgent);
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, pageNo), pages);
  return { rows: list.slice((p - 1) * size, p * size), total, page: p, pages, size };
}

module.exports = { buildEntry, matchesFilters, summarize, page, engagementOf, TABS, SORTS };
