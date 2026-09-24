// Demo data for trying LetoTalks locally: fictional teachers, students, ratings
// and reviews. Writes to a separate database and never touches the real one.
//
//   npm run demo                       # seed + start the app (see scripts/demo.js)
//   node scripts/seed-demo.js [db]     # only (re)create the demo database
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createDbProcessing } = require('../db_processing');
const { DEFAULT_SHOP_ITEMS } = require('../shop_items');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DB_PATH = path.join(ROOT, '.demo', 'demo.db');
const PHOTO_DIR = path.join(ROOT, 'photos');
const KEYS = ['clarity', 'humor', 'strict', 'favorites'];

const TEACHERS = [
  // [last name, first name, patronymic, department, subjects, rating profile per KEYS]
  ['Белкин', 'Андрей', 'Викторович', 'Кафедра математики', ['Алгебра', 'Геометрия'], [5, 4, 4, 2]],
  ['Гришина', 'Елена', 'Павловна', 'Кафедра словесности', ['Литература'], [4, 5, 2, 1]],
  ['Данилов', 'Максим', 'Олегович', 'Кафедра естественных наук', ['Физика'], [5, 3, 5, 2]],
  ['Жукова', 'Ирина', 'Сергеевна', 'Кафедра иностранных языков', ['Английский язык'], [4, 4, 3, 1]],
  ['Зайцев', 'Кирилл', 'Андреевич', 'Кафедра информационных технологий и дизайна', ['Информатика'], [5, 5, 2, 1]],
  ['Климова', 'Светлана', 'Игоревна', 'Кафедра естественных наук', ['Химия', 'Биология'], [4, 3, 4, 3]],
  ['Ларин', 'Георгий', 'Николаевич', 'Кафедра искусств', ['Музыка'], [3, 5, 1, 2]],
  ['Миронова', 'Дарья', 'Алексеевна', 'Кафедра математики', ['Математический анализ'], [5, 2, 5, 2]],
  ['Некрасов', 'Илья', 'Романович', 'Кафедра социальных и гуманитарных наук', ['История'], [4, 5, 3, 1]],
  ['Осипова', 'Вера', 'Михайловна', 'Кафедра иностранных языков', ['Французский язык'], [4, 3, 3, 2]],
  ['Панин', 'Роман', 'Евгеньевич', 'Кафедра информационных технологий и дизайна', ['Дизайн'], [5, 4, 2, 1]],
  ['Родионова', 'Алина', 'Дмитриевна', 'Кафедра социальных и гуманитарных наук', ['Обществознание', 'Экономика'], [4, 4, 4, 2]],
];

// [teacher index, author index, text, hours ago, students who liked it, students who disliked it]
const REVIEWS = [
  [0, 0, 'Объясняет так, что даже сложные задачи становятся понятными. Всегда разбирает ошибки после контрольных.', 30, [6, 7, 8, 9, 10], []],
  [0, 3, 'Строгий, но справедливый. Домашки много, зато к олимпиаде подготовил отлично.', 22, [5, 6], []],
  [0, 5, 'Уроки проходят бодро, есть время спросить непонятное.', 5, [], []],
  [0, 2, 'Лучший учитель по алгебре, которого я встречал. Понятно, структурно и с юмором.', 50, [5, 6, 7, 11], []],
  [0, 1, 'Иногда торопится с новой темой, но на консультациях всегда помогает.', 80, [], [13]],
  [1, 2, 'Уроки литературы похожи на дискуссионный клуб: спорим о героях и учимся аргументировать.', 64, [0, 4, 9], []],
  [1, 0, 'Сочинения проверяет подробно, с комментариями на полях. Очень помогает.', 120, [2, 3], []],
  [2, 4, 'Эксперименты на каждом уроке — физика наконец-то стала интересной.', 12, [8, 9], []],
  [2, 1, 'Задачи на контрольных сложнее, чем на уроках, — готовьтесь заранее.', 150, [0, 2, 12], []],
  [3, 2, 'Много разговорной практики, к концу года стало легко говорить.', 96, [1, 5], []],
  [4, 2, 'Даёт реальные проекты вместо скучных упражнений. Рекомендую спецкурс по алгоритмам.', 40, [1, 3, 12], []],
  [4, 0, 'Проверяет домашки как настоящее код-ревью: с замечаниями и советами.', 200, [2, 4, 6, 8], []],
  [5, 3, 'Лабораторные всегда хорошо подготовлены, и всё объясняет про технику безопасности.', 75, [1], []],
  [7, 2, 'Сложный предмет, но объясняет через примеры, и всё встаёт на свои места.', 33, [0, 3, 6], []],
  [8, 1, 'Рассказывает историю как сериал — невозможно оторваться.', 18, [2, 5, 7, 10], []],
  [11, 4, 'Разбираем реальные новости и кейсы, экономика перестала быть абстрактной.', 58, [0, 9], []],
];

// Nicknames the first students "bought" in the shop (given only if affordable).
const NICKNAMES = ['nick-owl', 'nick-1', 'nick-humanities', 'nick-coffee', 'nick-physmath'];

// Initials avatars instead of real photos.
const PALETTE = [['#dbeafe', '#1e40af'], ['#fce7f3', '#9d174d'], ['#dcfce7', '#166534'], ['#fef3c7', '#92400e'],
  ['#ede9fe', '#5b21b6'], ['#e0f2fe', '#075985'], ['#ffe4e6', '#9f1239'], ['#f1f5f9', '#334155']];
function writeAvatar(n, initials) {
  const [bg, fg] = PALETTE[n % PALETTE.length];
  const file = `demo-${n}.svg`;
  fs.writeFileSync(path.join(PHOTO_DIR, file), `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">
  <rect width="300" height="400" fill="${bg}"/>
  <circle cx="150" cy="150" r="70" fill="${fg}" opacity=".18"/>
  <rect x="55" y="245" width="190" height="200" rx="95" fill="${fg}" opacity=".18"/>
  <text x="150" y="172" font-family="Arial, sans-serif" font-size="64" font-weight="700" fill="${fg}" text-anchor="middle">${initials}</text>
</svg>
`);
  return file;
}

function seedDemo({ dbPath = DEFAULT_DB_PATH } = {}) {
  dbPath = path.resolve(dbPath);
  if (path.basename(dbPath) === 'letotalks.db') {
    throw new Error('Refusing to seed demo data into letotalks.db — use a separate file.');
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });

  const ctx = createDbProcessing({
    dbPath,
    defaultPhoto: '/photo/default_photo.png',
    defaultShopItems: DEFAULT_SHOP_ITEMS,
    characteristicsKeys: KEYS,
    teacherRequestStatuses: { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' },
    rootAdminEmail: '',
    sessionConfig: {}
  });
  const { db } = ctx;

  const teacherIds = TEACHERS.map(([lastName, firstName, patronymic, department, subjects], i) => {
    const id = `t-demo-${i + 1}`;
    const photo = writeAvatar(i + 1, lastName[0] + firstName[0]);
    ctx.upsertTeacher({ id, lastName, firstName, patronymic, department, subjects, photo });
    return id;
  });

  const now = Date.now();
  const insertUser = db.prepare('INSERT INTO users (id, email, username, created_ts, last_login_ts, login_count) VALUES (?, ?, ?, ?, ?, 1)');
  const students = Array.from({ length: 14 }, (_, i) => {
    const id = 'u-' + crypto.randomBytes(8).toString('hex');
    insertUser.run(id, `student${i + 1}@student.letovo.ru`, `student${i + 1}`, now, now);
    return id;
  });

  // Every teacher gets a slightly different number of raters and spread of stars.
  TEACHERS.forEach(([, , , , , profile], ti) => {
    const raters = 5 + (ti * 3) % 9;
    for (let r = 0; r < raters; r++) {
      const ratings = {};
      KEYS.forEach((key, ki) => { ratings[key] = Math.max(1, profile[ki] - ((r + ki) % 3 === 0 ? 1 : 0)); });
      ctx.updateRatings(teacherIds[ti], ratings, students[r]);
    }
  });

  const insertComment = db.prepare('INSERT INTO comments (teacher_id, ts, ts_iso, author, text, author_uid) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [ti, author, text, hoursAgo, likes, dislikes] of REVIEWS) {
    const ts = now - hoursAgo * 3600e3;
    const commentId = Number(insertComment.run(teacherIds[ti], ts, new Date(ts).toISOString(), 'Аноним', text, students[author]).lastInsertRowid);
    for (const s of likes) ctx.setUserVote(commentId, students[s], 1);
    for (const s of dislikes) ctx.setUserVote(commentId, students[s], -1);
  }
  ctx.reconcileUserCounters();

  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
  NICKNAMES.forEach((itemId, i) => {
    const item = DEFAULT_SHOP_ITEMS.find(it => it.id === itemId);
    if (ctx.calculateEarnedCoins(getUser.get(students[i])) < item.price) return;
    const row = ctx.insertInventoryItem({ userId: students[i], itemId, category: 'nickname', name: item.name, price: item.price });
    ctx.activateInventoryItemById(row.id);
  });

  db.close();
  return { dbPath, teachers: teacherIds.length, students: students.length, reviews: REVIEWS.length };
}

module.exports = { seedDemo, DEFAULT_DB_PATH };

if (require.main === module) {
  const result = seedDemo({ dbPath: process.argv[2] || DEFAULT_DB_PATH });
  const rel = path.relative(process.cwd(), result.dbPath);
  console.log(`Demo database created: ${rel} (${result.teachers} teachers, ${result.students} students, ${result.reviews} reviews).`);
}
