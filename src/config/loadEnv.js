// Central environment loader — require this once, first thing, in every
// entry point (src/server.js and the scripts/* files). It loads the single
// .env file from the project root, so scripts work no matter the cwd.
//
// One .env per machine:
//   local   -> NODE_ENV=development + your personal Supabase project
//   server  -> NODE_ENV=production  + the company Supabase project
//
// Real host environment variables (systemd / pm2 / Docker / hosting
// dashboard) are left untouched — dotenv never overwrites a var that is
// already set.

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const NODE_ENV = process.env.NODE_ENV || 'development';
process.env.NODE_ENV = NODE_ENV;

module.exports = { NODE_ENV };
