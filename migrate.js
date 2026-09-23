// migrate.js — инициализация БД: создаёт каталоги и всю схему идемпотентно.
// Безопасно запускать многократно: существующие данные не трогаются.
//   npm run migrate
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { ensureDirsAndDb, createDbProcessing } = require('./db_processing');

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PHOTO_DIR = path.join(ROOT_DIR, 'photos');
const REQUEST_PHOTO_DIR = path.join(DATA_DIR, 'teacher_request_photos');
const DB_PATH = process.env.LETOTALKS_DB_PATH
  ? path.resolve(process.env.LETOTALKS_DB_PATH)
  : path.join(ROOT_DIR, 'letotalks.db');

ensureDirsAndDb({ dataDir: DATA_DIR, photoDir: PHOTO_DIR, requestPhotoDir: REQUEST_PHOTO_DIR, dbPath: DB_PATH });

const ctx = createDbProcessing({
  dbPath: DB_PATH,
  defaultPhoto: '/photo/default_photo.png',
  defaultShopItems: [
    { id: 'nick-0', name: 'Новичок', price: 1, category: 'nickname' },
    { id: 'nick-1', name: 'Умник', price: 20, category: 'nickname' },
    { id: 'nick-2', name: 'Отличник', price: 50, category: 'nickname' },
    { id: 'nick-3', name: 'Эрудит', price: 75, category: 'nickname' },
    { id: 'nick-4', name: 'Профи', price: 150, category: 'nickname' },
    { id: 'nick-5', name: 'Гуру', price: 200, category: 'nickname' },
    { id: 'nick-6', name: 'Легенда', price: 300, category: 'nickname' },
    { id: 'nick-7', name: 'Мастер', price: 250, category: 'nickname' },
    { id: 'nick-8', name: 'kinnijin', price: 180, category: 'nickname' }
  ],
  characteristicsKeys: ['clarity', 'humor', 'strict', 'favorites'],
  teacherRequestStatuses: { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' },
  rootAdminEmail: (process.env.ROOT_ADMIN_EMAIL || '').trim().toLowerCase(),
  sessionConfig: { sessionTtlMs: 1000 * 60 * 60 * 24 * 14, maxSessionsPerUser: 1 }
});

console.log('✅  Миграция выполнена: схема БД готова ->', DB_PATH);
if (ctx.db && typeof ctx.db.close === 'function') ctx.db.close();
