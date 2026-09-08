const { extractToken, verifyToken } = require('../utils/jwt');
const supabase = require('../config/supabase');

// Middleware to verify JWT token
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = extractToken(authHeader);

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided. Please login first.'
      });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(403).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    // A token stays valid for days, so re-check the account on every request.
    const { data: account, error } = await supabase
      .from('users')
      .select('id, role, is_active, deactivated_at, deletion_requested_at, deletion_scheduled_at, deleted_at')
      .eq('id', decoded.userId)
      .maybeSingle();

    if (error) throw error;
    if (!account) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_NOT_FOUND',
        error: 'This account no longer exists'
      });
    }

    // Fully purged — nothing to come back to.
    if (account.deleted_at) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_DELETED',
        error: 'This account has been permanently deleted'
      });
    }

    // Deletion grace window has elapsed (purge job hasn't run yet) — treat as
    // gone.
    if (account.deletion_scheduled_at && new Date(account.deletion_scheduled_at) <= new Date()) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_DELETED',
        error: 'This account has been permanently deleted'
      });
    }

    // Disabled by an admin (is_active false, and the user didn't do it to
    // themselves via deactivate/delete) — a hard block.
    if (account.is_active === false && !account.deactivated_at && !account.deletion_scheduled_at) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_SUSPENDED',
        error: 'This account has been deactivated. Contact your administrator.'
      });
    }

    // Self-deactivated or pending self-deletion (still inside the grace
    // window): the session keeps working so the app can show a banner and let
    // the user undo it. req.account carries the state for anything that wants
    // to surface it.
    req.user = decoded;
    req.account = account;
    req.accountState = account.deletion_scheduled_at
      ? 'pending_deletion'
      : account.deactivated_at
        ? 'deactivated'
        : 'active';
    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Authentication error: ' + error.message
    });
  }
};
 
// Middleware that attaches req.user when a valid token is present, but
// doesn't reject the request when it's missing/invalid — for routes that
// should work for both guests and logged-in users (e.g. public course
// browsing), while still letting logged-in-only logic branch on req.user.
const optionalAuth = (req, res, next) => {
  try {
    const token = extractToken(req.headers['authorization']);
    if (token) {
      const decoded = verifyToken(token);
      if (decoded) req.user = decoded;
    }
    next();
  } catch (error) {
    next();
  }
};

// Middleware to check if user is teacher
const isTeacher = (req, res, next) => {
  if (req.user?.role !== 'teacher') {
    return res.status(403).json({
      success: false,
      error: 'This action requires teacher privileges'
    });
  }
  next();
};
 
// Middleware to check if user is student
const isStudent = (req, res, next) => {
  if (req.user?.role !== 'student') {
    return res.status(403).json({
      success: false,
      error: 'This action requires student privileges'
    });
  }
  next();
};

// Middleware to check if user is an admin (web portal only)
const isAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'This action requires admin privileges'
    });
  }
  next();
};

module.exports = {
  authenticateToken,
  optionalAuth,
  isTeacher,
  isStudent,
  isAdmin
};