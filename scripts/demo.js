// One-command local demo: a fresh database with fictional data and the app on
// http://localhost:3001, isolated from every external service.
//
//   npm install && npm run demo
const http = require('http');
const path = require('path');
const { seedDemo } = require('./seed-demo');

const DEMO_DIR = path.join(__dirname, '..', '.demo');
const ADMIN_EMAIL = 'demo-admin@student.letovo.ru';

// Stand-in for the OpenAI moderation request: approves every review. The local
// profanity filter still runs before it, exactly as in production.
function startModerationStub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ output_text: '1' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const { dbPath, teachers, reviews } = seedDemo({ dbPath: path.join(DEMO_DIR, 'demo.db') });
  const stub = await startModerationStub();

  // Pin every setting the app reads, so a real .env in the checkout can't leak
  // into the demo: dotenv never overrides variables that are already set.
  Object.assign(process.env, {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    TRUST_PROXY: '',
    LETOTALKS_DB_PATH: dbPath,
    LETOTALKS_DATA_DIR: path.join(DEMO_DIR, 'data'),
    ROOT_ADMIN_EMAIL: ADMIN_EMAIL,
    ALLOWED_EMAIL_DOMAINS: '@student.letovo.ru',
    ALLOWED_LOGIN_EMAILS: '',
    RESEND_API_KEY: '', // no email: login codes are printed to this console
    TELEGRAM_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    TELEGRAM_WEBHOOK_SECRET: '',
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: '',
    GPT_MODERATION_API_KEY: 'demo',
    GPT_MODERATION_URL: `http://127.0.0.1:${stub.address().port}/v1/responses`,
    OUTBOUND_PROXY_URL: '',
    HTTPS_PROXY: '',
    HTTP_PROXY: '',
    ALL_PROXY: '',
  });

  const { startServer } = require('../server');
  startServer(undefined, (port) => {
    console.log(`Demo data: ${teachers} fictional teachers, ${reviews} reviews.`);
    console.log(`Open http://localhost:${port} and sign in as ${ADMIN_EMAIL} (admin)`);
    console.log('or student1…student14@student.letovo.ru. No email is sent: the one-time');
    console.log('code is printed in this console. New reviews are approved by a local');
    console.log('stub instead of the OpenAI check; the profanity filter still applies.\n');
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
