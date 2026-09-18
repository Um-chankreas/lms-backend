const jwt = require('jsonwebtoken');
const { RtcTokenBuilder, RtcRole } = require('agora-token');

const appId = process.env.AGORA_APP_ID;
const appCertificate = process.env.AGORA_APP_CERTIFICATE;

if (!appId || !appCertificate) {
  console.warn('⚠️  WARNING: Agora credentials not configured in .env');
  console.warn('AGORA_APP_ID:', appId ? '✅ Set' : '❌ Missing');
  console.warn('AGORA_APP_CERTIFICATE:', appCertificate ? '✅ Set' : '❌ Missing');
}

/**
 * Generate Agora RTC Token
 */
const generateAgoraToken = (channel, uid, role, expirationTimeInSeconds = 3600) => {
  try {
    if (!appId || !appCertificate) {
      throw new Error('Agora credentials not configured in .env file');
    }

    // Ensure UID is numeric
    if (typeof uid !== 'number') {
      uid = parseInt(uid) || Math.floor(Math.random() * 10000);
    }

    // ✅ FIX: Calculate current timestamp (seconds) + expiration duration
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    console.log('🎟️  Generating Agora token:');
    console.log('  Channel:', channel);
    console.log('  UID:', uid, '(numeric)');
    console.log('  Expires At (Unix):', privilegeExpiredTs);

    const agoraRole = role === 'teacher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channel,
      uid,
      agoraRole,
      privilegeExpiredTs // ✅ Correct absolute timestamp passed here
    );

    console.log('✅ Token generated successfully');
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