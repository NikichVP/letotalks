// server.js — Node 18+ : npm i express better-sqlite3 bcrypt helmet express-rate-limit
// http://localhost:3001
//
// SQLite Database: letotalks.db
// Фото: photos/  -> /photo/<file>
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const multer = require('multer');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const { Blob } = require('buffer');
const { fetch: undiciFetch } = require('undici');
const { ensureDirsAndDb, createDbProcessing } = require('./db_processing');
const { COMMENT_DECISIONS, moderateComment } = require('./comment_moderation');
const { createDispatcher, resolveProxyUrl } = require('./outbound_proxy');

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = 3001;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const OUTBOUND_PROXY_URL = resolveProxyUrl();
const outboundDispatcher = createDispatcher({ allowH2: false });

if (OUTBOUND_PROXY_URL) {
  console.log(`[proxy] letotalks via ${OUTBOUND_PROXY_URL}`);
}

function fetchWithProxy(url, init = {}) {
  return undiciFetch(url, {
    ...init,
    dispatcher: init.dispatcher || outboundDispatcher,
  });
}

const ROOT_DIR    = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR    = path.join(ROOT_DIR, 'data');
const PHOTO_DIR   = path.join(ROOT_DIR, 'photos');
const REQUEST_PHOTO_DIR = path.join(DATA_DIR, 'teacher_request_photos');
const DEFAULT_PHOTO = '/photo/default_photo.png';
const DB_PATH     = process.env.LETOTALKS_DB_PATH
  ? path.resolve(process.env.LETOTALKS_DB_PATH)
  : path.join(ROOT_DIR, 'letotalks.db');

const TELEGRAM_WEBHOOK_SECRET = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_REVIEW_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const GPT_MODERATION_API_KEY = process.env.GPT_MODERATION_API_KEY || process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
const DEFAULT_GPT_MODERATION_URL = (() => {
  if (!OPENAI_BASE_URL) return 'https://api.openai.com/v1/responses';
  if (/\/(chat\/completions|responses)$/i.test(OPENAI_BASE_URL)) return OPENAI_BASE_URL;
  return `${OPENAI_BASE_URL}/responses`;
})();
const GPT_MODERATION_URL = process.env.GPT_MODERATION_URL || DEFAULT_GPT_MODERATION_URL;
const GPT_MODERATION_MODEL = process.env.GPT_MODERATION_MODEL || 'gpt-5-nano';

// Защита от утечки ключа/данных: endpoint модерации должен быть https и
// не указывать на внутренний/приватный адрес (иначе текст и Bearer-ключ уйдут не туда).
(() => {
  try {
    const u = new URL(GPT_MODERATION_URL);
    const host = u.hostname.toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const isPrivate = /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
    if (u.protocol !== 'https:' && !isLocal) {
      console.warn(`⚠️  GPT_MODERATION_URL не https (${u.protocol}//${host}) — ключ и данные могут передаваться небезопасно.`);
    }
    if (isPrivate) {
      console.warn(`⚠️  GPT_MODERATION_URL указывает на приватный адрес (${host}) — проверьте конфигурацию (возможный SSRF/утечка).`);
    }
  } catch {
    console.warn(`⚠️  GPT_MODERATION_URL некорректен: ${GPT_MODERATION_URL}`);
  }
})();

const ROOT_ADMIN_EMAIL = (process.env.ROOT_ADMIN_EMAIL || '').trim().toLowerCase();

const ALLOWED_EMAIL_DOMAIN = '@student.letovo.ru';
const SESSION_COOKIE = 'lt_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 дней
const AUTH_SESSION_TTL_MS = 1000 * 60 * 10; // 10 минут
const AUTH_CHECK_INTERVAL_MS = 5000;
const MAX_SESSIONS_PER_USER = 1; // Максимум одна одновременная сессия
const SESSION_CLEANUP_INTERVAL = 1000 * 60 * 60; // Очистка каждый час
const BCRYPT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 10; // За час
const SECURITY_HEADERS_ENABLED = true;
const SESSION_BINDING_MODE = (process.env.SESSION_BINDING_MODE || 'strict').toLowerCase(); // soft | strict

const CHARACTERISTICS_KEYS=['clarity','humor','strict','favorites'];

// Один Collator на процесс — его создание дорогое, не пересоздаём на каждый вызов.
const RU_COLLATOR = new Intl.Collator('ru', { sensitivity: 'base' });

const DEFAULT_SHOP_ITEMS = [
  { id: 'nick-0', name: 'Новичок', price: 1, category: 'nickname' },
  { id: 'nick-1', name: 'Умник', price: 20, category: 'nickname' },
  { id: 'nick-2', name: 'Отличник', price: 50, category: 'nickname' },
  { id: 'nick-3', name: 'Эрудит', price: 75, category: 'nickname' },
  { id: 'nick-4', name: 'Профи', price: 150, category: 'nickname' },
  { id: 'nick-5', name: 'Гуру', price: 200, category: 'nickname' },
  { id: 'nick-6', name: 'Легенда', price: 300, category: 'nickname' },
  { id: 'nick-7', name: 'Мастер', price: 250, category: 'nickname' },
  { id: 'nick-8', name: 'kinnijin', price: 180, category: 'nickname' }
];

const TEACHER_REQUEST_STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
};

const ALLOWED_REQUEST_PHOTO_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp']
]);

// --- Быстрый кэш для дорогих вычислений ---
const HOT_CACHE_TTL_MS = 60_000;
const HOT_CACHE_MAX_ENTRIES = 1000; // верхняя граница, чтобы кэш не рос бесконечно
const cacheStore = new Map();

function readCache(key) {
  const entry = cacheStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cacheStore.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key, value, ttl = HOT_CACHE_TTL_MS) {
  // Ограничиваем размер: при переполнении убираем самую старую запись (Map хранит порядок вставки).
  if (cacheStore.size >= HOT_CACHE_MAX_ENTRIES && !cacheStore.has(key)) {
    const oldestKey = cacheStore.keys().next().value;
    if (oldestKey !== undefined) cacheStore.delete(oldestKey);
  }
  cacheStore.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

// Периодическая чистка протухших записей (не зависим от повторного readCache).
const cacheSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cacheStore) {
    if (entry.expiresAt <= now) cacheStore.delete(key);
  }
}, 120_000);
if (typeof cacheSweepTimer.unref === 'function') cacheSweepTimer.unref();

function invalidateCache(prefix, { exact = false } = {}) {
  if (exact) {
    cacheStore.delete(prefix);
    return;
  }
  for (const key of Array.from(cacheStore.keys())) {
    if (key.startsWith(prefix)) {
      cacheStore.delete(key);
    }
  }
}

const TEACHER_LIST_CACHE_KEY = 'cache:teachers:enriched';
const HOME_PAYLOAD_CACHE_KEY = 'cache:home:payload';
const TEACHER_PAYLOAD_PREFIX = 'cache:teacher:payload:';

function invalidateTeacherAggregates() {
  invalidateCache(TEACHER_LIST_CACHE_KEY, { exact: true });
  invalidateCache(HOME_PAYLOAD_CACHE_KEY, { exact: true });
}

function invalidateTeacherPayloadCache(teacherId) {
  if (!teacherId) return;
  invalidateCache(`${TEACHER_PAYLOAD_PREFIX}${teacherId}`, { exact: true });
}

function invalidateAllTeacherPayloads() {
  invalidateCache(TEACHER_PAYLOAD_PREFIX);
}

function invalidateAllTeacherCaches(teacherId = null) {
  invalidateTeacherAggregates();
  if (teacherId) {
    invalidateTeacherPayloadCache(teacherId);
  } else {
    invalidateAllTeacherPayloads();
  }
}

ensureDirsAndDb({
  dataDir: DATA_DIR,
  photoDir: PHOTO_DIR,
  requestPhotoDir: REQUEST_PHOTO_DIR,
  dbPath: DB_PATH
});

const dbCtx = createDbProcessing({
  dbPath: DB_PATH,
  defaultPhoto: DEFAULT_PHOTO,
  defaultShopItems: DEFAULT_SHOP_ITEMS,
  characteristicsKeys: CHARACTERISTICS_KEYS,
  teacherRequestStatuses: TEACHER_REQUEST_STATUSES,
  rootAdminEmail: ROOT_ADMIN_EMAIL,
  sessionConfig: {
    sessionTtlMs: SESSION_TTL_MS,
    maxSessionsPerUser: MAX_SESSIONS_PER_USER
  }
});

const {
  db,
  loadAdminEmails,
  isAdminUser,
  isSuperAdminUser,
  listAdminEmails,
  addAdminEmail,
  removeAdminEmail,
  calculateEarnedCoins,
  getUserSpentCoins,
  getAvailableCoins,
  coinsOf,
  overall,
  getAllTeachers,
  getTeacherById,
  normalizeTeacherRow,
  getRatingsForTeacher,
  getAllRatings,
  ensureUniqueTeacherId,
  updateRatings,
  getCommentsForTeacher,
  getAllComments,
  getCommentById,
  addComment,
  deleteComment,
  getAllCommentsByUser,
  getUserVote,
  setUserVote,
  countVotesForCommentBulk,
  getActiveNickname,
  findUserByEmail,
  findUserById,
  upsertUserOnLogin,
  incUserStats,
  isUserBanned,
  setBanStatus,
  upsertTeacher,
  deleteTeacherById,
  logSecurityEvent,
  recordLoginAttempt,
  getRecentLoginAttempts,
  getUserFromSessionTokenHash,
  updateSessionActivity,
  updateSessionClient,
  countActiveSessions,
  deleteOldestSession,
  insertSession,
  deactivateSessionByHash,
  deactivateSessionsByUser,
  cleanupExpiredSessions: cleanupSessionsDb,
  cleanupOldLogs,
  insertLoginEvent,
  insertTeacherRequest,
  getTeacherRequestById,
  setTeacherRequestTelegramMeta,
  updateTeacherRequestError,
  finalizeTeacherRequest,
  insertPendingReview,
  getPendingReview,
  deletePendingReview,
  getSecurityLogs,
  getActiveSessionsList,
  getLoginAttempts,
  getUserSessions,
  revokeOtherSessions,
  getUserList,
  getAdminComments,
  getShopItems,
  getUserPurchasedItems,
  getActiveInventoryForUser,
  getShopItemById,
  getExistingInventoryItem,
  insertInventoryItem,
  getShopItemMeta,
  getInventoryItem,
  deactivateUserInventory,
  activateInventoryItemById,
  getActiveInventoryItem,
  deactivateUserInventoryByType,
  getInventoryForUser,
  getStartupStats,
  getUserVotesForComments
} = dbCtx;

const teacherRequestUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, REQUEST_PHOTO_DIR),
    filename: (_req, file, cb) => {
      const ext = ALLOWED_REQUEST_PHOTO_TYPES.get(file.mimetype) || (path.extname(file.originalname || '') || '.jpg');
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext.toLowerCase()) ? ext.toLowerCase() : '.jpg';
      const name = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${safeExt}`;
      cb(null, name);
    }
  }),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5 MB
  },
  fileFilter: (_req, file, cb) => {
    if (!file) return cb(null, true);
    if (ALLOWED_REQUEST_PHOTO_TYPES.has(file.mimetype)) return cb(null, true);
    const err = new Error('unsupported_file_type');
    err.code = 'UNSUPPORTED_FILE_TYPE';
    cb(err);
  }
}).single('photo');


app.use(express.json({ limit: '1mb' }));
// Сжимаем ответы (особенно крупные JSON-списки учителей).
app.use(compression());

app.use(express.static(PUBLIC_DIR));
// Фото статичны и редко меняются — кэшируем у клиента; nosniff против подмены типа.
app.use('/photo', express.static(PHOTO_DIR, {
  maxAge: '7d',
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff')
}));

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
// === БЕЗОПАСНОСТЬ: Функции для работы с хешированными токенами ===
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Сравнение секретов за константное время (защита от тайминг-атак).
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function generateSecureToken() {
  return crypto.randomBytes(32).toString('base64url');
}

const PENDING_AUTH = new Map(); // sessionId -> { email, sid_token, code, created, seenIds:Set, verified:false, ip, ua }

const CYRILLIC_TO_LATIN = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh',
  'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
  'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts',
  'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu',
  'я': 'ya', 'і': 'i', 'ї': 'yi', 'є': 'ye', 'ґ': 'g'
};

function transliterateCyrillic(value) {
  const input = String(value || '');
  let out = '';
  for (const ch of input) {
    const lower = ch.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(CYRILLIC_TO_LATIN, lower)) {
      out += CYRILLIC_TO_LATIN[lower];
      continue;
    }
    if (/[a-z0-9]/.test(lower)) {
      out += lower;
      continue;
    }
    out += ' ';
  }
  return out;
}

function slugifyTeacherParts(parts) {
  const merged = transliterateCyrillic(parts.filter(Boolean).join(' '));
  const normalized = merged.replace(/[^a-z0-9]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  const trimmed = normalized.slice(0, 80);
  return trimmed || '';
}

function generateTeacherIdFromPayload(payload) {
  const parts = [
    payload?.lastName || payload?.last_name,
    payload?.firstName || payload?.first_name,
    payload?.patronymic || payload?.patronymic_name
  ];
  const slug = slugifyTeacherParts(parts);
  const base = slug ? `t-${slug}` : `t-${crypto.randomBytes(4).toString('hex')}`;
  return ensureUniqueTeacherId(base);
}

function sanitizeRequestField(value, maxLength = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function sanitizeRequestMultiline(value, maxLength = 1500) {
  const normalized = String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
  return normalized.slice(0, maxLength);
}

function normalizeSubjectsList(value) {
  return String(value || '')
    .split(/[,|\n]+/g)
    .map(item => sanitizeRequestField(item, 80))
    .filter(Boolean)
    .slice(0, 15);
}

function normalizeDepartmentKey(value) {
  return sanitizeRequestField(value, 160).toLowerCase();
}

function getDepartmentList() {
  const teachers = getAllTeachers();
  const set = new Set();
  for (const t of teachers) {
    const dept = sanitizeRequestField(t.department, 160);
    if (dept) set.add(dept);
  }
  return Array.from(set);
}

function buildDepartmentsLookup() {
  const map = new Map();
  for (const dept of getDepartmentList()) {
    const key = normalizeDepartmentKey(dept);
    if (key) map.set(key, dept);
  }
  return map;
}

function getEnrichedTeachersSnapshot() {
  const cached = readCache(TEACHER_LIST_CACHE_KEY);
  if (cached) return cached;

  const teachers = getAllTeachers();
  const ratingsMap = getAllRatings();
  const collator = RU_COLLATOR;

  const list = teachers.map(row => {
    const teacher = normalizeTeacherRow(row);
    if (!teacher) return null;
    const ratings = {};
    for (const k of CHARACTERISTICS_KEYS) {
      ratings[k] = ratingsMap[row.id]?.[k] || { sum: 0, count: 0 };
    }
    return {
      ...teacher,
      ratings,
      overall: overall(ratings)
    };
  }).filter(Boolean);

  list.sort((a, b) => {
    const dv = (b.overall || 0) - (a.overall || 0);
    if (dv !== 0) return dv;
    const an = `${a.lastName || ''} ${a.firstName || ''}`.trim();
    const bn = `${b.lastName || ''} ${b.firstName || ''}`.trim();
    return collator.compare(an, bn);
  });

  const byId = new Map(list.map(t => [t.id, t]));

  return writeCache(TEACHER_LIST_CACHE_KEY, { list, byId });
}

function getHomePayloadCached() {
  const cached = readCache(HOME_PAYLOAD_CACHE_KEY);
  if (cached) return cached;

  const { list } = getEnrichedTeachersSnapshot();
  const collator = RU_COLLATOR;
  const byValueThenName = (getVal) => (a, b) => {
    const dv = (getVal(b) || 0) - (getVal(a) || 0);
    if (dv !== 0) return dv;
    const an = `${a.lastName || ''} ${a.firstName || ''}`.trim();
    const bn = `${b.lastName || ''} ${b.firstName || ''}`.trim();
    return collator.compare(an, bn);
  };

  const characteristics = {};
  for (const k of CHARACTERISTICS_KEYS) {
    characteristics[k] = [...list]
      .sort(byValueThenName(t => {
        const r = t.ratings?.[k];
        const sum = Number(r?.sum || 0), cnt = Number(r?.count || 0);
        return cnt > 0 ? (sum / cnt) : 0;
      }))
      .slice(0, 3);
  }

  const departmentsSet = new Set(list.map(t => t.department).filter(Boolean));
  const departments = Array.from(departmentsSet).sort(collator.compare).map(name => {
    const top = list
      .filter(t => t.department === name)
      .sort(byValueThenName(t => t.overall))
      .slice(0, 3);
    return { name, list: top };
  }).filter(d => d.list.length > 0);

  return writeCache(HOME_PAYLOAD_CACHE_KEY, { characteristics, departments });
}

function buildTeacherBaseCached(teacherId) {
  if (!teacherId) return null;

  const cacheKey = `${TEACHER_PAYLOAD_PREFIX}${teacherId}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const teacherRow = getTeacherById(teacherId);
  if (!teacherRow) return null;

  const ratings = getRatingsForTeacher(teacherId);
  const commentsRaw = getCommentsForTeacher(teacherId);
  const commentIds = commentsRaw.map(c => String(c.id));
  const { counts } = countVotesForCommentBulk(commentIds, null);

  const userCache = new Map();
  const resolveUser = (uid) => {
    if (!uid) return null;
    const key = String(uid);
    if (!userCache.has(key)) {
      userCache.set(key, findUserById(key) || null);
    }
    return userCache.get(key);
  };

  const comments = commentsRaw.map(c => {
    const authorUser = c.author_uid ? resolveUser(c.author_uid) : null;
    const activeNick = authorUser ? getActiveNickname(authorUser.id) : null;
    const displayAuthor = activeNick || 'Аноним';
    const base = {
      id: c.id,
      teacherId: c.teacher_id,
      ts: c.ts,
      ts_iso: c.ts_iso,
      // Публично не раскрываем сохранённое имя автора (там может быть username) —
      // показываем только активный ник или «Аноним».
      author: displayAuthor,
      authorDisplay: displayAuthor,
      text: c.text,
      likes: (counts[String(c.id)]?.likes) || 0,
      dislikes: (counts[String(c.id)]?.dislikes) || 0
    };
    const admin = {
      author_uid: c.author_uid || '',
      author_email: authorUser?.email || '',
      author_display: displayAuthor
    };
    return { base, admin };
  });

  const teacher = normalizeTeacherRow(teacherRow);

  return writeCache(cacheKey, {
    teacher,
    ratings,
    overall: overall(ratings),
    comments,
    commentIds
  });
}

function buildTeacherPayload(teacherId, req) {
  const base = buildTeacherBaseCached(teacherId);
  if (!base || !base.teacher) return null;

  const u = getUserFromRequest(req);
  const myId = u?.id || null;
  const amAdmin = isAdminUser(u);
  const myVotes = myId ? getUserVotesForComments(base.commentIds, myId) : {};

  const comments = base.comments.map(({ base: cBase, admin }) => {
    const myVote = Number(myVotes[String(cBase.id)] ?? 0);
    const isOwn = !!(myId && admin.author_uid && String(admin.author_uid) === String(myId));
    const publicComment = {
      ...cBase,
      myVote,
      isOwn
    };
    if (amAdmin) {
      return {
        ...publicComment,
        author_uid: admin.author_uid,
        author_email: admin.author_email,
        author_display: admin.author_display
      };
    }
    return publicComment;
  });

  return {
    ...base.teacher,
    ratings: base.ratings,
    comments,
    overall: base.overall
  };
}

async function callTelegramApi(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) {
    const err = new Error('telegram_not_configured');
    err.code = 'TELEGRAM_NOT_CONFIGURED';
    throw err;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const isFormData = typeof FormData !== 'undefined' && payload instanceof FormData;
  // Таймаут, чтобы зависший Telegram не держал пользовательский HTTP-запрос бесконечно.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const options = {
    method: 'POST',
    body: isFormData ? payload : JSON.stringify(payload),
    signal: controller.signal
  };
  if (!isFormData) {
    options.headers = { 'Content-Type': 'application/json' };
  }

  let resp;
  try {
    resp = await fetchWithProxy(url, options);
  } catch (err) {
    const e = new Error(err?.name === 'AbortError' ? 'telegram_timeout' : 'telegram_failed');
    e.code = err?.name === 'AbortError' ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_FAILED';
    e.description = err?.message || 'telegram_request_failed';
    throw e;
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const err = new Error('telegram_failed');
    err.code = 'TELEGRAM_FAILED';
    err.description = data?.description || resp.statusText || 'telegram_failed';
    err.statusCode = resp.status;
    throw err;
  }

  return data?.result ?? data;
}

function moveRequestPhotoToGallery(filename, teacherId) {
  if (!filename || !teacherId) return null;
  const srcPath = path.join(REQUEST_PHOTO_DIR, filename);
  if (!fs.existsSync(srcPath)) return null;

  const ext = (path.extname(filename) || '.jpg').toLowerCase();
  const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';

  let destName = `${teacherId}${safeExt}`;
  let destPath = path.join(PHOTO_DIR, destName);
  let counter = 1;
  while (fs.existsSync(destPath)) {
    destName = `${teacherId}-${counter}${safeExt}`;
    destPath = path.join(PHOTO_DIR, destName);
    counter += 1;
  }

  try {
    fs.renameSync(srcPath, destPath);
    return destName;
  } catch (err) {
    console.error('Не удалось переместить фото заявки учителя:', err);
    return null;
  }
}

function deleteRequestPhoto(filename) {
  if (!filename) return;
  const filePath = path.join(REQUEST_PHOTO_DIR, filename);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn('Не удалось удалить фото отклонённой заявки учителя:', err && err.message ? err.message : err);
  }
}

function describeTelegramUser(user) {
  if (!user) return '';
  if (user.username) return `@${user.username}`;
  const parts = [user.first_name, user.last_name].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return String(user.id || '');
}

async function sendTelegramPhotoMessage({ chatId, filePath, fileName, mimeType, caption, replyMarkup }) {
  if (!TELEGRAM_BOT_TOKEN) {
    const err = new Error('telegram_not_configured');
    err.code = 'TELEGRAM_NOT_CONFIGURED';
    throw err;
  }
  if (!fs.existsSync(filePath)) {
    const err = new Error('photo_not_found');
    err.code = 'PHOTO_NOT_FOUND';
    throw err;
  }
  const buffer = fs.readFileSync(filePath);
  const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) form.append('caption', caption);
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  form.append('photo', blob, fileName || path.basename(filePath));
  return callTelegramApi('sendPhoto', form);
}

async function safeAnswerCallback(callback, text, showAlert = false) {
  if (!callback?.id) return;
  try {
    await callTelegramApi('answerCallbackQuery', {
      callback_query_id: callback.id,
      text: text || '',
      show_alert: !!showAlert
    });
  } catch (err) {
    console.warn('Не удалось ответить на callback Telegram:', err && err.message ? err.message : err);
  }
}

function composeRequestDecisionText(originalText, statusLine) {
  const base = String(originalText || '').trimEnd();
  if (!statusLine) return base || 'Заявка обработана.';
  if (base.includes('Статус:')) {
    return base.replace(/Статус:.*$/s, `Статус: ${statusLine}`);
  }
  return `${base}\n\nСтатус: ${statusLine}`;
}

async function updateRequestMessage(callback, request, statusLine) {
  const chatId = callback?.message?.chat?.id ??
    (request?.telegram_chat_id ? Number(request.telegram_chat_id) || request.telegram_chat_id : null);
  const messageId = callback?.message?.message_id ??
    (request?.telegram_message_id ? Number(request.telegram_message_id) || request.telegram_message_id : null);
  if (!chatId || !messageId) return;

  const hasCaption = typeof callback?.message?.caption === 'string';
  const originalText = hasCaption
    ? callback.message.caption
    : (callback?.message?.text || '');
  let newText = composeRequestDecisionText(originalText, statusLine);

  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    };
    let method = 'editMessageText';
    if (hasCaption) {
      method = 'editMessageCaption';
      if (newText.length > 1024) {
        const statusIdx = newText.indexOf('Статус:');
        if (statusIdx >= 0) {
          const statusPart = newText.slice(statusIdx);
          const maxPrefixLength = Math.max(0, 1024 - statusPart.length - 1);
          const prefix = newText.slice(0, maxPrefixLength).trimEnd();
          newText = prefix ? `${prefix}\n${statusPart}` : statusPart.slice(0, 1024);
          if (newText.length > 1024) {
            newText = `${newText.slice(0, 1019)}…`;
          }
        } else {
          newText = `${newText.slice(0, 1019)}…`;
        }
      }
      payload.caption = newText;
    } else {
      payload.text = newText;
      payload.disable_web_page_preview = true;
    }
    await callTelegramApi(method, payload);
  } catch (err) {
    if (err && err.description && /message is not modified/i.test(err.description)) return;
    console.warn('Не удалось обновить сообщение заявки в Telegram:', err && err.message ? err.message : err);
  }
}

async function processTeacherRequestApproval(request, callback) {
  const payload = request?.payload || {};
  const actor = describeTelegramUser(callback?.from);

  const subjects = Array.isArray(payload.subjects)
    ? payload.subjects.map(s => sanitizeRequestField(s, 80)).filter(Boolean)
    : normalizeSubjectsList(payload.subjects);

  if (!payload.lastName || !payload.firstName || !payload.department || !subjects.length) {
    await safeAnswerCallback(callback, 'В заявке не хватает данных для создания учителя', true);
    updateTeacherRequestError(request.id, 'missing_fields_for_approval');
    return null;
  }

  const teacherId = generateTeacherIdFromPayload(payload);
  let photoFile = null;

  if (request.photo_filename) {
    photoFile = moveRequestPhotoToGallery(request.photo_filename, teacherId);
  }

  try {
    upsertTeacher({
      id: teacherId,
      lastName: payload.lastName,
      firstName: payload.firstName,
      patronymic: payload.patronymic || '',
      department: payload.department,
      subjects,
      photo: photoFile
    });
    invalidateAllTeacherCaches(teacherId);
  } catch (err) {
    console.error('Не удалось сохранить учителя из заявки:', err);
    updateTeacherRequestError(request.id, err && err.message ? err.message : 'db_error');
    await safeAnswerCallback(callback, 'Не удалось сохранить в базу. Проверьте логи сервера.', true);
    return null;
  }

  finalizeTeacherRequest({
    id: request.id,
    status: TEACHER_REQUEST_STATUSES.APPROVED,
    processedBy: actor,
    action: 'approve',
    teacherId,
    error: null
  });

  const statusLine = `✅ Одобрено ${actor || ''} • добавлен как ${teacherId}`;
  await safeAnswerCallback(callback, 'Учитель добавлен в базу');
  await updateRequestMessage(callback, request, statusLine.trim());

  return teacherId;
}

async function processTeacherRequestRejection(request, callback) {
  const actor = describeTelegramUser(callback?.from);
  if (request.photo_filename) {
    deleteRequestPhoto(request.photo_filename);
  }

  finalizeTeacherRequest({
    id: request.id,
    status: TEACHER_REQUEST_STATUSES.REJECTED,
    processedBy: actor,
    action: 'reject',
    teacherId: null,
    error: null
  });

  const statusLine = `🚫 Отклонено ${actor || ''}`;
  await safeAnswerCallback(callback, 'Заявка отклонена');
  await updateRequestMessage(callback, request, statusLine.trim());
}

async function handleTeacherRequestCallback(callback) {
  const data = String(callback?.data || '');
  if (!data.startsWith('teacher_req:')) return false;

  const [, action, ...rest] = data.split(':');
  const requestId = rest.join(':');
  if (!requestId) {
    await safeAnswerCallback(callback, 'Не удалось распознать заявку', true);
    return true;
  }

  const request = getTeacherRequestById(requestId);
  if (!request) {
    await safeAnswerCallback(callback, 'Заявка не найдена или уже удалена', true);
    return true;
  }

  if (request.status !== TEACHER_REQUEST_STATUSES.PENDING) {
    const statusLine = request.status === TEACHER_REQUEST_STATUSES.APPROVED ? 'уже одобрена' : 'уже обработана';
    await safeAnswerCallback(callback, `Заявка ${statusLine}`);
    await updateRequestMessage(callback, request, request.status === TEACHER_REQUEST_STATUSES.APPROVED ? '✅ Уже одобрено' : '🚫 Уже отклонено');
    return true;
  }

  if (action === 'approve') {
    await processTeacherRequestApproval(request, callback);
    return true;
  }
  if (action === 'reject') {
    await processTeacherRequestRejection(request, callback);
    return true;
  }

  await safeAnswerCallback(callback, 'Неизвестное действие', true);
  return true;
}

function generateCommentReviewId() {
  // Short id to keep Telegram callback_data under 64 bytes
  return `cr_${crypto.randomBytes(9).toString('base64url')}`;
}

async function queueCommentForReview({ teacherRow, teacherId, text, authorName, userId, reason }) {
  const reviewId = generateCommentReviewId();
  const normalizedTeacher = teacherRow ? normalizeTeacherRow(teacherRow) : null;
  const teacherLabel = normalizedTeacher
    ? `${normalizedTeacher.lastName || ''} ${normalizedTeacher.firstName || ''}`.trim() || normalizedTeacher.id
    : String(teacherId || '');
  const reasonLabel = reason ? String(reason).replace(/_/g, ' ') : '';
  const maxCommentLen = 3500;
  const safeText = text
    ? (text.length > maxCommentLen ? `${text.slice(0, maxCommentLen)}…` : text)
    : '(пусто)';

  const lines = [
    '📝 Новый комментарий на модерацию',
    `ID: ${reviewId}`,
    `Учитель: ${teacherLabel || teacherId}`,
    `Автор: ${authorName || 'Аноним'}`,
    `Текст: ${safeText}`
  ];
  if (reasonLabel) lines.push(`Причина: ${reasonLabel}`);
  let messageText = lines.join('\n');
  if (messageText.length > 4096) {
    messageText = `${messageText.slice(0, 4088)}…`;
  }

  let telegramMeta = { chatId: null, messageId: null };

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_REVIEW_CHAT_ID) {
    try {
      const message = await callTelegramApi('sendMessage', {
        chat_id: TELEGRAM_REVIEW_CHAT_ID,
        text: messageText,
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Одобрить', callback_data: `comment_review:approve:${reviewId}` },
              { text: '🚫 Отклонить', callback_data: `comment_review:reject:${reviewId}` }
            ]
          ]
        }
      });
      telegramMeta = {
        chatId: message?.chat?.id ? String(message.chat.id) : TELEGRAM_REVIEW_CHAT_ID,
        messageId: message?.message_id ? String(message.message_id) : null
      };
    } catch (err) {
      const details = err?.description || err?.message || err;
      console.warn('Не удалось отправить комментарий в Telegram на модерацию:', details);
    }
  }

  insertPendingReview({
    id: reviewId,
    teacherId,
    text,
    authorName,
    userId,
    reason,
    createdTs: Date.now(),
    telegramChatId: telegramMeta.chatId,
    telegramMessageId: telegramMeta.messageId
  });

  logSecurityEvent('comment_queued_for_review', {
    teacherId,
    userId: userId || null,
    reviewId,
    reason: reason || 'needs_review',
    severity: 'info'
  });

  return { reviewId, telegramMeta };
}

async function handleCommentReviewCallback(callback) {
  const data = String(callback?.data || '');
  if (!data.startsWith('comment_review:')) return false;

  const [, action, reviewId] = data.split(':');
  const pending = getPendingReview(reviewId);
  if (!pending) {
    await safeAnswerCallback(callback, 'Комментарий уже обработан или не найден', true);
    return true;
  }

  const clearButtons = async () => {
    const chatId = callback?.message?.chat?.id ?? pending.telegramMeta?.chatId;
    const messageId = callback?.message?.message_id ?? pending.telegramMeta?.messageId;
    if (chatId && messageId) {
      try {
        await callTelegramApi('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] }
        });
      } catch (err) {
        if (err && err.description && /message is not modified/i.test(err.description)) return;
        console.warn('Не удалось убрать кнопки модерации комментария:', err && err.message ? err.message : err);
      }
    }
  };

  if (action === 'reject') {
    deletePendingReview(reviewId);
    logSecurityEvent('comment_rejected', {
      reviewId,
      teacherId: pending.teacherId,
      userId: pending.userId || null,
      reason: pending.reason || 'manual_review',
      severity: 'info'
    });
    await safeAnswerCallback(callback, 'Комментарий отклонён');
    await clearButtons();
    return true;
  }

  if (action === 'approve') {
    const teacherRow = getTeacherById(pending.teacherId);
    if (!teacherRow) {
      deletePendingReview(reviewId);
      await safeAnswerCallback(callback, 'Учитель не найден', true);
      await clearButtons();
      return true;
    }

    try {
      addComment({
        teacherId: pending.teacherId,
        author: pending.authorName || 'Аноним',
        text: pending.text,
        author_uid: pending.userId || ''
      });
      if (pending.userId) {
        incUserStats(String(pending.userId), { comments: 1 });
      }
      logSecurityEvent('comment_published_after_review', {
        reviewId,
        teacherId: pending.teacherId,
        userId: pending.userId || null,
        reason: pending.reason || 'manual_review'
      });
      deletePendingReview(reviewId);
      await safeAnswerCallback(callback, 'Комментарий опубликован');
      await clearButtons();
      invalidateTeacherPayloadCache(pending.teacherId);
    } catch (err) {
      console.error('Не удалось сохранить комментарий после одобрения:', err);
      await safeAnswerCallback(callback, 'Не удалось сохранить комментарий', true);
    }
    return true;
  }

  await safeAnswerCallback(callback, 'Неизвестное действие', true);
  return true;
}

// Users

// Функция для получения отображаемого имени пользователя (с учетом купленных ников)
function getDisplayName(user) {
  if (!user) return 'Student';

  const activeNick = getActiveNickname(user.id);
  if (activeNick) {
    return activeNick;
  }

  // Иначе используем стандартное имя
  return (user.username || user.email || 'Student').split('@')[0];
}

/* Sessions & Auth */
if (IS_PRODUCTION) {
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
} else {
  app.set('trust proxy', false);
}

function normalizeIp(ip) {
  if (!ip) return '0.0.0.0';
  const value = String(ip).trim();
  if (value === '::1') return '127.0.0.1';
  if (value.startsWith('::ffff:')) return value.slice(7);
  return value;
}

function getClientIp(req){
  if (!req) return '0.0.0.0';
  if (req.ip) return normalizeIp(req.ip);
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return normalizeIp(xf || req.socket?.remoteAddress || '0.0.0.0');
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

  const existingSessions = countActiveSessions(userId);
  if (existingSessions > 0) {
    deactivateSessionsByUser(userId, {
      eventType: 'login_session_replaced',
      severity: 'info',
      details: { ip, userAgent: ua }
    });
  }

  insertSession({
    id: sessionId,
    tokenHash,
    userId,
    createdTs: now,
    lastActivityTs: now,
    expiresTs,
    ip,
    userAgent: ua
  });

  logSecurityEvent('session_created', {
    userId,
    sessionId,
    ip,
    userAgent: ua
  });

  return token;
}

function getUserFromRequest(req, res = null){
  const response = res || req.res || null;
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const tokenHash = hashToken(token);
  const session = getUserFromSessionTokenHash(tokenHash);
  if (!session) {
    if (response) clearSessionCookie(response);
    return null;
  }

  const currentIp = getClientIp(req);
  const currentUa = String(req.headers['user-agent'] || '');

  const mismatches = [];
  if (session.user_agent && currentUa && session.user_agent !== currentUa) mismatches.push('user_agent');
  if (session.ip && currentIp && session.ip !== currentIp) mismatches.push('ip');

  if (mismatches.length) {
    logSecurityEvent('session_client_mismatch', {
      userId: session.user_id,
      sessionId: session.id,
      mismatches,
      sessionIp: session.ip,
      requestIp: currentIp,
      sessionUserAgent: session.user_agent,
      requestUserAgent: currentUa,
      severity: 'warning'
    });

    if (SESSION_BINDING_MODE === 'strict') {
      deactivateSessionByHash(tokenHash);
      if (response) clearSessionCookie(response);
      return null;
    }

    const nextIp = currentIp || session.ip || null;
    const nextUa = currentUa || session.user_agent || null;
    updateSessionClient(session.id, nextIp, nextUa);
  } else if ((!session.ip && currentIp) || (!session.user_agent && currentUa)) {
    const nextIp = currentIp || session.ip || null;
    const nextUa = currentUa || session.user_agent || null;
    updateSessionClient(session.id, nextIp, nextUa);
  }

  // Обновляем время последней активности
  updateSessionActivity(session.id, Date.now());

  const user = findUserById(session.user_id);
  if (!user && response) {
    clearSessionCookie(response);
  }
  return user || null;
}

// Возвращает вошедшего и НЕ забаненного пользователя для мутаций.
// Если не вошёл (401) или забанен (403) — отправляет ответ и возвращает null.
function getActiveUser(req, res) {
  const u = getUserFromRequest(req, res);
  if (!u) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (isUserBanned(u.id)) { res.status(403).json({ error: 'banned', message: 'account_banned' }); return null; }
  return u;
}

function invalidateSession(token) {
  if (!token) return;
  const tokenHash = hashToken(token);
  deactivateSessionByHash(tokenHash);
}

function invalidateAllUserSessions(userId) {
  deactivateSessionsByUser(userId, { logEvent: false });
  logSecurityEvent('all_sessions_invalidated', {
    userId,
    severity: 'warning'
  });
}

// Запускаем очистку периодически
const cleanupTimer = setInterval(() => {
  cleanupSessionsDb();
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
  const r = await fetchWithProxy(url).catch(()=>null);
  if (!r || !r.ok) throw new Error('gm_get_email_failed');
  const j = await r.json();
  return { email: j.email_addr, sid_token: j.sid_token };
}

async function gmCheckEmail(sid_token){
  const url = `https://api.guerrillamail.com/ajax.php?f=check_email&seq=1&sid_token=${encodeURIComponent(sid_token)}`;
  const r = await fetchWithProxy(url).catch(()=>null);
  if (!r || !r.ok) return [];
  const j = await r.json();
  return Array.isArray(j.list) ? j.list : [];
}

async function gmFetchEmail(sid_token, id){
  const url = `https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${encodeURIComponent(id)}&sid_token=${encodeURIComponent(sid_token)}`;
  const r = await fetchWithProxy(url).catch(()=>null);
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
  const collator = RU_COLLATOR;
  const departments = getDepartmentList().sort(collator.compare);
  res.json({departments});
});

/**
 * GET /api/teachers
 * Возвращает список учителей с предрассчитанными рейтингами и общим баллом.
 * Поддерживает базовые фильтры и пагинацию, чтобы не отдавать весь массив целиком.
 *
 * Query-параметры:
 *  - q: string — поиск по ФИО (регистр игнорируется)
 *  - department: string — точное совпадение по названию кафедры
 *  - limit: number (0..200) — размер страницы; если 0 или не задан, отдаётся весь список (не рекомендуется)
 *  - offset: number (>=0) — смещение для пагинации
 *
 * Ответ:
 *  {
 *    teachers: Teacher[], // отфильтрованный и отсортированный срез (если задан limit)
 *    total: number        // общее количество элементов после применения фильтров (без учёта limit/offset)
 *  }
 */
app.get('/api/teachers',(req,res)=>{
  const { list } = getEnrichedTeachersSnapshot();
  let filtered = list;

  // Применяем необязательные базовые фильтры (строка поиска по ФИО и фильтр по кафедре)
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q) {
    filtered = filtered.filter(t => ([t.lastName, t.firstName, t.patronymic].filter(Boolean).join(' ')).toLowerCase().includes(q));
  }
  const dept = String(req.query.department || '').trim();
  if (dept) {
    filtered = filtered.filter(t => String(t.department) === dept);
  }

  // Пагинация: ограничиваем размер страницы и вычисляем смещение
  const total = filtered.length;
  const limit = Math.max(0, Math.min(200, Number(req.query.limit||0)));
  const offset = Math.max(0, Number(req.query.offset||0));
  const paged = limit ? filtered.slice(offset, offset + limit) : filtered;

  res.json({teachers: paged, total});
});

/**
 * GET /api/home
 * Лёгкий payload для главной страницы: отдаём только то, что нужно для карточек.
 *  - Топ-3 учителя по каждой характеристике
 *  - Топ-3 учителя по каждой кафедре (по overall)
 * Это позволяет на главной не загружать весь список учителей.
 *
 * Ответ:
 *  {
 *    characteristics: { [key: string]: Teacher[] },
 *    departments: { name: string, list: Teacher[] }[]
 *  }
 */
app.get('/api/home', (req, res) => {
  const payload = getHomePayloadCached();
  res.json(payload);
});

app.get('/api/teacher/:id',(req,res)=>{
  const payload = buildTeacherPayload(req.params.id, req);
  if (!payload) return res.status(404).json({error:'not_found'});

  res.json(payload);
});


/* Сильная модерация мата */
// Комментарии + рейтинг + модерация (локальная + опциональная модель)
app.post('/api/comment-with-ratings', commentPerMinuteLimiter, async (req, res) => {
  try {
    const { teacherId, text, author, ratings } = req.body || {};
    if (!teacherId) return res.status(400).json({ error: 'bad_request' });

    const t = getTeacherById(teacherId);
    if (!t) return res.status(404).json({ error: 'teacher_not_found' });

    const u = getUserFromRequest(req);
    // Регистрация обязательна: и комментарии, и оценки — только для вошедших.
    // Это же гарантирует дедупликацию оценок по user_id (нет анонимной накрутки).
    if (!u) return res.status(401).json({ error: 'unauthorized', message: 'login_required' });
    const userId = u.id;
    const authorName = String(author || u.username || 'Аноним').slice(0, 64);
    const textStr = String(text || '').trim();

    const validRatingKeys = [];
    if (ratings && typeof ratings === 'object') {
      for (const k of Object.keys(ratings)) {
        const v = Number(ratings[k]);
        if (Array.isArray(CHARACTERISTICS_KEYS) && CHARACTERISTICS_KEYS.includes(k) && v >= 1 && v <= 5) {
          validRatingKeys.push(k);
        }
      }
    }
    const hasRatings = validRatingKeys.length > 0;

    if (!textStr && !hasRatings) {
      return res.status(400).json({ error: 'bad_request', message: 'empty' });
    }

    // Бан блокирует любое действие (и комментарий, и оценку).
    if (isUserBanned(u.id)) {
      return res.status(403).json({ error: 'banned', message: 'account_banned' });
    }

    const handleLocalBan = async () => {
      if (!u?.id) return;
      try {
        setBanStatus(u.id, true, 'local_profanity');
        logSecurityEvent('user_auto_banned_for_profanity', {
          userId: u.id,
          teacherId,
          snippet: textStr.slice(0, 180)
        });
      } catch (err) {
        console.warn('Не удалось автоматически забанить пользователя за мат:', err && err.message ? err.message : err);
      }
    };

    const moderationResult = textStr
      ? await moderateComment(textStr, {
          gptApiKey: GPT_MODERATION_API_KEY,
          gptApiUrl: GPT_MODERATION_URL,
          gptModel: GPT_MODERATION_MODEL,
          onLocalBan: handleLocalBan
        })
      : { decision: COMMENT_DECISIONS.ALLOW };

    if (textStr && moderationResult.decision === COMMENT_DECISIONS.DELETE) {
      try {
        logSecurityEvent('comment_blocked', {
          teacherId,
          userId: u?.id || null,
          reason: moderationResult.reason || 'forbidden'
        });
      } catch (err) {
        console.warn('Не удалось записать блокировку комментария:', err && err.message ? err.message : err);
      }
      return res.status(400).json({
        error: 'comment_blocked',
        reason: moderationResult.reason || 'forbidden',
        score: moderationResult.score || 0
      });
    }

    let queuedReviewId = null;
    let commentAdded = false;
    let invalidatePayload = false;
    let invalidateAggregates = false;
    let moderationUnavailable = false;

    // Сначала сохраняем оценки — они не зависят от модерации текста и не должны
    // теряться, если комментарий уходит на ручную модерацию или не сохранился.
    let ratingUpdateInfo = { added: 0, updated: 0 };
    if (hasRatings) {
      try {
        ratingUpdateInfo = updateRatings(teacherId, ratings, userId) || ratingUpdateInfo;
        if (ratingUpdateInfo.added || ratingUpdateInfo.updated) {
          invalidateAggregates = true;
          invalidatePayload = true;
        }
      } catch (err) {
        console.error('updateRatings failed:', err && err.message ? err.message : err);
        ratingUpdateInfo = { added: 0, updated: 0 };
      }
    }

    // Затем — текстовый комментарий.
    if (textStr) {
      if (moderationResult.decision === COMMENT_DECISIONS.REVIEW) {
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_REVIEW_CHAT_ID) {
          // Модерация недоступна: текст не публикуем, но оценки уже сохранены.
          moderationUnavailable = true;
        } else {
          try {
            const { reviewId } = await queueCommentForReview({
              teacherRow: t,
              teacherId,
              text: textStr,
              authorName,
              userId,
              reason: moderationResult.reason || 'needs_review'
            });
            queuedReviewId = reviewId;
          } catch (err) {
            console.error('Не удалось поставить комментарий в очередь модерации:', err && err.message ? err.message : err);
            moderationUnavailable = true;
          }
        }
      } else if (moderationResult.decision === COMMENT_DECISIONS.ALLOW) {
        try {
          await addComment({ teacherId, author: authorName, text: textStr, author_uid: userId });
          commentAdded = true;
          invalidatePayload = true;
        } catch (err) {
          console.error('addComment failed:', err && err.message ? err.message : err);
          // Если и оценок нет — это полноценная ошибка; иначе сохраняем оценки.
          if (!ratingUpdateInfo.added && !ratingUpdateInfo.updated) {
            return res.status(500).json({ error: 'server_error', message: 'failed_to_save_comment' });
          }
          moderationUnavailable = true;
        }
      }
    }

    // Статистика пользователя — считаем валидные оценки и комментарии
    try {
      const ratingDelta = ratingUpdateInfo?.added ?? (hasRatings ? validRatingKeys.length : 0);
      incUserStats(u.id, { comments: commentAdded ? 1 : 0, ratings: ratingDelta });
    } catch (err) {
      console.warn('incUserStats failed:', err && err.message ? err.message : err);
    }

    if (invalidateAggregates) {
      invalidateAllTeacherCaches(teacherId);
    } else if (invalidatePayload) {
      invalidateTeacherPayloadCache(teacherId);
    }

    return res.json({
      ok: true,
      pendingReview: !!queuedReviewId,
      reviewId: queuedReviewId || undefined,
      moderationUnavailable: moderationUnavailable || undefined,
      ratingsSaved: (ratingUpdateInfo.added || ratingUpdateInfo.updated) ? true : undefined,
      teacher: buildTeacherPayload(teacherId, req)
    });
  } catch (err) {
    console.error('Unhandled error in /api/comment-with-ratings:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/comment/vote', (req,res)=>{
  const u = getActiveUser(req, res);
  if (!u) return;

  const {commentId, vote} = req.body || {};
  const c = getCommentById(commentId);
  if (!c) return res.status(404).json({error:'not_found'});

  if (c.author_uid && String(c.author_uid)===String(u.id)){
    return res.status(403).json({error:'forbidden'});
  }

  const newVote = vote==='like' ? 1 : vote==='dislike' ? -1 : 0;
  const prev = getUserVote(commentId, u.id);

  if (prev === newVote){
    const {counts} = countVotesForCommentBulk([String(commentId)], u.id);
    const cnt = counts[String(commentId)] || {likes:0,dislikes:0};
    return res.json({ok:true, likes:cnt.likes, dislikes:cnt.dislikes, myVote:newVote});
  }

  const cast_like     = (newVote===1?1:0)  - (prev===1?1:0);
  const cast_dislike  = (newVote===-1?1:0) - (prev===-1?1:0);
  const recv_like     = cast_like;
  const recv_dislike  = cast_dislike;

  // Голос и счётчики — атомарно, чтобы comment_votes и users не рассинхронились при сбое.
  db.transaction(() => {
    setUserVote(commentId, u.id, newVote);
    if (cast_like || cast_dislike) incUserStats(u.id, { cast_like, cast_dislike });
    if (c.author_uid) incUserStats(String(c.author_uid), { recv_like, recv_dislike });
  })();

  const {counts} = countVotesForCommentBulk([String(commentId)], u.id);
  const cnt = counts[String(commentId)] || {likes:0,dislikes:0};
  invalidateTeacherPayloadCache(c.teacher_id);
  res.json({ok:true, likes:cnt.likes, dislikes:cnt.dislikes, myVote:newVote});
});

app.post('/api/teacher-request', (req, res) => {
  const u = getActiveUser(req, res);
  if (!u) return;
  teacherRequestUpload(req, res, async uploadErr => {
    if (uploadErr) {
      const code = uploadErr?.code || uploadErr?.message;
      if (code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ ok: false, error: 'photo_too_large' });
      }
      if (code === 'UNSUPPORTED_FILE_TYPE' || uploadErr.message === 'unsupported_file_type') {
        return res.status(400).json({ ok: false, error: 'unsupported_photo_type' });
      }
      console.error('Ошибка загрузки файла заявки учителя:', uploadErr);
      return res.status(500).json({ ok: false, error: 'upload_failed' });
    }

    try {
      const fields = req.body || {};
      const lastName = sanitizeRequestField(fields.lastName, 120);
      const firstName = sanitizeRequestField(fields.firstName, 120);
      const patronymic = sanitizeRequestField(fields.patronymic, 120);
      const departmentKey = normalizeDepartmentKey(fields.department);
      const subjects = normalizeSubjectsList(fields.subjects);
      const submitterName = sanitizeRequestField(fields.submitterName, 160);
      const submitterContact = sanitizeRequestField(fields.submitterContact, 160);
      const notes = sanitizeRequestMultiline(fields.notes, 1500);

      if (!lastName || !firstName) {
        return res.status(400).json({ ok: false, error: 'missing_name' });
      }
      if (!departmentKey) {
        return res.status(400).json({ ok: false, error: 'missing_department' });
      }
      if (!subjects.length) {
        return res.status(400).json({ ok: false, error: 'missing_subjects' });
      }

      const departmentsLookup = buildDepartmentsLookup();
      if (!departmentsLookup.size) {
        return res.status(503).json({ ok: false, error: 'departments_unavailable' });
      }
      const department = departmentsLookup.get(departmentKey);
      if (!department) {
        return res.status(400).json({ ok: false, error: 'invalid_department' });
      }

      const payload = {
        lastName,
        firstName,
        patronymic,
        department,
        subjects,
        submitterName,
        submitterContact,
        notes,
        source: 'public_form',
        photoOriginalName: req.file?.originalname || null,
        photoMime: req.file?.mimetype || null
      };

      const meta = {
        photoFilename: req.file?.filename || null,
        ip: req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.ip,
        userAgent: req.headers['user-agent'] || ''
      };

      const { id } = insertTeacherRequest(payload, meta);

      if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_REVIEW_CHAT_ID) {
        updateTeacherRequestError(id, 'telegram_not_configured');
        return res.status(503).json({ ok: false, error: 'telegram_not_configured', requestId: id });
      }

      const fio = [lastName, firstName, patronymic].filter(Boolean).join(' ');
      const summaryLines = [
        '🆕 Запрос на добавление учителя',
        `ID: ${id}`,
        `ФИО: ${fio}`,
        `Кафедра: ${department}`,
        `Предметы: ${subjects.join(', ') || '—'}`
      ];
      if (submitterName) summaryLines.push(`Отправитель: ${submitterName}`);
      if (submitterContact) summaryLines.push(`Контакт: ${submitterContact}`);
      const fullSummaryText = summaryLines.join('\n');
      const summaryText = fullSummaryText.length > 1024 ? `${fullSummaryText.slice(0, 1019)}…` : fullSummaryText;

      const detailsLines = [];
      if (notes) {
        const truncatedNotes = notes.length > 3500 ? `${notes.slice(0, 3495)}…` : notes;
        detailsLines.push('Комментарий:');
        detailsLines.push(truncatedNotes);
      }
      let detailsText = detailsLines.join('\n').trim();
      if (detailsText.length > 4096) {
        detailsText = `${detailsText.slice(0, 4090)}…`;
      }

      const replyMarkup = {
        inline_keyboard: [
          [
            { text: '✅ Одобрить', callback_data: `teacher_req:approve:${id}` },
            { text: '🚫 Отклонить', callback_data: `teacher_req:reject:${id}` }
          ]
        ]
      };

      try {
        let message = null;
        if (req.file) {
          const photoPath = path.join(REQUEST_PHOTO_DIR, req.file.filename);
          let caption = summaryText;
          if (caption.length > 1024) {
            caption = `${caption.slice(0, 1019)}…`;
          }
          message = await sendTelegramPhotoMessage({
            chatId: TELEGRAM_REVIEW_CHAT_ID,
            filePath: photoPath,
            fileName: req.file.originalname || req.file.filename,
            mimeType: req.file.mimetype || 'image/jpeg',
            caption,
            replyMarkup
          });
          if (detailsText) {
            await callTelegramApi('sendMessage', {
              chat_id: TELEGRAM_REVIEW_CHAT_ID,
              text: detailsText,
              disable_web_page_preview: true
            });
          }
        } else {
          let text = [fullSummaryText, detailsText].filter(Boolean).join('\n\n');
          if (text.length > 4096) {
            text = `${text.slice(0, 4090)}…`;
          }
          message = await callTelegramApi('sendMessage', {
            chat_id: TELEGRAM_REVIEW_CHAT_ID,
            text,
            disable_web_page_preview: true,
            reply_markup: replyMarkup
          });
        }

        const telegramChatId = message?.chat?.id ? String(message.chat.id) : TELEGRAM_REVIEW_CHAT_ID;
        const telegramMessageId = message?.message_id ? String(message.message_id) : null;
        setTeacherRequestTelegramMeta(id, telegramChatId, telegramMessageId);

        res.json({ ok: true, requestId: id });
      } catch (err) {
        updateTeacherRequestError(id, err?.description || err?.message || 'telegram_failed');
        if (err && err.code === 'TELEGRAM_FAILED') {
          return res.status(502).json({ ok: false, error: 'telegram_failed', description: err.description || 'telegram_failed', requestId: id });
        }
        if (err && err.code === 'TELEGRAM_NOT_CONFIGURED') {
          return res.status(503).json({ ok: false, error: 'telegram_not_configured', requestId: id });
        }
        console.error('Ошибка отправки заявки в Telegram:', err);
        return res.status(500).json({ ok: false, error: 'telegram_failed', requestId: id });
      }
    } catch (err) {
      console.error('Ошибка обработки заявки на добавление учителя:', err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });
});

app.post('/api/telegram/webhook', express.json({ limit: '1mb' }), async (req, res) => {
  // Секрет обязателен: без него webhook отклоняется, иначе любой мог бы
  // подделывать callback'и (одобрять комментарии, создавать учителей).
  if (!TELEGRAM_WEBHOOK_SECRET) {
    return res.status(503).json({ ok: false, error: 'webhook_secret_not_configured' });
  }
  const provided = String(req.headers['x-telegram-bot-api-secret-token'] || '').trim();
  if (!timingSafeEqualStr(provided, TELEGRAM_WEBHOOK_SECRET)) {
    return res.status(403).json({ ok: false });
  }

  const update = req.body || {};

  try {
    if (update.callback_query) {
      const handledReview = await handleCommentReviewCallback(update.callback_query);
      if (!handledReview) {
        await handleTeacherRequestCallback(update.callback_query);
      }
    }
  } catch (err) {
    console.error('Ошибка обработки Telegram webhook:', err);
  }

  res.json({ ok: true });
});

/* --- ADMIN API --- */

app.get('/api/admin/admins', requireSuperAdmin, (req, res) => {
  try {
    const admins = listAdminEmails().map(email => ({
      email,
      isRoot: ROOT_ADMIN_EMAIL ? email === ROOT_ADMIN_EMAIL : false,
    }));
    res.json({ ok: true, admins });
  } catch (err) {
    console.error('Ошибка получения списка администраторов:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/admin/admins/add', requireSuperAdmin, express.json({ limit: '1mb' }), (req, res) => {
  try {
    const emailRaw = req.body?.email;
    const email = String(emailRaw || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    if (!email.endsWith(ALLOWED_EMAIL_DOMAIN)) {
      return res.status(400).json({ ok: false, error: 'invalid_domain' });
    }

    addAdminEmail(email);
    logSecurityEvent('admin_granted', {
      email,
      grantedBy: req.user?.email || 'unknown',
      severity: 'info'
    });

    const admins = listAdminEmails().map(e => ({ email: e, isRoot: ROOT_ADMIN_EMAIL ? e === ROOT_ADMIN_EMAIL : false }));
    res.json({ ok: true, admins });
  } catch (err) {
    console.error('Ошибка добавления администратора:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/admin/admins/remove', requireSuperAdmin, express.json({ limit: '1mb' }), (req, res) => {
  try {
    const emailRaw = req.body?.email;
    const email = String(emailRaw || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    if (ROOT_ADMIN_EMAIL && email === ROOT_ADMIN_EMAIL) {
      return res.status(400).json({ ok: false, error: 'cannot_remove_root' });
    }

    removeAdminEmail(email);
    logSecurityEvent('admin_revoked', {
      email,
      revokedBy: req.user?.email || 'unknown',
      severity: 'warning'
    });

    const admins = listAdminEmails().map(e => ({ email: e, isRoot: ROOT_ADMIN_EMAIL ? e === ROOT_ADMIN_EMAIL : false }));
    res.json({ ok: true, admins });
  } catch (err) {
    console.error('Ошибка удаления администратора:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

function requireAdmin(req,res,next){
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({error:'unauthorized'});
  if (!isAdminUser(u)) return res.status(403).json({error:'forbidden'});
  req.user = u;
  next();
}

function requireSuperAdmin(req,res,next){
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({ error:'unauthorized' });
  if (!isSuperAdminUser(u)) return res.status(403).json({ error:'forbidden' });
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

  const users = getUserList();
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

  const all = getAllCommentsByUser(userId);

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
  const users = getUserList();

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
  const all = getAdminComments(limit);

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
  invalidateTeacherPayloadCache(comment.teacher_id);
  return res.json({ ok:true });
});


// --- Жалобы на комментарии (пользователи -> Telegram админу) ---
app.post('/api/report-comment', express.json(), async (req, res) => {
  const u = getActiveUser(req, res);
  if (!u) return;
  const { commentId, reason } = req.body || {};
  const cleanedReason = String(reason || '').trim();
  if (!commentId || !cleanedReason) return res.status(400).json({ error: 'bad_request' });

  const comment = getCommentById(commentId);
  if (!comment) return res.status(404).json({ error: 'comment_not_found' });


  const reporter = u.email;
  const messageParts = [
    '🚩 Жалоба на комментарий',
    `ID: ${commentId}`,
    `От: ${reporter}`,
    `Текст: ${String(comment.text || '(без текста)')}`,
    `Причина: ${cleanedReason.slice(0, 500)}`
  ];
  const msg = messageParts.join('\n');

  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_REVIEW_CHAT_ID) {
      console.warn('TELEGRAM_TOKEN или CHAT_ID не заданы');
      return res.status(503).json({ ok: false, error: 'telegram_not_configured' });
    }

    await callTelegramApi('sendMessage', {
      chat_id: TELEGRAM_REVIEW_CHAT_ID,
      text: msg
    });

    res.json({ ok: true });
  } catch (err) {
    if (err && err.code === 'TELEGRAM_FAILED') {
      console.warn('Telegram вернул ошибку при отправке жалобы:', err.description || err.message);
      return res.status(502).json({ ok: false, error: 'telegram_failed', description: err.description || 'telegram_failed' });
    }
    if (err && err.code === 'TELEGRAM_NOT_CONFIGURED') {
      return res.status(503).json({ ok: false, error: 'telegram_not_configured' });
    }
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
  const result = teachers.map(normalizeTeacherRow).filter(Boolean);
  return res.json({ ok:true, teachers: result });
});

app.post('/api/admin/teacher/upsert', requireAdmin, express.json(), (req,res)=>{
  const { id, lastName, firstName, patronymic, department, subjects, photo } = req.body || {};
  upsertTeacher({ id, lastName, firstName, patronymic, department, subjects, photo });
  // сбрасываем кэш списков/деталей, чтобы обновления были мгновенными
  invalidateAllTeacherCaches(id);
  return res.json({ ok:true, total: getAllTeachers().length });
});

app.post('/api/admin/teacher/delete', requireAdmin, express.json(), (req,res)=>{
  const { id } = req.body || {};
  if (!id) return res.status(400).json({error:'bad_request'});
  deleteTeacherById(String(id));
  invalidateAllTeacherCaches(id);
  return res.json({ ok:true, total: getAllTeachers().length });
});

/* --- ADMIN SECURITY ENDPOINTS --- */

// Просмотр логов безопасности
app.get('/api/admin/security/logs', requireAdmin, (req,res)=>{
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const severity = req.query.severity || null;

  const { logs, total } = getSecurityLogs({ limit, offset, severity });

  res.json({
    ok: true,
    logs: logs.map(log => ({
      ...log,
      details: log.details ? JSON.parse(log.details) : null
    })),
    total,
    limit,
    offset
  });
});

// Просмотр активных сессий
app.get('/api/admin/security/sessions', requireAdmin, (req,res)=>{
  const sessions = getActiveSessionsList();

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

  const attempts = getLoginAttempts({ cutoff, limit: 100 });

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
  const u = getUserFromRequest(req, res);
  if (!u) return res.status(401).json({error:'unauthorized'});

  const sessions = getUserSessions(u.id);
  const cookies = parseCookies(req);
  const currentToken = cookies[SESSION_COOKIE] || null;
  const currentTokenHash = currentToken ? hashToken(currentToken) : null;

  res.json({
    ok: true,
    sessions: sessions.map(s => ({
      id: s.id,
      createdAt: new Date(s.created_ts).toISOString(),
      lastActivity: new Date(s.last_activity_ts).toISOString(),
      expiresAt: new Date(s.expires_ts).toISOString(),
      ip: s.ip,
      userAgent: s.user_agent,
      isCurrent: currentTokenHash ? s.token_hash === currentTokenHash : false
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
    revokeOtherSessions(u.id, currentTokenHash);
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
      insertLoginEvent({
        action: 'login',
        email: user.email,
        ip: getClientIp(req),
        ua: req.headers['user-agent'] || ''
      });
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
        is_super_admin: isSuperAdminUser(user),
        is_banned: isUserBanned(user.id)
      }
    });
  }
  return res.json({ status:'pending' });
});

app.get('/api/auth/me', (req,res)=>{
  const u = getUserFromRequest(req);
  if (!u) {
    clearSessionCookie(res);
    return res.json({ loggedIn:false });
  }
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
      is_super_admin: isSuperAdminUser(u),
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
      insertLoginEvent({
        action: 'logout',
        email: u.email,
        ip: getClientIp(req),
        ua: req.headers['user-agent'] || ''
      });

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
  if (!u) return res.status(401).json({ ok:false, error:'unauthorized' });
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

function buildShopStateForUser(user) {
  if (!user) return null;

  const availableItems = getShopItems();
  const purchasedItems = new Set(getUserPurchasedItems(user.id).map(row => row.item_id));
  const activeByType = new Map(getActiveInventoryForUser(user.id).map(row => [row.item_type, row.item_id]));

  const balance = getAvailableCoins(user);
  const earnedCoins = calculateEarnedCoins(user);
  const spentCoins = getUserSpentCoins(user.id);
  const activeNickname = getActiveNickname(user.id);

  return {
    items: availableItems.map(item => ({
      ...item,
      purchased: purchasedItems.has(item.id),
      isActive: activeByType.get(item.category) === item.id
    })),
    balance,
    earnedCoins,
    spentCoins,
    activeNickname
  };
}

app.get('/api/shop/items', (req, res) => {
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });

  const shopState = buildShopStateForUser(u);

  res.json({
    ok: true,
    ...(shopState || {})
  });
});

app.post('/api/shop/buy', express.json(), (req, res) => {
  const u = getActiveUser(req, res);
  if (!u) return;

  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'bad_request' });

  const item = getShopItemById(itemId);
  if (!item) return res.status(404).json({ error: 'item_not_found' });

  const availableCoins = getAvailableCoins(u);
  if (availableCoins < item.price) {
    return res.status(400).json({ error: 'not_enough_coins' });
  }

  // Проверяем, не куплен ли уже этот ник
  const existing = getExistingInventoryItem(u.id, itemId, item.category);

  if (existing) {
    const shopState = buildShopStateForUser(u);
    return res.status(400).json({ error: 'already_purchased', shop: shopState || null });
  }

  const hadActiveInCategory = getActiveInventoryForUser(u.id).some(row => row.item_type === item.category);

  // Покупаем товар
  const newInventoryRow = insertInventoryItem({
    userId: u.id,
    itemId,
    category: item.category,
    name: item.name,
    price: item.price
  });

  if (!newInventoryRow) {
    return res.status(500).json({ error: 'cannot_save_purchase' });
  }

  // Если это первый ник в категории — активируем сразу, чтобы он отобразился в профиле
  if (!hadActiveInCategory) {
    activateInventoryItemById(newInventoryRow.id);
  }

  const shopState = buildShopStateForUser(u);

  logSecurityEvent('shop_purchase', {
    userId: u.id,
    itemId: itemId,
    itemName: item.name,
    price: item.price,
    balanceBefore: availableCoins,
    balanceAfter: shopState?.balance ?? availableCoins
  });

  invalidateAllTeacherPayloads();

  res.json({
    ok: true,
    message: `Ник "${item.name}" успешно приобретен!`,
    balance: shopState?.balance ?? getAvailableCoins(u),
    earnedCoins: shopState?.earnedCoins ?? calculateEarnedCoins(u),
    spentCoins: shopState?.spentCoins ?? getUserSpentCoins(u.id),
    activeNickname: shopState?.activeNickname || null,
    shop: shopState || null
  });
});

app.post('/api/shop/activate', express.json(), (req, res) => {
  const u = getActiveUser(req, res);
  if (!u) return;

  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'bad_request' });

  const shopItem = getShopItemMeta(itemId);
  if (!shopItem) {
    return res.status(404).json({ error: 'item_not_found' });
  }

  // Проверяем, есть ли у пользователя этот товар
  const item = getInventoryItem(u.id, itemId, shopItem.category);

  if (!item) {
    return res.status(400).json({ error: 'item_not_owned' });
  }

  // Деактивируем все ники пользователя
  deactivateUserInventory(u.id, shopItem.category);

  // Активируем выбранный ник
  activateInventoryItemById(item.id);

  logSecurityEvent('nickname_activated', {
    userId: u.id,
    itemId: itemId,
    nickname: item.item_name,
    category: shopItem.category
  });

  const shopState = buildShopStateForUser(u);
  invalidateAllTeacherPayloads();

  res.json({
    ok: true,
    message: `Ник "${item.item_name}" теперь отображается в вашем профиле!`,
    balance: shopState?.balance ?? getAvailableCoins(u),
    earnedCoins: shopState?.earnedCoins ?? calculateEarnedCoins(u),
    spentCoins: shopState?.spentCoins ?? getUserSpentCoins(u.id),
    activeNickname: shopState?.activeNickname || null,
    shop: shopState || null
  });
});

app.post('/api/shop/deactivate', express.json(), (req, res) => {
  const u = getActiveUser(req, res);
  if (!u) return;

  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'bad_request' });

  const inventoryItem = getActiveInventoryItem(u.id, itemId);

  if (!inventoryItem) {
    return res.status(400).json({ error: 'not_active' });
  }

  deactivateUserInventoryByType(u.id, inventoryItem.item_type);

  logSecurityEvent('nickname_deactivated', {
    userId: u.id,
    itemId,
    nickname: inventoryItem.item_name,
    category: inventoryItem.item_type
  });

  const shopState = buildShopStateForUser(u);
  invalidateAllTeacherPayloads();

  res.json({
    ok: true,
    message: `Ник "${inventoryItem.item_name}" деактивирован.`,
    balance: shopState?.balance ?? getAvailableCoins(u),
    earnedCoins: shopState?.earnedCoins ?? calculateEarnedCoins(u),
    spentCoins: shopState?.spentCoins ?? getUserSpentCoins(u.id),
    activeNickname: shopState?.activeNickname || null,
    shop: shopState || null
  });
});

app.get('/api/shop/my-items', (req, res) => {
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });

  const items = getInventoryForUser(u.id);

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

/* Неизвестные API-маршруты — всегда JSON 404, чтобы catch-all SPA ниже
   случайно не отдал им index.html (HTML вместо данных). */
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found' });
});

/* Catch-all для SPA (исключаем /api и файлы с расширением) */
app.get(/^\/(?!api\/)(?!.*\.).*$/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

function printStartupInfo(port = PORT) {
  const stats = getStartupStats();

  console.log('\n' + '='.repeat(60));
  console.log('🎓  LETO TALKS — Платформа рейтинга учителей');
  console.log('='.repeat(60));
  console.log('');
  console.log('🌐  Сервер:        http://localhost:' + port);
  console.log('📊  База данных:   SQLite (WAL mode)');
  console.log('🔒  Безопасность:  Helmet + Rate Limiting');
  console.log('');
  console.log('📈  Статистика:');
  console.log('    👨‍🏫 Учителя:    ' + stats.teachersCount);
  console.log('    👥 Пользователи: ' + stats.usersCount);
  console.log('    💬 Комментарии:  ' + stats.commentsCount);
  console.log('    🛡️  Администраторы: ' + stats.adminCount);
  console.log('');
  console.log('✅  Сервер готов к работе!');
  console.log('='.repeat(60));
  console.log('');
}

function startServer(_port = PORT, onListen = null) {
  const server = app.listen(PORT, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : PORT;
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
