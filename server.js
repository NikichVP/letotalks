// server.js — Node 18+ : npm i express better-sqlite3 bcrypt helmet express-rate-limit
// http://localhost:3000
//
// SQLite Database: letotalks.db
// Фото: photos/  -> /photo/<file>

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const ROOT_DIR    = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR    = path.join(ROOT_DIR, 'data');
const PHOTO_DIR   = path.join(ROOT_DIR, 'photos');
const DB_PATH     = process.env.LETOTALKS_DB_PATH
  ? path.resolve(process.env.LETOTALKS_DB_PATH)
  : path.join(ROOT_DIR, 'letotalks.db');

const ALLOWED_EMAIL_DOMAIN = '@student.letovo.ru';
const SESSION_COOKIE = 'lt_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 дней
const AUTH_SESSION_TTL_MS = 1000 * 60 * 10; // 10 минут
const AUTH_CHECK_INTERVAL_MS = 5000;
const MAX_SESSIONS_PER_USER = 5; // Максимум одновременных сессий
const SESSION_CLEANUP_INTERVAL = 1000 * 60 * 60; // Очистка каждый час
const BCRYPT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 10; // За час
const SECURITY_HEADERS_ENABLED = true;


app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/photo', express.static(PHOTO_DIR));
// --- Проверка токсичности через локальный Python API (uvicorn на 127.0.0.1:8001) ---
async function isToxicComment(text) {
  if (!text || !String(text).trim()) return false;
  try {
    const resp = await fetch('http://127.0.0.1:8001/toxicity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text) })
    });
    if (!resp.ok) {
      console.warn('toxicity API returned', resp.status);
      return false; // на время падения сервера — не блокируем публикацию
    }
    const data = await resp.json();
    // data формат зависит от твоего python-сервера; подстроил порог:
    // пример ожидаемого: { label: 'toxic'|'neutral'|'insult', score: 0.92 }
    const label = String(data.label || '').toLowerCase();
    const score = Number(data.score || 0);
    // считаем токсичным, если label содержит 'toxic' или score >= 0.6
    if (label.includes('toxic') || score >= 0.6) return true;
    return false;
  } catch (err) {
    console.warn('Ошибка запроса к toxicity API:', err && err.message ? err.message : err);
    // если сервер упал — лучше не блокировать комментарии; верни false
    return false;
  }
}


// === БЕЗОПАСНОСТЬ: Helmet для HTTP заголовков ===
if (SECURITY_HEADERS_ENABLED) {
  app.use(helmet({
    contentSecurityPolicy: false, // Отключаем CSP, чтобы стили работали
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  }));
}

// === БЕЗОПАСНОСТЬ: Rate Limiting ===
// Оставляем только для авторизации - защита от брутфорса
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: MAX_LOGIN_ATTEMPTS,
  message: 'Слишком много попыток входа, попробуйте через час',
  skipSuccessfulRequests: true,
  trustProxy: false
});

// Проверка и инициализация
function ensureDirsAndDb() {
  if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR, {recursive:true});
  if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, {recursive:true});

  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error('❌ База данных не найдена!');
    console.log('Запустите миграцию: npm run migrate');
    process.exit(1);
  }
}
ensureDirsAndDb();

// Подключаемся к БД
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Создаем таблицу для инвентаря пользователей
db.exec(`
  CREATE TABLE IF NOT EXISTS user_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    item_name TEXT NOT NULL,
    purchase_date INTEGER NOT NULL,
    price INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

// Индексы для быстрого поиска
db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_user_id ON user_inventory(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_item_id ON user_inventory(item_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_active ON user_inventory(user_id, is_active) WHERE is_active = 1`);

function ensureInventorySchemaUpToDate() {
  try {
    const columns = db.prepare('PRAGMA table_info(user_inventory)').all();
    const hasPrice = columns.some(col => col.name === 'price');
    if (!hasPrice) {
      db.exec('ALTER TABLE user_inventory ADD COLUMN price INTEGER NOT NULL DEFAULT 0');
    }
  } catch (err) {
    console.error('Не удалось обновить схему user_inventory:', err);
  }
}

ensureInventorySchemaUpToDate();

console.log('⚡ Инициализация сервера...');
console.log('✅ База данных подключена');

// === БЕЗОПАСНОСТЬ: Создание таблиц для сессий и логов ===
function initSecurityTables() {
  // Таблица сессий
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      created_ts INTEGER NOT NULL,
      last_activity_ts INTEGER NOT NULL,
      expires_ts INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_ts)`);

  // Таблица логов безопасности
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_iso TEXT NOT NULL,
      event_type TEXT NOT NULL,
      user_id TEXT,
      email TEXT,
      ip TEXT,
      user_agent TEXT,
      details TEXT,
      severity TEXT DEFAULT 'info'
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_security_log_ts ON security_log(ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_security_log_user ON security_log(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_security_log_type ON security_log(event_type)`);

  // Таблица попыток входа (для защиты от брутфорса)
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      ip TEXT NOT NULL,
      ts INTEGER NOT NULL,
      success INTEGER DEFAULT 0
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email, ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, ts)`);
}

initSecurityTables();

// === БЕЗОПАСНОСТЬ: Функции для работы с хешированными токенами ===
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateSecureToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function logSecurityEvent(eventType, details = {}) {
  try {
    const stmt = db.prepare(`
      INSERT INTO security_log (ts, ts_iso, event_type, user_id, email, ip, user_agent, details, severity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      Date.now(),
      new Date().toISOString(),
      eventType,
      details.userId || null,
      details.email || null,
      details.ip || null,
      details.userAgent || null,
      JSON.stringify(details),
      details.severity || 'info'
    );
  } catch (err) {
    console.error('Ошибка записи security log:', err);
  }
}

function recordLoginAttempt(email, ip, success) {
  try {
    const stmt = db.prepare('INSERT INTO login_attempts (email, ip, ts, success) VALUES (?, ?, ?, ?)');
    stmt.run(email, ip, Date.now(), success ? 1 : 0);
  } catch (err) {
    console.error('Ошибка записи login attempt:', err);
  }
}

function getRecentLoginAttempts(email, ip, windowMs = 3600000) {
  const cutoff = Date.now() - windowMs;
  const stmt = db.prepare(`
    SELECT COUNT(*) as count, SUM(success) as successful
    FROM login_attempts
    WHERE (email = ? OR ip = ?) AND ts > ?
  `);
  return stmt.get(email, ip, cutoff) || { count: 0, successful: 0 };
}

/* --- In-memory caches --- */
let ADMIN_EMAILS = new Set();
const PENDING_AUTH = new Map(); // sessionId -> { email, sid_token, code, created, seenIds:Set, verified:false, ip, ua }

function syncAdminsFromFile() {
  const adminsPath = path.join(DATA_DIR, 'admins.csv');
  if (!fs.existsSync(adminsPath)) return [];

  try {
    const fileContent = fs.readFileSync(adminsPath, 'utf8');
    const emails = fileContent
      .split(/\r?\n/)
      .map(e => String(e || '').trim().toLowerCase())
      .filter(e => e && e.includes('@'));

    if (!emails.length) return [];

    const insert = db.prepare('INSERT OR IGNORE INTO admins (email, role) VALUES (?, ?)');
    const tx = db.transaction(list => {
      for (const email of list) {
        insert.run(email, 'admin');
      }
    });
    tx(emails);

    return emails;
  } catch (err) {
    console.error('Не удалось синхронизировать список админов из файла:', err);
    return [];
  }
}

/* Teachers */
function loadAdminEmails() {
  const stmt = db.prepare('SELECT email FROM admins');
  const rows = stmt.all();
  ADMIN_EMAILS = new Set(rows.map(r => r.email.toLowerCase()));
}

syncAdminsFromFile();
loadAdminEmails();

function isAdminUser(u) {
  const email = String(u?.email || '').toLowerCase();
  return ADMIN_EMAILS.has(email);
}

function calculateEarnedCoins(user) {
  if (!user) return 0;
  const comments = Number(user.comment_count || 0);
  const ratings = Number(user.rating_count || 0);
  const receivedLikes = Number(user.received_likes || 0);
  const receivedDislikes = Number(user.received_dislikes || 0);
  return (comments * 5) + ratings + receivedLikes - receivedDislikes;
}

function getUserSpentCoins(userId) {
  if (!userId) return 0;
  const row = db.prepare('SELECT COALESCE(SUM(price), 0) as total FROM user_inventory WHERE user_id = ?').get(userId);
  return Number(row?.total || 0);
}

function getAvailableCoins(user) {
  if (!user) return 0;
  const earned = calculateEarnedCoins(user);
  const spent = getUserSpentCoins(user.id);
  return Math.max(0, earned - spent);
}

function coinsOf(user) {
  return getAvailableCoins(user);
}

const CHARACTERISTICS_KEYS=['clarity','humor','strict','favorites'];

function overall(r){
  let tot=0,cnt=0;
  for(const k of CHARACTERISTICS_KEYS){
    const v=r[k];
    if(v&&v.count){ tot+=v.sum/v.count; cnt++; }
  }
  return cnt?tot/cnt:0;
}

/* API helper functions */

function getAllTeachers() {
  const stmt = db.prepare('SELECT * FROM teachers ORDER BY last_name, first_name');
  return stmt.all();
}

function getTeacherById(id) {
  const stmt = db.prepare('SELECT * FROM teachers WHERE id = ?');
  return stmt.get(id);
}

function getRatingsForTeacher(teacherId) {
  const stmt = db.prepare('SELECT key, sum, count FROM ratings WHERE teacher_id = ?');
  const rows = stmt.all(teacherId);
  const result = {};
  for (const k of CHARACTERISTICS_KEYS) {
    result[k] = { sum: 0, count: 0 };
  }
  for (const row of rows) {
    if (CHARACTERISTICS_KEYS.includes(row.key)) {
      result[row.key] = { sum: row.sum, count: row.count };
    }
  }
  return result;
}

function getAllRatings() {
  const stmt = db.prepare('SELECT teacher_id, key, sum, count FROM ratings');
  const rows = stmt.all();
  const map = {};
  for (const row of rows) {
    if (!map[row.teacher_id]) map[row.teacher_id] = {};
    map[row.teacher_id][row.key] = { sum: row.sum, count: row.count };
  }
  return map;
}

function getCommentsForTeacher(teacherId) {
  const stmt = db.prepare('SELECT * FROM comments WHERE teacher_id = ? ORDER BY ts DESC');
  return stmt.all(teacherId);
}

function getAllComments() {
  const stmt = db.prepare('SELECT * FROM comments ORDER BY ts DESC');
  return stmt.all();
}

function getCommentById(commentId) {
  const stmt = db.prepare('SELECT * FROM comments WHERE id = ?');
  return stmt.get(commentId);
}

function getNextCommentId() {
  const stmt = db.prepare('SELECT MAX(id) as maxId FROM comments');
  const row = stmt.get();
  return (row.maxId || 0) + 1;
}

function addComment({ teacherId, author = 'Аноним', text, author_uid = '' }) {
  const ts = Date.now();
  const id = getNextCommentId();
  const stmt = db.prepare('INSERT INTO comments (id, teacher_id, ts, ts_iso, author, text, author_uid) VALUES (?, ?, ?, ?, ?, ?, ?)');
  stmt.run(id, teacherId, ts, new Date(ts).toISOString(), author, text, author_uid);
  return id;
}

function deleteComment(commentId) {
  const stmt = db.prepare('DELETE FROM comments WHERE id = ?');
  const info = stmt.run(commentId);
  return info.changes > 0;
}

function updateRatings(teacherId, ratings) {
  const upsert = db.prepare('INSERT INTO ratings (teacher_id, key, sum, count) VALUES (?, ?, ?, ?) ON CONFLICT(teacher_id, key) DO UPDATE SET sum = sum + excluded.sum, count = count + excluded.count');

  for (const key of Object.keys(ratings)) {
    if (!CHARACTERISTICS_KEYS.includes(key)) continue;
    const v = Number(ratings[key]);
    if (!(v >= 1 && v <= 5)) continue;
    upsert.run(teacherId, key, v, 1);
  }
}

// Votes
function getUserVote(commentId, userId) {
  const stmt = db.prepare('SELECT vote FROM comment_votes WHERE comment_id = ? AND user_id = ?');
  const row = stmt.get(commentId, userId);
  return row ? row.vote : 0;
}

function setUserVote(commentId, userId, newVote) {
  if (newVote === 0) {
    const stmt = db.prepare('DELETE FROM comment_votes WHERE comment_id = ? AND user_id = ?');
    stmt.run(commentId, userId);
  } else {
    const stmt = db.prepare('INSERT INTO comment_votes (comment_id, user_id, vote, ts) VALUES (?, ?, ?, ?) ON CONFLICT(comment_id, user_id) DO UPDATE SET vote = excluded.vote, ts = excluded.ts');
    stmt.run(commentId, userId, newVote, Date.now());
  }
}

function countVotesForCommentBulk(commentIds, myUserId = null) {
  if (!commentIds.length) return { counts: {}, myVotes: {} };

  const placeholders = commentIds.map(() => '?').join(',');
  const stmt = db.prepare(`SELECT comment_id, vote FROM comment_votes WHERE comment_id IN (${placeholders})`);
  const rows = stmt.all(...commentIds);

  const counts = {};
  const myVotes = {};
  const userIdStr = myUserId ? String(myUserId) : null;

  for (const cid of commentIds) {
    counts[String(cid)] = { likes: 0, dislikes: 0 };
  }

  for (const row of rows) {
    const key = String(row.comment_id);
    if (!counts[key]) counts[key] = { likes: 0, dislikes: 0 };

    if (row.vote === 1) counts[key].likes++;
    else if (row.vote === -1) counts[key].dislikes++;

    if (userIdStr && row.user_id === userIdStr) {
      myVotes[key] = row.vote;
    }
  }

  return { counts, myVotes };
}

// Users

// Функция для получения отображаемого имени пользователя (с учетом купленных ников)
function getDisplayName(user) {
  if (!user) return 'Student';

  // Сначала проверяем активный ник в инвентаре
  const nickStmt = db.prepare(`
    SELECT item_name FROM user_inventory
    WHERE user_id = ? AND item_type = 'nickname' AND is_active = 1
    LIMIT 1
  `);

  const activeNick = nickStmt.get(user.id);
  if (activeNick) {
    return activeNick.item_name;
  }

  // Иначе используем стандартное имя
  return (user.username || user.email || 'Student').split('@')[0];
}

function findUserByEmail(email) {
  const stmt = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)');
  return stmt.get(email);
}

function findUserById(userId) {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  return stmt.get(userId);
}

function upsertUserOnLogin(email) {
  const now = Date.now();
  const username = String(email).split('@')[0];

  let user = findUserByEmail(email);

  if (!user) {
    const id = 'u-' + crypto.randomBytes(8).toString('hex');
    const stmt = db.prepare('INSERT INTO users (id, email, username, created_ts, last_login_ts, login_count, comment_count, rating_count, cast_likes, cast_dislikes, received_likes, received_dislikes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    stmt.run(id, email, username, now, now, 1, 0, 0, 0, 0, 0, 0);
    user = findUserById(id);
  } else {
    const stmt = db.prepare('UPDATE users SET username = ?, last_login_ts = ?, login_count = login_count + 1 WHERE id = ?');
    stmt.run(username, now, user.id);
    user = findUserById(user.id);
  }

  return user;
}

function incUserStats(userId, { comments = 0, ratings = 0, cast_like = 0, cast_dislike = 0, recv_like = 0, recv_dislike = 0 } = {}) {
  const stmt = db.prepare(`UPDATE users SET
    comment_count = comment_count + ?,
    rating_count = rating_count + ?,
    cast_likes = cast_likes + ?,
    cast_dislikes = cast_dislikes + ?,
    received_likes = received_likes + ?,
    received_dislikes = received_dislikes + ?
    WHERE id = ?`);
  stmt.run(comments, ratings, cast_like, cast_dislike, recv_like, recv_dislike, userId);
}

function isUserBanned(userId) {
  const stmt = db.prepare('SELECT is_banned FROM banned_users WHERE user_id = ?');
  const row = stmt.get(userId);
  return row ? !!row.is_banned : false;
}

function setBanStatus(userId, banned, reason = '') {
  const stmt = db.prepare('INSERT INTO banned_users (user_id, is_banned, reason, ts) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET is_banned = excluded.is_banned, reason = excluded.reason, ts = excluded.ts');
  stmt.run(userId, banned ? 1 : 0, reason, Date.now());
}

// Teachers CRUD
function upsertTeacher(teacher) {
  const { id, lastName, firstName, patronymic, department, subjects, photo } = teacher;
  const subjectsStr = Array.isArray(subjects) ? subjects.join('|') : String(subjects || '');
  const photoStr = photo ? (photo.startsWith('/photo/') ? photo : `/photo/${photo}`) : null;

  const stmt = db.prepare('INSERT INTO teachers (id, last_name, first_name, patronymic, department, subjects, photo) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_name = excluded.last_name, first_name = excluded.first_name, patronymic = excluded.patronymic, department = excluded.department, subjects = excluded.subjects, photo = excluded.photo');
  stmt.run(id, lastName || '', firstName || '', patronymic || '', department || '', subjectsStr, photoStr);
}

function deleteTeacherById(id) {
  // Удалится также связанные комментарии, рейтинги и голоса благодаря ON DELETE CASCADE
  const stmt = db.prepare('DELETE FROM teachers WHERE id = ?');
  const info = stmt.run(id);
  return info.changes > 0;
}

/* Sessions & Auth */
app.set('trust proxy', true);

function getClientIp(req){
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || '0.0.0.0';
}

function parseCookies(req){
  const header = req.headers['cookie'] || '';
  const out = {};
  header.split(';').forEach(p=>{
    const [k, ...v] = p.trim().split('=');
    if (!k) return;
    out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}

// === БЕЗОПАСНОСТЬ: Управление сессиями через БД ===
function setSessionCookie(res, token){
  const maxAge = SESSION_TTL_MS;
  const secureFlag = IS_PRODUCTION ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=${Math.floor(maxAge/1000)}`
  );
}

function clearSessionCookie(res){
  const secureFlag = IS_PRODUCTION ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=0`);
}

function createSession(userId, req){
  const token = generateSecureToken();
  const tokenHash = hashToken(token);
  const now = Date.now();
  const expiresTs = now + SESSION_TTL_MS;
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const sessionId = 'ses-' + crypto.randomBytes(12).toString('hex');

  // Ограничение количества сессий на пользователя
  const existingSessions = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE user_id = ? AND is_active = 1').get(userId);
  if (existingSessions && existingSessions.count >= MAX_SESSIONS_PER_USER) {
    // Удаляем самую старую сессию
    db.prepare('DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE user_id = ? AND is_active = 1 ORDER BY last_activity_ts ASC LIMIT 1)').run(userId);

    logSecurityEvent('session_limit_reached', {
      userId,
      ip,
      userAgent: ua,
      severity: 'warning'
    });
  }

  const stmt = db.prepare(`
    INSERT INTO sessions (id, token_hash, user_id, created_ts, last_activity_ts, expires_ts, ip, user_agent, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  stmt.run(sessionId, tokenHash, userId, now, now, expiresTs, ip, ua);

  logSecurityEvent('session_created', {
    userId,
    sessionId,
    ip,
    userAgent: ua
  });

  return token;
}

function getUserFromRequest(req){
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const tokenHash = hashToken(token);
  const stmt = db.prepare(`
    SELECT * FROM sessions
    WHERE token_hash = ? AND is_active = 1 AND expires_ts > ?
  `);

  const session = stmt.get(tokenHash, Date.now());
  if (!session) return null;

  // Проверка IP (опционально, для усиленной безопасности)
  const currentIp = getClientIp(req);
  if (session.ip && session.ip !== currentIp) {
    logSecurityEvent('session_ip_mismatch', {
      userId: session.user_id,
      sessionIp: session.ip,
      requestIp: currentIp,
      severity: 'warning'
    });
    // Не блокируем, но логируем (IP может меняться легитимно)
  }

  // Обновляем время последней активности
  db.prepare('UPDATE sessions SET last_activity_ts = ? WHERE id = ?').run(Date.now(), session.id);

  const user = findUserById(session.user_id);
  return user || null;
}

function invalidateSession(token) {
  if (!token) return;
  const tokenHash = hashToken(token);
  db.prepare('UPDATE sessions SET is_active = 0 WHERE token_hash = ?').run(tokenHash);
}

function invalidateAllUserSessions(userId) {
  db.prepare('UPDATE sessions SET is_active = 0 WHERE user_id = ?').run(userId);
  logSecurityEvent('all_sessions_invalidated', {
    userId,
    severity: 'warning'
  });
}

// Автоматическая очистка истекших сессий
function cleanupExpiredSessions() {
  const deleted = db.prepare('DELETE FROM sessions WHERE expires_ts < ? OR is_active = 0').run(Date.now());
  if (deleted.changes > 0) {
    console.log(`🧹 Очищено ${deleted.changes} истекших сессий`);
  }
}

// Очистка старых логов (старше 90 дней)
function cleanupOldLogs() {
  const cutoff = Date.now() - (90 * 24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM security_log WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM login_attempts WHERE ts < ?').run(cutoff);
}

// Запускаем очистку периодически
const cleanupTimer = setInterval(() => {
  cleanupExpiredSessions();
  cleanupOldLogs();
}, SESSION_CLEANUP_INTERVAL);

if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

/* Rate limiters */
function limitPerIp(minIntervalMs){
  const lastByIp = new Map();
  return function(req, res, next){
    const ip = getClientIp(req);
    const now = Date.now();
    const last = lastByIp.get(ip) || 0;
    const diff = now - last;
    if (diff < minIntervalMs){
      const retryMs = minIntervalMs - diff;
      const retrySec = Math.ceil(retryMs / 1000);
      res.setHeader('Retry-After', retrySec);
      return res.status(429).json({
        error: 'rate_limited',
        message: `Слишком часто. Попробуйте через ${retrySec} сек.`,
        retry_after_ms: retryMs
      });
    }
    lastByIp.set(ip, now);
    next();
  };
}

const commentPerMinuteLimiter = limitPerIp(30_000);
// Rate limiting убран для обычных API запросов

function createSlidingWindowLimiter({ windowMs, maxRequests }) {
  const buckets = new Map();

  function pruneOldEntries(now) {
    for (const [ip, state] of buckets.entries()) {
      if (now - state.windowStart > windowMs * 2) {
        buckets.delete(ip);
      }
    }
  }

  return function(req, res, next) {
    const ip = getClientIp(req);
    const now = Date.now();
    let state = buckets.get(ip);
    if (!state || now - state.windowStart >= windowMs) {
      state = { windowStart: now, count: 0 };
    }
    state.count += 1;
    state.windowStart = state.windowStart ?? now;
    buckets.set(ip, state);

    if (state.count > maxRequests) {
      const retryMs = windowMs - (now - state.windowStart);
      const retrySec = Math.max(1, Math.ceil(retryMs / 1000));
      res.setHeader('Retry-After', retrySec);
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Слишком много запросов. Попробуйте немного позже.',
        retry_after_ms: Math.max(0, retryMs)
      });
    }

    if (buckets.size > 1000) pruneOldEntries(now);
    next();
  };
}

const apiRateLimiter = createSlidingWindowLimiter({ windowMs: 60_000, maxRequests: 120 });
app.use('/api', apiRateLimiter);


/* GuerrillaMail helpers */
async function gmGetEmailAddress(){
  const url = 'https://api.guerrillamail.com/ajax.php?f=get_email_address&lang=ru';
  const r = await fetch(url).catch(()=>null);
  if (!r || !r.ok) throw new Error('gm_get_email_failed');
  const j = await r.json();
  return { email: j.email_addr, sid_token: j.sid_token };
}

async function gmCheckEmail(sid_token){
  const url = `https://api.guerrillamail.com/ajax.php?f=check_email&seq=1&sid_token=${encodeURIComponent(sid_token)}`;
  const r = await fetch(url).catch(()=>null);
  if (!r || !r.ok) return [];
  const j = await r.json();
  return Array.isArray(j.list) ? j.list : [];
}

async function gmFetchEmail(sid_token, id){
  const url = `https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${encodeURIComponent(id)}&sid_token=${encodeURIComponent(sid_token)}`;
  const r = await fetch(url).catch(()=>null);
  if (!r || !r.ok) return null;
  return await r.json();
}

function extractCode(text){
  if (!text) return null;
  const m = String(text).match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

function extractPureEmail(s){
  if (!s) return '';
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : String(s)).trim().toLowerCase();
}

/* --- PUBLIC API --- */

app.get('/api/departments',(req,res)=>{
  const teachers = getAllTeachers();
  const set = new Set(teachers.map(t=>t.department).filter(Boolean));
  res.json({departments:[...set].sort(new Intl.Collator('ru',{sensitivity:'base'}).compare)});
});

app.get('/api/teachers',(req,res)=>{
  const teachers = getAllTeachers();
  const ratingsMap = getAllRatings();

  const result = teachers.map(t=>{
    const ratings = {};
    for(const k of CHARACTERISTICS_KEYS){
      ratings[k] = ratingsMap[t.id]?.[k] || {sum:0,count:0};
    }
    return {
      id: t.id,
      lastName: t.last_name,
      firstName: t.first_name,
      patronymic: t.patronymic,
      department: t.department,
      photo: t.photo,
      subjects: t.subjects ? t.subjects.split('|') : [],
      ratings,
      overall: overall(ratings)
    };
  });

  res.json({teachers: result});
});

app.get('/api/teacher/:id',(req,res)=>{
  const t = getTeacherById(req.params.id);
  if(!t) return res.status(404).json({error:'not_found'});

  const ratings = getRatingsForTeacher(t.id);
  const commentsRaw = getCommentsForTeacher(t.id);

  const u = getUserFromRequest(req);
  const myId = u?.id || null;
  const amAdmin = isAdminUser(u);

  const ids = commentsRaw.map(c=>String(c.id));
  const {counts, myVotes} = countVotesForCommentBulk(ids, myId);

  const comments = commentsRaw.map(c=>{
    const base = {
      id: c.id,
      teacherId: c.teacher_id,
      ts: c.ts,
      ts_iso: c.ts_iso,
      author: c.author,
      text: c.text,
      likes: (counts[String(c.id)]?.likes)||0,
      dislikes: (counts[String(c.id)]?.dislikes)||0,
      myVote: myVotes[String(c.id)]||0,
      isOwn: !!(myId && c.author_uid && String(c.author_uid)===String(myId))
    };
    if (amAdmin) {
      const au = c.author_uid ? findUserById(String(c.author_uid)) : null;
      return { ...base, author_uid: c.author_uid||'', author_email: au?.email || '' };
    }
    return base;
  });

  res.json({
    id: t.id,
    lastName: t.last_name,
    firstName: t.first_name,
    patronymic: t.patronymic,
    department: t.department,
    photo: t.photo,
    subjects: t.subjects ? t.subjects.split('|') : [],
    ratings,
    comments,
    overall: overall(ratings)
  });
});


/* Сильная модерация мата */
// Нормализация и проверка: кир/лат, 1337, пробелы/символы, удвоения
const BAD_STEMS = [
  'бля','бляд','хуй','хуе','пизд','еб','ёб','сука','сук','мраз','гандон',
  'пидор','пидр','чмо','урод','нахуй','нехуй','охуе','долбоёб','долбаёб','долбаеб','долбоеб'
];
const LAT2CYR = { 'a':'а','b':'в','c':'с','e':'е','h':'н','k':'к','m':'м','o':'о','p':'р','t':'т','x':'х','y':'у' };
const LEET = { '0':'о','1':'i','3':'е','4':'а','5':'с','6':'б','7':'т','8':'в','9':'д' };
/* --- Модель токсичности RuBERT --- */


/* --- Проверка мата --- */
function normalizeForBadWords(s) {
  let t = String(s || '').toLowerCase();
  t = t.replace(/[0-9]/g, ch => LEET[ch] || ch);
  t = t.replace(/[a-z]/g, ch => LAT2CYR[ch] || ch); // латиница → кириллица
  t = t.replace(/[\s\.\,\-\_\*\+\=\!\?\(\)\[\]\{\}\/\\\|\'\"\:;@#\$%^&`~]+/g, ''); // убрать разделители
  t = t.replace(/(.)\1{2,}/g, '$1$1'); // сжать длинные повторения
  return t;
}

function hasBadWords(text) {
  const norm = normalizeForBadWords(text);
  return BAD_STEMS.some(st => norm.includes(st));
}


// Комментарии + рейтинг + модерация (локальная + опциональная модель)
app.post('/api/comment-with-ratings', commentPerMinuteLimiter, async (req, res) => {
  try {
    const { teacherId, text, author, ratings } = req.body || {};
    if (!teacherId) return res.status(400).json({ error: 'bad_request' });

    const t = getTeacherById(teacherId);
    if (!t) return res.status(404).json({ error: 'teacher_not_found' });

    const u = getUserFromRequest(req);
    const userId = u?.id || '';
    const authorName = String(author || (u ? u.username : 'Аноним')).slice(0, 64);
    const textStr = String(text || '').trim();

    const hasRatings = ratings && typeof ratings === 'object' && Object.keys(ratings).some(k => {
      const v = Number(ratings[k]);
      return Array.isArray(CHARACTERISTICS_KEYS) && CHARACTERISTICS_KEYS.includes(k) && v >= 1 && v <= 5;
    });

    if (!textStr && !hasRatings) {
      return res.status(400).json({ error: 'bad_request', message: 'empty' });
    }

    // Бан — блокируем только текстовые комментарии
    if (textStr && u && isUserBanned(u.id)) {
      return res.status(403).json({ error: 'banned', message: 'commenting_banned' });
    }

    // Локальная проверка мата
    if (textStr && hasBadWords(textStr)) {
      return res.status(400).json({ error: 'profanity_forbidden' });
    }

    // Вызов внешней модели токсичности (опционально, если fetch доступен и задан URL)
    if (textStr) {
      let toxicScore = 0;
      try {
        if (typeof fetch === 'function') {
          const toxxUrl = typeof TOXICITY_SERVER_URL !== 'undefined' ? TOXICITY_SERVER_URL : 'http://127.0.0.1:8001/toxicity';
          const r = await fetch(toxxUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: textStr })
          });

          if (r.ok) {
            const jr = await r.json();

            // Универсальный разбор возможных форматов ответа
            if (jr && Array.isArray(jr.probs) && jr.probs.length >= 2) {
              toxicScore = Number(jr.probs[1]) || 0;
            } else if (jr && Array.isArray(jr.logits) && jr.logits.length >= 2) {
              try {
                const l0 = Number(jr.logits[0]) || 0;
                const l1 = Number(jr.logits[1]) || 0;
                const max = Math.max(l0, l1);
                const e0 = Math.exp(l0 - max);
                const e1 = Math.exp(l1 - max);
                toxicScore = e1 / (e0 + e1);
              } catch (e) { toxicScore = 0; }
            } else if (Array.isArray(jr) && jr.length > 0 && jr[0].label) {
              for (const it of jr) {
                const lab = String(it.label || '').toLowerCase();
                const sc = Number(it.score || 0);
                if (lab.includes('tox') || lab === 'label_1' || lab === 'label1') toxicScore = Math.max(toxicScore, sc);
              }
              if (!toxicScore && jr.length === 1) {
                const lab = String(jr[0].label || '').toLowerCase();
                if (lab.includes('tox')) toxicScore = Number(jr[0].score || 0);
              }
            } else if (jr && (jr.toxic === true || jr.is_toxic === true || String(jr.label||'').toLowerCase().includes('tox'))) {
              toxicScore = 1;
            }
          } else {
            console.warn('toxicity server returned non-ok', r.status);
          }
        } else {
          // fetch отсутствует — пропускаем вызов модели (локальная модерация уже выполнена)
          console.warn('fetch is not available — skipping toxicity server call');
        }
      } catch (err) {
        console.warn('failed to call toxicity server:', err && err.message ? err.message : err);
        // фоллбек: при ошибке модели не блокируем (как ты и просила — локальная модерация остаётся)
      }

      const thresh = typeof TOXICITY_THRESHOLD !== 'undefined' ? TOXICITY_THRESHOLD : 0.8;
      if (toxicScore >= thresh) {
        return res.status(400).json({ error: 'toxic_comment', message: 'Комментарий отклонён как токсичный', score: toxicScore });
      }
    }

    // Сохраняем комментарий (используем только новую функцию addComment)
    if (textStr) {
      try {
        // предполагается, что addComment может быть async и вернуть id или объект
        await addComment({ teacherId, author: authorName, text: textStr, author_uid: userId || '' });
      } catch (err) {
        console.error('addComment failed:', err && err.message ? err.message : err);
        return res.status(500).json({ error: 'server_error', message: 'failed_to_save_comment' });
      }
    }

    // Обновляем рейтинг (используем только новую функцию updateRatings)
    if (hasRatings) {
      try {
        await updateRatings(teacherId, ratings);
      } catch (err) {
        console.error('updateRatings failed:', err && err.message ? err.message : err);
        // не прерываем основной поток — вернём ответ с тем, что успели сохранить
      }
    }

    // Статистика пользователя — считаем валидные оценки и комментарии
    if (u) {
      try {
        let validRatings = 0;
        if (ratings && typeof ratings === 'object') {
          for (const k of Object.keys(ratings)) {
            const v = Number(ratings[k]);
            if (Array.isArray(CHARACTERISTICS_KEYS) && CHARACTERISTICS_KEYS.includes(k) && v >= 1 && v <= 5) validRatings++;
          }
        }
        incUserStats(u.id, { comments: textStr ? 1 : 0, ratings: validRatings });
      } catch (err) {
        console.warn('incUserStats failed:', err && err.message ? err.message : err);
      }
    }

    // Формируем и отдаем ответ в формате новой версии проекта
    const retRatings = typeof getRatingsForTeacher === 'function' ? getRatingsForTeacher(teacherId) : {};
    const comments = typeof getCommentsForTeacher === 'function' ? getCommentsForTeacher(teacherId) : [];

    return res.json({
      ok: true,
      teacher: {
        id: t.id,
        lastName: t.last_name,
        firstName: t.first_name,
        patronymic: t.patronymic,
        department: t.department,
        photo: t.photo,
        subjects: t.subjects ? t.subjects.split('|') : [],
        ratings: retRatings,
        comments,
        overall: typeof overall === 'function' ? overall(retRatings) : null
      }
    });
  } catch (err) {
    console.error('Unhandled error in /api/comment-with-ratings:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/comment/vote', (req,res)=>{
  const u = getUserFromRequest(req);
  if (!u) return res.json({error:'unauthorized'});

  const {commentId, vote} = req.body || {};
  const c = getCommentById(commentId);
  if (!c) return res.json({error:'not_found'});

  if (c.author_uid && String(c.author_uid)===String(u.id)){
    return res.json({error:'forbidden'});
  }

  const newVote = vote==='like' ? 1 : vote==='dislike' ? -1 : 0;
  const prev = getUserVote(commentId, u.id);

  if (prev === newVote){
    const {counts} = countVotesForCommentBulk([String(commentId)], u.id);
    const cnt = counts[String(commentId)] || {likes:0,dislikes:0};
    return res.json({ok:true, likes:cnt.likes, dislikes:cnt.dislikes, myVote:newVote});
  }

  setUserVote(commentId, u.id, newVote);

  const cast_like     = (newVote===1?1:0)  - (prev===1?1:0);
  const cast_dislike  = (newVote===-1?1:0) - (prev===-1?1:0);
  const recv_like     = cast_like;
  const recv_dislike  = cast_dislike;

  if (cast_like || cast_dislike) incUserStats(u.id, { cast_like, cast_dislike });
  if (c.author_uid) incUserStats(String(c.author_uid), { recv_like, recv_dislike });

  const {counts} = countVotesForCommentBulk([String(commentId)], u.id);
  const cnt = counts[String(commentId)] || {likes:0,dislikes:0};
  res.json({ok:true, likes:cnt.likes, dislikes:cnt.dislikes, myVote:newVote});
});

/* --- ADMIN API --- */

function requireAdmin(req,res,next){
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({error:'unauthorized'});
  if (!isAdminUser(u)) return res.status(403).json({error:'forbidden'});
  req.user = u;
  next();
}

app.get('/api/admin/commenters', requireAdmin, (req,res)=>{
  const comments = getAllComments();
  const counts = {};
  const lastTs = {};

  for (const c of comments) {
    const uid = String(c.author_uid||'').trim();
    if (!uid) continue;
    counts[uid] = (counts[uid]||0) + 1;
    lastTs[uid] = Math.max(lastTs[uid]||0, Number(c.ts)||0);
  }

  const stmt = db.prepare('SELECT * FROM users');
  const users = stmt.all();
  const out = [];

  for (const u of users) {
    const uid = String(u.id||'');
    const cnt = counts[uid] || Number(u.comment_count||0) || 0;
    if (!cnt) continue;
    out.push({
      id: uid,
      email: u.email || '',
      username: u.username || '',
      comment_count: cnt,
      is_banned: isUserBanned(uid),
      last_comment_ts: lastTs[uid] || 0
    });
  }

  out.sort((a,b)=>{
    if (b.comment_count !== a.comment_count) return b.comment_count - a.comment_count;
    return (b.last_comment_ts||0) - (a.last_comment_ts||0);
  });

  res.json({ ok:true, users: out });
});

app.get('/api/admin/comments/by-user', requireAdmin, (req,res)=>{
  const userId = String(req.query.userId||'').trim();
  if (!userId) return res.status(400).json({ error:'bad_request' });

  const stmt = db.prepare('SELECT * FROM comments WHERE author_uid = ? ORDER BY ts DESC');
  const all = stmt.all(userId);

  const teachers = getAllTeachers();
  const teacherMap = new Map(teachers.map(t=>[t.id, t]));
  const user = findUserById(userId);

  const comments = all.map(c=>{
    const teacher = teacherMap.get(c.teacher_id);
    const fio = teacher ? [teacher.last_name, teacher.first_name, teacher.patronymic].filter(Boolean).join(' ') : '';
    return {
      id: c.id,
      teacherId: c.teacher_id,
      teacher_name: fio,
      ts: c.ts,
      ts_iso: c.ts_iso,
      text: c.text || ''
    };
  });

  res.json({
    ok: true,
    user: user ? {
      id: user.id,
      email: user.email || '',
      username: user.username || '',
      is_banned: isUserBanned(user.id)
    } : { id: userId, email: '', username: '', is_banned: isUserBanned(userId) },
    comments
  });
});

app.get('/api/admin/users', requireAdmin, (req,res)=>{
  const stmt = db.prepare('SELECT * FROM users ORDER BY email');
  const users = stmt.all();

  const out = users.map(u=>({
    id: u.id,
    email: u.email || '',
    username: u.username || '',
    comment_count: Number(u.comment_count||0) || 0,
    rating_count: Number(u.rating_count||0) || 0,
    is_banned: isUserBanned(u.id)
  }));

  res.json({ ok:true, users: out });
});

app.get('/api/admin/comments', requireAdmin, (req,res)=>{
  const limit = Math.max(1, Math.min(500, Number(req.query.limit||100)));
  const stmt = db.prepare('SELECT * FROM comments ORDER BY ts DESC LIMIT ?');
  const all = stmt.all(limit);

  const out = all.map(c=>{
    const u = c.author_uid ? findUserById(String(c.author_uid)) : null;
    return {
      id:c.id, teacherId:c.teacher_id, ts:c.ts, ts_iso:c.ts_iso,
      text:c.text, author:c.author,
      author_uid:c.author_uid||'',
      author_email:u?.email||''
    };
  });

  res.json({ ok:true, comments: out });
});

app.post('/api/admin/comment/delete', requireAdmin, express.json(), (req,res)=>{
  const { commentId } = req.body || {};
  if (!commentId) return res.status(400).json({error:'bad_request'});

  const comment = getCommentById(commentId);
  if (!comment) return res.status(404).json({error:'not_found'});

  const { counts } = countVotesForCommentBulk([String(commentId)], null);
  const cnt = counts[String(commentId)] || { likes:0, dislikes:0 };

  if (comment.author_uid) {
    incUserStats(String(comment.author_uid), {
      comments: -1,
      recv_like: -(cnt.likes||0),
      recv_dislike: -(cnt.dislikes||0)
    });
  }

  deleteComment(commentId);
  return res.json({ ok:true });
});


// --- Жалобы на комментарии (пользователи -> Telegram админу) ---
app.post('/api/report-comment', express.json(), async (req, res) => {
  const u = getUserFromRequest(req);
  const { commentId, reason } = req.body || {};
  const cleanedReason = String(reason || '').trim();
  if (!commentId || !cleanedReason) return res.status(400).json({ error: 'bad_request' });

  const comment = getCommentById(commentId);
  if (!comment) return res.status(404).json({ error: 'comment_not_found' });


  const reporter = u ? u.email : 'анон';
  const messageParts = [
    '🚩 Жалоба на комментарий',
    `ID: ${commentId}`,
    `От: ${reporter}`,
    `Текст: ${String(comment.text || '(без текста)')}`,
    `Причина: ${cleanedReason.slice(0, 500)}`
  ];
  const msg = messageParts.join('\n');

  try {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    if (!BOT_TOKEN || !CHAT_ID) {
      console.warn('TELEGRAM_TOKEN или CHAT_ID не заданы');
      return res.status(503).json({ ok: false, error: 'telegram_not_configured' });
    }

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const tgResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: msg
      })
    });

    let tgData = null;
    try {
      tgData = await tgResponse.json();
    } catch (parseErr) {
      console.warn('Не удалось прочитать ответ Telegram:', parseErr);
    }

    if (!tgResponse.ok || (tgData && tgData.ok === false)) {
      const description = tgData?.description || tgResponse.statusText || 'telegram_failed';
      console.warn('Telegram вернул ошибку при отправке жалобы:', description);
      return res.status(502).json({ ok: false, error: 'telegram_failed', description });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка отправки в Telegram:', err);
    res.status(500).json({ ok: false, error: 'telegram_failed' });
  }
});


app.get('/api/admin/user/find', requireAdmin, (req,res)=>{
  const email = String(req.query.email||'').toLowerCase().trim();
  if (!email) return res.status(400).json({error:'bad_request'});
  const u = findUserByEmail(email);
  if (!u) return res.status(404).json({error:'not_found'});
  return res.json({ ok:true, user: { id:u.id, email:u.email, username:u.username, is_banned:isUserBanned(u.id) } });
});

app.post('/api/admin/user/ban', requireAdmin, express.json(), (req,res)=>{
  const { email, userId, banned, reason } = req.body || {};
  let u = null;
  if (userId) u = findUserById(String(userId));
  if (!u && email) u = findUserByEmail(String(email).toLowerCase());
  if (!u) return res.status(404).json({ error:'user_not_found' });

  setBanStatus(u.id, !!banned, String(reason||''));
  return res.json({ ok:true, user: { id:u.id, email:u.email, is_banned: !!banned } });
});

app.get('/api/admin/teachers', requireAdmin, (req,res)=>{
  const teachers = getAllTeachers();
  const result = teachers.map(t => ({
    ...t,
    subjects: t.subjects ? t.subjects.split('|') : []
  }));
  return res.json({ ok:true, teachers: result });
});

app.post('/api/admin/teacher/upsert', requireAdmin, express.json(), (req,res)=>{
  const { id, lastName, firstName, patronymic, department, subjects, photo } = req.body || {};
  upsertTeacher({ id, lastName, firstName, patronymic, department, subjects, photo });
  return res.json({ ok:true, total: getAllTeachers().length });
});

app.post('/api/admin/teacher/delete', requireAdmin, express.json(), (req,res)=>{
  const { id } = req.body || {};
  if (!id) return res.status(400).json({error:'bad_request'});
  deleteTeacherById(String(id));
  return res.json({ ok:true, total: getAllTeachers().length });
});

/* --- ADMIN SECURITY ENDPOINTS --- */

// Просмотр логов безопасности
app.get('/api/admin/security/logs', requireAdmin, (req,res)=>{
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const severity = req.query.severity || null;

  let query = 'SELECT * FROM security_log';
  let params = [];

  if (severity) {
    query += ' WHERE severity = ?';
    params.push(severity);
  }

  query += ' ORDER BY ts DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const logs = db.prepare(query).all(...params);
  const total = db.prepare('SELECT COUNT(*) as count FROM security_log').get();

  res.json({
    ok: true,
    logs: logs.map(log => ({
      ...log,
      details: log.details ? JSON.parse(log.details) : null
    })),
    total: total.count,
    limit,
    offset
  });
});

// Просмотр активных сессий
app.get('/api/admin/security/sessions', requireAdmin, (req,res)=>{
  const sessions = db.prepare(`
    SELECT s.id, s.user_id, s.created_ts, s.last_activity_ts, s.expires_ts, s.ip, s.user_agent, s.is_active,
           u.email, u.username
    FROM sessions s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.is_active = 1 AND s.expires_ts > ?
    ORDER BY s.last_activity_ts DESC
  `).all(Date.now());

  res.json({
    ok: true,
    sessions: sessions.map(s => ({
      id: s.id,
      userId: s.user_id,
      email: s.email,
      username: s.username,
      createdAt: new Date(s.created_ts).toISOString(),
      lastActivity: new Date(s.last_activity_ts).toISOString(),
      expiresAt: new Date(s.expires_ts).toISOString(),
      ip: s.ip,
      userAgent: s.user_agent
    })),
    total: sessions.length
  });
});

// Удаление всех сессий пользователя (принудительный выход)
app.post('/api/admin/security/revoke-sessions', requireAdmin, express.json(), (req,res)=>{
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({error:'bad_request'});

  const admin = getUserFromRequest(req);
  invalidateAllUserSessions(userId);

  logSecurityEvent('admin_revoked_sessions', {
    adminId: admin.id,
    adminEmail: admin.email,
    targetUserId: userId,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || '',
    severity: 'warning'
  });

  res.json({ ok: true, message: 'Все сессии пользователя удалены' });
});

// Статистика попыток входа
app.get('/api/admin/security/login-attempts', requireAdmin, (req,res)=>{
  const windowMs = parseInt(req.query.window) || 3600000; // По умолчанию последний час
  const cutoff = Date.now() - windowMs;

  const attempts = db.prepare(`
    SELECT email, ip, COUNT(*) as total, SUM(success) as successful, MAX(ts) as last_attempt
    FROM login_attempts
    WHERE ts > ?
    GROUP BY email, ip
    ORDER BY total DESC
    LIMIT 100
  `).all(cutoff);

  res.json({
    ok: true,
    attempts: attempts.map(a => ({
      email: a.email,
      ip: a.ip,
      total: a.total,
      successful: a.successful || 0,
      failed: a.total - (a.successful || 0),
      lastAttempt: new Date(a.last_attempt).toISOString()
    })),
    windowMs
  });
});

/* --- USER SECURITY ENDPOINTS --- */

// Просмотр собственных активных сессий
app.get('/api/user/sessions', (req,res)=>{
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({error:'unauthorized'});

  const sessions = db.prepare(`
    SELECT id, created_ts, last_activity_ts, expires_ts, ip, user_agent
    FROM sessions
    WHERE user_id = ? AND is_active = 1 AND expires_ts > ?
    ORDER BY last_activity_ts DESC
  `).all(u.id, Date.now());

  res.json({
    ok: true,
    sessions: sessions.map(s => ({
      id: s.id,
      createdAt: new Date(s.created_ts).toISOString(),
      lastActivity: new Date(s.last_activity_ts).toISOString(),
      expiresAt: new Date(s.expires_ts).toISOString(),
      ip: s.ip,
      userAgent: s.user_agent,
      isCurrent: false // TODO: определять текущую сессию
    }))
  });
});

// Удаление всех своих сессий кроме текущей
app.post('/api/user/revoke-other-sessions', (req,res)=>{
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({error:'unauthorized'});

  const cookies = parseCookies(req);
  const currentToken = cookies[SESSION_COOKIE];
  const currentTokenHash = currentToken ? hashToken(currentToken) : null;

  if (currentTokenHash) {
    db.prepare(`
      UPDATE sessions
      SET is_active = 0
      WHERE user_id = ? AND token_hash != ? AND is_active = 1
    `).run(u.id, currentTokenHash);
  }

  logSecurityEvent('user_revoked_other_sessions', {
    userId: u.id,
    email: u.email,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || ''
  });

  res.json({ ok: true, message: 'Все остальные сессии удалены' });
});

/* --- AUTH --- */

app.post('/api/auth/request', authLimiter, async (req,res)=>{
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';

  try{
    let email, sid_token;
    try{
      const r = await gmGetEmailAddress();
      email = r.email; sid_token = r.sid_token;
    }catch{
      const random = Math.random().toString(36).slice(2,10);
      email = `${random}@guerrillamailblock.com`;
      sid_token = null;
    }

    // Проверка на слишком много попыток входа
    const attempts = getRecentLoginAttempts(email, ip);
    if (attempts.count > MAX_LOGIN_ATTEMPTS && attempts.successful < 1) {
      logSecurityEvent('login_rate_limit_exceeded', {
        email,
        ip,
        userAgent: ua,
        attempts: attempts.count,
        severity: 'warning'
      });
      return res.status(429).json({
        error: 'too_many_attempts',
        message: 'Слишком много попыток входа. Попробуйте позже.'
      });
    }

    const code = ('' + Math.floor(100000 + Math.random()*900000)).slice(0,6);
    const sessionId = 'a-' + crypto.randomBytes(16).toString('hex');

    PENDING_AUTH.set(sessionId, {
      email, sid_token, code,
      created: Date.now(),
      seenIds: new Set(),
      verified: false,
      ip,
      ua
    });

    logSecurityEvent('auth_request_initiated', {
      email,
      ip,
      userAgent: ua
    });

    return res.json({
      ok:true,
      session_id: sessionId,
      email,
      code,
      check_every_ms: AUTH_CHECK_INTERVAL_MS,
      expires_in_ms: AUTH_SESSION_TTL_MS,
      required_domain: ALLOWED_EMAIL_DOMAIN
    });
  }catch(err){
    logSecurityEvent('auth_request_error', {
      error: err.message,
      ip,
      userAgent: ua,
      severity: 'error'
    });
    return res.status(500).json({ error:'auth_request_failed' });
  }
});

app.get('/api/auth/poll', authLimiter, async (req,res)=>{
  const sessionId = String(req.query.session_id||'');
  const rec = PENDING_AUTH.get(sessionId);
  if (!rec) return res.status(404).json({ error:'no_auth_session' });

  if (Date.now() - rec.created > AUTH_SESSION_TTL_MS){
    PENDING_AUTH.delete(sessionId);
    return res.status(410).json({ error:'expired' });
  }

  if (!rec.sid_token){
    return res.json({ status:'pending' });
  }

  const list = await gmCheckEmail(rec.sid_token);
  for (const m of list){
    const id = m.mail_id || m.id;
    if (!id || rec.seenIds.has(id)) continue;
    rec.seenIds.add(id);

    const full = await gmFetchEmail(rec.sid_token, id);
    if (!full) continue;

    const fromRaw = full.mail_from || '';
    const from = extractPureEmail(fromRaw);
    const subject = full.mail_subject || '';
    const excerpt = full.mail_excerpt || '';
    const body = full.mail_body || '';

    const codeFound = extractCode(subject) || extractCode(excerpt) || extractCode(body);
    if (!codeFound) continue;

    if (codeFound !== rec.code){
      recordLoginAttempt(from, rec.ip, false);
      logSecurityEvent('login_invalid_code', {
        email: from,
        ip: rec.ip,
        userAgent: rec.ua,
        severity: 'warning'
      });
      continue;
    }

    if (!from.endsWith(ALLOWED_EMAIL_DOMAIN)){
      recordLoginAttempt(from, rec.ip, false);
      logSecurityEvent('login_wrong_domain', {
        email: from,
        domain: from.split('@')[1],
        ip: rec.ip,
        userAgent: rec.ua,
        severity: 'warning'
      });
      return res.json({
        status:'wrong_domain',
        sender_email: from,
        required_domain: ALLOWED_EMAIL_DOMAIN
      });
    }

    rec.verified = true;
    const user = upsertUserOnLogin(from);

    // Записываем успешную попытку входа
    recordLoginAttempt(from, rec.ip, true);

    const token = createSession(user.id, req);
    setSessionCookie(res, token);

    try{
      const stmt = db.prepare('INSERT INTO login_events (ts, ts_iso, action, email, ip, ua) VALUES (?, ?, ?, ?, ?, ?)');
      stmt.run(Date.now(), new Date().toISOString(), 'login', user.email, getClientIp(req), req.headers['user-agent']||'');
    }catch{}

    logSecurityEvent('login_successful', {
      userId: user.id,
      email: user.email,
      ip: rec.ip,
      userAgent: rec.ua
    });

    PENDING_AUTH.delete(sessionId);
    return res.json({
      ok:true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        comment_count: Number(user.comment_count||0),
        rating_count: Number(user.rating_count||0),
        cast_likes: Number(user.cast_likes||0),
        cast_dislikes: Number(user.cast_dislikes||0),
        received_likes: Number(user.received_likes||0),
        received_dislikes: Number(user.received_dislikes||0),
        available_coins: getAvailableCoins(user),
        earned_coins: calculateEarnedCoins(user),
        spent_coins: getUserSpentCoins(user.id),
        is_admin: isAdminUser(user),
        is_banned: isUserBanned(user.id)
      }
    });
  }
  return res.json({ status:'pending' });
});

app.get('/api/auth/me', (req,res)=>{
  const u = getUserFromRequest(req);
  if (!u) return res.json({ loggedIn:false });
  const is_admin = isAdminUser(u);
  const is_banned = isUserBanned(u.id);
  return res.json({
    loggedIn:true,
    user: {
      id: u.id,
      email: u.email,
      username: u.username,
      display_name: getDisplayName(u),
      comment_count: Number(u.comment_count||0),
      rating_count: Number(u.rating_count||0),
      cast_likes: Number(u.cast_likes||0),
      cast_dislikes: Number(u.cast_dislikes||0),
      received_likes: Number(u.received_likes||0),
      received_dislikes: Number(u.received_dislikes||0),
      available_coins: getAvailableCoins(u),
      earned_coins: calculateEarnedCoins(u),
      spent_coins: getUserSpentCoins(u.id),
      is_admin,
      is_banned
    }
  });
});

app.post('/api/auth/logout', (req,res)=>{
  const u = getUserFromRequest(req);
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];

  if (token) {
    invalidateSession(token);
  }

  clearSessionCookie(res);

  try{
    if (u){
      const stmt = db.prepare('INSERT INTO login_events (ts, ts_iso, action, email, ip, ua) VALUES (?, ?, ?, ?, ?, ?)');
      stmt.run(Date.now(), new Date().toISOString(), 'logout', u.email, getClientIp(req), req.headers['user-agent']||'');

      logSecurityEvent('logout', {
        userId: u.id,
        email: u.email,
        ip: getClientIp(req),
        userAgent: req.headers['user-agent'] || ''
      });
    }
  }catch{}

  return res.json({ ok:true });
});

app.get('/api/user/stats', (req,res)=>{
  const u = getUserFromRequest(req);
  if (!u) return res.json({ ok:false, error:'unauthorized' });
  const earned = calculateEarnedCoins(u);
  const spent = getUserSpentCoins(u.id);
  const available = Math.max(0, earned - spent);
  return res.json({
    ok:true,
    user: {
      id: u.id,
      email: u.email,
      username: u.username,
      display_name: getDisplayName(u),
      comment_count: Number(u.comment_count||0),
      rating_count: Number(u.rating_count||0),
      cast_likes: Number(u.cast_likes||0),
      cast_dislikes: Number(u.cast_dislikes||0),
      received_likes: Number(u.received_likes||0),
      received_dislikes: Number(u.received_dislikes||0),
      available_coins: available,
      earned_coins: earned,
      spent_coins: spent,
    }
  });
});

/* Store */

/* --- SHOP API --- */

app.get('/api/shop/items', (req, res) => {
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });

  // Убедитесь, что этот массив существует и заполнен
  const availableNicks = [
    { id: 'nick-1', name: 'Умник', price: 50, category: 'nickname' },
    { id: 'nick-2', name: 'Отличник', price: 75, category: 'nickname' },
    { id: 'nick-3', name: 'Эрудит', price: 100, category: 'nickname' },
    { id: 'nick-4', name: 'Профи', price: 150, category: 'nickname' },
    { id: 'nick-5', name: 'Гуру', price: 200, category: 'nickname' },
    { id: 'nick-6', name: 'Легенда', price: 300, category: 'nickname' },
    { id: 'nick-7', name: 'Мастер', price: 250, category: 'nickname' },
    { id: 'nick-8', name: 'Эксперт', price: 180, category: 'nickname' }
  ];

  console.log('🛍️ [SERVER] Отправляю товары:', availableNicks.length);

  // Получаем купленные ники пользователя
  const purchasedStmt = db.prepare('SELECT item_id FROM user_inventory WHERE user_id = ? AND item_type = ?');
  const purchasedItems = purchasedStmt.all(u.id, 'nickname').map(row => row.item_id);

  // Получаем текущий активный ник
  const activeNickStmt = db.prepare('SELECT item_id FROM user_inventory WHERE user_id = ? AND item_type = ? AND is_active = 1');
  const activeNick = activeNickStmt.get(u.id, 'nickname');

  const balance = getAvailableCoins(u);
  const earnedCoins = calculateEarnedCoins(u);
  const spentCoins = getUserSpentCoins(u.id);

  res.json({
    ok: true,
    items: availableNicks.map(item => ({
      ...item,
      purchased: purchasedItems.includes(item.id),
      isActive: activeNick ? activeNick.item_id === item.id : false
    })),
    balance,
    earnedCoins,
    spentCoins
  });
});

app.post('/api/shop/buy', express.json(), (req, res) => {
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });

  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'bad_request' });

  // Определяем товары (в реальном приложении это должно быть в БД)
  const shopItems = {
    'nick-1': { name: 'Умник', price: 50, type: 'nickname' },
    'nick-2': { name: 'Отличник', price: 75, type: 'nickname' },
    'nick-3': { name: 'Эрудит', price: 100, type: 'nickname' },
    'nick-4': { name: 'Профи', price: 150, type: 'nickname' },
    'nick-5': { name: 'Гуру', price: 200, type: 'nickname' },
    'nick-6': { name: 'Легенда', price: 300, type: 'nickname' },
    'nick-7': { name: 'Мастер', price: 250, type: 'nickname' },
    'nick-8': { name: 'Эксперт', price: 180, type: 'nickname' }
  };

  const item = shopItems[itemId];
  if (!item) return res.status(404).json({ error: 'item_not_found' });

  const availableCoins = getAvailableCoins(u);
  if (availableCoins < item.price) {
    return res.status(400).json({ error: 'not_enough_coins' });
  }

  // Проверяем, не куплен ли уже этот ник
  const existingStmt = db.prepare('SELECT id FROM user_inventory WHERE user_id = ? AND item_id = ? AND item_type = ?');
  const existing = existingStmt.get(u.id, itemId, 'nickname');

  if (existing) {
    return res.status(400).json({ error: 'already_purchased' });
  }

  // Покупаем товар
  const insertStmt = db.prepare(`
    INSERT INTO user_inventory (user_id, item_id, item_type, item_name, purchase_date, price, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertStmt.run(u.id, itemId, item.type, item.name, Date.now(), item.price, 0);

  const balanceAfter = getAvailableCoins(u);
  const spentCoins = getUserSpentCoins(u.id);
  const earnedCoins = calculateEarnedCoins(u);

  logSecurityEvent('shop_purchase', {
    userId: u.id,
    itemId: itemId,
    itemName: item.name,
    price: item.price,
    balanceBefore: availableCoins,
    balanceAfter
  });

  res.json({
    ok: true,
    message: `Ник "${item.name}" успешно приобретен!`,
    balance: balanceAfter,
    earnedCoins,
    spentCoins
  });
});

app.post('/api/shop/activate', express.json(), (req, res) => {
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });

  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'bad_request' });

  // Проверяем, есть ли у пользователя этот товар
  const itemStmt = db.prepare('SELECT id, item_name FROM user_inventory WHERE user_id = ? AND item_id = ? AND item_type = ?');
  const item = itemStmt.get(u.id, itemId, 'nickname');

  if (!item) {
    return res.status(400).json({ error: 'item_not_owned' });
  }

  // Деактивируем все ники пользователя
  const deactivateStmt = db.prepare('UPDATE user_inventory SET is_active = 0 WHERE user_id = ? AND item_type = ?');
  deactivateStmt.run(u.id, 'nickname');

  // Активируем выбранный ник
  const activateStmt = db.prepare('UPDATE user_inventory SET is_active = 1 WHERE id = ?');
  activateStmt.run(item.id);

  logSecurityEvent('nickname_activated', {
    userId: u.id,
    itemId: itemId,
    nickname: item.item_name
  });

  const balance = getAvailableCoins(u);
  const spentCoins = getUserSpentCoins(u.id);
  const earnedCoins = calculateEarnedCoins(u);

  res.json({
    ok: true,
    message: `Ник "${item.item_name}" теперь отображается в вашем профиле!`,
    balance,
    earnedCoins,
    spentCoins
  });
});

app.get('/api/shop/my-items', (req, res) => {
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });

  const stmt = db.prepare(`
    SELECT item_id, item_name, item_type, purchase_date, is_active
    FROM user_inventory
    WHERE user_id = ?
    ORDER BY purchase_date DESC
  `);

  const items = stmt.all(u.id);

  const balance = getAvailableCoins(u);
  const earnedCoins = calculateEarnedCoins(u);
  const spentCoins = getUserSpentCoins(u.id);

  res.json({
    ok: true,
    items: items,
    balance,
    earnedCoins,
    spentCoins
  });
});

/* Catch-all для SPA */
app.get(/^\/(?!.*\.).*$/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

function printStartupInfo(port = PORT) {
  const teachersCount = db.prepare('SELECT COUNT(*) as count FROM teachers').get().count;
  const usersCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const commentsCount = db.prepare('SELECT COUNT(*) as count FROM comments').get().count;

  const inventoryCount = db.prepare('SELECT COUNT(*) as count FROM user_inventory').get().count;

  console.log('\n' + '='.repeat(60));
  console.log('🎓  LETO TALKS — Платформа рейтинга учителей');
  console.log('='.repeat(60));
  console.log('');
  console.log('🌐  Сервер:        http://localhost:' + port);
  console.log('📊  База данных:   SQLite (WAL mode)');
  console.log('🔒  Безопасность:  Helmet + Rate Limiting');
  console.log('');
  console.log('📈  Статистика:');
  console.log('    👨‍🏫 Учителя:    ' + teachersCount);
  console.log('    👥 Пользователи: ' + usersCount);
  console.log('    💬 Комментарии:  ' + commentsCount);
  console.log('    🛡️  Администраторы: ' + ADMIN_EMAILS.size);
  console.log('');
  console.log('✅  Сервер готов к работе!');
  console.log('='.repeat(60));
  console.log('');
}

function startServer(port = PORT, onListen = null) {
  const server = app.listen(port, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    printStartupInfo(actualPort);
    if (typeof onListen === 'function') {
      onListen(actualPort);
    }
  });
  return server;
}

/* Graceful shutdown */
function closeDatabaseAndExit(signal) {
  console.log(`\n👋 (${signal}) Закрываем соединение с базой данных...`);
  try {
    clearInterval(cleanupTimer);
  } catch (err) {
    console.warn('Не удалось остановить таймер очистки:', err);
  }
  try {
    db.close();
  } catch (err) {
    console.error('Ошибка при закрытии базы данных:', err);
  }
  process.exit(0);
}

process.on('SIGINT', () => closeDatabaseAndExit('SIGINT'));
process.on('SIGTERM', () => closeDatabaseAndExit('SIGTERM'));

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  db,
  startServer,
  constants: {
    SESSION_COOKIE,
    SESSION_TTL_MS,
    AUTH_SESSION_TTL_MS
  },
  helpers: {
    calculateEarnedCoins,
    getUserSpentCoins,
    getAvailableCoins
  }
};
