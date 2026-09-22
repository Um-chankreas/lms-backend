const jwt = require('jsonwebtoken');
const { RtcTokenBuilder, RtcRole } = require('agora-token');

const appId = process.env.AGORA_APP_ID;
const appCertificate = process.env.AGORA_APP_CERTIFICATE;

if (!appId || !appCertificate) {
  console.warn('⚠️  WARNING: Agora credentials not configured in .env');
  console.warn('AGORA_APP_ID:', appId ? '✅ Set' : '❌ Missing');
  console.warn('AGORA_APP_CERTIFICATE:', appCertificate ? '✅ Set' : '❌ Missing');
}

// Token lifetime in seconds. Clients also renew before expiry (web:
// 'token-privilege-will-expire', mobile: onTokenPrivilegeWillExpire ->
// POST /live-classes/:id/token), so this only has to outlast one renewal
// cycle; it is long so a missed renewal doesn't drop a class mid-lesson.
// Agora caps a single privilege at 24 hours.
const MAX_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_TTL_SECONDS = parseInt(process.env.AGORA_TOKEN_TTL_SECONDS, 10) || 4 * 60 * 60;

/**
 * Generate Agora RTC Token
 *
 * NOTE: agora-token v2's builder takes tokenExpire / privilegeExpire as
 * *durations in seconds from now*, not absolute Unix timestamps. (The old code
 * passed `now + ttl`, i.e. a ~56-year lifetime, and left privilegeExpire at 0,
 * so the intended 1-hour expiry was never actually encoded in the token.)
 */
const generateAgoraToken = (channel, uid, role, expirationTimeInSeconds = DEFAULT_TTL_SECONDS) => {
  try {
    if (!appId || !appCertificate) {
      throw new Error('Agora credentials not configured in .env file');
    }

    // Ensure UID is numeric
    if (typeof uid !== 'number') {
      uid = parseInt(uid) || Math.floor(Math.random() * 10000);
    }

    const ttl = Math.min(Math.max(parseInt(expirationTimeInSeconds, 10) || DEFAULT_TTL_SECONDS, 60), MAX_TTL_SECONDS);

    const agoraRole = role === 'teacher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channel,
      uid,
      agoraRole,
      ttl, // token lifetime (seconds from now)
      ttl  // privilege lifetime (seconds from now); must not exceed the token's
    );

    console.log(`🎟️  Agora token: channel=${channel} uid=${uid} role=${agoraRole === RtcRole.PUBLISHER ? 'publisher' : 'subscriber'} ttl=${ttl}s`);
    return token;
  } catch (error) {
    console.error('❌ Error generating Agora token:', error.message);
    throw error;
  }
};

module.exports = {
  generateAgoraToken,
  appId: appId
};
