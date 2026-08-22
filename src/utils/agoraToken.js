const { RtcTokenBuilder, RtcRole } = require('agora-token');
 
const appId = process.env.AGORA_APP_ID;
const appCertificate = process.env.AGORA_APP_CERTIFICATE;
 
if (!appId || !appCertificate) {
  console.warn('⚠️  Warning: Agora credentials not configured in .env');
}
 
/**
 * Generate Agora RTC Token for live class
 * @param {string} channel - Channel name
 * @param {number} uid - User ID
 * @param {string} role - 'teacher' or 'student'
 * @param {number} expirationTime - Token expiration time in seconds (default: 3600 = 1 hour)
 * @returns {string} RTC Token
 */
const generateAgoraToken = (channel, uid, role, expirationTime = 3600) => {
  try {
    if (!appId || !appCertificate) {
      throw new Error('Agora credentials not configured');
    }
 
    // Teacher = PUBLISHER (can publish and receive)
    // Student = SUBSCRIBER (can only receive, but allow to publish too for questions)
    const agoraRole = role === 'teacher' ? RtcRole.PUBLISHER : RtcRole.PUBLISHER;
 
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channel,
      uid,
      agoraRole,
      expirationTime
    );
 
    return token;
  } catch (error) {
    console.error('Error generating Agora token:', error);
    throw error;
  }
};
 
module.exports = {
  generateAgoraToken,
  appId: appId
};
 