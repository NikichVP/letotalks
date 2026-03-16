const { ProxyAgent, Agent } = require('undici');

function resolveProxyUrl() {
  return (
    process.env.OUTBOUND_PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    ''
  ).trim();
}

function createDispatcher({ allowH2 = false } = {}) {
  const proxyUrl = resolveProxyUrl();
  if (proxyUrl) {
    return new ProxyAgent(proxyUrl);
  }
  return new Agent({ allowH2 });
}

module.exports = {
  resolveProxyUrl,
  createDispatcher,
};
