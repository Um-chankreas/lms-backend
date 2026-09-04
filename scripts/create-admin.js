/**
 * Create an admin account for the web portal.
 *
 *   node scripts/create-admin.js "<name>" <email> <password> [phone]
 *
 * Example:
 *   node scripts/create-admin.js "Portal Admin" admin@romduol.com secret123
 *
 * Admins can log in via POST /api/auth/login like anyone else; the returned
 * JWT carries role:"admin", which unlocks /api/admin/*.
 */
require('../src/config/loadEnv');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../src/config/supabase');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main() {
  const [, , name, email, password, phone] = process.argv;

  if (!name || !email || !password) {
    console.error('Usage: node scripts/create-admin.js "<name>" <email> <password> [phone]');
    process.exit(1);
  }
  const normEmail = String(email).trim().toLowerCase();
  if (!EMAIL_REGEX.test(normEmail)) {
    console.error('Invalid email:', email);
    process.exit(1);
  }
  if (String(password).length < 6) {
    console.error('Password must be at least 6 characters');
    process.exit(1);
  }

  const { data: existing } = await supabase
    .from('users')
    .select('id, role')
    .eq('email', normEmail)
    .maybeSingle();

  if (existing) {
    if (existing.role === 'admin') {
      console.log('That email is already an admin:', existing.id);
      process.exit(0);
    }
    // Promote instead of creating a duplicate.
    const { error } = await supabase.from('users').update({ role: 'admin' }).eq('id', existing.id);
    if (error) throw error;
    console.log(`Promoted existing user ${existing.id} (${normEmail}) to admin.`);
    process.exit(0);
  }

  const hashed = await bcrypt.hash(password, 10);
  const id = uuidv4();
  const { error } = await supabase.from('users').insert({
    id,
    name,
    email: normEmail,
    phone: phone ? String(phone).replace(/[\s\-()]/g, '') : null,
    password: hashed,
    role: 'admin',
    created_at: new Date()
  });
  if (error) throw error;

  console.log(`Admin created: ${normEmail}  (id ${id})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
