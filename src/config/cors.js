// Which browser origins may call the API (REST and Socket.IO).
//
// CORS_ORIGIN is a comma-separated list, e.g.
//   CORS_ORIGIN=https://web.romduolscholars.com,http://localhost:5173
// "*" allows every origin. Unset: every origin in development (so localhost
// and LAN IPs just work), only the production web portal otherwise.
//
// Requests with no Origin header (the mobile app, curl, Postman, server-to-
// server) aren't subject to CORS and are always let through — the JWT is what
// protects those.

const DEFAULT_PRODUCTION_ORIGINS = ['https://web.romduolscholars.com'];

const configured = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const allowAll =
  configured.includes('*') ||
  (configured.length === 0 && process.env.NODE_ENV === 'development');

const allowedOrigins = new Set(configured.length ? configured : DEFAULT_PRODUCTION_ORIGINS);

const isAllowedOrigin = (origin) => !origin || allowAll || allowedOrigins.has(origin);

// For the `origin` option of the cors package (also what Socket.IO uses).
// A disallowed origin gets no CORS headers, so the browser blocks the
// response — it isn't an error on our side.
const corsOrigin = (origin, callback) => callback(null, isAllowedOrigin(origin));

module.exports = { corsOrigin, isAllowedOrigin };
