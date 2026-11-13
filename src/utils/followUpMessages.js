// Telegram follow-up messages: rendering a template, the sending rules, and the callback_data format.
// Everything here is pure (no database, no clock unless passed in) so it can be unit tested.

const PP_MS = 7 * 3600000;                       // Cambodia is UTC+7, no daylight saving
const DAY = 86400000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER = /\{(\w+)\}/g;
const REASONS = ['time_clash', 'not_interested', 'no_internet_device', 'too_hard', 'family_work', 'sick', 'other'];

const RULES = {
  send_window_weekday: ['17:00', '20:00'],
  send_window_weekend: ['08:00', '20:00'],
  timezone: 'Asia/Phnom_Penh',
  max_per_student_per_day: 1,
  same_case_cooldown_days: 3,
  stop_after_unanswered: 2,
  praise_max_per_week: 1,
  max_words: 60,
};

const isBlank = (v) => v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isNaN(v));
const pick = (v, lang) => (v && typeof v === 'object' && !Array.isArray(v) ? (v[lang] ?? v.km ?? v.en) : v);

// ── Khmer / English date text ───────────────────────────────────────────────
const KM_DAYS = ['ថ្ងៃអាទិត្យ', 'ថ្ងៃច័ន្ទ', 'ថ្ងៃអង្គារ', 'ថ្ងៃពុធ', 'ថ្ងៃព្រហស្បតិ៍', 'ថ្ងៃសុក្រ', 'ថ្ងៃសៅរ៍'];
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toKmDigits = (s) => String(s).replace(/\d/g, d => '០១២៣៤៥៦៧៨៩'[d]);

/** "ថ្ងៃពុធ ម៉ោង ៦ល្ងាច" / "Wed 6pm" for an instant, in Cambodia time. */
function formatClassTime(ms, lang) {
  const local = new Date(ms + PP_MS);
  const day = local.getUTCDay();
  const h24 = local.getUTCHours();
  const min = local.getUTCMinutes();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  if (lang === 'en') return `${EN_DAYS[day]} ${h12}${min ? ':' + String(min).padStart(2, '0') : ''}${h24 < 12 ? 'am' : 'pm'}`;
  const period = h24 < 5 ? 'យប់' : h24 < 12 ? 'ព្រឹក' : h24 < 17 ? 'រសៀល' : h24 < 20 ? 'ល្ងាច' : 'យប់';
  return `${KM_DAYS[day]} ម៉ោង ${toKmDigits(h12)}${min ? ':' + toKmDigits(String(min).padStart(2, '0')) : ''}${period}`;
}

// ── Rendering ───────────────────────────────────────────────────────────────
/**
 * template: { key, body: {km,en}, buttons: [{label:{km,en}, target?, callback?}], asks_reason, copy_only,
 *             variant_if_attended_zero?: { line, km, en }, steps?: { <step_key>: {km,en,target} } }
 * vars: { name, teacher, subject, attended, held, ... } (a value may be a {km,en} object)
 * -> { text, buttons: [{ label, url?|callback? }], missing: [names], error: string|null, draft }
 * With a missing variable `text` is null and `error` names it; `draft` is the text with the gaps left in.
 */
function renderTemplate(template, vars = {}, lang = 'km', opts = {}) {
  const L = lang === 'en' ? 'en' : 'km';
  const v = { ...vars };
  let body = String(pick(template.body, L) || '');

  // skip_subject: when they joined nothing, line 2 says so instead of "joined 0 of 8".
  const alt = template.variant_if_attended_zero;
  if (alt && Number(v.attended) === 0 && !isBlank(v.attended)) {
    const lines = body.split('\n');
    const i = (alt.line || 2) - 1;
    if (i >= 0 && i < lines.length) lines[i] = pick(alt, L);
    body = lines.join('\n');
  }

  // step_reminder: the late step supplies {step} and the button.
  let buttons = (template.buttons || []).map(b => ({ ...b }));
  if (template.steps) {
    const s = template.steps[v.step_key];
    if (s) {
      v.step = pick(s, L);
      v.step_button = pick(s, L);
      buttons = buttons.map(b => (b.target ? { ...b, target: s.target } : b));
    }
  }

  // Values may be per-language objects.
  const val = (k) => pick(v[k], L);
  const used = new Set();
  [body, ...buttons.map(b => pick(b.label, L) || '')].forEach(str => String(str).replace(PLACEHOLDER, (_, k) => { used.add(k); return ''; }));
  const missing = [...used].filter(k => isBlank(val(k)));
  const fill = (str) => String(str).replace(PLACEHOLDER, (m, k) => (isBlank(val(k)) ? m : String(val(k))));
  const draft = fill(body);

  const base = opts.linkBase || '';
  const out = buttons.map(b => {
    const label = fill(pick(b.label, L) || '');
    if (b.callback) return { label, callback: b.callback };
    return { label, url: targetToLink(b.target, v, base) };
  });
  if (missing.length) return { text: null, buttons: out, missing, error: `Missing ${missing.map(k => `{${k}}`).join(', ')}`, draft };
  return { text: draft, buttons: out, missing: [], error: null, draft };
}

// ── Deep links ──────────────────────────────────────────────────────────────
// Telegram URL buttons only take https:// (or tg://). The app understands /open/lesson|unit|live-class/<uuid>;
// every other target opens the app itself, which lands on Home until the app has a screen for it.
const ID_KINDS = { lesson: 'lesson', unit: 'unit', live: 'live-class', 'live-class': 'live-class' };

function targetToLink(target, vars = {}, base = '') {
  const root = String(base || '').replace(/\/$/, '');
  const app = `${root}/open/app`;
  if (!target) return app;
  const resolved = String(target).replace(PLACEHOLDER, (m, k) => (isBlank(vars[k]) ? m : String(vars[k])));
  if (PLACEHOLDER.test(resolved)) { PLACEHOLDER.lastIndex = 0; return app; }
  PLACEHOLDER.lastIndex = 0;
  let [kind, id] = resolved.split(':');
  if (kind === 'lesson' && id === 'first') id = vars.first_lesson_id;
  if (kind === 'lesson' && id === 'next') id = vars.next_lesson_id;
  if (kind === 'live' && (id === 'next' || id === 'schedule')) id = vars.live_class_id;
  const route = ID_KINDS[kind];
  if (route && UUID.test(String(id || ''))) return `${root}/open/${route}/${id}`;
  return app;
}

// ── callback_data (Telegram allows 64 bytes) ────────────────────────────────
const bytes = (s) => Buffer.byteLength(String(s), 'utf8');
/** r:<reason>:<id> / call_me:<id> / help:<id>. Throws if it would not fit. */
function callbackData(kind, id, reason) {
  const data = kind === 'r' ? `r:${reason}:${id}` : `${kind}:${id}`;
  if (bytes(data) > 64) throw new Error(`callback_data too long (${bytes(data)} bytes)`);
  return data;
}
/** -> { kind: 'r'|'call_me'|'help', id, reason? } or null. */
function parseCallback(data) {
  const parts = String(data || '').split(':');
  if (parts[0] === 'r' && parts.length === 3 && REASONS.includes(parts[1]) && UUID.test(parts[2])) return { kind: 'r', reason: parts[1], id: parts[2] };
  if ((parts[0] === 'call_me' || parts[0] === 'help') && parts.length === 2 && UUID.test(parts[1])) return { kind: parts[0], id: parts[1] };
  return null;
}

/**
 * Telegram inline_keyboard for a rendered message: one row per link / callback button, then (for templates that ask
 * why) the 7 reason buttons in 2 columns.
 */
function buildKeyboard({ buttons = [], asksReason = false, reasonLabels = {}, lang = 'km', messageId }) {
  const rows = [];
  buttons.forEach(b => {
    if (b.url) rows.push([{ text: b.label, url: b.url }]);
    else if (b.callback) rows.push([{ text: b.label, callback_data: callbackData(b.callback, messageId) }]);
  });
  if (asksReason) {
    const btns = REASONS.map(r => ({ text: pick(reasonLabels[r], lang) || r, callback_data: callbackData('r', messageId, r) }));
    for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  }
  return rows;
}

// ── Sending rules ───────────────────────────────────────────────────────────
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const ppParts = (ms) => { const d = new Date(ms + PP_MS); return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), dayStart: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - PP_MS }; };
const windowFor = (day, rules) => (day === 0 || day === 6 ? rules.send_window_weekend : rules.send_window_weekday).map(toMinutes);

/** Is `ms` inside the sending window (start inclusive, end exclusive), and when does the next window open? */
function sendWindow(ms, rules = RULES) {
  const { day, minutes, dayStart } = ppParts(ms);
  const [from, to] = windowFor(day, rules);
  if (minutes >= from && minutes < to) return { open: true, at: ms };
  if (minutes < from) return { open: false, at: dayStart + from * 60000 };
  const next = ppParts(dayStart + DAY + 12 * 3600000);   // noon tomorrow, to read its weekday
  return { open: false, at: dayStart + DAY + windowFor(next.day, rules)[0] * 60000 };
}

/**
 * Warnings for sending to a student now. history: their earlier messages, newest first
 * [{ case_code, status, created_at, sent_at, replied_at }]. Warnings never block by themselves.
 * -> [{ code, params }]  codes: daily, same_case, unanswered, praise_week, outside_hours
 */
function checkRules({ now, caseCode, history = [], rules = RULES, window = true }) {
  const out = [];
  const live = history.filter(h => h.status !== 'failed' && h.status !== 'blocked');
  const at = (h) => new Date(h.sent_at || h.created_at).getTime();
  const today = ppParts(now).dayStart;
  if (live.filter(h => at(h) >= today).length >= rules.max_per_student_per_day) out.push({ code: 'daily' });
  if (caseCode && caseCode !== 'praise') {
    const recent = live.find(h => h.case_code === caseCode && now - at(h) < rules.same_case_cooldown_days * DAY);
    if (recent) out.push({ code: 'same_case', params: { days: rules.same_case_cooldown_days } });
  }
  if (caseCode === 'praise' && live.some(h => h.case_code === 'praise' && now - at(h) < 7 * DAY)) out.push({ code: 'praise_week' });
  let unanswered = 0;
  for (const h of live.filter(x => x.status === 'sent')) { if (h.replied_at) break; unanswered += 1; }
  if (unanswered >= rules.stop_after_unanswered) out.push({ code: 'unanswered', params: { n: unanswered } });
  if (window) { const w = sendWindow(now, rules); if (!w.open) out.push({ code: 'outside_hours', params: { at: new Date(w.at).toISOString() } }); }
  return out;
}

/** Word count: English by spaces, Khmer with the ICU segmenter (Khmer has no spaces). */
function wordCount(text, lang = 'en') {
  const s = String(text || '').trim();
  if (!s) return 0;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    let n = 0;
    for (const seg of new Intl.Segmenter(lang === 'km' ? 'km' : 'en', { granularity: 'word' }).segment(s)) if (seg.isWordLike) n += 1;
    return n;
  }
  return s.split(/\s+/).length;
}

module.exports = { renderTemplate, targetToLink, callbackData, parseCallback, buildKeyboard, sendWindow, checkRules, wordCount, formatClassTime, REASONS, RULES, isBlank, PLACEHOLDER };
