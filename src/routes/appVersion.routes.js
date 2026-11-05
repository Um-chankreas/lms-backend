const express = require('express');
const router = express.Router();
const { loadSettings } = require('../utils/appSettings');
const { ensureIosStoreVersion } = require('../utils/iosStoreVersion');

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
 * The same values can be set in the app_settings table (keys min_app_version,
 * latest_app_version, min_build, latest_build, store_url_android, store_url_ios),
 * which wins over the environment and needs no restart. Empty rows fall back to
 * the variables above.
 *
 * iOS: "latest" is read from the App Store itself (Apple's public lookup, checked at most once a day,
 * see utils/iosStoreVersion.js), so nothing needs setting when Apple approves a
 * release. The minimum still comes from app_settings / env. If the lookup is unavailable,
 * iOS falls back to the latest values above. IOS_STORE_SYNC=0 turns the lookup off.
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

router.get('/', async (req, res) => {
  const platform = String(req.query.platform || '').toLowerCase() === 'ios' ? 'IOS' : 'ANDROID';
  const s = await loadSettings();
  const pick = (key, envName) => s[key] || read(envName, platform);
  // iOS: the App Store's own version wins for "latest" (build number and link too).
  let ios = null;
  if (platform === 'IOS') ios = await ensureIosStoreVersion();
  res.json({
    success: true,
    data: {
      latest_version: ios?.version || pick('latest_app_version', 'APP_LATEST_VERSION'),
      min_supported_version: pick('min_app_version', 'APP_MIN_VERSION'),
      latest_build: ios ? null : toBuild(pick('latest_build', 'APP_LATEST_BUILD')),
      min_build: toBuild(pick('min_build', 'APP_MIN_BUILD')),
      store_url: s[platform === 'IOS' ? 'store_url_ios' : 'store_url_android'] || (ios?.url) || read('APP_STORE_URL', platform),
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
