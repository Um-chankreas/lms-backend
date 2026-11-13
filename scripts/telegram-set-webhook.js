// One-off: point the Telegram bot at this API and set its commands.
//   node scripts/telegram-set-webhook.js            (uses PUBLIC_API_URL)
//   node scripts/telegram-set-webhook.js --delete   (stop receiving updates)
require('../src/config/loadEnv');
const tg = require('../src/utils/telegram');

(async () => {
  if (!tg.enabled()) { console.error('Set TELEGRAM_BOT_TOKEN first.'); process.exit(1); }
  if (process.argv.includes('--delete')) {
    console.log('deleteWebhook:', JSON.stringify(await tg.call('deleteWebhook', {})));
    return;
  }
  const base = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!base.startsWith('https://')) { console.error('PUBLIC_API_URL must be an https URL.'); process.exit(1); }
  if (!secret) { console.error('Set TELEGRAM_WEBHOOK_SECRET first.'); process.exit(1); }

  console.log('setWebhook:', JSON.stringify(await tg.call('setWebhook', {
    url: `${base}/api/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query']   // callback_query = taps on follow-up message buttons
  })));
  console.log('setMyCommands:', JSON.stringify(await tg.call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Connect to Romduol Scholars' },
      { command: 'stop', description: 'Turn live class reminders off' }
    ]
  })));
  console.log('webhook info:', JSON.stringify(await tg.call('getWebhookInfo', {})));
})();
