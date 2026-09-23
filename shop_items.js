// Ассортимент магазина ников — общий для server.js и migrate.js.
//
// При старте сервера товары синхронизируются с БД: новые добавляются с ценой
// отсюда, у существующих обновляются название, редкость и описание. ЦЕНА
// существующего товара берётся из БД (её могли поменять вручную) — чтобы
// изменить цену уже заведённого товара, правьте shop_items в базе.
//
// id существующих товаров не менять: на них ссылаются покупки пользователей.

const SHOP_RARITIES = ['common', 'rare', 'epic', 'legendary'];

const DEFAULT_SHOP_ITEMS = [
  // Обычные — доступны почти сразу (пара отзывов/оценок).
  { id: 'nick-0', name: '🐣 Новичок', price: 1, rarity: 'common', description: 'Первый шаг: ник вместо «Аноним».' },
  { id: 'nick-owl', name: '🦉 Сова', price: 10, rarity: 'common', description: 'Домашку делает после полуночи.' },
  { id: 'nick-lark', name: '🌅 Жаворонок', price: 10, rarity: 'common', description: 'Приходит к первому уроку раньше учителя.' },
  { id: 'nick-coffee', name: '☕ Кофеман', price: 15, rarity: 'common', description: 'Без стаканчика кофе на урок не заходит.' },
  { id: 'nick-notes', name: '📝 Конспектер', price: 20, rarity: 'common', description: 'Его конспекты просит весь класс.' },

  // Редкие.
  { id: 'nick-1', name: '🤓 Умник', price: 50, rarity: 'rare', description: 'Знает ответ раньше, чем дослушает вопрос.' },
  { id: 'nick-physmath', name: '📐 Физмат', price: 60, rarity: 'rare', description: 'Решает задачу, пока другие читают условие.' },
  { id: 'nick-humanities', name: '🎭 Гуманитарий', price: 60, rarity: 'rare', description: 'Сочинение на пять страниц? Легко.' },
  { id: 'nick-chem', name: '🧪 Химик', price: 65, rarity: 'rare', description: 'Смешивает реактивы и шутки.' },
  { id: 'nick-2', name: '⭐ Отличник', price: 75, rarity: 'rare', description: 'Дневник без единой четвёрки.' },
  { id: 'nick-polyglot', name: '🗣️ Полиглот', price: 85, rarity: 'rare', description: 'Здоровается на пяти языках.' },

  // Эпические.
  { id: 'nick-3', name: '📚 Эрудит', price: 100, rarity: 'epic', description: 'Выигрывает любой квиз.' },
  { id: 'nick-critic', name: '🕵️ Критик', price: 110, rarity: 'epic', description: 'Пишет честные и подробные отзывы.' },
  { id: 'nick-olymp', name: '🏅 Олимпиадник', price: 130, rarity: 'epic', description: 'Дипломы хранит в отдельной папке.' },
  { id: 'nick-4', name: '💼 Профи', price: 150, rarity: 'epic', description: 'Всё делает по-взрослому.' },
  { id: 'nick-8', name: 'kinnijin', price: 180, rarity: 'epic', description: 'Кто знает — тот знает.' },

  // Легендарные.
  { id: 'nick-5', name: '🧘 Гуру', price: 200, rarity: 'legendary', description: 'К нему идут за советом по любому предмету.' },
  { id: 'nick-7', name: '🎓 Мастер', price: 250, rarity: 'legendary', description: 'Сдаёт проекты раньше дедлайна.' },
  { id: 'nick-6', name: '🏆 Легенда', price: 300, rarity: 'legendary', description: 'О нём рассказывают младшим классам.' },
  { id: 'nick-king', name: '👑 Король отзывов', price: 350, rarity: 'legendary', description: 'Самые залайканные отзывы школы.' },
  { id: 'nick-unicorn', name: '🦄 Единорог', price: 500, rarity: 'legendary', description: 'Говорят, он существует.' },
].map(item => ({ category: 'nickname', ...item }));

module.exports = { DEFAULT_SHOP_ITEMS, SHOP_RARITIES };
