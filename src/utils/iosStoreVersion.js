// The version live on the App Store, so iOS students are told about a new release
// without anyone typing it in. Uses Apple's public lookup (no key or account needed).
//
// Env (all optional):
//   IOS_BUNDLE_ID       default romduolscholars.com (the app.json ios.bundleIdentifier)
//   IOS_STORE_COUNTRY   default kh  (storefront to look in)
//   IOS_STORE_CHECK_HOURS  how old the answer may get before it is looked up again (default 24)
//   IOS_STORE_SYNC=0    turn the lookup off (iOS then uses app_settings / APP_LATEST_VERSION_IOS)
//
// There is no timer. The lookup runs only when a student's app asks for the version and the
// last answer is older than a day, so an idle server does no work at all.

const BUNDLE_ID = () => (process.env.IOS_BUNDLE_ID || 'romduolscholars.com').trim();
const COUNTRY = () => (process.env.IOS_STORE_COUNTRY || 'kh').trim();
const CHECK_MS = () => Math.max(1, Number(process.env.IOS_STORE_CHECK_HOURS) || 24) * 3600 * 1000;

let live = null; // { version, url, notes, releasedAt, checkedAt }

async function refreshIosStoreVersion() {
  if (process.env.IOS_STORE_SYNC === '0') return live;
  try {
    const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(BUNDLE_ID())}&country=${encodeURIComponent(COUNTRY())}&t=${Date.now()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = (await res.json())?.results?.[0];
    if (r?.version) {
      const next = {
        version: String(r.version),
        url: r.trackViewUrl ? String(r.trackViewUrl).replace(/\?.*$/, '') : null,
        notes: r.releaseNotes ? String(r.releaseNotes).slice(0, 200) : null,
        releasedAt: r.currentVersionReleaseDate || null,
        checkedAt: Date.now()
      };
      if (!live || live.version !== next.version) console.log(`ios-store: App Store version is ${next.version}`);
      live = next;
    }
  } catch (e) {
    // Keep the last good answer; a blip must never remove the prompt.
    console.warn('ios-store: lookup failed:', e.message);
    if (live) live.checkedAt = Date.now(); // try again tomorrow, not on every request
  }
  return live;
}

let refreshing = null;

/** The App Store version. The very first call waits for Apple; after that, a stale answer is
 * returned straight away and refreshed in the background (at most one lookup per day). */
async function ensureIosStoreVersion() {
  if (process.env.IOS_STORE_SYNC === '0') return null;
  if (!live) return refreshIosStoreVersion();
  if (Date.now() - live.checkedAt > CHECK_MS() && !refreshing) {
    refreshing = refreshIosStoreVersion().finally(() => { refreshing = null; });
  }
  return live;
}

module.exports = { refreshIosStoreVersion, ensureIosStoreVersion };
