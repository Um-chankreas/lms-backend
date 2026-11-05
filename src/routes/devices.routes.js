const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, hasRole } = require('../middleware/auth');
const { buildDevicesView, devicesOfStudent, invalidateOverviewCache } = require('../utils/deviceOverview');
const { invalidateSettings } = require('../utils/appSettings');

const adminOnly = [authenticateToken, hasRole('admin', 'super_admin')];
const platformOf = q => (['android', 'ios'].includes(String(q || '').toLowerCase()) ? String(q).toLowerCase() : 'all');

const clip = (v, max) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * POST /api/devices/register   { device_id, platform, model?, os_version?, app_version?, app_build? }
 * Any signed-in user. The app calls it on every cold start (even with a restored
 * session, so old users are counted after they update without signing in again),
 * after sign-in, and when it comes back to the foreground (at most every 6 h).
 * Stores only the phone model, OS version and app version, for analytics.
 */
router.post('/register', authenticateToken, async (req, res) => {
  try {
    const b = req.body || {};
    const deviceId = clip(b.device_id, 64);
    const platform = String(b.platform || '').toLowerCase();
    if (!deviceId) return res.status(400).json({ success: false, error: 'device_id is required' });
    if (platform !== 'android' && platform !== 'ios') {
      return res.status(400).json({ success: false, error: 'platform must be android or ios' });
    }
    const { error } = await supabase.rpc('register_device', {
      p_user_id: req.user.userId,
      p_device_id: deviceId,
      p_platform: platform,
      p_model: clip(b.model, 80),
      p_os_version: clip(b.os_version, 40),
      p_app_version: clip(b.app_version, 20),
      p_app_build: clip(b.app_build, 20)
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Register device error:', error);
    res.status(500).json({ success: false, error: 'Failed to register device' });
  }
});

/**
 * GET /api/devices/stats   (admin / super_admin)
 * Totals only, from the SECURITY DEFINER functions in sql/066. No per-user rows.
 */
router.get('/stats', authenticateToken, hasRole('admin', 'super_admin'), async (req, res) => {
  try {
    const [models, perUser, versions] = await Promise.all([
      supabase.rpc('device_models_summary'),
      supabase.rpc('devices_per_user_summary'),
      supabase.rpc('app_version_summary')
    ]);
    for (const r of [models, perUser, versions]) if (r.error) throw r.error;
    res.json({
      success: true,
      data: { models: models.data || [], devices_per_user: perUser.data || [], app_versions: versions.data || {} }
    });
  } catch (error) {
    console.error('Device stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to load device stats' });
  }
});

/**
 * GET /api/devices/overview?platform=all|android|ios   (admin / super_admin)
 * The cards on the Devices page: coverage, active devices, devices per student,
 * app versions, phone models and the update rules.
 */
router.get('/overview', ...adminOnly, async (req, res) => {
  try {
    const { overview, counts } = await buildDevicesView(platformOf(req.query.platform));
    res.json({ success: true, data: { ...overview, counts } });
  } catch (error) {
    console.error('Devices overview error:', error);
    res.status(500).json({ success: false, error: 'Failed to load devices overview' });
  }
});

/**
 * GET /api/devices/students?platform=&tab=all|multi|must_update|old_app&q=&page=&limit=&export=1
 * The "Students and devices" table. With export=1 every matching row comes back (for the CSV).
 */
router.get('/students', ...adminOnly, async (req, res) => {
  try {
    const { rows, counts } = await buildDevicesView(platformOf(req.query.platform));
    const tab = String(req.query.tab || 'all');
    const q = String(req.query.q || '').trim().toLowerCase();
    let list = rows.filter(r => {
      if (tab === 'multi' && r.devices < 2) return false;
      if (tab === 'must_update' && r.version_status !== 'must_update') return false;
      if (tab === 'old_app' && r.devices !== 0) return false;
      if (q && !(r.name || '').toLowerCase().includes(q) && !r.models.some(m => m.toLowerCase().includes(q))) return false;
      return true;
    });
    // Problems first (over the limit, must update), then the most devices, then name.
    list.sort((a, b) =>
      (b.over_limit - a.over_limit) ||
      ((b.version_status === 'must_update') - (a.version_status === 'must_update')) ||
      (b.devices - a.devices) ||
      String(a.name).localeCompare(String(b.name)));

    const total = list.length;
    if (req.query.export === '1') return res.json({ success: true, data: { rows: list.slice(0, 5000), total, counts } });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    res.json({
      success: true,
      data: {
        rows: list.slice((page - 1) * limit, page * limit),
        counts,
        pagination: { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) }
      }
    });
  } catch (error) {
    console.error('Devices students error:', error);
    res.status(500).json({ success: false, error: 'Failed to load students and devices' });
  }
});

/** GET /api/devices/students/:id   one student's devices ("View devices"). */
router.get('/students/:id', ...adminOnly, async (req, res) => {
  try {
    res.json({ success: true, data: { devices: await devicesOfStudent(req.params.id) } });
  } catch (error) {
    console.error('Student devices error:', error);
    res.status(500).json({ success: false, error: 'Failed to load devices' });
  }
});

/**
 * PUT /api/devices/rules   { min_app_version, latest_app_version }
 * The "Update rules" box. Saved in app_settings, which /api/app-version reads, so the
 * app picks the change up within about 30 seconds. Empty = no rule.
 */
router.put('/rules', ...adminOnly, async (req, res) => {
  try {
    const VERSION = /^\d+(\.\d+){0,3}$/;
    const rows = [];
    for (const key of ['min_app_version', 'latest_app_version']) {
      if (req.body?.[key] === undefined) continue;
      const v = String(req.body[key] ?? '').trim();
      if (v && !VERSION.test(v)) return res.status(400).json({ success: false, error: `${key} must look like 1.4.0` });
      rows.push({ key, value: v || null, updated_at: new Date().toISOString() });
    }
    if (!rows.length) return res.status(400).json({ success: false, error: 'Nothing to save' });
    const { error } = await supabase.from('app_settings').upsert(rows, { onConflict: 'key' });
    if (error) throw error;
    invalidateSettings();
    invalidateOverviewCache();
    res.json({ success: true });
  } catch (error) {
    console.error('Save update rules error:', error);
    res.status(500).json({ success: false, error: 'Failed to save update rules' });
  }
});

module.exports = router;
