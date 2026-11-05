const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, hasRole } = require('../middleware/auth');

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

module.exports = router;
