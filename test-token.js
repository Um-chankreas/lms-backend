require('dotenv').config();
const { RtcTokenBuilder, RtcRole } = require('agora-token');

const appId = process.env.AGORA_APP_ID;
const appCertificate = process.env.AGORA_APP_CERTIFICATE;

console.log('\n🔍 Agora Token Test\n');
console.log('App ID:', appId ? appId.substring(0, 16) + '...' : '❌ NOT SET');
console.log('Certificate:', appCertificate ? appCertificate.substring(0, 16) + '...' : '❌ NOT SET');
console.log('Certificate Length:', appCertificate?.length || 0, '(should be 40)');

if (!appId || !appCertificate) {
    console.error('\n❌ ERROR: Missing Agora credentials in .env');
    console.log('\nFix: Add these to .env:');
    console.log('AGORA_APP_ID=your_app_id');
    console.log('AGORA_APP_CERTIFICATE=your_40_char_certificate');
    process.exit(1);
}

try {
    const channel = 'test-channel';
    const uid = 123456;
    const expirationTime = 3600;

    console.log('\n📝 Generating Token...');
    console.log('  Channel:', channel);
    console.log('  UID:', uid);
    console.log('  Role: PUBLISHER');
    console.log('  Expiration:', expirationTime, 'seconds');

    const token = RtcTokenBuilder.buildTokenWithUid(
        appId,
        appCertificate,
        channel,
        uid,
        RtcRole.PUBLISHER,
        expirationTime
    );

    console.log('\n✅ Token Generated Successfully!');
    console.log('\n🎟️  Token (first 100 chars):');
    console.log(token.substring(0, 100) + '...\n');

    console.log('📊 Token Details:');
    console.log('  Total Length:', token.length);
    console.log('  Starts with:', token.substring(0, 10));

    console.log('\n✅ Your Agora credentials are VALID!');

} catch (error) {
    console.error('\n❌ Token Generation Failed!');
    console.error('Error:', error.message);
    console.log('\n🔧 Common Fixes:');
    console.log('1. Check App Certificate is 40 characters');
    console.log('2. Verify App Certificate is ENABLED in Agora Console');
    console.log('3. Make sure App ID matches the Certificate');
    console.log('4. Check system time is correct');
    process.exit(1);
}