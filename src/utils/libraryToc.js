const supabase = require('../config/supabase');

/**
 * Tables of contents for Library files (sql/054_library_toc.sql).
 *
 * Like libraryTitles, every failure path degrades to "no table of contents":
 * a missing table or a Supabase hiccup must never break a book, the reader just
 * falls back to its even "parts".
 */

const TABLE = 'library_toc';
const MAX_ITEMS = 300;
const MAX_TITLE = 200;

/** Coerce whatever arrived (a model's guess, an admin's edit) into clean items. */
function sanitize(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const raw of items.slice(0, MAX_ITEMS)) {
    const title = typeof raw?.title === 'string' ? raw.title.trim().slice(0, MAX_TITLE) : '';
    if (!title) continue;
    const page = Number.isFinite(Number(raw.page)) && Number(raw.page) >= 1 && Number(raw.page) <= 5000
      ? Math.round(Number(raw.page)) : null;
    const level = [0, 1, 2].includes(Number(raw.level)) ? Number(raw.level) : 0;
    out.push({ title, page, level });
  }
  return out;
}

const cleanOffset = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(-500, Math.min(500, n)) : 0;
};

/** { items, page_offset } for one file, or null when it has no table of contents. */
async function load(kind, fileId) {
  const { data, error } = await supabase.from(TABLE).select('items, page_offset').eq('kind', kind).eq('file_id', fileId).maybeSingle();
  if (error) {
    console.warn(`library_toc unavailable (${error.message})`);
    return null;
  }
  if (!data) return null;
  return { items: sanitize(data.items), page_offset: data.page_offset || 0 };
}

/** Save the table of contents for one file; an empty list removes it. */
async function save(kind, fileId, items, pageOffset) {
  const clean = sanitize(items);
  if (!clean.length) return remove(kind, fileId);
  const { error } = await supabase.from(TABLE).upsert({
    kind, file_id: fileId, items: clean, page_offset: cleanOffset(pageOffset), updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`could not save table of contents: ${error.message}`);
  return clean;
}

async function remove(kind, fileId) {
  const { error } = await supabase.from(TABLE).delete().eq('kind', kind).eq('file_id', fileId);
  if (error) console.warn(`could not remove table of contents: ${error.message}`);
}

/** A rename changes file_id, so the table of contents has to follow it. */
async function move(kind, oldId, newId) {
  if (oldId === newId) return;
  const found = await load(kind, oldId);
  if (!found) return;
  await save(kind, newId, found.items, found.page_offset);
  await remove(kind, oldId);
}

module.exports = { load, save, remove, move, sanitize };
