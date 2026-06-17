const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function loadBetterSqlite3() {
  try {
    return require('better-sqlite3');
  } catch (err) {
    const needsRebuild = err && err.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(String(err.message || ''));
    if (!needsRebuild) throw err;
    console.warn('⚠️  Обнаружено несовпадение версии native-модуля better-sqlite3. Пытаюсь пересобрать под текущую версию Node...');
    try {
      const rebuildArgs = ['rebuild', 'better-sqlite3'];
      if (process.env.npm_execpath) {
        execFileSync(process.execPath, [process.env.npm_execpath, ...rebuildArgs], {
          cwd: __dirname,
          stdio: 'inherit'
        });
      } else {
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        execFileSync(npmCmd, rebuildArgs, {
          cwd: __dirname,
          stdio: 'inherit'
        });
      }
      try {
        delete require.cache[require.resolve('better-sqlite3')];
      } catch {}
      console.log('✅ better-sqlite3 успешно пересобран. Повторная загрузка...');
      return require('better-sqlite3');
    } catch (rebuildErr) {
      console.error('❌ Автоматически пересобрать better-sqlite3 не удалось. Выполните вручную: npm rebuild better-sqlite3');
      console.error(rebuildErr);
      throw err;
    }
  }
}

function ensureDirsAndDb({ dataDir, photoDir, requestPhotoDir, dbPath }) {
  if (dataDir && !fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (photoDir && !fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
  if (requestPhotoDir && !fs.existsSync(requestPhotoDir)) fs.mkdirSync(requestPhotoDir, { recursive: true });

  if (dbPath) {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    if (!fs.existsSync(dbPath)) {
      // Файл создастся автоматически при первом открытии в createDbProcessing,
      // где идемпотентно создаётся вся схема (CREATE TABLE IF NOT EXISTS).
      console.log('ℹ️  База данных не найдена — будет создана новая по схеме.');
    }
  }
}

function createDbProcessing({
  dbPath,
  defaultPhoto,
  defaultShopItems = [],
  characteristicsKeys = [],
  teacherRequestStatuses,
  rootAdminEmail = '',
  sessionConfig = {}
}) {
  const Database = loadBetterSqlite3();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const { sessionTtlMs = 0, maxSessionsPerUser = 5 } = sessionConfig;

  // --- Базовые (core) таблицы. Создаём идемпотентно, чтобы свежий стенд
  // поднимался без заранее заготовленного файла БД. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL DEFAULT '',
      created_ts INTEGER NOT NULL DEFAULT 0,
      last_login_ts INTEGER NOT NULL DEFAULT 0,
      login_count INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      rating_count INTEGER NOT NULL DEFAULT 0,
      cast_likes INTEGER NOT NULL DEFAULT 0,
      cast_dislikes INTEGER NOT NULL DEFAULT 0,
      received_likes INTEGER NOT NULL DEFAULT 0,
      received_dislikes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS teachers (
      id TEXT PRIMARY KEY,
      last_name TEXT NOT NULL DEFAULT '',
      first_name TEXT NOT NULL DEFAULT '',
      patronymic TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      subjects TEXT NOT NULL DEFAULT '',
      photo TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      teacher_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      ts_iso TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'Аноним',
      text TEXT NOT NULL DEFAULT '',
      author_uid TEXT DEFAULT '',
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_comments_teacher ON comments(teacher_id);
    CREATE INDEX IF NOT EXISTS idx_comments_ts ON comments(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_author_uid ON comments(author_uid);

    CREATE TABLE IF NOT EXISTS ratings (
      teacher_id TEXT NOT NULL,
      key TEXT NOT NULL,
      sum INTEGER NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (teacher_id, key),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS comment_votes (
      comment_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      vote INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (comment_id, user_id),
      FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_votes_comment ON comment_votes(comment_id);
    CREATE INDEX IF NOT EXISTS idx_votes_user ON comment_votes(user_id);

    CREATE TABLE IF NOT EXISTS admins (
      email TEXT PRIMARY KEY,
      role TEXT DEFAULT 'admin'
    );

    CREATE TABLE IF NOT EXISTS banned_users (
      user_id TEXT PRIMARY KEY,
      is_banned INTEGER NOT NULL DEFAULT 0,
      reason TEXT DEFAULT '',
      ts INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS login_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_iso TEXT NOT NULL,
      action TEXT NOT NULL,
      email TEXT NOT NULL,
      ip TEXT DEFAULT '',
      ua TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_login_ts ON login_events(ts DESC);

    CREATE TABLE IF NOT EXISTS shop_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      category TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS user_ratings (
      user_id TEXT NOT NULL,
      teacher_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL,
      PRIMARY KEY (user_id, teacher_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_ratings_teacher ON user_ratings(teacher_id, key);

    CREATE TABLE IF NOT EXISTS teacher_requests (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_ts INTEGER NOT NULL,
      created_iso TEXT NOT NULL,
      payload TEXT NOT NULL,
      photo_filename TEXT,
      submitter_ip TEXT,
      submitter_agent TEXT,
      telegram_chat_id TEXT,
      telegram_message_id TEXT,
      processed_ts INTEGER,
      processed_iso TEXT,
      processed_by TEXT,
      processed_action TEXT,
      teacher_id TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_teacher_requests_status ON teacher_requests(status);

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
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_ts);

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
    );
    CREATE INDEX IF NOT EXISTS idx_security_log_ts ON security_log(ts);
    CREATE INDEX IF NOT EXISTS idx_security_log_type ON security_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_security_log_user ON security_log(user_id);

    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      ip TEXT NOT NULL,
      ts INTEGER NOT NULL,
      success INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email, ts);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, ts);
  `);

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

  function ensureShopItemsTable() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shop_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price INTEGER NOT NULL,
        category TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      )
    `);

    try {
      const columns = db.prepare('PRAGMA table_info(shop_items)').all();
      const hasIsActive = columns.some(col => col.name === 'is_active');
      if (!hasIsActive) {
        db.exec('ALTER TABLE shop_items ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
      }
    } catch (err) {
      console.error('Не удалось обновить схему shop_items:', err);
    }

    const upsert = db.prepare(`
      INSERT OR IGNORE INTO shop_items (id, name, price, category, is_active)
      VALUES (?, ?, ?, ?, 1)
    `);
    const updateMeta = db.prepare(`
      UPDATE shop_items
      SET name = ?, category = ?, is_active = 1
      WHERE id = ?
    `);

    for (const item of defaultShopItems) {
      const info = upsert.run(item.id, item.name, item.price, item.category);
      if (!info.changes) {
        updateMeta.run(item.name, item.category, item.id);
      }
    }
  }

  function ensureUserRatingsTable() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_ratings (
        user_id TEXT NOT NULL,
        teacher_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        PRIMARY KEY (user_id, teacher_id, key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_user_ratings_teacher ON user_ratings(teacher_id, key)`);
  }

  function ensureTeacherRequestsTable() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS teacher_requests (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        created_iso TEXT NOT NULL,
        payload TEXT NOT NULL,
        photo_filename TEXT,
        submitter_ip TEXT,
        submitter_agent TEXT,
        telegram_chat_id TEXT,
        telegram_message_id TEXT,
        processed_ts INTEGER,
        processed_iso TEXT,
        processed_by TEXT,
        processed_action TEXT,
        teacher_id TEXT,
        error TEXT
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_teacher_requests_status ON teacher_requests(status)`);
  }

  const ensureAggregateRatingRowStmt = db.prepare(`
    INSERT OR IGNORE INTO ratings (teacher_id, key, sum, count)
    VALUES (?, ?, 0, 0)
  `);
  const updateAggregateRatingStmt = db.prepare(`
    UPDATE ratings
    SET sum = sum + ?, count = count + ?
    WHERE teacher_id = ? AND key = ?
  `);
  const selectUserRatingStmt = db.prepare(`
    SELECT value FROM user_ratings
    WHERE user_id = ? AND teacher_id = ? AND key = ?
  `);
  const insertUserRatingStmt = db.prepare(`
    INSERT INTO user_ratings (user_id, teacher_id, key, value, updated_ts)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateUserRatingStmt = db.prepare(`
    UPDATE user_ratings
    SET value = ?, updated_ts = ?
    WHERE user_id = ? AND teacher_id = ? AND key = ?
  `);

  function initSecurityTables() {
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

  ensureInventorySchemaUpToDate();
  ensureShopItemsTable();
  ensureUserRatingsTable();
  ensureTeacherRequestsTable();
  initSecurityTables();

  let ADMIN_EMAILS = new Set();
  function loadAdminEmails() {
    const stmt = db.prepare('SELECT email FROM admins');
    const rows = stmt.all();
    ADMIN_EMAILS = new Set(rows.map(r => r.email.toLowerCase()));
    if (rootAdminEmail) {
      ADMIN_EMAILS.add(rootAdminEmail);
    }
  }
  loadAdminEmails();

  function isAdminUser(u) {
    const email = String(u?.email || '').toLowerCase();
    return ADMIN_EMAILS.has(email);
  }

  function isSuperAdminUser(u) {
    if (!rootAdminEmail) return false;
    const email = String(u?.email || '').toLowerCase();
    return email === rootAdminEmail;
  }

  function listAdminEmails() {
    const stmt = db.prepare('SELECT email FROM admins ORDER BY email');
    const rows = stmt.all();
    const emails = new Set(rows.map(r => String(r.email || '').toLowerCase()).filter(Boolean));
    if (rootAdminEmail) emails.add(rootAdminEmail);
    return Array.from(emails).sort();
  }

  function addAdminEmail(email) {
    const cleaned = String(email || '').trim().toLowerCase();
    if (!cleaned) return false;
    const stmt = db.prepare('INSERT OR IGNORE INTO admins (email) VALUES (?)');
    stmt.run(cleaned);
    loadAdminEmails();
    return true;
  }

  function removeAdminEmail(email) {
    const cleaned = String(email || '').trim().toLowerCase();
    if (!cleaned) return false;
    const stmt = db.prepare('DELETE FROM admins WHERE email = ?');
    stmt.run(cleaned);
    loadAdminEmails();
    return true;
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

  function overall(ratingsMap) {
    let tot = 0;
    let cnt = 0;
    for (const k of characteristicsKeys) {
      const v = ratingsMap[k];
      if (v && v.count) {
        tot += v.sum / v.count;
        cnt++;
      }
    }
    return cnt ? tot / cnt : 0;
  }

  const TEACHER_CACHE_TTL_MS = 1000 * 30;
  let teacherRowsCache = { data: null, expiresAt: 0 };
  let ratingsAggregateCache = { data: null, expiresAt: 0 };

  function invalidateTeacherRowsCache() {
    teacherRowsCache = { data: null, expiresAt: 0 };
  }

  function invalidateRatingsCache() {
    ratingsAggregateCache = { data: null, expiresAt: 0 };
  }

  function invalidateTeacherCaches() {
    invalidateTeacherRowsCache();
    invalidateRatingsCache();
  }

  function getAllTeachers() {
    const now = Date.now();
    if (teacherRowsCache.data && teacherRowsCache.expiresAt > now) {
      return teacherRowsCache.data;
    }
    const stmt = db.prepare('SELECT * FROM teachers ORDER BY last_name, first_name');
    const rows = stmt.all();
    teacherRowsCache = { data: rows, expiresAt: now + TEACHER_CACHE_TTL_MS };
    return rows;
  }

  function getTeacherById(id) {
    const stmt = db.prepare('SELECT * FROM teachers WHERE id = ?');
    return stmt.get(id);
  }

  function normalizeTeacherRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      lastName: row.last_name || '',
      firstName: row.first_name || '',
      patronymic: row.patronymic || '',
      department: row.department || '',
      photo: row.photo || defaultPhoto,
      subjects: row.subjects ? row.subjects.split('|').filter(Boolean) : []
    };
  }

  function getRatingsForTeacher(teacherId) {
    const stmt = db.prepare('SELECT key, sum, count FROM ratings WHERE teacher_id = ?');
    const rows = stmt.all(teacherId);
    const result = {};
    for (const k of characteristicsKeys) {
      result[k] = { sum: 0, count: 0 };
    }
    for (const row of rows) {
      if (characteristicsKeys.includes(row.key)) {
        result[row.key] = { sum: row.sum, count: row.count };
      }
    }
    return result;
  }

  function getAllRatings() {
    const now = Date.now();
    if (ratingsAggregateCache.data && ratingsAggregateCache.expiresAt > now) {
      return ratingsAggregateCache.data;
    }
    const stmt = db.prepare('SELECT teacher_id, key, sum, count FROM ratings');
    const rows = stmt.all();
    const map = {};
    for (const row of rows) {
      if (!map[row.teacher_id]) map[row.teacher_id] = {};
      map[row.teacher_id][row.key] = { sum: row.sum, count: row.count };
    }
    ratingsAggregateCache = { data: map, expiresAt: now + TEACHER_CACHE_TTL_MS };
    return map;
  }

  function ensureUniqueTeacherId(baseId) {
    let candidate = baseId;
    let counter = 1;
    while (getTeacherById(candidate)) {
      counter += 1;
      if (counter > 25) {
        candidate = `${baseId}-${crypto.randomBytes(3).toString('hex')}`;
        break;
      }
      candidate = `${baseId}-${counter}`;
    }
    return candidate;
  }

  function getCommentById(commentId) {
    const stmt = db.prepare('SELECT * FROM comments WHERE id = ?');
    return stmt.get(commentId);
  }

  function updateRatings(teacherId, ratings, userId = null) {
    const updateRatingsTx = db.transaction((teacherIdInner, ratingsInner, userIdInner) => {
      let added = 0;
      let updated = 0;
      if (!teacherIdInner || !ratingsInner || typeof ratingsInner !== 'object') {
        return { added, updated };
      }

      const ts = Date.now();

      for (const key of Object.keys(ratingsInner)) {
        if (!characteristicsKeys.includes(key)) continue;
        const value = Number(ratingsInner[key]);
        if (!(value >= 1 && value <= 5)) continue;

        ensureAggregateRatingRowStmt.run(teacherIdInner, key);

        if (!userIdInner) {
          updateAggregateRatingStmt.run(value, 1, teacherIdInner, key);
          added++;
          continue;
        }

        const prev = selectUserRatingStmt.get(userIdInner, teacherIdInner, key);
        if (!prev) {
          insertUserRatingStmt.run(userIdInner, teacherIdInner, key, value, ts);
          updateAggregateRatingStmt.run(value, 1, teacherIdInner, key);
          added++;
        } else {
          const prevValue = Number(prev.value);
          updateUserRatingStmt.run(value, ts, userIdInner, teacherIdInner, key);
          if (prevValue !== value) {
            updateAggregateRatingStmt.run(value - prevValue, 0, teacherIdInner, key);
            updated++;
          }
        }
      }

      return { added, updated };
    });

    const result = updateRatingsTx(teacherId, ratings, userId);
    if (result && (result.added || result.updated)) {
      invalidateRatingsCache();
    }
    return result;
  }

  function getCommentsForTeacher(teacherId) {
    const stmt = db.prepare('SELECT * FROM comments WHERE teacher_id = ? ORDER BY ts DESC');
    return stmt.all(teacherId);
  }

  function getAllComments() {
    const stmt = db.prepare('SELECT * FROM comments ORDER BY ts DESC');
    return stmt.all();
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

  function getAllCommentsByUser(userId) {
    const stmt = db.prepare('SELECT * FROM comments WHERE author_uid = ? ORDER BY ts DESC');
    return stmt.all(userId);
  }

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
    const stmt = db.prepare(`SELECT comment_id, user_id, vote FROM comment_votes WHERE comment_id IN (${placeholders})`);
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
        myVotes[key] = Number(row.vote) || 0;
      }
    }

    return { counts, myVotes };
  }

  function getUserVotesForComments(commentIds, userId) {
    if (!commentIds.length || !userId) return {};

    const placeholders = commentIds.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT comment_id, vote FROM comment_votes WHERE comment_id IN (${placeholders}) AND user_id = ?`);
    const rows = stmt.all(...commentIds, String(userId));

    const map = {};
    for (const row of rows) {
      map[String(row.comment_id)] = Number(row.vote) || 0;
    }
    return map;
  }

  const activeNicknameStmt = db.prepare(`
    SELECT item_name FROM user_inventory
    WHERE user_id = ? AND item_type = 'nickname' AND is_active = 1
    LIMIT 1
  `);

  function getActiveNickname(userId) {
    if (!userId) return null;
    const row = activeNicknameStmt.get(userId);
    return row ? row.item_name : null;
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

  function upsertTeacher(teacher) {
    const { id, lastName, firstName, patronymic, department, subjects, photo } = teacher;
    const subjectsStr = Array.isArray(subjects) ? subjects.join('|') : String(subjects || '');
    const rawPhoto = typeof photo === 'string' ? photo.trim() : (photo ? String(photo).trim() : '');
    const photoStr = (() => {
      if (!rawPhoto) return defaultPhoto;
      if (rawPhoto.startsWith('/photo/')) return rawPhoto;
      if (rawPhoto.startsWith('/photos/')) return rawPhoto.replace('/photos/', '/photo/');
      if (/^https?:\/\//i.test(rawPhoto)) return rawPhoto;
      return `/photo/${rawPhoto}`;
    })();

    const stmt = db.prepare('INSERT INTO teachers (id, last_name, first_name, patronymic, department, subjects, photo) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_name = excluded.last_name, first_name = excluded.first_name, patronymic = excluded.patronymic, department = excluded.department, subjects = excluded.subjects, photo = excluded.photo');
    stmt.run(id, lastName || '', firstName || '', patronymic || '', department || '', subjectsStr, photoStr);
    invalidateTeacherCaches();
  }

  function deleteTeacherById(id) {
    const stmt = db.prepare('DELETE FROM teachers WHERE id = ?');
    const info = stmt.run(id);
    if (info.changes > 0) {
      invalidateTeacherCaches();
    }
    return info.changes > 0;
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

  function getUserFromSessionTokenHash(tokenHash) {
    const stmt = db.prepare(`
      SELECT * FROM sessions
      WHERE token_hash = ? AND is_active = 1 AND expires_ts > ?
    `);
    const session = stmt.get(tokenHash, Date.now());
    if (!session) return null;
    return session;
  }

  function updateSessionActivity(sessionId, ts) {
    db.prepare('UPDATE sessions SET last_activity_ts = ? WHERE id = ?').run(ts, sessionId);
  }

  function updateSessionClient(sessionId, ip, userAgent) {
    db.prepare('UPDATE sessions SET ip = ?, user_agent = ? WHERE id = ?').run(ip || null, userAgent || null, sessionId);
  }

  function countActiveSessions(userId) {
    const existingSessions = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE user_id = ? AND is_active = 1').get(userId);
    return existingSessions?.count || 0;
  }

  function deleteOldestSession(userId) {
    db.prepare('DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE user_id = ? AND is_active = 1 ORDER BY last_activity_ts ASC LIMIT 1)').run(userId);
  }

  function insertSession(sessionRecord) {
    const stmt = db.prepare(`
      INSERT INTO sessions (id, token_hash, user_id, created_ts, last_activity_ts, expires_ts, ip, user_agent, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    stmt.run(
      sessionRecord.id,
      sessionRecord.tokenHash,
      sessionRecord.userId,
      sessionRecord.createdTs,
      sessionRecord.lastActivityTs,
      sessionRecord.expiresTs,
      sessionRecord.ip,
      sessionRecord.userAgent
    );
  }

  function deactivateSessionByHash(tokenHash) {
    db.prepare('UPDATE sessions SET is_active = 0 WHERE token_hash = ?').run(tokenHash);
  }

  function deactivateSessionsByUser(userId, { eventType = 'all_sessions_invalidated', severity = 'warning', logEvent = true, details = {} } = {}) {
    db.prepare('UPDATE sessions SET is_active = 0 WHERE user_id = ?').run(userId);
    if (logEvent) {
      logSecurityEvent(eventType, { userId, ...details, severity });
    }
  }

  function cleanupExpiredSessions() {
    const deleted = db.prepare('DELETE FROM sessions WHERE expires_ts < ? OR is_active = 0').run(Date.now());
    return deleted.changes || 0;
  }

  function cleanupOldLogs() {
    const cutoff = Date.now() - (90 * 24 * 60 * 60 * 1000);
    db.prepare('DELETE FROM security_log WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM login_attempts WHERE ts < ?').run(cutoff);
  }

  function insertLoginEvent({ action, email, ip, ua }) {
    try {
      const stmt = db.prepare('INSERT INTO login_events (ts, ts_iso, action, email, ip, ua) VALUES (?, ?, ?, ?, ?, ?)');
      stmt.run(Date.now(), new Date().toISOString(), action, email, ip, ua);
    } catch {}
  }

  function insertTeacherRequest(payload, meta = {}) {
    const id = meta.id || (typeof crypto.randomUUID === 'function' ? `req_${crypto.randomUUID()}` : `req_${crypto.randomBytes(8).toString('hex')}`);
    const createdTs = Date.now();
    const stmt = db.prepare(`
      INSERT INTO teacher_requests (id, status, created_ts, created_iso, payload, photo_filename, submitter_ip, submitter_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      teacherRequestStatuses.PENDING,
      createdTs,
      new Date(createdTs).toISOString(),
      JSON.stringify(payload),
      meta.photoFilename || null,
      meta.ip || null,
      meta.userAgent || null
    );
    return { id, createdTs };
  }

  function getTeacherRequestById(id) {
    if (!id) return null;
    const stmt = db.prepare('SELECT * FROM teacher_requests WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;
    let parsed = {};
    try {
      parsed = row.payload ? JSON.parse(row.payload) : {};
    } catch {
      parsed = {};
    }
    return { ...row, payload: parsed };
  }

  function setTeacherRequestTelegramMeta(id, chatId, messageId) {
    const stmt = db.prepare(`
      UPDATE teacher_requests
      SET telegram_chat_id = ?, telegram_message_id = ?
      WHERE id = ?
    `);
    stmt.run(chatId || null, messageId || null, id);
  }

  function updateTeacherRequestError(id, error) {
    if (!id) return;
    const stmt = db.prepare('UPDATE teacher_requests SET error = ? WHERE id = ?');
    stmt.run(error || null, id);
  }

  function finalizeTeacherRequest({ id, status, processedBy, action, teacherId = null, error = null }) {
    if (!id || !status) return null;
    const safeStatus = Object.values(teacherRequestStatuses).includes(status) ? status : teacherRequestStatuses.PENDING;
    const ts = Date.now();
    const stmt = db.prepare(`
      UPDATE teacher_requests
      SET status = ?, processed_ts = ?, processed_iso = ?, processed_by = ?, processed_action = ?, teacher_id = ?, error = ?
      WHERE id = ?
    `);
    stmt.run(
      safeStatus,
      ts,
      new Date(ts).toISOString(),
      processedBy || null,
      action || null,
      teacherId || null,
      error || null,
      id
    );
    return getTeacherRequestById(id);
  }

  function getSecurityLogs({ limit, offset, severity }) {
    let query = 'SELECT * FROM security_log';
    const params = [];

    if (severity) {
      query += ' WHERE severity = ?';
      params.push(severity);
    }

    query += ' ORDER BY ts DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const logs = db.prepare(query).all(...params);
    const total = db.prepare('SELECT COUNT(*) as count FROM security_log').get();

    return { logs, total: total.count };
  }

  function getActiveSessionsList() {
    const sessions = db.prepare(`
      SELECT s.id, s.user_id, s.created_ts, s.last_activity_ts, s.expires_ts, s.ip, s.user_agent, s.is_active,
             u.email, u.username
      FROM sessions s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.is_active = 1 AND s.expires_ts > ?
      ORDER BY s.last_activity_ts DESC
    `).all(Date.now());
    return sessions;
  }

  function getLoginAttempts({ cutoff, limit = 100 }) {
    const attempts = db.prepare(`
      SELECT email, ip, COUNT(*) as total, SUM(success) as successful, MAX(ts) as last_attempt
      FROM login_attempts
      WHERE ts > ?
      GROUP BY email, ip
      ORDER BY total DESC
      LIMIT ?
    `).all(cutoff, limit);

    return attempts;
  }

  function getUserSessions(userId) {
    const sessions = db.prepare(`
      SELECT id, token_hash, created_ts, last_activity_ts, expires_ts, ip, user_agent
      FROM sessions
      WHERE user_id = ? AND is_active = 1 AND expires_ts > ?
      ORDER BY last_activity_ts DESC
    `).all(userId, Date.now());
    return sessions;
  }

  function revokeOtherSessions(userId, currentTokenHash) {
    db.prepare(`
      UPDATE sessions
      SET is_active = 0
      WHERE user_id = ? AND token_hash != ? AND is_active = 1
    `).run(userId, currentTokenHash);
  }

  function getUserList() {
    const stmt = db.prepare('SELECT * FROM users ORDER BY email');
    return stmt.all();
  }

  function getAdminComments(limit) {
    const stmt = db.prepare('SELECT * FROM comments ORDER BY ts DESC LIMIT ?');
    return stmt.all(limit);
  }

  function getShopItems() {
    return db.prepare(`
      SELECT id, name, price, category
      FROM shop_items
      WHERE is_active = 1
      ORDER BY price ASC, name ASC
    `).all();
  }

  function getUserPurchasedItems(userId) {
    return db.prepare('SELECT item_id FROM user_inventory WHERE user_id = ?').all(userId);
  }

  function getActiveInventoryForUser(userId) {
    return db.prepare('SELECT item_id, item_type FROM user_inventory WHERE user_id = ? AND is_active = 1').all(userId);
  }

  function getShopItemById(itemId) {
    return db.prepare('SELECT id, name, price, category FROM shop_items WHERE id = ? AND is_active = 1').get(itemId);
  }

  function getExistingInventoryItem(userId, itemId, category) {
    return db.prepare('SELECT id FROM user_inventory WHERE user_id = ? AND item_id = ? AND item_type = ?').get(userId, itemId, category);
  }

  function insertInventoryItem({ userId, itemId, category, name, price }) {
    const insertStmt = db.prepare(`
      INSERT INTO user_inventory (user_id, item_id, item_type, item_name, purchase_date, price, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const info = insertStmt.run(userId, itemId, category, name, Date.now(), price, 0);
    const insertedId = Number(info?.lastInsertRowid || 0);
    if (!Number.isFinite(insertedId) || insertedId <= 0) return null;

    return db.prepare(`
      SELECT id, user_id, item_id, item_type, item_name, purchase_date, price, is_active
      FROM user_inventory
      WHERE id = ?
    `).get(insertedId);
  }

  function getShopItemMeta(itemId) {
    return db.prepare('SELECT id, category, name FROM shop_items WHERE id = ? AND is_active = 1').get(itemId);
  }

  function getInventoryItem(userId, itemId, category) {
    return db.prepare('SELECT id, item_name FROM user_inventory WHERE user_id = ? AND item_id = ? AND item_type = ?').get(userId, itemId, category);
  }

  function deactivateUserInventory(userId, category) {
    const deactivateStmt = db.prepare('UPDATE user_inventory SET is_active = 0 WHERE user_id = ? AND item_type = ?');
    deactivateStmt.run(userId, category);
  }

  function activateInventoryItemById(id) {
    const activateStmt = db.prepare('UPDATE user_inventory SET is_active = 1 WHERE id = ?');
    activateStmt.run(id);
  }

  function getActiveInventoryItem(userId, itemId) {
    return db.prepare(`
      SELECT id, item_name, item_type
      FROM user_inventory
      WHERE user_id = ? AND item_id = ? AND is_active = 1
    `).get(userId, itemId);
  }

  function deactivateUserInventoryByType(userId, itemType) {
    db.prepare('UPDATE user_inventory SET is_active = 0 WHERE user_id = ? AND item_type = ?')
      .run(userId, itemType);
  }

  function getInventoryForUser(userId) {
    const stmt = db.prepare(`
      SELECT item_id, item_name, item_type, purchase_date, is_active
      FROM user_inventory
      WHERE user_id = ?
      ORDER BY purchase_date DESC
    `);

    return stmt.all(userId);
  }

  function getStartupStats() {
    const teachersCount = db.prepare('SELECT COUNT(*) as count FROM teachers').get().count;
    const usersCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const commentsCount = db.prepare('SELECT COUNT(*) as count FROM comments').get().count;
    const inventoryCount = db.prepare('SELECT COUNT(*) as count FROM user_inventory').get().count;
    return { teachersCount, usersCount, commentsCount, inventoryCount, adminCount: ADMIN_EMAILS.size };
  }

  return {
    db,
    ensureInventorySchemaUpToDate,
    ensureShopItemsTable,
    ensureUserRatingsTable,
    ensureTeacherRequestsTable,
    initSecurityTables,
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
    getUserVotesForComments,
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
    cleanupExpiredSessions,
    cleanupOldLogs,
    insertLoginEvent,
    insertTeacherRequest,
    getTeacherRequestById,
    setTeacherRequestTelegramMeta,
    updateTeacherRequestError,
    finalizeTeacherRequest,
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
    sessionConfig: { sessionTtlMs, maxSessionsPerUser }
  };
}

module.exports = {
  loadBetterSqlite3,
  ensureDirsAndDb,
  createDbProcessing
};
