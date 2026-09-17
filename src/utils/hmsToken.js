const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const accessKey = process.env.HMS_APP_ACCESS_KEY;
const appSecret = process.env.HMS_APP_SECRET;
const templateId = process.env.HMS_TEMPLATE_ID;

if (!accessKey || !appSecret || !templateId) {
  console.warn('⚠️  WARNING: 100ms credentials not configured in .env');
  console.warn('HMS_APP_ACCESS_KEY:', accessKey ? '✅ Set' : '❌ Missing');
  console.warn('HMS_APP_SECRET:', appSecret ? '✅ Set' : '❌ Missing');
  console.warn('HMS_TEMPLATE_ID:', templateId ? '✅ Set' : '❌ Missing');
}

const API_BASE = 'https://api.100ms.live/v2';

/** Short-lived token authenticating calls to 100ms's own REST API. */
function generateManagementToken() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { access_key: accessKey, type: 'management', version: 2, iat: now, nbf: now },
    appSecret,
    { algorithm: 'HS256', expiresIn: '5m', jwtid: uuidv4() }
  );
}

/**
 * Per-participant token for joining a room with a given role. 24h expiry —
 * far longer than a class ever runs, so unlike Agora there's no mid-call
 * renewal to handle.
 */
function generateAuthToken({ roomId, userId, role }) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { access_key: accessKey, room_id: roomId, user_id: userId, role, type: 'app', version: 2, iat: now, nbf: now },
    appSecret,
    { algorithm: 'HS256', expiresIn: '24h', jwtid: uuidv4() }
  );
}

async function hmsFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${generateManagementToken()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`100ms API ${path} -> ${res.status}: ${body?.message || res.statusText}`);
  }
  return body;
}

/** Creates a 100ms room for one live class, bound to our fixed template
 * (see HMS_TEMPLATE_ID / the teacher/student/co-host roles set up on it). */
async function createHmsRoom(name) {
  return hmsFetch('/rooms', {
    method: 'POST',
    body: JSON.stringify({ name, template_id: templateId }),
  });
}

/**
 * Pushes a role change to an already-connected peer, server-side — no new
 * token or client-initiated renegotiation needed (unlike Agora's co-host
 * upgrade, which had to mint a publisher token and call renewToken() +
 * setClientRole() on the client). Best-effort: if the user hasn't actually
 * joined the 100ms room yet, there's no peer to update — their next token
 * fetch will already carry the right role, so this is safe to skip silently.
 */
async function changeActivePeerRole({ roomId, userId, role }) {
  try {
    const { peers } = await hmsFetch(`/active-rooms/${roomId}/peers`);
    const peer = (peers || []).find((p) => p.customer_user_id === userId);
    if (!peer) return false;
    await hmsFetch(`/active-rooms/${roomId}/peers/${peer.id}`, {
      method: 'POST',
      body: JSON.stringify({ role }),
    });
    return true;
  } catch (e) {
    console.warn('changeActivePeerRole failed:', e.message);
    return false;
  }
}

module.exports = { generateManagementToken, generateAuthToken, createHmsRoom, changeActivePeerRole };
