const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticateToken, isAdmin, isSuperAdmin } = require('../middleware/auth');
const { listAccounts, encrypt } = require('../utils/agoraAccounts');
const { getUsage } = require('../utils/agoraUsage');

// Agora App IDs and App Certificates are 32-character hex strings.
const HEX32 = /^[0-9a-f]{32}$/i;
const clean = (v) => String(v ?? '').trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const monthRange = () => {
  const n = new Date();
  return [Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1), Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1)];
};

// Public shape: never includes the certificate (only whether one is stored).
const shape = async (accounts) => {
  const [from, to] = monthRange();
  return Promise.all(accounts.map(async (a) => {
    const { total } = await getUsage(from, to, a.key);
    return {
      id: a.key,
      label: a.label,
      app_id: a.appId || null,
      email: a.email || null,
      source: a.source,
      is_active: !!a.isActive,
      free_minutes: a.freeMinutes,
      used_minutes: total,
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

/** PUT /api/admin/agora-accounts/:id  { label?, email?, free_minutes?, app_certificate? } */
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
