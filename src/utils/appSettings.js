const supabase = require('../config/supabase');

// app_settings rows (min_app_version, latest_app_version, store URLs ...), cached
// briefly so launch checks and the admin page don't each hit the database.
let cache = { at: 0, map: {} };

async function loadSettings() {
  if (Date.now() - cache.at < 30000) return cache.map;
  try {
    const { data, error } = await supabase.from('app_settings').select('key, value');
    if (error) throw error;
    const map = {};
    for (const r of data || []) if (r.value && String(r.value).trim()) map[r.key] = String(r.value).trim();
    cache = { at: Date.now(), map };
  } catch (e) {
    // Table missing (migration 066 not run) or a blip: keep what we had.
    cache = { at: Date.now(), map: cache.map };
  }
  return cache.map;
}

function invalidateSettings() {
  cache = { at: 0, map: cache.map };
}

module.exports = { loadSettings, invalidateSettings };
