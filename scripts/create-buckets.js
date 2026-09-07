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
 * After this, raise the video limit if you need more than 2 GB:
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

async function main() {
  console.log(`Target: ${process.env.SUPABASE_URL}\n`);

  const { data: existing, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) {
    console.error('❌ Could not list buckets:', listErr.message);
    process.exit(1);
  }
  const existingIds = new Set((existing || []).map(b => b.id));

  for (const cfg of BUCKETS) {
    const opts = {
      public: cfg.public,
      fileSizeLimit: cfg.fileSizeLimit,
      allowedMimeTypes: cfg.allowedMimeTypes,
    };

    if (existingIds.has(cfg.id)) {
      const { error } = await supabase.storage.updateBucket(cfg.id, opts);
      if (error) { console.error(`❌ ${cfg.id}: ${error.message}`); process.exit(1); }
      console.log(`↻ updated  ${cfg.id}`);
    } else {
      const { error } = await supabase.storage.createBucket(cfg.id, opts);
      if (error) { console.error(`❌ ${cfg.id}: ${error.message}`); process.exit(1); }
      console.log(`✓ created  ${cfg.id}`);
    }
  }

  console.log('\nDone.');
}

main();