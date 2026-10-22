/**
 * Print how every file in the `past-papers` bucket parses, so a mis-named
 * upload is caught before students see it on the shelf.
 *
 *   node scripts/list-past-papers.js
 *
 * Reads the same storage project as the textbooks (TEXTBOOK_S3_* in .env).
 * Anything under "unparsed" doesn't match <order>-<topic>[-answers].pdf —
 * rename it in the Supabase dashboard and re-run. An "unmapped topic" still
 * serves, under its prettified English slug; give it a Khmer title by adding
 * a line to TOPICS in src/utils/pastPaperNames.js.
 */
require('../src/config/loadEnv');
const textbookStorage = require('../src/config/textbookStorage');
const { parsePastPaperName, TOPICS } = require('../src/utils/pastPaperNames');

const BUCKET = 'past-papers';

async function main() {
  if (!textbookStorage.isConfigured()) {
    console.error('❌ TEXTBOOK_S3_* not set in .env — nothing to list.');
    process.exit(1);
  }
  console.log(`Target: ${process.env.TEXTBOOK_SUPABASE_URL}\n`);

  let entries;
  try {
    entries = await textbookStorage.listBucket(BUCKET);
  } catch (error) {
    console.error(`❌ ${BUCKET}: ${error.message}`);
    process.exit(1);
  }

  const papers = [];
  const skipped = [];
  const unparsed = [];
  const unmapped = [];

  for (const entry of entries) {
    const parsed = parsePastPaperName(entry.name);
    if (!parsed) { skipped.push(entry.name); continue; }
    if (!parsed.order_number) { unparsed.push(entry.name); continue; }
    if (!TOPICS[parsed.topic_slug]) unmapped.push(`${entry.name}  (topic "${parsed.topic_slug}")`);
    papers.push(parsed);
  }

  papers.sort((a, b) => a.order_number - b.order_number);

  // A question paper and its answer key share a topic slug.
  const answerTopics = new Set(papers.filter(p => p.is_answer_key).map(p => p.topic_slug));

  for (const p of papers) {
    const pair = p.is_answer_key ? '↳ answers' : answerTopics.has(p.topic_slug) ? '+ answers' : '';
    console.log(
      `${String(p.order_number).padStart(3)}  ${p.title.padEnd(38)} ${(p.subtitle || '').padEnd(44)} ${pair}`,
    );
  }

  const pairs = papers.filter(p => !p.is_answer_key && answerTopics.has(p.topic_slug)).length;
  console.log(`\n${entries.length} files, ${papers.length} papers, ${pairs} with an answer key`);
  if (skipped.length)  console.log(`\nnon-PDF, ignored (${skipped.length}):\n   ${skipped.join('\n   ')}`);
  if (unmapped.length) console.log(`\n⚠ unmapped topic (${unmapped.length}):\n   ${unmapped.join('\n   ')}`);
  if (unparsed.length) console.log(`\n⚠ unparsed filenames (${unparsed.length}):\n   ${unparsed.join('\n   ')}`);
}

main();
