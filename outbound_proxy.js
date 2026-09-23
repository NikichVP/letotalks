const { ProxyAgent, Agent } = require('undici');

// Исходящий прокси для запросов к OpenAI, Telegram и Resend (нужен, если они
// недоступны с сервера напрямую). Поддерживаются только http(s)-прокси.
function resolveProxyUrl() {
  const candidates = [
    process.env.OUTBOUND_PROXY_URL,
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY,
    process.env.ALL_PROXY
  ];
  for (const raw of candidates) {
    const value = String(raw || '').trim();
    if (!value) continue;
    // socks5://… и адреса без схемы ProxyAgent не умеет — раньше сервер из-за
    // этого просто не запускался. Пропускаем с предупреждением.
    if (!/^https?:\/\//i.test(value)) {
      console.warn(`[proxy] пропускаю неподдерживаемый прокси «${value.replace(/\/\/[^@/]*@/, '//***@')}» — нужен http:// или https://`);
      continue;
    }
    return value;
  }
  return '';
}

function createDispatcher({ allowH2 = false } = {}) {
  const proxyUrl = resolveProxyUrl();
  if (proxyUrl) {
    try {
      return new ProxyAgent(proxyUrl);
    } catch (err) {
      console.warn('[proxy] не удалось настроить прокси, иду напрямую:', err && err.message ? err.message : err);
    }
  }
  return new Agent({ allowH2 });
}

module.exports = {
  resolveProxyUrl,
  createDispatcher,
};
