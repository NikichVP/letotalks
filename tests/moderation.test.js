const test = require('node:test');
const assert = require('node:assert/strict');
const { hasBadWords } = require('../comment_moderation');

// Невинные слова и фразы — НЕ должны срабатывать (раньше давали ложный авто-бан).
const CLEAN = [
  'требовать', 'хлеб', 'себе', 'сукно', 'искусство', 'небо', 'потребность',
  'благодарю', 'блаженство', 'требования к учителю', 'хлебобулочные изделия',
  'Очень требовательный преподаватель, но справедливый',
  'Любит давать сложные задачи, требует дисциплины',
  'серебро', 'погреб', 'требуха', 'улыбается'
];

// Настоящий мат — должен ловиться (в т.ч. с обфускацией).
const PROFANE = [
  'ты хуй', 'блядь', 'сука', 'сукин сын', 'еблан', 'пиздец', 'нахуй',
  'мразь', 'гандон', 'долбоёб', 'х у й', 'хуйня', 'сукааа', 'бляяя',
  'что за пидор', 'залупа'
];

test('profanity filter: clean words are not flagged', () => {
  for (const phrase of CLEAN) {
    assert.equal(hasBadWords(phrase), false, `ложное срабатывание на: "${phrase}"`);
  }
});

test('profanity filter: real profanity is flagged', () => {
  for (const phrase of PROFANE) {
    assert.equal(hasBadWords(phrase), true, `пропущен мат: "${phrase}"`);
  }
});
