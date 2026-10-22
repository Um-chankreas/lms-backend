const supabase = require('../config/supabase');

// Pages an admin can control access to, per role (role_permissions,
// sql/044) and per individual user on top of that (feature_permissions,
// sql/043). Deliberately does NOT cover Student Management or Roles &
// Permissions — those touch account creation/deletion and payments and stay
// strictly role-gated in admin.routes.js, not something this system opens up.
const FEATURES = ['dashboard', 'schedule', 'latex_to_text', 'trim_video', 'compress_video'];
const ROLES = ['student', 'teacher', 'admin', 'super_admin'];

/** One role's feature defaults, e.g. { dashboard: true, schedule: true, ... }. */
async function roleDefaultsFor(role) {
  const { data } = await supabase
    .from('role_permissions')
    .select('feature_key, allowed')
    .eq('role', role);
  return Object.fromEntries((data || []).map(r => [r.feature_key, r.allowed]));
}

/** The full role x feature matrix — { [role]: { [feature]: allowed } }, every cell present. */
async function getRoleDefaultsMatrix() {
  const { data } = await supabase.from('role_permissions').select('role, feature_key, allowed');
  const matrix = {};
  ROLES.forEach(role => { matrix[role] = Object.fromEntries(FEATURES.map(f => [f, false])); });
  (data || []).forEach(row => {
    if (matrix[row.role] && FEATURES.includes(row.feature_key)) matrix[row.role][row.feature_key] = row.allowed;
  });
  return matrix;
}

/** Every feature's effective state for one user: { [key]: { allowed, overridden } }. */
async function effectivePermissions(userId, role) {
  const [{ data: overrides }, roleDefaults] = await Promise.all([
    supabase.from('feature_permissions').select('feature_key, allowed').eq('user_id', userId),
    roleDefaultsFor(role)
  ]);
  const overrideMap = Object.fromEntries((overrides || []).map(o => [o.feature_key, o.allowed]));

  return Object.fromEntries(FEATURES.map(key => [
    key,
    {
      allowed: overrideMap[key] !== undefined ? overrideMap[key] : !!roleDefaults[key],
      overridden: overrideMap[key] !== undefined
    }
  ]));
}

/** Just the allowed booleans — what the frontend's nav/route gating needs. */
async function effectiveAllowedMap(userId, role) {
  const perms = await effectivePermissions(userId, role);
  return Object.fromEntries(Object.entries(perms).map(([k, v]) => [k, v.allowed]));
}

async function hasFeature(userId, role, featureKey) {
  const [{ data: override }, { data: roleDefault }] = await Promise.all([
    supabase.from('feature_permissions').select('allowed').eq('user_id', userId).eq('feature_key', featureKey).maybeSingle(),
    supabase.from('role_permissions').select('allowed').eq('role', role).eq('feature_key', featureKey).maybeSingle()
  ]);
  return override ? !!override.allowed : !!roleDefault?.allowed;
}

/** Middleware: block the request unless the caller has this feature allowed. */
const requireFeature = (featureKey) => async (req, res, next) => {
  try {
    const ok = await hasFeature(req.user.userId, req.user.role, featureKey);
    if (!ok) {
      return res.status(403).json({ success: false, error: 'You do not have access to this feature. Ask an admin.' });
    }
    next();
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to check permissions: ' + error.message });
  }
};

module.exports = {
  FEATURES,
  ROLES,
  getRoleDefaultsMatrix,
  effectivePermissions,
  effectiveAllowedMap,
  hasFeature,
  requireFeature
};
