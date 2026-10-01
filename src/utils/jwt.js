const jwt = require('jsonwebtoken');
 
// Placeholder secrets that have appeared in this (public) repo — anyone can
// read them, so a server running with one of them lets anyone forge a token
// for any user and role.
const KNOWN_PLACEHOLDERS = new Set([
  'your_jwt_secret_key_here',
  'any_random_string_here',
  'change-me'
]);
const MIN_SECRET_LENGTH = 32;

// No fallback: refuse to start rather than sign tokens with a guessable key.
// Generate one with: openssl rand -hex 32
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || KNOWN_PLACEHOLDERS.has(JWT_SECRET) || JWT_SECRET.length < MIN_SECRET_LENGTH) {
  throw new Error(
    `JWT_SECRET is missing, a placeholder, or shorter than ${MIN_SECRET_LENGTH} characters. ` +
    'Set a random value in .env (e.g. `openssl rand -hex 32`).'
  );
}
const JWT_EXPIRE = process.env.JWT_EXPIRE || '7d';
const JWT_ALGORITHM = 'HS256';

// Generate JWT Token
const generateToken = (userId, role) => {
  return jwt.sign(
    { userId, role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRE, algorithm: JWT_ALGORITHM }
  );
};

// Verify JWT Token
const verifyToken = (token) => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
    return decoded;
  } catch (error) {
    return null;
  }
};
 
// Extract token from Authorization header
const extractToken = (authHeader) => {
  if (!authHeader) return null;
  
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }
  
  return parts[1];
};
 
module.exports = {
  JWT_SECRET,
  JWT_ALGORITHM,
  generateToken,
  verifyToken,
  extractToken
};
 