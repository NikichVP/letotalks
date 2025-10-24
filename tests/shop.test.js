const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { once } = require('events');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letotalks-test-'));
const fixtureDb = path.join(tmpDir, 'letotalks.db');
const Database = require('better-sqlite3');
const fixtureSetupDb = new Database(fixtureDb);
fixtureSetupDb.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    username TEXT,
    created_ts INTEGER,
    last_login_ts INTEGER,
    login_count INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    rating_count INTEGER NOT NULL DEFAULT 0,
    cast_likes INTEGER NOT NULL DEFAULT 0,
    cast_dislikes INTEGER NOT NULL DEFAULT 0,
    received_likes INTEGER NOT NULL DEFAULT 0,
    received_dislikes INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE teachers (
    id TEXT PRIMARY KEY,
    last_name TEXT,
    first_name TEXT,
    patronymic TEXT,
    department TEXT,
    subjects TEXT,
    photo TEXT
  );
  CREATE TABLE ratings (
    teacher_id TEXT NOT NULL,
    key TEXT NOT NULL,
    sum REAL NOT NULL DEFAULT 0,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (teacher_id, key)
  );
  CREATE TABLE user_ratings (
    user_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL,
    PRIMARY KEY (user_id, teacher_id, key)
  );
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY,
    teacher_id TEXT,
    ts INTEGER,
    ts_iso TEXT,
    author TEXT,
    text TEXT,
    author_uid TEXT
  );
  CREATE TABLE comment_votes (
    comment_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    vote INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (comment_id, user_id)
  );
  CREATE TABLE admins (email TEXT PRIMARY KEY);
  CREATE TABLE banned_users (
    user_id TEXT PRIMARY KEY,
    is_banned INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    ts INTEGER
  );
  CREATE TABLE login_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER,
    ts_iso TEXT,
    action TEXT,
    email TEXT,
    ip TEXT,
    ua TEXT
  );
`);
fixtureSetupDb.close();

const repoRoot = path.join(__dirname, '..');
const repoDataDir = path.join(repoRoot, 'data');
const dataBackupDir = path.join(tmpDir, 'data-backup');
let restoreDataDir = false;
let dataDirHandled = false;

if (fs.existsSync(repoDataDir)) {
  fs.cpSync(repoDataDir, dataBackupDir, { recursive: true });
  fs.rmSync(repoDataDir, { recursive: true, force: true });
  restoreDataDir = true;
}

function ensureRepoDataRestored() {
  if (dataDirHandled) return;
  if (restoreDataDir) {
    try {
      fs.rmSync(repoDataDir, { recursive: true, force: true });
      fs.cpSync(dataBackupDir, repoDataDir, { recursive: true });
    } catch (err) {
      console.error('Failed to restore data directory after tests:', err);
    }
  } else {
    try {
      fs.rmSync(repoDataDir, { recursive: true, force: true });
    } catch (err) {
      // ignore removal errors for recreated data dir
    }
  }
  dataDirHandled = true;
}

process.once('exit', ensureRepoDataRestored);
process.once('SIGINT', () => {
  ensureRepoDataRestored();
  process.exit(130);
});
process.once('SIGTERM', () => {
  ensureRepoDataRestored();
  process.exit(143);
});

process.env.LETOTALKS_DB_PATH = fixtureDb;
process.env.NODE_ENV = 'test';

const { app, db, constants } = require('../server');
const { SESSION_COOKIE } = constants;

let server;
let baseUrl;

async function startTestServer() {
  server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopTestServer() {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()));
  });
  server = null;
}

test.before(async () => {
  await startTestServer();
});

test.after(async () => {
  await stopTestServer();
  try {
    db.close();
  } catch (err) {
    // ignore errors on shutdown
  }
  ensureRepoDataRestored();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    // ignore temp cleanup errors
  }
});

function createAuthedUser({
  commentCount = 20,
  ratingCount = 3,
  receivedLikes = 2,
  receivedDislikes = 1
} = {}) {
  const now = Date.now();
  const userId = `u-${crypto.randomUUID()}`;
  const email = `${userId}@student.letovo.ru`;
  const username = email.split('@')[0];

  db.prepare(`INSERT INTO users (id, email, username, created_ts, last_login_ts, login_count, comment_count, rating_count, cast_likes, cast_dislikes, received_likes, received_dislikes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      userId,
      email,
      username,
      now,
      now,
      1,
      commentCount,
      ratingCount,
      0,
      0,
      receivedLikes,
      receivedDislikes
    );

  const sessionId = `sess-${crypto.randomUUID()}`;
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
  const expiresTs = now + (14 * 24 * 60 * 60 * 1000);

  db.prepare(`INSERT INTO sessions (id, token_hash, user_id, created_ts, last_activity_ts, expires_ts, ip, user_agent, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(sessionId, tokenHash, userId, now, now, expiresTs, '127.0.0.1', 'tests');

  return {
    userId,
    sessionToken,
    email,
    commentCount,
    ratingCount,
    receivedLikes,
    receivedDislikes
  };
}

function authHeaders(token) {
  return {
    Cookie: `${SESSION_COOKIE}=${token}`,
    'Content-Type': 'application/json'
  };
}

function expectedEarned({ commentCount, ratingCount, receivedLikes, receivedDislikes }) {
  return (commentCount * 5) + ratingCount + receivedLikes - receivedDislikes;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  return { response, data };
}

test('shop items include balances calculated from stats', async () => {
  const user = createAuthedUser();
  const { data, response } = await fetchJson(`${baseUrl}/api/shop/items`, {
    headers: authHeaders(user.sessionToken)
  });

  assert.equal(response.status, 200, 'shop/items should respond with 200');
  assert.equal(data.ok, true, 'shop/items should return ok=true');

  const earned = expectedEarned(user);
  assert.equal(data.balance, earned, 'balance should equal earned coins before purchases');
  assert.equal(data.earnedCoins, earned, 'earnedCoins should match calculated value');
  assert.equal(data.spentCoins, 0, 'spentCoins should be zero without purchases');
});

test('buying and activating a nickname updates balances and inventory', async () => {
  const user = createAuthedUser();
  const itemId = 'nick-2';

  const purchase = await fetchJson(`${baseUrl}/api/shop/buy`, {
    method: 'POST',
    headers: authHeaders(user.sessionToken),
    body: JSON.stringify({ itemId })
  });

  assert.equal(purchase.response.status, 200, 'purchase should succeed');
  assert.equal(purchase.data.ok, true, 'purchase response should have ok=true');

  const earned = expectedEarned(user);
  assert.equal(purchase.data.earnedCoins, earned, 'earned coins remain unchanged after purchase');
  assert.equal(purchase.data.spentCoins, 50, 'spent coins should reflect the item price');
  assert.equal(purchase.data.balance, earned - 50, 'balance should decrease by item price');

  const activation = await fetchJson(`${baseUrl}/api/shop/activate`, {
    method: 'POST',
    headers: authHeaders(user.sessionToken),
    body: JSON.stringify({ itemId })
  });

  assert.equal(activation.response.status, 200, 'activation should succeed');
  assert.equal(activation.data.ok, true, 'activation response should have ok=true');
  assert.equal(activation.data.balance, earned - 50, 'balance should remain after activation');

  const mine = await fetchJson(`${baseUrl}/api/shop/my-items`, {
    headers: authHeaders(user.sessionToken)
  });

  assert.equal(mine.response.status, 200, 'my-items should succeed');
  assert.equal(mine.data.ok, true, 'my-items response should have ok=true');

  const purchasedItem = mine.data.items.find((item) => item.item_id === itemId);
  assert.ok(purchasedItem, 'purchased nickname should be returned in my-items');
  assert.equal(purchasedItem.is_active, 1, 'activated nickname should be marked active');
  assert.equal(mine.data.spentCoins, 50, 'spent coins should match purchase price');
});

test('re-buying the same nickname is prevented with a clear error', async () => {
  const user = createAuthedUser();
  const itemId = 'nick-1';

  const first = await fetchJson(`${baseUrl}/api/shop/buy`, {
    method: 'POST',
    headers: authHeaders(user.sessionToken),
    body: JSON.stringify({ itemId })
  });
  assert.equal(first.response.status, 200);

  const repeat = await fetchJson(`${baseUrl}/api/shop/buy`, {
    method: 'POST',
    headers: authHeaders(user.sessionToken),
    body: JSON.stringify({ itemId })
  });

  assert.equal(repeat.response.status, 400, 'repeat purchase should fail');
  assert.equal(repeat.data.error, 'already_purchased', 'should return already_purchased error code');
});
