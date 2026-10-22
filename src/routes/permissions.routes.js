const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { effectiveAllowedMap } = require('../utils/permissions');

/**
 * GET /api/permissions/mine
 * The logged-in user's effective allowed/denied map for the per-user
 * togglable web features (dashboard/schedule/latex_to_text/trim_video/
 * compress_video — see src/utils/permissions.js). The web portal fetches
 * this once after login to decide what the sidebar shows and to guard
 * direct navigation to a gated page — see romduol-web's Sidebar.vue and
 * router/index.js.
 */
router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const permissions = await effectiveAllowedMap(req.user.userId, req.user.role);
    res.json({ success: true, data: { permissions } });
  } catch (error) {
    console.error('Get my permissions error:', error);
    res.status(500).json({ success: false, error: 'Failed to load permissions: ' + error.message });
  }
});

module.exports = router;
