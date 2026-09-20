/**
 * Create the storage buckets this app expects, in whatever Supabase project
 * the current .env points to. Safe to re-run — an existing bucket is updated
 * to the settings below, not recreated.
 *
 *   node scripts/create-buckets.js
 *
 * Buckets (all public — every file_url in the DB is read back through
 * /storage/v1/object/public/<bucket>/<path>):
 *   avatars           profile pictures
 *   course-materials  lesson files, videos, thumbnails  (large file limit)
 *   assignments       assignment submission uploads
 *
 * The fileSizeLimit below is a REQUEST — Supabase caps it at your plan's
 * global limit (50 MB on Free, up to 50 GB on Pro). If the request is too
 * high the bucket is still created/updated, just without a custom limit
 * (it then inherits the project default). Raise it later once on Pro:
 *   node scripts/set-video-bucket-limit.js 2048
 */
require('../src/config/loadEnv');
const supabase = require('../src/config/supabase');

const MB = 1024 * 1024;

const BUCKETS = [
  { id: 'avatars', public: true, fileSizeLimit: 10 * MB, allowedMimeTypes: null },
  { id: 'course-materials', public: true, fileSizeLimit: 2048 * MB, allowedMimeTypes: null },
  { id: 'assignments', public: true, fileSizeLimit: 100 * MB, allowedMimeTypes: null },
];

// A Supabase plan-limit rejection — not a real failure, retry without a limit.
const isSizeLimitError = (msg = '') =>
  /maximum allowed size|exceeded the maximum|file size limit|payload too large/i.test(msg);

async function apply(cfg, exists) {
  const write = (opts) =>
    exists
      ? supabase.storage.updateBucket(cfg.id, opts)
      : supabase.storage.createBucket(cfg.id, opts);

  const opts = { public: cfg.public, fileSizeLimit: cfg.fileSizeLimit, allowedMimeTypes: cfg.allowedMimeTypes };
  let { error } = await write(opts);

  if (error && isSizeLimitError(error.message)) {
    // Plan won't allow this limit — set the bucket up with the plan default.
    ({ error } = await write({ public: cfg.public, fileSizeLimit: null, allowedMimeTypes: cfg.allowedMimeTypes }));
    if (!error) return 'no-limit';
  }
  if (error) return { error };
  return 'ok';
}

async function main() {
  console.log(`Target: ${process.env.SUPABASE_URL}\n`);

  const { data: existing, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) {
    console.error('❌ Could not list buckets:', listErr.message);
    process.exit(1);
  }
  const existingIds = new Set((existing || []).map(b => b.id));

  let failed = false;
  for (const cfg of BUCKETS) {
    const exists = existingIds.has(cfg.id);
    const result = await apply(cfg, exists);
    const verb = exists ? 'updated' : 'created';

    if (result === 'ok') {
      console.log(`✓ ${verb}  ${cfg.id}`);
    } else if (result === 'no-limit') {
      console.log(`✓ ${verb}  ${cfg.id}  (plan doesn't allow a custom size limit — using project default)`);
    } else {
      console.error(`❌ ${cfg.id}: ${result.error.message}`);
      failed = true;
    }
  }

  console.log(failed ? '\nDone with errors.' : '\nDone.');
  process.exit(failed ? 1 : 0);
}

main();
