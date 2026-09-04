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

    // A token stays valid for days, so re-check the account still exists and
    // is active on every request — this is what makes self-service
    // deactivation / deletion take effect immediately instead of when the
    // token happens to expire.
    const { data: account, error } = await supabase
      .from('users')
      .select('id, role, is_active')
      .eq('id', decoded.userId)
      .maybeSingle();

    if (error) throw error;
    if (!account) {
      return res.status(403).json({
        success: false,
        error: 'This account no longer exists'
      });
    }
    if (account.is_active === false) {
      return res.status(403).json({
        success: false,
        error: 'This account has been deactivated'
      });
    }

    // Attach user info to request
    req.user = decoded;
    req.account = account;
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