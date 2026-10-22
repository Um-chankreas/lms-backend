const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticateToken, isAdmin, isSuperAdmin } = require('../middleware/auth');
const { listAccounts, encrypt, importedEnvId, envAccount } = require('../utils/agoraAccounts');
const { getUsage, getAdjustment } = require('../utils/agoraUsage');

// Agora App IDs and App Certificates are 32-character hex strings.
const HEX32 = /^[0-9a-f]{32}$/i;
const clean = (v) => String(v ?? '').trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const monthRange = () => {
  const n = new Date();
  return [Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1), Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1)];
};
const currentMonth = () => new Date().toISOString().slice(0, 7);

// Public shape: never includes the certificate (only whether one is stored).
const shape = async (accounts) => {
  const [from, to] = monthRange();
  return Promise.all(accounts.map(async (a) => {
    const tracked = (await getUsage(from, to, a.key)).total;
    const adjustment = await getAdjustment(a.key, currentMonth());
    const total = Math.max(0, tracked + adjustment);
    return {
      id: a.key,
      label: a.label,
      app_id: a.appId || null,
      email: a.email || null,
      source: a.source,
      is_active: !!a.isActive,
      free_minutes: a.freeMinutes,
      used_minutes: total,
      adjustment_minutes: adjustment,
      remaining_minutes: Math.max(0, a.freeMinutes - total),
      percent_used: Math.round((total / a.freeMinutes) * 1000) / 10,
      has_certificate: a.source === 'env' ? !!a.appCertificate : true,
      created_at: a.createdAt || null,
    };
  }));
};

/** GET /api/admin/agora-accounts — admins can see usage per account. */
router.get('/', authenticateToken, isAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: { accounts: await shape(await listAccounts()) } });
  } catch (e) {
    console.error('List Agora accounts error:', e);
    res.status(500).json({ success: false, error: 'Failed to load Agora accounts' });
  }
});

// Credentials are secrets, so changing them is super-admin only.

/** POST /api/admin/agora-accounts  { label, email, app_id, app_certificate, free_minutes? } */
router.post('/', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const label = clean(req.body.label);
    const email = clean(req.body.email).toLowerCase();
    const appId = clean(req.body.app_id);
    const cert = clean(req.body.app_certificate);
    const free = req.body.free_minutes == null || req.body.free_minutes === '' ? 10000 : parseInt(req.body.free_minutes, 10);

    if (!label) return res.status(400).json({ success: false, error: 'Give the account a name' });
    if (!EMAIL.test(email)) return res.status(400).json({ success: false, error: 'Enter the email this Agora account signs in with' });
    if (!HEX32.test(appId)) return res.status(400).json({ success: false, error: 'App ID must be 32 letters/numbers (copy it from the Agora console)' });
    if (!HEX32.test(cert)) return res.status(400).json({ success: false, error: 'App Certificate must be 32 letters/numbers (copy it from the Agora console)' });
    if (!Number.isInteger(free) || free < 1) return res.status(400).json({ success: false, error: 'Free minutes must be a positive number' });

    if (appId.toLowerCase() === String(process.env.AGORA_APP_ID || '').toLowerCase()) {
      return res.status(409).json({ success: false, error: 'This App ID is already the default (.env) account' });
    }
    const { data: dupe } = await supabase.from('agora_accounts').select('id').eq('app_id', appId).maybeSingle();
    if (dupe) return res.status(409).json({ success: false, error: 'This App ID has already been added' });

    const { error } = await supabase.from('agora_accounts').insert({
      id: uuidv4(), label, email, app_id: appId, app_certificate_enc: encrypt(cert), free_minutes: free, is_active: false,
    });
    if (error) throw error;

    res.status(201).json({ success: true, data: { accounts: await shape(await listAccounts()) } });
  } catch (e) {
    console.error('Add Agora account error:', e);
    res.status(500).json({ success: false, error: 'Failed to add Agora account' });
  }
});

/**
 * POST /api/admin/agora-accounts/env/import
 * "Make editable": copies the .env account into the database (certificate
 * encrypted) so it can be edited and deleted like any other. Everything keyed
 * 'env' (pinned classes, usage, synced minutes, active state) moves to the new
 * row, and the .env card is hidden from then on.
 */
router.post('/env/import', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const env = envAccount();
    if (!env.appId || !env.appCertificate) {
      return res.status(400).json({ success: false, error: 'AGORA_APP_ID / AGORA_APP_CERTIFICATE are not set in the server .env' });
    }
    if (await importedEnvId()) {
      return res.status(409).json({ success: false, error: 'The default account is already editable' });
    }
    const { data: anyActive } = await supabase.from('agora_accounts').select('id').eq('is_active', true).maybeSingle();

    const id = uuidv4();
    const { error } = await supabase.from('agora_accounts').insert({
      id, label: 'Default', email: env.email, app_id: env.appId, app_certificate_enc: encrypt(env.appCertificate),
      free_minutes: env.freeMinutes, is_active: !anyActive,   // .env was active when no stored account was
    });
    if (error) throw error;

    // Re-point everything that referred to the .env account.
    await supabase.from('live_classes').update({ agora_account: id }).eq('agora_account', 'env');
    await supabase.from('agora_usage_sessions').update({ agora_account: id }).eq('agora_account', 'env');
    await supabase.from('agora_usage_adjustments').update({ agora_account: id }).eq('agora_account', 'env');

    res.status(201).json({ success: true, data: { accounts: await shape(await listAccounts()) } });
  } catch (e) {
    console.error('Import .env Agora account error:', e);
    res.status(500).json({ success: false, error: 'Failed to make the default account editable' });
  }
});

/** PUT /api/admin/agora-accounts/:id  { label?, email?, app_id?, free_minutes?, app_certificate? } */
router.put('/:id', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    if (req.params.id === 'env') return res.status(400).json({ success: false, error: 'The default account is set in the server .env' });
    const patch = {};
    if (req.body.label !== undefined) {
      patch.label = clean(req.body.label);
      if (!patch.label) return res.status(400).json({ success: false, error: 'Name cannot be empty' });
    }
    if (req.body.email !== undefined) {
      const em = clean(req.body.email).toLowerCase();
      if (!EMAIL.test(em)) return res.status(400).json({ success: false, error: 'Enter a valid email' });
      patch.email = em;
    }
    if (req.body.free_minutes !== undefined) {
      const f = parseInt(req.body.free_minutes, 10);
      if (!Number.isInteger(f) || f < 1) return res.status(400).json({ success: false, error: 'Free minutes must be a positive number' });
      patch.free_minutes = f;
    }
    if (req.body.app_id !== undefined) {
      const appId = clean(req.body.app_id);
      if (!HEX32.test(appId)) return res.status(400).json({ success: false, error: 'App ID must be 32 letters/numbers' });
      const { data: cur } = await supabase.from('agora_accounts').select('app_id').eq('id', req.params.id).maybeSingle();
      if (cur && cur.app_id.toLowerCase() !== appId.toLowerCase()) {
        // Changing the App ID under a class that is mid-flight would strand the
        // people already in it (and tokens would no longer match).
        const { count } = await supabase.from('live_classes').select('id', { count: 'exact', head: true })
          .eq('agora_account', req.params.id).in('status', ['active', 'scheduled']);
        if (count) return res.status(409).json({ success: false, error: 'A live class is using this account — change the App ID after it ends' });
        const { data: dupe } = await supabase.from('agora_accounts').select('id').eq('app_id', appId).neq('id', req.params.id).maybeSingle();
        if (dupe || appId.toLowerCase() === String(process.env.AGORA_APP_ID || '').toLowerCase()) {
          return res.status(409).json({ success: false, error: 'This App ID is already added' });
        }
        patch.app_id = appId;
      }
    }
    if (req.body.app_certificate) {
      const cert = clean(req.body.app_certificate);
      if (!HEX32.test(cert)) return res.status(400).json({ success: false, error: 'App Certificate must be 32 letters/numbers' });
      patch.app_certificate_enc = encrypt(cert);
    }
    if (!Object.keys(patch).length) return res.status(400).json({ success: false, error: 'Nothing to update' });

    const { data, error } = await supabase.from('agora_accounts').update(patch).eq('id', req.params.id).select('id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Account not found' });
    res.json({ success: true, data: { accounts: await shape(await listAccounts()) } });
  } catch (e) {
    console.error('Update Agora account error:', e);
    res.status(500).json({ success: false, error: 'Failed to update Agora account' });
  }
});

/**
 * POST /api/admin/agora-accounts/:id/activate   (id 'env' = back to the .env account)
 * Classes that start from now on use this account. A class already running
 * keeps the account it started on — everyone in it must share one App ID.
 */
router.post('/:id/activate', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (id !== 'env') {
      const { data: row } = await supabase.from('agora_accounts').select('id').eq('id', id).maybeSingle();
      if (!row) return res.status(404).json({ success: false, error: 'Account not found' });
    }
    // Clear first: the unique index allows only one active row at a time.
    const { error: clearErr } = await supabase.from('agora_accounts').update({ is_active: false }).eq('is_active', true);
    if (clearErr) throw clearErr;
    if (id !== 'env') {
      const { error } = await supabase.from('agora_accounts').update({ is_active: true }).eq('id', id);
      if (error) throw error;
    }
    res.json({ success: true, data: { accounts: await shape(await listAccounts()) } });
  } catch (e) {
    console.error('Activate Agora account error:', e);
    res.status(500).json({ success: false, error: 'Failed to switch Agora account' });
  }
});

/**
 * POST /api/admin/agora-accounts/:id/usage   { used_minutes }   (id 'env' allowed)
 * "Sync with the Agora console": the admin types the minutes the console shows
 * as used this month; we store the gap between that and what we tracked, so
 * the usage pages match from now on and keep counting on top.
 */
router.post('/:id/usage', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const used = Number(req.body.used_minutes);
    if (!Number.isFinite(used) || used < 0 || used > 10000000) {
      return res.status(400).json({ success: false, error: 'Enter the minutes used, as a number (0 or more)' });
    }
    if (id !== 'env') {
      const { data: row } = await supabase.from('agora_accounts').select('id').eq('id', id).maybeSingle();
      if (!row) return res.status(404).json({ success: false, error: 'Account not found' });
    }
    const [from, to] = monthRange();
    const tracked = (await getUsage(from, to, id)).total;
    const { error } = await supabase.from('agora_usage_adjustments').upsert({
      agora_account: id, month: currentMonth(), minutes: Math.round(used) - tracked, updated_at: new Date(),
    });
    if (error) throw error;
    res.json({ success: true, data: { accounts: await shape(await listAccounts()) } });
  } catch (e) {
    console.error('Sync Agora usage error:', e);
    res.status(500).json({ success: false, error: 'Failed to update usage' });
  }
});

/** DELETE /api/admin/agora-accounts/:id — not the active one, nor one a live class is using. */
router.delete('/:id', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === 'env') return res.status(400).json({ success: false, error: 'The default account cannot be removed here' });
    const { data: row } = await supabase.from('agora_accounts').select('id, is_active').eq('id', id).maybeSingle();
    if (!row) return res.status(404).json({ success: false, error: 'Account not found' });
    if (row.is_active) return res.status(409).json({ success: false, error: 'Switch to another account before removing this one' });

    const { count } = await supabase.from('live_classes').select('id', { count: 'exact', head: true })
      .eq('agora_account', id).in('status', ['active', 'scheduled']);
    if (count) return res.status(409).json({ success: false, error: 'A live class is still using this account' });

    const { error } = await supabase.from('agora_accounts').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true, data: { accounts: await shape(await listAccounts()) } });
  } catch (e) {
    console.error('Delete Agora account error:', e);
    res.status(500).json({ success: false, error: 'Failed to remove Agora account' });
  }
});

module.exports = router;
