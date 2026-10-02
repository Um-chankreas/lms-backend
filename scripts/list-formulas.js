/**
 * Print how every file in the `Formula` bucket parses, so a mis-named upload
 * is caught before students see it on the shelf.
 *
 *   node scripts/list-formulas.js
 *
 * Reads the same storage project as the textbooks (TEXTBOOK_S3_* in .env).
 * Anything under "unparsed" doesn't match
 * <id>-<subject>-formulas[-qualifier]-g<NN>[-g<NN>][-source]-<language>[-v<N>].pdf.
 * An "unknown subject" falls back to its raw slug — add it to SUBJECTS in
 * src/utils/textbookNames.js, which this shares with the textbook shelf.
 */
require('../src/config/loadEnv');
const textbookStorage = require('../src/config/textbookStorage');
const { parseFormulaName } = require('../src/utils/formulaNames');
const { SUBJECTS } = require('../src/utils/textbookNames');

const BUCKET = 'Formula';

const mb = (bytes) => bytes == null ? '' : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  if (!textbookStorage.isConfigured()) {
    console.error('❌ TEXTBOOK_S3_* not set in .env — nothing to list.');
    process.exit(1);
  }
  console.log(`Target: ${process.env.TEXTBOOK_SUPABASE_URL}  bucket: ${BUCKET}\n`);

  let entries;
  try {
    entries = await textbookStorage.listBucket(BUCKET);
  } catch (error) {
    console.error(`❌ ${BUCKET}: ${error.message}`);
    process.exit(1);
  }

  const sheets = [];
  const skipped = [];
  const unparsed = [];
  const unknownSubject = [];

  for (const entry of entries) {
    const parsed = parseFormulaName(entry.name);
    if (!parsed) { skipped.push(entry.name); continue; }
    if (!parsed.upload_id) { unparsed.push(entry.name); continue; }
    if (!SUBJECTS[parsed.subject_slug]) unknownSubject.push(`${entry.name}  (subject "${parsed.subject_slug}")`);
    sheets.push({ parsed, size: entry.size });
  }

  sheets.sort((a, b) =>
    (a.parsed.subject_slug || '').localeCompare(b.parsed.subject_slug || '') ||
    (a.parsed.grade_from ?? 99) - (b.parsed.grade_from ?? 99) ||
    a.parsed.id.localeCompare(b.parsed.id));

  for (const { parsed, size } of sheets) {
    console.log(`  ${parsed.title.padEnd(44)} ${(parsed.subtitle || '').padEnd(58)} ${mb(size)}`);
  }

  console.log(`\n${entries.length} files, ${sheets.length} formula sheets`);
  if (skipped.length)        console.log(`\nnon-PDF, ignored (${skipped.length}):\n   ${skipped.join('\n   ')}`);
  if (unknownSubject.length) console.log(`\n⚠ unknown subject (${unknownSubject.length}):\n   ${unknownSubject.join('\n   ')}`);
  if (unparsed.length)       console.log(`\n⚠ unparsed filenames (${unparsed.length}):\n   ${unparsed.join('\n   ')}`);
}

main();
