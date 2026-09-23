// Минимальный ESLint: ловим реальные баги (необъявленные переменные, дубликаты
// ключей, недостижимый код), без стилевого шума на существующей кодовой базе.
const globals = {
  // Node.js
  require: 'readonly', module: 'writable', process: 'readonly', __dirname: 'readonly',
  Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', queueMicrotask: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly', FormData: 'readonly',
  AbortController: 'readonly', Blob: 'readonly', crypto: 'readonly',
};

const browserGlobals = {
  window: 'readonly', document: 'readonly', location: 'writable', navigator: 'readonly',
  localStorage: 'readonly', fetch: 'readonly', alert: 'readonly', confirm: 'readonly',
  prompt: 'readonly', history: 'readonly',
  addEventListener: 'readonly', removeEventListener: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', queueMicrotask: 'readonly', console: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', AbortController: 'readonly',
  MouseEvent: 'readonly', WeakMap: 'readonly', getComputedStyle: 'readonly',
  IntersectionObserver: 'readonly', requestAnimationFrame: 'readonly', Intl: 'readonly',
  FormData: 'readonly', Event: 'readonly', CustomEvent: 'readonly',
  sessionStorage: 'readonly', performance: 'readonly', cancelAnimationFrame: 'readonly',
  Profanity: 'readonly',
};

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-fallthrough': 'error',
    },
  },
  {
    // Общий модуль (сервер + браузер): UMD-обёртка.
    files: ['public/profanity.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { self: 'readonly', module: 'writable' } },
  },
  {
    // Браузерный SPA — отдельный набор глобалей.
    files: ['public/app.js'],
    ignores: [],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: browserGlobals },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
    },
  },
];
