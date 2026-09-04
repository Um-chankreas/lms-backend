/**
 * Permanently erase accounts whose 30-day deletion grace period has elapsed.
 *
 *   node scripts/purge-deleted-accounts.js [--dry-run]
 *
 * Run on a schedule (hosting cron, GitHub Action, Supabase scheduled
 * function, ...). Personal data is scrubbed from the users row and
 * deleted_at is stamped; learning records (submissions, xp_events,
 * completions, enrollments) are kept but are no longer tied to an
 * identifiable person.
 *
 * See sql/017_account_lifecycle.sql and POST/DELETE /api/auth/account*.
 */
require('../src/config/loadEnv');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../src/config/supabase');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const nowIso = new Date().toISOString();

  const { data: due, error } = await supabase
    .from('users')
    .select('id, name, email, avatar_url')
    .lte('deletion_scheduled_at', nowIso)
    .is('deleted_at', null);
  if (error) throw error;

  if (!due || due.length === 0) {
    console.log('No accounts due for purge.');
    return;
  }

  console.log(`${due.length} account(s) due for purge${DRY_RUN ? ' (dry run — nothing written)' : ''}:`);

  for (const u of due) {
    console.log(`  - ${u.id} (${u.email || u.name || 'no identifier'})`);
    if (DRY_RUN) continue;

    // Best-effort: drop the avatar file from storage.
    if (u.avatar_url) {
      const key = u.avatar_url.split('/storage/v1/object/public/avatars/')[1];
      if (key) {
        const { error: rmErr } = await supabase.storage.from('avatars').remove([key]);
        if (rmErr) console.warn(`    avatar cleanup failed: ${rmErr.message}`);
      }
    }

    // Overwrite the password with an unusable random hash so the row can
    // never be authenticated against again.
    const deadPassword = await bcrypt.hash(uuidv4(), 10);

    const { error: updErr } = await supabase
      .from('users')
      .update({
        name: 'Deleted user',
        email: null,
        phone: null,
        password: deadPassword,
        avatar_url: null,
        bio: null,
        is_active: false,
        deleted_at: new Date(),
        deletion_scheduled_at: null
      })
      .eq('id', u.id);

    if (updErr) {
      console.error(`    FAILED: ${updErr.message}`);
      continue;
    }
    console.log('    scrubbed');
  }

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
