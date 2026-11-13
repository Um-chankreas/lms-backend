/**
 * Matching a teacher's Telegram sheet to students (Students → Import Telegram).
 *
 * A sheet row is { name, full_name, handle, link }. Pure functions only (no DB), so they are
 * easy to test; the routes load the students and call buildPreview().
 *
 *   exact       one student whose name equals the row's Khmer full name or display name
 *   suggested   no exact name, but a student shares name words — the teacher confirms
 *   ambiguous   several students share the exact name — the teacher picks
 *   unmatched   a usable username but nobody to give it to
 *   unusable    the cell isn't a Telegram username ("Don't have username", spaces, Khmer text…)
 *   empty       nothing in the cell
 */

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const LINK_RE = /(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})/i;

const strip = (s) => String(s ?? '').normalize('NFC').replace(/[​-‍﻿]/g, '').trim();
// Name key: no zero-width marks, no (bracketed text), no punctuation/spaces, lower-case.
const key = (s) => strip(s).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
const words = (s) => strip(s).toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length >= 4);

/** A clean username from "@name", "name" or a t.me link — or null. */
function cleanHandle(raw, link) {
  const v = strip(raw).replace(/^@/, '');
  if (USERNAME_RE.test(v)) return v;
  const m = LINK_RE.exec(strip(link)) || LINK_RE.exec(strip(raw));
  return m ? m[1] : null;
}

const pub = (u) => ({ id: u.id, name: u.name, phone: u.phone || null, current: u.telegram_username || null });

function buildPreview(rows, students) {
  const byKey = new Map();
  for (const u of students) {
    const k = key(u.name);
    if (k) (byKey.get(k) || byKey.set(k, []).get(k)).push(u);
  }
  const out = { exact: [], suggested: [], ambiguous: [], unmatched: [], unusable: [], empty: 0 };

  rows.forEach((r, i) => {
    const row = { index: i, name: strip(r.name), full_name: strip(r.full_name) };
    const raw = strip(r.handle);
    const handle = cleanHandle(r.handle, r.link);
    if (!handle) {
      if (!raw || raw === '@') out.empty += 1;
      else out.unusable.push({ ...row, raw });
      return;
    }
    const found = new Map();
    for (const k of [key(r.full_name), key(r.name)]) if (k) (byKey.get(k) || []).forEach((u) => found.set(u.id, u));
    const hits = [...found.values()];
    if (hits.length === 1) return out.exact.push({ ...row, handle, student: pub(hits[0]) });
    if (hits.length > 1) return out.ambiguous.push({ ...row, handle, candidates: hits.map(pub) });

    const mine = new Set([...words(r.name), ...words(r.full_name)]);
    const cands = students
      .map((u) => ({ u, n: words(u.name).filter((w) => mine.has(w) || [...mine].some((x) => x.length >= 5 && (w.includes(x) || x.includes(w)))).length }))
      .filter((c) => c.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map((c) => pub(c.u));
    if (cands.length) out.suggested.push({ ...row, handle, candidates: cands });
    else out.unmatched.push({ ...row, handle });
  });
  return out;
}

module.exports = { USERNAME_RE, cleanHandle, buildPreview, key };
