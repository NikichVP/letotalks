const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('node:http');
const { Duplex } = require('node:stream');
const { once } = require('events');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'letotalks-test-'));
const fixtureDb = path.join(tmpDir, 'letotalks.db');
// Свежая пустая БД: схему создаёт сам код (createDbProcessing), тесты вставляют
// нужные данные сами. Не зависим от (gitignored) репозиторного letotalks.db.

const repoRoot = path.join(__dirname, '..');
const repoDataDir = path.join(repoRoot, 'data');
const dataBackupDir = path.join(tmpDir, 'data-backup');
let restoreDataDir = false;
let dataDirHandled = false;
const shouldIsolateDataDir = process.env.RUN_INTEGRATION_TESTS !== '1';

if (shouldIsolateDataDir && fs.existsSync(repoDataDir)) {
  try {
    fs.cpSync(repoDataDir, dataBackupDir, { recursive: true });
    restoreDataDir = true;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  try {
    fs.rmSync(repoDataDir, { recursive: true, force: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function ensureRepoDataRestored() {
  if (!shouldIsolateDataDir) return;
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
process.env.ROOT_ADMIN_EMAIL = 'root-admin@student.letovo.ru';

const { app, db, constants } = require('../server');
const { SESSION_COOKIE } = constants;

test.after(async () => {
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
  receivedDislikes = 1,
  email = null
} = {}) {
  const now = Date.now();
  const userId = `u-${crypto.randomUUID()}`;
  const userEmail = (email || `${userId}@student.letovo.ru`).toLowerCase();
  const username = userEmail.split('@')[0];

  db.prepare(`INSERT INTO users (id, email, username, created_ts, last_login_ts, login_count, comment_count, rating_count, cast_likes, cast_dislikes, received_likes, received_dislikes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      userId,
      userEmail,
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

  return {
    userId,
    sessionToken,
    email: userEmail,
    commentCount,
    ratingCount,
    receivedLikes,
    receivedDislikes
  };
}

function authHeaders(token, extra = {}) {
  return {
    cookie: `${SESSION_COOKIE}=${token}`,
    'content-type': 'application/json',
    'user-agent': 'node',
    ...extra
  };
}

function expectedEarned({ commentCount, ratingCount, receivedLikes, receivedDislikes }) {
  return (commentCount * 5) + ratingCount + receivedLikes - receivedDislikes;
}

function normalizeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function matchRoutePath(routePath, pathname) {
  if (!routePath) return null;
  if (routePath instanceof RegExp) {
    return routePath.test(pathname) ? { params: {} } : null;
  }
  if (typeof routePath !== 'string') return null;
  if (!routePath.includes(':')) {
    return routePath === pathname ? { params: {} } : null;
  }
  const routeParts = routePath.split('/').filter(Boolean);
  const pathParts = pathname.split('?')[0].split('/').filter(Boolean);
  if (routeParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < routeParts.length; i += 1) {
    const routePart = routeParts[i];
    const pathPart = pathParts[i];
    if (routePart.startsWith(':')) {
      params[routePart.slice(1)] = decodeURIComponent(pathPart);
      continue;
    }
    if (routePart !== pathPart) return null;
  }
  return { params };
}

function getRouteHandler(pathname, method) {
  const methodLower = method.toLowerCase();
  for (const entry of app.router.stack) {
    if (!entry.route) continue;
    const match = matchRoutePath(entry.route.path, pathname);
    if (!match) continue;
    const matching = entry.route.stack.filter((layer) => layer.method === methodLower);
    if (!matching.length) continue;
    return { handler: matching[matching.length - 1].handle, params: match.params };
  }
  throw new Error(`Route not found for ${method} ${pathname}`);
}

async function dispatchJson(pathname, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = normalizeHeaders(options.headers || {});
  let body = options.body;

  if (body !== undefined && body !== null && typeof body !== 'string') {
    body = JSON.stringify(body);
  }

  if (body) {
    headers['content-length'] = Buffer.byteLength(body).toString();
    headers['content-type'] = headers['content-type'] || 'application/json';
  }

  let parsedBody = body;
  if (body && headers['content-type']?.includes('application/json')) {
    try {
      parsedBody = JSON.parse(body);
    } catch (err) {
      parsedBody = body;
    }
  }

  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  socket.readable = true;
  socket.writable = true;
  socket.remoteAddress = '127.0.0.1';

  const req = new http.IncomingMessage(socket);
  Object.setPrototypeOf(req, app.request);
  req.method = method;
  req.url = pathname;
  req.headers = headers;
  req.connection = socket;
  req.socket = socket;
  req.readable = true;
  if (req._readableState) {
    req._readableState.readable = true;
  }
  req.body = parsedBody;
  req.app = app;

  const res = new http.ServerResponse(req);
  Object.setPrototypeOf(res, app.response);
  res.assignSocket(socket);
  res.req = req;
  res.app = app;
  req.res = res;

  const bodyChunks = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = (chunk, encoding, callback) => {
    if (chunk) {
      bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    }
    return originalWrite(chunk, encoding, callback);
  };

  const responseFinished = new Promise((resolve) => {
    res.end = (chunk, encoding, callback) => {
      if (chunk) {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      const result = originalEnd(chunk, encoding, callback);
      resolve();
      return result;
    };
  });

  const route = getRouteHandler(pathname, method);
  req.params = route.params || {};
  const handler = route.handler;
  handler(req, res, (err) => {
    if (err) {
      res.statusCode = 500;
      res.end();
    }
  });
  await responseFinished;

  const bodyText = Buffer.concat(bodyChunks).toString('utf8');
  let data;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch (err) {
    data = bodyText;
  }

  return { response: { status: res.statusCode, headers: res.getHeaders() }, data };
}

function createTeacher() {
  const teacherId = `t-${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO teachers (id, last_name, first_name, patronymic, department, subjects, photo)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      teacherId,
      'Тестов',
      'Тест',
      'Тестович',
      'Тестовая кафедра',
      'Тестовые предметы',
      ''
    );
  return teacherId;
}

function createComment({ teacherId, author, authorUserId, text }) {
  const ts = Date.now();
  const tsIso = new Date(ts).toISOString();
  const result = db.prepare(`INSERT INTO comments (teacher_id, ts, ts_iso, author, text, author_uid)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(teacherId, ts, tsIso, author, text, authorUserId || '');
  return Number(result.lastInsertRowid);
}

function createVote({ commentId, userId, vote }) {
  const ts = Date.now();
  db.prepare(`INSERT INTO comment_votes (comment_id, user_id, vote, ts)
    VALUES (?, ?, ?, ?)`)
    .run(commentId, userId, vote, ts);
}

test('shop items include balances calculated from stats', async () => {
  const user = createAuthedUser();
  const { data, response } = await dispatchJson('/api/shop/items', {
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

  // Берём реальную цену из каталога, а не хардкодим — устойчиво к ценам БД/сида.
  const catalog = await dispatchJson('/api/shop/items', { headers: authHeaders(user.sessionToken) });
  const price = catalog.data.items.find((i) => i.id === itemId).price;

  const purchase = await dispatchJson('/api/shop/buy', {
    method: 'POST',
    headers: authHeaders(user.sessionToken),
    body: JSON.stringify({ itemId })
  });

  assert.equal(purchase.response.status, 200, 'purchase should succeed');
  assert.equal(purchase.data.ok, true, 'purchase response should have ok=true');

  const earned = expectedEarned(user);
  assert.equal(purchase.data.earnedCoins, earned, 'earned coins remain unchanged after purchase');
  assert.equal(purchase.data.spentCoins, price, 'spent coins should reflect the item price');
  assert.equal(purchase.data.balance, earned - price, 'balance should decrease by item price');

  const activation = await dispatchJson('/api/shop/activate', {
    method: 'POST',
    headers: authHeaders(user.sessionToken),
    body: JSON.stringify({ itemId })
  });

  assert.equal(activation.response.status, 200, 'activation should succeed');
  assert.equal(activation.data.ok, true, 'activation response should have ok=true');
  assert.equal(activation.data.balance, earned - price, 'balance should remain after activation');

  const mine = await dispatchJson('/api/shop/my-items', {
    headers: authHeaders(user.sessionToken)
  });

  assert.equal(mine.response.status, 200, 'my-items should succeed');
  assert.equal(mine.data.ok, true, 'my-items response should have ok=true');

  const purchasedItem = mine.data.items.find((item) => item.item_id === itemId);
  assert.ok(purchasedItem, 'purchased nickname should be returned in my-items');
  assert.equal(purchasedItem.is_active, 1, 'activated nickname should be marked active');
  assert.equal(mine.data.spentCoins, price, 'spent coins should match purchase price');
});

test('re-buying the same nickname is prevented with a clear error', async () => {
  const user = createAuthedUser();
  const itemId = 'nick-1';

  const first = await dispatchJson('/api/shop/buy', {
    method: 'POST',
    headers: authHeaders(user.sessionToken),
    body: JSON.stringify({ itemId })
  });
  assert.equal(first.response.status, 200);

  const repeat = await dispatchJson('/api/shop/buy', {
    method: 'POST',
    headers: authHeaders(user.sessionToken),
    body: JSON.stringify({ itemId })
  });

  assert.equal(repeat.response.status, 400, 'repeat purchase should fail');
  assert.equal(repeat.data.error, 'already_purchased', 'should return already_purchased error code');
});

test('auth/me switches between accounts without leaking session state', async () => {
  const userA = createAuthedUser();
  const userB = createAuthedUser();

  const meA = await dispatchJson('/api/auth/me', {
    headers: authHeaders(userA.sessionToken)
  });
  assert.equal(meA.data.loggedIn, true);
  assert.equal(meA.data.user.id, userA.userId);
  assert.equal(meA.data.user.email, userA.email);

  const meB = await dispatchJson('/api/auth/me', {
    headers: authHeaders(userB.sessionToken)
  });
  assert.equal(meB.data.loggedIn, true);
  assert.equal(meB.data.user.id, userB.userId);
  assert.equal(meB.data.user.email, userB.email);

  const meA2 = await dispatchJson('/api/auth/me', {
    headers: authHeaders(userA.sessionToken)
  });
  assert.equal(meA2.data.loggedIn, true);
  assert.equal(meA2.data.user.id, userA.userId);
});

test('teacher payload isolates votes per user even with caching', async () => {
  const userA = createAuthedUser();
  const userB = createAuthedUser();
  const teacherId = createTeacher();
  const commentId = createComment({
    teacherId,
    author: userA.email,
    authorUserId: userA.userId,
    text: 'vote-isolation'
  });

  createVote({ commentId, userId: userA.userId, vote: 1 });

  const payloadA = await dispatchJson(`/api/teacher/${teacherId}`, {
    headers: authHeaders(userA.sessionToken)
  });
  const commentA = payloadA.data.comments.find((c) => c.id === commentId);
  assert.ok(commentA, 'comment should be returned for user A');
  assert.equal(commentA.myVote, 1);
  assert.equal(commentA.isOwn, true);

  const payloadB = await dispatchJson(`/api/teacher/${teacherId}`, {
    headers: authHeaders(userB.sessionToken)
  });
  const commentB = payloadB.data.comments.find((c) => c.id === commentId);
  assert.ok(commentB, 'comment should be returned for user B');
  assert.equal(commentB.myVote, 0);
  assert.equal(commentB.isOwn, false);

  createVote({ commentId, userId: userB.userId, vote: -1 });

  const payloadB2 = await dispatchJson(`/api/teacher/${teacherId}`, {
    headers: authHeaders(userB.sessionToken)
  });
  const commentB2 = payloadB2.data.comments.find((c) => c.id === commentId);
  assert.ok(commentB2, 'comment should be returned after user B vote');
  assert.equal(commentB2.myVote, -1);
});

test('admin comment metadata does not leak to non-admin responses', async () => {
  const adminUser = createAuthedUser({ email: process.env.ROOT_ADMIN_EMAIL });
  const regularUser = createAuthedUser();
  const teacherId = createTeacher();
  const commentId = createComment({
    teacherId,
    author: adminUser.email,
    authorUserId: adminUser.userId,
    text: 'admin-metadata'
  });

  const adminPayload = await dispatchJson(`/api/teacher/${teacherId}`, {
    headers: authHeaders(adminUser.sessionToken)
  });
  const adminComment = adminPayload.data.comments.find((c) => c.id === commentId);
  assert.ok(adminComment, 'comment should be returned for admin');
  assert.equal(adminComment.author_uid, adminUser.userId);
  assert.equal(adminComment.author_email, adminUser.email);

  const regularPayload = await dispatchJson(`/api/teacher/${teacherId}`, {
    headers: authHeaders(regularUser.sessionToken)
  });
  const regularComment = regularPayload.data.comments.find((c) => c.id === commentId);
  assert.ok(regularComment, 'comment should be returned for regular user');
  assert.equal(Object.prototype.hasOwnProperty.call(regularComment, 'author_uid'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(regularComment, 'author_email'), false);
});
