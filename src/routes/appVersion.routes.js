const express = require('express');
const router = express.Router();

/**
 * GET /api/app-version?platform=ios|android        (public — no login needed)
 *
 * Tells the mobile app which build is current so it can nudge users to update.
 * Configured with environment variables (restart the server after changing):
 *
 *   APP_LATEST_VERSION_IOS / APP_LATEST_VERSION_ANDROID   newest published version, e.g. 1.2.0
 *   APP_MIN_VERSION_IOS    / APP_MIN_VERSION_ANDROID      oldest version still allowed.
 *                                                        Anything older gets a blocking
 *                                                        "update required" screen.
 *   APP_STORE_URL_IOS      / APP_STORE_URL_ANDROID        where the Update button goes
 *   APP_RELEASE_NOTES                                    optional one-liner shown in the prompt
 *
 * Unset values come back null and the app simply shows nothing.
 */
router.get('/', (req, res) => {
  const platform = String(req.query.platform || '').toLowerCase() === 'ios' ? 'IOS' : 'ANDROID';
  const env = (name) => (process.env[`${name}_${platform}`] || '').trim() || null;

  res.json({
    success: true,
    data: {
      latest_version: env('APP_LATEST_VERSION'),
      min_supported_version: env('APP_MIN_VERSION'),
      store_url: env('APP_STORE_URL'),
      release_notes: (process.env.APP_RELEASE_NOTES || '').trim() || null
    }
  });
});

module.exports = router;
