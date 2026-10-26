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
 *   APP_LATEST_BUILD_IOS   / APP_LATEST_BUILD_ANDROID     (optional) newest build number
 *   APP_MIN_BUILD_IOS      / APP_MIN_BUILD_ANDROID        (optional) oldest build number allowed.
 *                                                        For releases that keep the same version
 *                                                        string and only raise the build number
 *                                                        (iOS buildNumber / Android versionCode).
 *   APP_STORE_URL_IOS      / APP_STORE_URL_ANDROID        where the Update button goes
 *   APP_RELEASE_NOTES                                    optional one-liner shown in the prompt
 *
 * Each name also works without the _IOS/_ANDROID suffix (one value for both
 * platforms); the platform-specific one wins. Unset values come back null and
 * the app simply shows nothing — so a missing variable looks like "the update
 * alert doesn't work". The server logs what it has at start-up.
 */
const NAMES = ['APP_LATEST_VERSION', 'APP_MIN_VERSION', 'APP_LATEST_BUILD', 'APP_MIN_BUILD', 'APP_STORE_URL'];

const read = (name, platform) => (process.env[`${name}_${platform}`] || process.env[name] || '').trim() || null;
const toBuild = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

router.get('/', (req, res) => {
  const platform = String(req.query.platform || '').toLowerCase() === 'ios' ? 'IOS' : 'ANDROID';
  res.json({
    success: true,
    data: {
      latest_version: read('APP_LATEST_VERSION', platform),
      min_supported_version: read('APP_MIN_VERSION', platform),
      latest_build: toBuild(read('APP_LATEST_BUILD', platform)),
      min_build: toBuild(read('APP_MIN_BUILD', platform)),
      store_url: read('APP_STORE_URL', platform),
      release_notes: (process.env.APP_RELEASE_NOTES || '').trim() || null
    }
  });
});

// One line at start-up so "why is nobody told to update?" is answered by the log.
for (const platform of ['ANDROID', 'IOS']) {
  const set = NAMES.filter(n => read(n, platform));
  if (!read('APP_LATEST_VERSION', platform) && !read('APP_MIN_VERSION', platform)) {
    console.warn(`app-version (${platform}): APP_LATEST_VERSION_${platform} / APP_MIN_VERSION_${platform} are not set, so ${platform.toLowerCase()} users will never be asked to update.`);
  } else {
    console.log(`app-version (${platform}): ${set.map(n => `${n}=${read(n, platform)}`).join(', ')}`);
  }
}

module.exports = router;
