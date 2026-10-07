/**
 * Bulk-edit Library titles in a spreadsheet instead of one file at a time.
 *
 *   node scripts/library-titles.js export [file.csv]            write every file's title to a CSV
 *   node scripts/library-titles.js import file.csv [--dry-run]  save the titles you changed
 *
 * `export` lists the three shelves (textbooks, past papers, formulas) and writes
 * kind, id, title, subtitle — pre-filled with what the app shows today, so you
 * only retype the ones you want to change. Open it in Excel / Google Sheets
 * (it's UTF-8 with a BOM, so Khmer displays correctly) and keep the `kind` and
 * `id` columns untouched: they identify the file.
 *
 * `import` saves a row only when its title/subtitle differ from the automatic
 * filename-derived one, so unchanged rows stay automatic. A row whose title is
 * emptied (or set back to the automatic one) removes any custom title.
 *
 * Needs sql/046_library_titles.sql applied, plus the usual .env (Supabase and
 * TEXTBOOK_S3_*).
 */
require('../src/config/loadEnv');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const textbookStorage = require('../src/config/textbookStorage');
const libraryTitles = require('../src/utils/libraryTitles');
const supabase = require('../src/config/supabase');
const { parseTextbookName } = require('../src/utils/textbookNames');
const { parsePastPaperName } = require('../src/utils/pastPaperNames');
const { parseFormulaName } = require('../src/utils/formulaNames');

const SHELVES = [
  { kind: 'textbook', bucket: 'textbook-chapters', parse: parseTextbookName },
  { kind: 'past-paper', bucket: 'past-papers', parse: parsePastPaperName },
  { kind: 'formula', bucket: 'Formula', parse: parseFormulaName },
];

/** Every PDF on every shelf, with its automatic (filename-derived) title. */
async function listAuto() {
  const rows = [];
  for (const shelf of SHELVES) {
    let entries;
    try {
      entries = await textbookStorage.listBucket(shelf.bucket);
    } catch (e) {
      console.warn(`⚠️  ${shelf.bucket}: ${e.message} — skipped`);
      continue;
    }
    for (const entry of entries) {
      const p = shelf.parse(entry.name);
      if (p) rows.push({ kind: shelf.kind, id: p.id, title: p.title, subtitle: p.subtitle || '' });
    }
  }
  return rows;
}

const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function exportCsv(file) {
  const auto = await listAuto();
  const overrides = {};
  for (const shelf of SHELVES) overrides[shelf.kind] = await libraryTitles.load(shelf.kind);

  const lines = ['kind,id,title,subtitle'];
  for (const r of auto) {
    const o = overrides[r.kind].get(r.id);
    lines.push([r.kind, r.id, o ? o.title : r.title, o ? (o.subtitle || '') : r.subtitle].map(cell).join(','));
  }
  // BOM so Excel reads the Khmer as UTF-8.
  fs.writeFileSync(file, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  console.log(`✅ Wrote ${auto.length} rows to ${file}`);
}

async function importCsv(file, dryRun) {
  const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, bom: true, skip_empty_lines: true, trim: true });
  const autoByKey = new Map((await listAuto()).map(r => [`${r.kind}|${r.id}`, r]));
  const existing = new Set();
  for (const shelf of SHELVES) for (const id of (await libraryTitles.load(shelf.kind)).keys()) existing.add(`${shelf.kind}|${id}`);

  let saved = 0; let cleared = 0; let unchanged = 0; let unknown = 0;
  for (const row of rows) {
    const key = `${row.kind}|${row.id}`;
    const auto = autoByKey.get(key);
    if (!auto) { console.warn(`⚠️  unknown file, skipped: ${row.kind} ${row.id}`); unknown++; continue; }

    const title = libraryTitles.clean(row.title);
    const subtitle = libraryTitles.clean(row.subtitle);
    const isAuto = !title || (title === auto.title && subtitle === (auto.subtitle || ''));

    if (isAuto) {
      // Back to automatic: drop a custom title only if there is one.
      if (existing.has(key)) {
        if (!dryRun) await libraryTitles.remove(row.kind, row.id);
        cleared++;
      } else unchanged++;
    } else {
      console.log(`  ${row.kind} ${row.id}\n    → ${title}${subtitle ? '  ·  ' + subtitle : ''}`);
      if (!dryRun) await libraryTitles.save(row.kind, row.id, title, subtitle);
      saved++;
    }
  }
  console.log(`\n${dryRun ? '(dry run — nothing written) ' : ''}saved ${saved}, reset to automatic ${cleared}, unchanged ${unchanged}, skipped ${unknown}.`);
  if (!dryRun) {
    // The shelves cache for ~1 minute; they pick the new titles up on their own.
    console.log('Shelves refresh within a minute.');
  }
}

async function main() {
  const [cmd, file, ...flags] = process.argv.slice(2);
  if (!textbookStorage.isConfigured()) {
    console.error('❌ TEXTBOOK_S3_* not set in .env.');
    process.exit(1);
  }
  if (cmd === 'export') return exportCsv(file || 'library-titles.csv');
  if (cmd === 'import' && file) return importCsv(file, flags.includes('--dry-run'));
  console.error('Usage:\n  node scripts/library-titles.js export [file.csv]\n  node scripts/library-titles.js import file.csv [--dry-run]');
  process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error('❌', e.message); process.exit(1); });
