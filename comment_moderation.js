const BAD_STEMS = [
  'бля','бляд','хуй','хуе','пизд','еб','ёб','сука','сук','мраз','гандон',
  'пидор','пидр','чмо','урод','нахуй','нехуй','охуе','долбоёб','долбаёб','долбаеб','долбоеб'
];

const LAT2CYR = { 'a':'а','b':'в','c':'с','e':'е','h':'н','k':'к','m':'м','o':'о','p':'р','t':'т','x':'х','y':'у' };
const LEET = { '0':'о','1':'i','3':'е','4':'а','5':'с','6':'б','7':'т','8':'в','9':'д' };

const COMMENT_DECISIONS = {
  ALLOW: 1,
  DELETE: 0,
  REVIEW: 2
};

const DEFAULT_GPT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_GPT_MODEL = 'gpt-5.1-nano';

function normalizeForBadWords(text) {
  let t = String(text || '').toLowerCase();
  t = t.replace(/[0-9]/g, ch => LEET[ch] || ch);
  t = t.replace(/[a-z]/g, ch => LAT2CYR[ch] || ch);
  t = t.replace(/[\s\.\,\-\_\*\+\=\!\?\(\)\[\]\{\}\/\\\|\'\"\:;@#\$%^&`~]+/g, '');
  t = t.replace(/(.)\1{2,}/g, '$1$1');
  return t;
}

function hasBadWords(text) {
  const norm = normalizeForBadWords(text);
  return BAD_STEMS.some(st => norm.includes(st));
}

function buildModerationMessages(text) {
  const compact = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  return [
    {
      role: 'system',
      content: [
        'Ты — строгий модератор комментариев.',
        'Нужно выявлять оскорбления, маты и очень грубую лексику на любом языке.',
        'Верни ровно одну цифру:',
        '0 — если есть маты/грубость/враждебность и комментарий нужно удалить.',
        '1 — если текст безопасен и можно опубликовать.',
        '2 — если сомневаешься; используй 2 только при реальной неопределенности.',
        'Никаких пояснений, только цифра.'
      ].join(' ')
    },
    {
      role: 'user',
      content: `Оцени модерацию комментария и верни только 0/1/2.\nКомментарий: """${compact}"""`
    }
  ];
}

async function requestGptDecision(text, {
  apiKey,
  apiUrl = DEFAULT_GPT_ENDPOINT,
  model = DEFAULT_GPT_MODEL,
  timeoutMs = 12000
} = {}) {
  if (!apiKey || !apiUrl || typeof fetch !== 'function') {
    return { decision: COMMENT_DECISIONS.REVIEW, reason: 'llm_not_configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: buildModerationMessages(text),
        temperature: 0,
        max_tokens: 4
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      return { decision: COMMENT_DECISIONS.REVIEW, reason: 'llm_http_error', status: res.status };
    }

    const payload = await res.json();
    const raw = (payload?.choices?.[0]?.message?.content || '').trim();
    const parsed = Number(raw);
    const normalizedDecision = [0, 1, 2].includes(parsed)
      ? parsed
      : (() => {
          const match = raw.match(/[0-2]/);
          return match ? Number(match[0]) : COMMENT_DECISIONS.REVIEW;
        })();

    return {
      decision: normalizedDecision,
      reason: normalizedDecision === COMMENT_DECISIONS.REVIEW ? 'llm_unsure' : 'llm_answer',
      raw
    };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'llm_timeout' : 'llm_error';
    return { decision: COMMENT_DECISIONS.REVIEW, reason };
  } finally {
    clearTimeout(timer);
  }
}

async function moderateComment(text, {
  gptApiKey,
  gptApiUrl = DEFAULT_GPT_ENDPOINT,
  gptModel = DEFAULT_GPT_MODEL,
  onLocalBan
} = {}) {
  const cleaned = String(text || '').trim();
  if (!cleaned) {
    return { decision: COMMENT_DECISIONS.ALLOW, reason: 'empty' };
  }

  if (hasBadWords(cleaned)) {
    if (typeof onLocalBan === 'function') {
      try { await onLocalBan(cleaned); } catch {}
    }
    return { decision: COMMENT_DECISIONS.DELETE, reason: 'profanity', score: 1 };
  }

  const llmResult = await requestGptDecision(cleaned, {
    apiKey: gptApiKey,
    apiUrl: gptApiUrl,
    model: gptModel
  });

  if (llmResult.decision === COMMENT_DECISIONS.DELETE) {
    return { decision: COMMENT_DECISIONS.DELETE, reason: 'llm_block', score: 1, raw: llmResult.raw || null };
  }

  if (llmResult.decision === COMMENT_DECISIONS.ALLOW) {
    return { decision: COMMENT_DECISIONS.ALLOW, reason: 'llm_allow', score: 0, raw: llmResult.raw || null };
  }

  return { decision: COMMENT_DECISIONS.REVIEW, reason: llmResult.reason || 'llm_unsure', score: 0.5, raw: llmResult.raw || null };
}

module.exports = {
  COMMENT_DECISIONS,
  moderateComment,
  hasBadWords,
  normalizeForBadWords
};
