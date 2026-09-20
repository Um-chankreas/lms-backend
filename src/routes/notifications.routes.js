const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');

// The bell feed is for real, logged-in accounts only.
router.use(authenticateToken);

/**
 * GET /api/notifications?limit=30&before=<iso>&unread=true&types=quiz_complete,lesson_complete
 * Newest first. `before` pages backwards from a row's created_at.
 * `types` is a comma-separated allow-list (e.g. the mobile "my activity" feed
 * passes the owner types only).
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user.userId;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

    let query = supabase
      .from('notifications')
      .select('id, type, title, body, data, read_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (req.query.before) query = query.lt('created_at', req.query.before);
    if (req.query.unread === 'true') query = query.is('read_at', null);
    if (req.query.types) {
      const types = String(req.query.types).split(',').map(s => s.trim()).filter(Boolean);
      if (types.length > 0) query = query.in('type', types);
    }

    const { data: notifications, error } = await query;
    if (error) throw error;

    res.json({ success: true, data: { notifications: notifications || [] } });
  } catch (error) {
    console.error('List notifications error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch notifications: ' + error.message });
  }
});

/**
 * GET /api/notifications/unread-count  -> { count }
 */
router.get('/unread-count', async (req, res) => {
  try {
    let q = supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.userId)
      .is('read_at', null);
    if (req.query.types) {
      const types = String(req.query.types).split(',').map(s => s.trim()).filter(Boolean);
      if (types.length > 0) q = q.in('type', types);
    }
    const { count, error } = await q;
    if (error) throw error;
    res.json({ success: true, data: { count: count || 0 } });
  } catch (error) {
    console.error('Unread count error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch unread count: ' + error.message });
  }
});

/**
 * PATCH /api/notifications/read
 * body: { all: true }  OR  { ids: [uuid, …] }
 */
router.patch('/read', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { all, ids } = req.body || {};

    let query = supabase
      .from('notifications')
      .update({ read_at: new Date() })
      .eq('user_id', userId)
      .is('read_at', null);

    if (all === true) {
      // mark everything unread as read
    } else if (Array.isArray(ids) && ids.length > 0) {
      query = query.in('id', ids.slice(0, 200));
    } else {
      return res.status(400).json({ success: false, error: 'Provide { all: true } or { ids: [...] }' });
    }

    const { error } = await query;
    if (error) throw error;

    res.json({ success: true, message: 'Marked as read' });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ success: false, error: 'Failed to mark notifications read: ' + error.message });
  }
});

/**
 * POST /api/notifications/push-token   body: { token, platform? }
 * Register (or refresh) an Expo push token for this device.
 */
router.post('/push-token', async (req, res) => {
  try {
    const { token, platform } = req.body || {};
    if (!token || typeof token !== 'string' || !token.startsWith('ExponentPushToken')) {
      return res.status(400).json({ success: false, error: 'A valid Expo push token is required' });
    }
    const { error } = await supabase
      .from('push_tokens')
      .upsert(
        { token, user_id: req.user.userId, platform: platform || null, updated_at: new Date() },
        { onConflict: 'token' }
      );
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Register push token error:', error);
    res.status(500).json({ success: false, error: 'Failed to register push token: ' + error.message });
  }
});

/**
 * DELETE /api/notifications/push-token   body: { token? }
 * Drop one device's token (on logout), or all of this user's tokens.
 */
router.delete('/push-token', async (req, res) => {
  try {
    const { token } = req.body || {};
    const query = token
      ? supabase.from('push_tokens').delete().eq('token', token)
      : supabase.from('push_tokens').delete().eq('user_id', req.user.userId);
    await query;
    res.json({ success: true });
  } catch (error) {
    console.error('Delete push token error:', error);
    res.status(500).json({ success: false, error: 'Failed to remove push token: ' + error.message });
  }
});

module.exports = router;
