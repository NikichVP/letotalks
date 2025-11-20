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

function extractToxicityScore(payload) {
  if (payload && Array.isArray(payload.probs) && payload.probs.length >= 2) {
    return Number(payload.probs[1]) || 0;
  }
  if (payload && Array.isArray(payload.logits) && payload.logits.length >= 2) {
    try {
      const l0 = Number(payload.logits[0]) || 0;
      const l1 = Number(payload.logits[1]) || 0;
      const max = Math.max(l0, l1);
      const e0 = Math.exp(l0 - max);
      const e1 = Math.exp(l1 - max);
      return e1 / (e0 + e1);
    } catch {
      return 0;
    }
  }
  if (Array.isArray(payload) && payload.length > 0 && payload[0].label) {
    let score = 0;
    for (const it of payload) {
      const lab = String(it.label || '').toLowerCase();
      const sc = Number(it.score || 0);
      if (lab.includes('tox') || lab === 'label_1' || lab === 'label1') score = Math.max(score, sc);
    }
    if (!score && payload.length === 1) {
      const lab = String(payload[0].label || '').toLowerCase();
      if (lab.includes('tox')) score = Number(payload[0].score || 0);
    }
    return score;
  }
  if (payload && (payload.toxic === true || payload.is_toxic === true || String(payload.label || '').toLowerCase().includes('tox'))) {
    return 1;
  }
  return 0;
}

async function fetchToxicityScore(text, toxicityUrl) {
  if (!toxicityUrl || typeof fetch !== 'function') return 0;
  try {
    const r = await fetch(toxicityUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!r.ok) return 0;
    const payload = await r.json();
    return extractToxicityScore(payload);
  } catch {
    return 0;
  }
}

async function moderateComment(text, {
  toxicityUrl,
  toxicityChecker,
  reviewThreshold = 0.6,
  blockThreshold = 0.8
} = {}) {
  const cleaned = String(text || '').trim();
  if (!cleaned) {
    return { decision: COMMENT_DECISIONS.ALLOW, reason: 'empty' };
  }

  if (hasBadWords(cleaned)) {
    return { decision: COMMENT_DECISIONS.DELETE, reason: 'profanity', score: 1 };
  }

  let score = 0;
  if (typeof toxicityChecker === 'function') {
    try {
      const res = await toxicityChecker(cleaned);
      if (typeof res === 'number') score = res;
      else if (res === true) score = 1;
    } catch {
      score = 0;
    }
  } else if (toxicityUrl) {
    score = await fetchToxicityScore(cleaned, toxicityUrl);
  }

  if (score >= blockThreshold) {
    return { decision: COMMENT_DECISIONS.DELETE, reason: 'toxicity', score };
  }
  if (score >= reviewThreshold) {
    return { decision: COMMENT_DECISIONS.REVIEW, reason: 'needs_review', score };
  }

  return { decision: COMMENT_DECISIONS.ALLOW, reason: 'clean', score };
}

module.exports = {
  COMMENT_DECISIONS,
  moderateComment,
  hasBadWords,
  normalizeForBadWords
};
