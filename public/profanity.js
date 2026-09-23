// Проверка текста на мат — ОДИН источник правды для сервера (comment_moderation.js)
// и браузера (app.js предупреждает до отправки). За найденный мат сервер отклоняет
// отзыв и засчитывает нарушение, поэтому проверка должна быть точной: лучше
// пропустить хитро замаскированное слово (его поймает LLM-модерация), чем
// заблокировать ученика за «колебания», «небанальные задачи» или «кабинет 364».
//
// Как устроено: текст режется на слова, каждое слово проверяется отдельно
// (никаких склеек соседних слов — «зал, упражнения» не превращается в «залуп»).
// Внутри слова латинские двойники и цифры заменяются на буквы («xуй», «пи3дец»),
// повторы схлопываются («бляяя»). Подряд идущие одиночные буквы («х у й»)
// склеиваются в одно слово.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Profanity = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const LAT2CYR = { a:'а', b:'в', c:'с', e:'е', h:'н', k:'к', m:'м', o:'о', p:'р', t:'т', x:'х', y:'у' };
  const LEET = { '0':'о', '1':'и', '3':'з', '4':'ч', '6':'б', '8':'в', '9':'я' };

  // Корни, которые не встречаются внутри обычных слов, — ищем в любом месте слова.
  const ANYWHERE = [
    /пизд/,
    /бляд/,
    /(?<!стра)ху[йеиюя]/,          // но не «страхую», «подстрахуешь»
    /долбо[её]б/,
  ];

  // Корни, опасные только в начале слова: внутри обычных слов они встречаются
  // («колебание», «небанальный», «учебник», «сукно», «мудрый», «вебинар»).
  const WORD_START = [
    /^(?:за|на|вы|у|по|про|до|недо|от|отъ|пере|при|подъ|объ|разъ|изъ|въ|съ)?[её]б/,
    /^мраз/,
    /^г[ао]ндон/,
    /^пид[оа]р/,
    /^пидр/,
    /^залуп/,
    /^муд(?:ак|ач|ил|озвон)/,
    /^бля(?:$|д|т)/,
    /^блад[ьи]/,                     // «бл@дь»
    /^сук(?:а|и|у|ой|е|ам|ами|ах|ин|ина|ины)$/, // «сука», но не «Сукачёва» или «сукно»
    /^суч(?:к|ар)/,
    /^чмо(?:$|ш)/,
    /^гнид/,
  ];

  function normalizeWord(token) {
    // Чистые числа не проверяем («3 балла», «кабинет 364»).
    const letters = (token.match(/[a-zа-я]/g) || []).length;
    if (!letters) return '';
    let w = token.replace(/[a-z]/g, ch => LAT2CYR[ch] || ch);
    // Цифры как буквы («пи3дец», «6ля») — только внутри настоящих слов, а не
    // в «5Б» или шахматном «e6».
    if (letters >= 2) w = w.replace(/[0-9]/g, ch => LEET[ch] || ch);
    return w.replace(/(.)\1+/g, '$1'); // «хууууй» -> «хуй»
  }

  function words(text) {
    const raw = String(text || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/@/g, 'а')
      .replace(/\$/g, 'с')
      .split(/[^a-zа-я0-9]+/)
      .filter(Boolean);
    const out = [];
    let singles = [];
    const flush = () => {
      if (singles.length >= 2) out.push(singles.join('').replace(/(.)\1+/g, '$1'));
      singles = [];
    };
    for (const token of raw) {
      const w = normalizeWord(token);
      if (!w) { flush(); continue; }
      if (w.length === 1) { singles.push(w); continue; }
      flush();
      out.push(w);
    }
    flush();
    return out;
  }

  function isBadWord(w) {
    return ANYWHERE.some(re => re.test(w)) || WORD_START.some(re => re.test(w));
  }

  function hasBadWords(text) {
    return words(text).some(isBadWord);
  }

  return { hasBadWords, words, isBadWord };
});
