/**
 * Print how every file in the `textbook-chapters` bucket parses, so a
 * mis-named upload is caught before students see it on the shelf.
 *
 *   node scripts/list-textbooks.js
 *
 * Reads whatever project the current .env points at. Anything under
 * "unparsed" is a filename that doesn't match
 * <order>-grade<NN>-<subject>[-<variant>][-<language>].pdf — rename it in the
 * Supabase dashboard and re-run. Same for an "unknown subject": either fix
 * the name or add the slug to SUBJECTS in src/utils/textbookNames.js.
 */
require('../src/config/loadEnv');
const supabase = require('../src/config/supabase');
const { parseTextbookName, SUBJECTS } = require('../src/utils/textbookNames');

const BUCKET = 'textbook-chapters';
const PAGE = 100;

async function main() {
  console.log(`Target: ${process.env.SUPABASE_URL}\n`);

  const entries = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage.from(BUCKET)
      .list('', { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) {
      console.error(`❌ ${BUCKET}: ${error.message}`);
      process.exit(1);
    }
    entries.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  const books = [];
  const skipped = [];
  const unparsed = [];
  const unknownSubject = [];

  for (const entry of entries) {
    const parsed = parseTextbookName(entry.name);
    if (!parsed) { skipped.push(entry.name); continue; }
    if (parsed.grade === null) { unparsed.push(entry.name); continue; }
    if (!SUBJECTS[parsed.subject_slug]) unknownSubject.push(`${entry.name}  (subject "${parsed.subject_slug}")`);
    books.push(parsed);
  }

  const byGrade = new Map();
  for (const b of books) {
    if (!byGrade.has(b.grade)) byGrade.set(b.grade, []);
    byGrade.get(b.grade).push(b);
  }

  for (const grade of [...byGrade.keys()].sort((a, b) => a - b)) {
    const list = byGrade.get(grade).sort((a, b) => a.order_number - b.order_number);
    console.log(`Grade ${grade}  (${list.length})`);
    for (const b of list) console.log(`   ${b.title.padEnd(34)} ${b.subtitle}`);
    console.log();
  }

  console.log(`${entries.length} files, ${books.length} textbooks, ${byGrade.size} grades`);
  if (skipped.length)        console.log(`\nnon-PDF, ignored (${skipped.length}):\n   ${skipped.join('\n   ')}`);
  if (unknownSubject.length) console.log(`\n⚠ unknown subject (${unknownSubject.length}):\n   ${unknownSubject.join('\n   ')}`);
  if (unparsed.length)       console.log(`\n⚠ unparsed filenames (${unparsed.length}):\n   ${unparsed.join('\n   ')}`);
}

main();
