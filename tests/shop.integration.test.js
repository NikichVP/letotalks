const test = require('node:test');
const assert = require('node:assert/strict');

const shouldRun = process.env.RUN_INTEGRATION_TESTS === '1';

if (!shouldRun) {
  test('shop buy accepts JSON body via middleware (integration)', { skip: true }, () => {});
} else {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const crypto = require('crypto');
  const { once } = require('events');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letotalks-integration-'));
  const fixtureDb = path.join(tmpDir, 'letotalks.db');
  fs.copyFileSync(path.join(__dirname, '..', 'letotalks.db'), fixtureDb);

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
    server = app.listen(0, '127.0.0.1');
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
      .run(sessionId, tokenHash, userId, now, now, expiresTs, '127.0.0.1', 'node');

    return { sessionToken };
  }

  test('shop buy accepts JSON body via middleware (integration)', async () => {
    const user = createAuthedUser();
    const response = await fetch(`${baseUrl}/api/shop/buy`, {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE}=${user.sessionToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'node'
      },
      body: JSON.stringify({ itemId: 'nick-1' })
    });

    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
  });
}
