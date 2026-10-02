/**
 * Render a cover thumbnail for every PDF on a shelf and upload it.
 *
 *   node scripts/make-covers.js [textbooks|formulas|past-papers] [--limit N] [--force]
 *
 * These are scans with no embedded thumbnail, so the only way to get a cover
 * is to rasterize page one. That needs the whole PDF — a page's objects
 * are reachable only through the trailer at the end of the file — so each book
 * is downloaded, rendered, uploaded and deleted one at a time rather than
 * pulling 3.6 GB onto disk at once.
 *
 * Rendering uses macOS `qlmanage`, so this is a developer-machine job, not
 * something the server does. Covers never change once made, which is why it's
 * a one-off script and not an endpoint.
 *
 * Covers land in the main project's public `course-materials` bucket rather
 * than beside the PDFs: the textbook bucket lives in another Supabase project
 * whose credentials here are read-only, and mixing images in with the PDFs
 * would also put non-book entries into the shelf listing.
 *
 * Re-running skips books that already have a cover, so it can be interrupted
 * and resumed. `--force` re-renders them anyway.
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const supabase = require('../src/config/supabase');

const BUCKET = 'course-materials';
const COVER_WIDTH = 420;

// Each shelf has its own endpoint, its own response key and its own cover
// folder. The Formula bucket is private, so its file_url arrives presigned —
// which is exactly why covers are fetched through the API rather than built
// from a storage path.
const SHELVES = {
  textbooks: { path: '/api/textbooks', key: 'textbooks', prefix: 'textbook-covers' },
  formulas: { path: '/api/formulas', key: 'formulas', prefix: 'formula-covers' },
  'past-papers': { path: '/api/past-papers', key: 'past_papers', prefix: 'past-paper-covers' },
};

const args = process.argv.slice(2);
const shelfName = args.find(a => !a.startsWith('--') && SHELVES[a]) || 'textbooks';
const shelf = SHELVES[shelfName];
const API = `http://localhost:${process.env.PORT || 5002}${shelf.path}`;
const PREFIX = shelf.prefix;
const force = args.includes('--force');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity;

async function existingCovers() {
  const { data } = await supabase.storage.from(BUCKET).list(PREFIX, { limit: 1000 });
  return new Set((data || []).map(f => f.name.replace(/\.jpg$/, '')));
}

async function main() {
  const res = await fetch(API);
  const body = await res.json();
  if (!body.success) throw new Error(`could not list ${shelfName} — is the server running?`);
  const books = body.data[shelf.key];
  if (!books) throw new Error(`unexpected response shape for ${shelfName}`);

  const have = force ? new Set() : await existingCovers();
  const todo = books.filter(b => !have.has(b.id)).slice(0, limit);

  console.log(`${books.length} ${shelfName}, ${have.size} already have covers, ${todo.length} to do\n`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covers-'));
  let done = 0;
  let failed = 0;

  for (const [i, book] of todo.entries()) {
    const pdf = path.join(tmp, `${book.id}.pdf`);
    const png = `${pdf}.png`;
    const label = `[${i + 1}/${todo.length}] ${book.id}`;

    try {
      const file = await fetch(book.file_url);
      if (!file.ok) throw new Error(`download ${file.status}`);
      fs.writeFileSync(pdf, Buffer.from(await file.arrayBuffer()));

      // qlmanage writes "<name>.pdf.png" next to the -o directory.
      execFileSync('qlmanage', ['-t', '-s', '900', '-o', tmp, pdf], { stdio: 'ignore' });
      if (!fs.existsSync(png)) throw new Error('render produced nothing');

      const jpg = await sharp(png).resize({ width: COVER_WIDTH }).jpeg({ quality: 80 }).toBuffer();
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(`${PREFIX}/${book.id}.jpg`, jpg, { contentType: 'image/jpeg', upsert: true });
      if (error) throw error;

      done++;
      console.log(`${label}  ok  ${(jpg.length / 1024).toFixed(0)}KB`);
    } catch (e) {
      failed++;
      console.warn(`${label}  FAILED  ${e.message}`);
    } finally {
      // Deleted straight away: the whole set would be 3.6 GB on disk.
      for (const f of [pdf, png]) {
        try { fs.unlinkSync(f); } catch { /* never existed */ }
      }
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\ndone: ${done} covers, ${failed} failed`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
