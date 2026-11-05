const supabase = require('../config/supabase');
const { loadSettings } = require('./appSettings');
const { isSubscriptionActive } = require('./access');

const ACTIVE_DAYS = 30;
const PAID_DEVICE_LIMIT = 2;

async function fetchAllRows(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

/** <0 if a<b, 0 if equal, >0 if a>b ("1.10.0" > "1.9.2"). */
function compareVersions(a, b) {
  const parts = v => String(v).split(/[.-]/).map(p => parseInt(p, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// The data is the same for every call on the page, so load it once per 30 s.
let cache = { at: 0, data: null };
function invalidateOverviewCache() { cache = { at: 0, data: null }; }

async function loadData() {
  if (cache.data && Date.now() - cache.at < 30000) return cache.data;

  const [students, devices, subs, lastActiveRes, settings] = await Promise.all([
    fetchAllRows(() => supabase.from('users').select('id, name, created_at')
      .eq('role', 'student').is('deleted_at', null).eq('is_test', false)),
    fetchAllRows(() => supabase.from('device_sessions')
      .select('user_id, device_id, platform, model, os_version, app_version, app_build, first_seen_at, last_seen_at')),
    fetchAllRows(() => supabase.from('student_course_subscriptions').select('student_id, expiry_date')),
    supabase.rpc('student_last_active'),
    loadSettings()
  ]);

  const paid = new Set(subs.filter(r => isSubscriptionActive(r.expiry_date)).map(r => r.student_id));
  const lastXp = new Map((lastActiveRes.data || []).map(r => [r.student_id, r.last_active]));
  const data = {
    students, devices, paid, lastXp,
    rules: {
      min: settings.min_app_version || (process.env.APP_MIN_VERSION || '').trim() || null,
      latest: settings.latest_app_version || (process.env.APP_LATEST_VERSION || '').trim() || null
    }
  };
  cache = { at: Date.now(), data };
  return data;
}

const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

/** Everything the page needs, for one platform filter ('all' | 'android' | 'ios'). */
async function buildDevicesView(platform = 'all') {
  const { students, devices, paid, lastXp, rules } = await loadData();
  const studentIds = new Set(students.map(s => s.id));
  const since = Date.now() - ACTIVE_DAYS * 24 * 3600 * 1000;
  const isActive = d => new Date(d.last_seen_at).getTime() >= since;

  // Real students only (test accounts, teachers and deleted users are left out).
  const mine = devices.filter(d => studentIds.has(d.user_id));
  const activeAll = mine.filter(isActive);
  const active = platform === 'all' ? activeAll : activeAll.filter(d => d.platform === platform);

  const byStudent = new Map();
  for (const d of active) {
    if (!byStudent.has(d.user_id)) byStudent.set(d.user_id, []);
    byStudent.get(d.user_id).push(d);
  }

  const statusOf = v => {
    if (rules.min && v && compareVersions(v, rules.min) < 0) return 'must_update';
    if (rules.latest && v && compareVersions(v, rules.latest) >= 0) return 'latest';
    return 'ok';
  };

  // ---- table rows
  const rows = students.map(s => {
    const list = (byStudent.get(s.id) || []).sort((a, b) => new Date(b.last_seen_at) - new Date(a.last_seen_at));
    const isPaid = paid.has(s.id);
    const newest = list[0];
    const seen = [newest?.last_seen_at, lastXp.get(s.id)].filter(Boolean).map(x => new Date(x).getTime());
    return {
      id: s.id,
      name: s.name,
      plan: isPaid ? 'paid' : 'free',
      devices: list.length,
      over_limit: isPaid && list.length > PAID_DEVICE_LIMIT,
      models: [...new Set(list.map(d => (d.model || 'Unknown')))],
      app_version: newest?.app_version || null,
      version_status: newest ? statusOf(newest.app_version) : 'no_data',
      last_active: seen.length ? new Date(Math.max(...seen)).toISOString() : null
    };
  });

  // ---- cards
  const withDevice = rows.filter(r => r.devices > 0);
  const total = students.length;
  const count = { 1: 0, 2: 0, 3: 0, 4: 0 };
  withDevice.forEach(r => { count[Math.min(r.devices, 4)] += 1; });
  const multi = withDevice.filter(r => r.devices >= 2).length;

  const versionMap = new Map();
  active.forEach(d => {
    const v = d.app_version || 'Unknown';
    versionMap.set(v, (versionMap.get(v) || 0) + 1);
  });
  const versions = [...versionMap.entries()]
    .sort((a, b) => compareVersions(b[0], a[0]))
    .map(([version, n]) => ({
      version, devices: n, pct: pct(n, active.length),
      tag: version === 'Unknown' ? null : statusOf(version) === 'latest' ? 'latest' : statusOf(version) === 'must_update' ? 'must_update' : null
    }));
  const onLatest = versions.filter(v => v.tag === 'latest').reduce((n, v) => n + v.devices, 0);
  const mustUpdateDevices = versions.filter(v => v.tag === 'must_update').reduce((n, v) => n + v.devices, 0);

  const modelMap = new Map();
  active.forEach(d => {
    const key = `${d.platform}|${d.model || 'Unknown'}`;
    modelMap.set(key, (modelMap.get(key) || 0) + 1);
  });
  const modelList = [...modelMap.entries()]
    .map(([k, n]) => ({ platform: k.split('|')[0], model: k.slice(k.indexOf('|') + 1), devices: n }))
    .sort((a, b) => b.devices - a.devices);
  const topModels = modelList.slice(0, 9);
  const rest = modelList.slice(9);

  const androidAll = activeAll.filter(d => d.platform === 'android').length;
  const iosAll = activeAll.filter(d => d.platform === 'ios').length;

  const counts = {
    all: rows.length,
    multi: rows.filter(r => r.devices >= 2).length,
    must_update: rows.filter(r => r.version_status === 'must_update').length,
    old_app: rows.filter(r => r.devices === 0).length
  };

  return {
    rows,
    counts,
    overview: {
      platform,
      coverage: { students_total: total, with_device: withDevice.length, pct: pct(withDevice.length, total), old_app: total - withDevice.length },
      devices: { active: active.length, android: androidAll, ios: iosAll },
      per_student: {
        avg: withDevice.length ? Math.round((active.length / withDevice.length) * 10) / 10 : 0,
        students_with_device: withDevice.length,
        multi,
        over_limit: rows.filter(r => r.over_limit).length,
        paid_limit: PAID_DEVICE_LIMIT,
        buckets: [1, 2, 3, 4].map(n => ({ label: n === 4 ? '4 or more' : `${n} ${n === 1 ? 'device' : 'devices'}`, students: count[n], pct: pct(count[n], withDevice.length) })),
        three_plus: count[3] + count[4]
      },
      latest: { devices_on_latest: onLatest, devices_total: active.length, pct: pct(onLatest, active.length), must_update_devices: mustUpdateDevices, latest_version: rules.latest },
      versions,
      rules,
      models: {
        top: topModels.map(m => ({ ...m, pct: pct(m.devices, active.length) })),
        other: rest.length ? { models: rest.length, devices: rest.reduce((n, m) => n + m.devices, 0) } : null
      }
    }
  };
}

/** One student's devices (active or not), newest first. */
async function devicesOfStudent(studentId) {
  const { data, error } = await supabase
    .from('device_sessions')
    .select('device_id, platform, model, os_version, app_version, app_build, first_seen_at, last_seen_at')
    .eq('user_id', studentId)
    .order('last_seen_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(({ device_id, ...rest }) => rest); // the install id means nothing to an admin
}

module.exports = { buildDevicesView, devicesOfStudent, invalidateOverviewCache, compareVersions };
