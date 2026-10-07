const crypto = require('crypto');
const supabase = require('../config/supabase');

// Free-plan allowance for the built-in (.env) account.
const ENV_FREE_MINUTES = parseInt(process.env.AGORA_FREE_MINUTES, 10) || 10000;

// ---- certificate encryption ------------------------------------------------
// AES-256-GCM. The key comes from AGORA_ACCOUNTS_KEY (preferred) or, failing
// that, the JWT secret, so no extra setup is needed. Changing either key makes
// stored certificates unreadable — re-enter them if you rotate it.
const keyMaterial = () => process.env.AGORA_ACCOUNTS_KEY || process.env.JWT_SECRET || '';
const aesKey = () => crypto.createHash('sha256').update(keyMaterial()).digest();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join(':');
}

function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(':').map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---- accounts --------------------------------------------------------------

const envAccount = () => ({
  key: 'env',
  label: 'Default (.env)',
  appId: process.env.AGORA_APP_ID,
  appCertificate: process.env.AGORA_APP_CERTIFICATE,
  email: process.env.AGORA_ACCOUNT_EMAIL || null,
  freeMinutes: ENV_FREE_MINUTES,
  source: 'env',
});

const fromRow = (r) => ({
  key: r.id,
  label: r.label,
  appId: r.app_id,
  appCertificate: null, // decrypted on demand, see credentialsFor()
  certEnc: r.app_certificate_enc,
  email: r.email || null,
  freeMinutes: r.free_minutes,
  isActive: r.is_active,
  createdAt: r.created_at,
  source: 'db',
});

async function listDbRows() {
  const { data, error } = await supabase.from('agora_accounts').select('*').order('created_at');
  if (error) throw error;
  return data || [];
}

/** All accounts (the .env one first), without certificates. */
async function listAccounts() {
  const rows = await listDbRows();
  const anyActive = rows.some((r) => r.is_active);
  return [{ ...envAccount(), isActive: !anyActive }, ...rows.map(fromRow)];
}

/** Key of the account new classes should use: 'env' or an agora_accounts.id. */
async function getActiveKey() {
  const { data } = await supabase.from('agora_accounts').select('id').eq('is_active', true).maybeSingle();
  return data?.id || 'env';
}

/** { appId, appCertificate } for an account key; unknown/deleted falls back to .env. */
async function credentialsFor(key) {
  if (!key || key === 'env') return { appId: process.env.AGORA_APP_ID, appCertificate: process.env.AGORA_APP_CERTIFICATE };
  const { data } = await supabase.from('agora_accounts').select('app_id, app_certificate_enc').eq('id', key).maybeSingle();
  if (!data) return { appId: process.env.AGORA_APP_ID, appCertificate: process.env.AGORA_APP_CERTIFICATE };
  return { appId: data.app_id, appCertificate: decrypt(data.app_certificate_enc) };
}

/**
 * The account a live class runs on. Pinned the first time it is needed (start
 * or first token): a class that was already active before this feature existed
 * is on the .env account; otherwise it takes whichever account is active now.
 */
async function accountKeyForClass(liveClass) {
  if (liveClass.agora_account) return liveClass.agora_account;
  // Already running with nothing pinned = started before accounts existed.
  const key = liveClass.status === 'active' ? 'env' : await getActiveKey();
  await supabase.from('live_classes').update({ agora_account: key }).eq('id', liveClass.id);
  return key;
}

module.exports = {
  ENV_FREE_MINUTES, encrypt, decrypt, envAccount, listAccounts, getActiveKey, credentialsFor, accountKeyForClass,
};
