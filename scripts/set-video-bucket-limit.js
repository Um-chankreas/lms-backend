/**
 * Raise the course-materials bucket's per-file size limit so lesson videos
 * can be uploaded. Supabase defaults this to ~50MB.
 *
 *   node scripts/set-video-bucket-limit.js [sizeMB]
 *
 * Example (2 GB):
 *   node scripts/set-video-bucket-limit.js 2048
 *
 * Note: the hard ceiling depends on your Supabase plan (Free is lower than
 * Pro). Run this once after deploying, or set it in the dashboard:
 *   Storage -> course-materials -> Settings -> File size limit.
 */
require('dotenv').config();
const supabase = require('../src/config/supabase');

async function main() {
  const sizeMB = parseInt(process.argv[2], 10) || 2048;
  const bytes = sizeMB * 1024 * 1024;

  const { data, error } = await supabase.storage.updateBucket('course-materials', {
    public: true,
    fileSizeLimit: bytes,
    allowedMimeTypes: null // allow any type (videos, docs, zips, …)
  });

  if (error) {
    console.error('❌ Failed:', error.message);
    process.exit(1);
  }
  console.log(`✅ course-materials file size limit set to ${sizeMB} MB`, data);
}

main();
