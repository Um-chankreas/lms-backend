const { extractToken, verifyToken } = require('../utils/jwt');
 
// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
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
 
    // Attach user info to request
    req.user = decoded;
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