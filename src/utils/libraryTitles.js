const supabase = require('../config/supabase');

/**
 * Hand-written titles for Library files (sql/046_library_titles.sql).
 *
 * The shelves derive every title from the filename; a row here overrides the
 * derived title/subtitle for one file. Every failure path degrades to "no
 * overrides" — a missing table or a Supabase hiccup must never take a shelf
 * down, it just falls back to the filename-derived titles.
 */

const TABLE = 'library_titles';
const MAX_TITLE = 200;

/** file_id -> { title, subtitle } for one kind. */
async function load(kind) {
  const map = new Map();
  const { data, error } = await supabase.from(TABLE).select('file_id, title, subtitle').eq('kind', kind);
  if (error) {
    console.warn(`library_titles unavailable (${error.message}) — using filename titles`);
    return map;
  }
  for (const row of data || []) map.set(row.file_id, { title: row.title, subtitle: row.subtitle });
  return map;
}

/** Apply overrides in place; flags overridden items so the portal can show them. */
function apply(items, overrides, getId = (i) => i.id) {
  for (const item of items) {
    const o = overrides.get(getId(item));
    if (!o) { item.title_custom = false; continue; }
    item.title = o.title;
    if (o.subtitle) item.subtitle = o.subtitle;
    item.title_custom = true;
  }
  return items;
}

const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_TITLE) : '');

/** Save (or, for an empty title, remove) the override for one file. */
async function save(kind, fileId, title, subtitle) {
  const t = clean(title);
  if (!t) return remove(kind, fileId);
  const { error } = await supabase.from(TABLE).upsert({
    kind, file_id: fileId, title: t, subtitle: clean(subtitle) || null, updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`could not save title: ${error.message}`);
}

async function remove(kind, fileId) {
  const { error } = await supabase.from(TABLE).delete().eq('kind', kind).eq('file_id', fileId);
  if (error) console.warn(`could not remove title: ${error.message}`);
}

/** A rename changes file_id, so the override has to follow it. */
async function move(kind, oldId, newId) {
  if (oldId === newId) return;
  const { data } = await supabase.from(TABLE).select('title, subtitle').eq('kind', kind).eq('file_id', oldId).maybeSingle();
  if (!data) return;
  await save(kind, newId, data.title, data.subtitle);
  await remove(kind, oldId);
}

module.exports = { load, apply, save, remove, move, clean };
