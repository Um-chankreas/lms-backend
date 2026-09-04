/**
 * Reset a user's password (admin / dev recovery — there is no self-service
 * password reset yet).
 *
 *   node scripts/set-password.js <email-or-phone> <new-password>
 *
 * Example:
 *   node scripts/set-password.js teacher@example.com newpass123
 */
require('../src/config/loadEnv');
const bcrypt = require('bcryptjs');
const supabase = require('../src/config/supabase');
const { normalizePhone } = require('../src/utils/phone');

async function main() {
  const [, , identifier, newPassword] = process.argv;

  if (!identifier || !newPassword) {
    console.error('Usage: node scripts/set-password.js <email-or-phone> <new-password>');
    process.exit(1);
  }
  if (String(newPassword).length < 6) {
    console.error('Password must be at least 6 characters');
    process.exit(1);
  }

  const isEmail = identifier.includes('@');
  const lookup = isEmail
    ? { col: 'email', val: String(identifier).trim().toLowerCase() }
    : { col: 'phone', val: normalizePhone(identifier) };

  const { data: user, error } = await supabase
    .from('users')
    .select('id, name, email, phone, role')
    .eq(lookup.col, lookup.val)
    .maybeSingle();
  if (error) throw error;
  if (!user) {
    console.error(`No user found with ${lookup.col} = ${lookup.val}`);
    process.exit(1);
  }

  const hashed = await bcrypt.hash(newPassword, 10);
  const { error: updErr } = await supabase
    .from('users')
    .update({ password: hashed })
    .eq('id', user.id);
  if (updErr) throw updErr;

  console.log(`Password updated for ${user.name} (${user.email || user.phone}, role ${user.role}).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
