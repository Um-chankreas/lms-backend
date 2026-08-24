const dotenv = require('dotenv');

dotenv.config();

const {
  RtcTokenBuilder,
  RtcRole
} = require('agora-access-token');

const appId = process.env.AGORA_APP_ID;
const appCertificate = process.env.AGORA_APP_CERTIFICATE;

if (!appId) {
  console.error('❌ AGORA_APP_ID is missing');
}

if (!appCertificate) {
  console.error('❌ AGORA_APP_CERTIFICATE is missing');
}

/**
 * Generate Agora RTC token
 *
 * @param {string} channelName
 * @param {number} uid
 * @param {string} userRole
 */
function generateAgoraToken(channelName, uid, userRole = 'student') {
  if (!appId || !appCertificate) {
    throw new Error(
      'Agora App ID or App Certificate is missing'
    );
  }

  if (!channelName) {
    throw new Error('Agora channel name is required');
  }

  if (!uid) {
    throw new Error('Agora UID is required');
  }

  const role =
    userRole === 'teacher'
      ? RtcRole.PUBLISHER
      : RtcRole.SUBSCRIBER;

  // Token valid for 1 hour
  const expirationTimeInSeconds = 60 * 60;

  const currentTimestamp = Math.floor(Date.now() / 1000);

  const privilegeExpiredTs =
    currentTimestamp + expirationTimeInSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    uid,
    role,
    privilegeExpiredTs
  );

  return token;
}

module.exports = {
  generateAgoraToken,
  appId
};