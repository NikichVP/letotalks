// app.js — SPA «leto talks»: вход по коду на почту, каталог и профили учителей,
// оценки и отзывы с модерацией, лайки, магазин ников и админ-панель.
const APP_VERSION = '2026-09-24';
const EMAIL_DOMAIN = '@student.letovo.ru';
const AUTH_REFRESH_INTERVAL_MS = 60 * 1000; // раз в минуту сверяем сессию с сервером
const SEARCH_QUERY_MAX_LEN = 50;
const COMMENT_MAX_LEN = 2000;               // синхронно с MAX_COMMENT_LENGTH на сервере
const AUTH_CODE_RESEND_SEC = 60;            // синхронно с AUTH_CODE_COOLDOWN_MS на сервере

const CHARACTERISTICS = [
  { key:'clarity',   name:'Понятно объясняет' },
  { key:'humor',     name:'Чувство юмора' },
  { key:'strict',    name:'Строгость' },
  { key:'favorites', name:'Есть любимчики' },
];

/* ---------- мелкие помощники ---------- */
const $  = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>Array.from(r.querySelectorAll(s));
const html = (a,...v)=>a.reduce((x,s,i)=>x+s+(v[i]??''),'');
// Экранирование пользовательских данных перед вставкой в innerHTML.
// esc — для текстового контекста, escAttr — для значений атрибутов (src="...", value="...").
const esc = (v)=>String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const escAttr = esc;
const fmtNum = v => Math.round((v||0)*10)/10;
// Оценки 1..5, поэтому среднее 0 = «оценок ещё нет»: показываем прочерк, а не «★ 0».
const fmtStars = v => v > 0
  ? html`<span class="rating" title="${fmtNum(v)} из 5"><span class="star">★</span>${fmtNum(v)}</span>`
  : '<span class="rating none" title="Пока нет оценок">—</span>';
const fmtDate = ts => {
  const d = new Date(Number(ts) || 0);
  try { return d.toLocaleString('ru-RU', { dateStyle:'medium', timeStyle:'short' }); }
  catch { return d.toISOString(); }
};
// Склонение: plural(3, ['оценка','оценки','оценок']) -> 'оценки'.
function plural(n, forms){
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
const countLabel = (n, forms) => `${n} ${plural(n, forms)}`;
const RATING_FORMS = ['оценка','оценки','оценок'];
// Редкости ников в магазине (синхронно с shop_items.js на сервере).
const SHOP_TIERS = [
  { key:'common', title:'Обычные' },
  { key:'rare', title:'Редкие' },
  { key:'epic', title:'Эпические' },
  { key:'legendary', title:'Легендарные' },
];
const COMMENT_FORMS = ['отзыв','отзыва','отзывов'];

// Поиск по ФИО: без учёта регистра и ё/е, слова в любом порядке («Артём Сухов» = «Сухов Артем»).
const normName = v => String(v ?? '').toLowerCase().replace(/ё/g, 'е');
function matchesQuery(t, q){
  const words = normName(q).split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const fio = normName([t.lastName, t.firstName, t.patronymic].filter(Boolean).join(' '));
  return words.every(w => fio.includes(w));
}
const fullName = t => [t.lastName, t.firstName, t.patronymic].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
function characteristicAvg(t,k){ const r=t.ratings?.[k]; return r&&r.count?(r.sum/r.count):0; }
function characteristicCount(t,k){ return Number(t.ratings?.[k]?.count || 0); }
function overall(t){ let tot=0,cnt=0; for(const c of CHARACTERISTICS){ const r=t.ratings?.[c.key]; if(r&&r.count){ tot+=r.sum/r.count; cnt++; } } return cnt?tot/cnt:0; }
// Сколько человек оценили учителя (примерно: максимум оценок по одной характеристике).
function ratersCount(t){ return Math.max(0, ...CHARACTERISTICS.map(c => characteristicCount(t, c.key))); }
const collator = new Intl.Collator('ru',{sensitivity:'base'});
function normalizeSearchQuery(v){
  const text = String(v ?? '');
  return text.length > SEARCH_QUERY_MAX_LEN ? text.slice(0, SEARCH_QUERY_MAX_LEN) : text;
}

function coinsOf(u){
  if (!u) return 0;
  const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const earned = num(u.earned_coins) ?? (5*Number(u.comment_count||0) + Number(u.rating_count||0) + Number(u.received_likes||0) - Number(u.received_dislikes||0));
  const available = num(u.available_coins) ?? (earned - (num(u.spent_coins) ?? 0));
  return Math.max(0, Number.isFinite(available) ? available : 0);
}

// Блокирует кнопку на время асинхронного действия — защита от двойного клика
// (двойная публикация, двойная покупка и т.п.).
async function withBusy(btn, fn){
  if (btn && btn.disabled) return undefined;
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  try { return await fn(); }
  finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }
}

/* ---------- предпроверка мата ----------
   Та же функция, что на сервере (public/profanity.js подключён перед app.js):
   предупреждаем ровно о том, за что сервер отклонит отзыв и засчитает нарушение. */
function hasProfanity(text){
  return !!(window.Profanity && window.Profanity.hasBadWords(text));
}

/* ---------- уведомления и диалоги (вместо alert / prompt / confirm) ---------- */
const UI = {
  toast(message, tone = 'info', ms = 3800){
    let host = $('#toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.textContent = message;
    host.appendChild(el);
    while (host.children.length > 3) host.firstElementChild.remove();
    setTimeout(()=>{ el.remove(); }, ms);
  },

  // Модальное окно. Возвращает Promise: true/строка — подтвердили, null/false — отмена.
  _modal({ title, text = '', input = null, confirmText = 'OK', cancelText = 'Отмена', danger = false }){
    return new Promise(resolve => {
      const prevFocus = document.activeElement;
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = html`
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <h3 class="modal-title" id="modalTitle">${esc(title)}</h3>
          ${text ? html`<p class="modal-text">${esc(text)}</p>` : ''}
          ${input ? html`<textarea class="input" id="modalInput" rows="3" maxlength="${input.maxLength || 500}" placeholder="${escAttr(input.placeholder || '')}"></textarea>` : ''}
          <div class="modal-actions">
            <button type="button" class="btn outline" data-act="cancel">${esc(cancelText)}</button>
            <button type="button" class="btn ${danger ? 'danger solid' : 'primary'}" data-act="ok">${esc(confirmText)}</button>
          </div>
        </div>`;
      const field = input ? backdrop.querySelector('#modalInput') : null;
      const finish = (value) => {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        try { prevFocus?.focus?.(); } catch {}
        resolve(value);
      };
      const confirm = () => {
        if (!field) return finish(true);
        const v = field.value.trim();
        if (input.required && !v) { field.focus(); field.classList.add('invalid'); return; }
        finish(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(field ? null : false); }
        else if (e.key === 'Enter' && (!field || !e.shiftKey) && document.activeElement !== backdrop.querySelector('[data-act="cancel"]')) {
          e.preventDefault(); confirm();
        }
      };
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) finish(field ? null : false);
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'cancel') finish(field ? null : false);
        if (act === 'ok') confirm();
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(backdrop);
      (field || backdrop.querySelector('[data-act="ok"]')).focus();
    });
  },
  confirm(opts){ return this._modal({ confirmText: 'Да', ...opts }); },
  prompt(opts){ return this._modal({ ...opts, input: { placeholder: opts.placeholder, required: opts.required, maxLength: opts.maxLength } }); },
};

function makeLoggedOutState(){
  return {
    loggedIn:false, id:null, email:null, username:null, display_name:null,
    comment_count:0, rating_count:0, cast_likes:0, cast_dislikes:0,
    received_likes:0, received_dislikes:0, available_coins:0, earned_coins:0, spent_coins:0,
    _isAdmin:false, _isSuperAdmin:false, _isBanned:false
  };
}

/* ---------- авторизация (состояние берётся с сервера) ---------- */
const Auth = {
  _state: makeLoggedOutState(),
  _ready: false,
  _readyPromise: null,

  get(){ return this._state; },
  set(o){
    const merged = { ...this._state, ...o };
    merged.available_coins = coinsOf(merged);
    if (typeof merged.earned_coins !== 'number' || Number.isNaN(merged.earned_coins)) {
      merged.earned_coins = 5*Number(merged.comment_count||0) + Number(merged.rating_count||0) + Number(merged.received_likes||0) - Number(merged.received_dislikes||0);
    }
    if (typeof merged.spent_coins !== 'number' || Number.isNaN(merged.spent_coins)) {
      merged.spent_coins = Math.max(0, merged.earned_coins - merged.available_coins);
    }
    this._state = merged;
    this.render();
    this.renderProfilePopover();
  },

  // Единое применение пользователя из ответа сервера (/api/auth/me, /verify, /user/stats).
  applyUser(u){
    if (!u) return;
    this.set({
      loggedIn:true,
      id: u.id,
      email: u.email,
      username: u.username,
      display_name: u.display_name || u.username || String(u.email || '').split('@')[0],
      comment_count: Number(u.comment_count || 0),
      rating_count: Number(u.rating_count || 0),
      cast_likes: Number(u.cast_likes || 0),
      cast_dislikes: Number(u.cast_dislikes || 0),
      received_likes: Number(u.received_likes || 0),
      received_dislikes: Number(u.received_dislikes || 0),
      available_coins: Number(u.available_coins ?? coinsOf(u)),
      earned_coins: Number(u.earned_coins ?? 0),
      spent_coins: Number(u.spent_coins ?? 0),
      _isAdmin: !!u.is_admin,
      _isSuperAdmin: !!u.is_super_admin,
      _isBanned: !!u.is_banned
    });
  },

  // Сессия закончилась на сервере (истекла, вход с другого устройства, отзыв):
  // сбрасываем состояние и, если пользователь был внутри, показываем экран входа.
  _dropSession(){
    const wasLoggedIn = this.isLogged();
    this.set(makeLoggedOutState());
    App.resetUserScopedState();
    if (wasLoggedIn) {
      UI.toast('Сессия завершилась — войдите снова.', 'warn');
      Router.match();
    }
  },

  async me(){
    let r = null;
    try{ r = await fetch('/api/auth/me', { cache: 'no-store' }); }
    catch{ this._ready = true; return; }

    if (r.status === 401) { this._dropSession(); this._ready = true; return; }
    if (!r.ok) { this._ready = true; return; }

    let j = null;
    try{ j = await r.json(); }catch{ this._ready = true; return; }

    if (j?.loggedIn){
      const wasBanned = this._state._isBanned;
      this.applyUser(j.user);
      // Бан/разбан, пришедший при фоновой сверке, — перерисовываем текущий экран.
      if (wasBanned !== this._state._isBanned) Router.match();
    }else if (j && j.loggedIn === false){
      this._dropSession();
    }
    this._ready = true;
  },

  async ensure(){
    if (this._ready) return;
    if (!this._readyPromise){
      this._readyPromise = this.me().finally(()=>{
        this._ready = true;
        this._readyPromise = null;
      });
    }
    return this._readyPromise;
  },

  async logout(){
    try{ await fetch('/api/auth/logout',{method:'POST'}); }catch{}
    const wasLoggedIn = this.isLogged();
    this.set(makeLoggedOutState());
    App.resetUserScopedState();
    if (wasLoggedIn) Router.go('/login', { replace:true });
  },

  // Любой 401 от API: сессия уже недействительна на сервере.
  handleUnauthorized(){
    if (this.isLogged()) this._dropSession();
  },

  // 403 banned от API: аккаунт заблокирован — обновляем состояние и экран.
  markBanned(){
    if (this._state._isBanned) return;
    this.set({ _isBanned: true });
    UI.toast('Ваш аккаунт заблокирован за нарушение правил.', 'error', 6000);
    Router.match();
  },

  isLogged(){ return !!this._state.loggedIn; },

  render(){
    const userBadge = $('#userBadge');
    const adminLink = $('#adminLink'), shopLink = $('#shopLink');
    const logged = this.isLogged();

    userBadge?.classList.toggle('hidden', !logged);
    // Админка — только администраторам; магазин — всем, кроме заблокированных.
    adminLink?.classList.toggle('hidden', !(logged && this._state._isAdmin));
    shopLink?.classList.toggle('hidden', !(logged && !this._state._isBanned));

    if (logged && userBadge) {
      const nick = this._state.display_name || (this._state.username || this._state.email || 'Student').split('@')[0] || 'Student';
      userBadge.textContent = nick;
      userBadge.title = `${nick} — аккаунт`;
    }
  },

  // При смене версии фронтенда сбрасываем закэшированный список учителей.
  migrate(){
    try {
      const vkey = 'letotalks:version';
      if (localStorage.getItem(vkey) !== APP_VERSION) {
        clearTeacherCacheInStorage();
        localStorage.setItem(vkey, APP_VERSION);
      }
    } catch { /* localStorage недоступен (приватный режим) — не критично */ }
  },

  async refreshStatsAndPopover(){
    if (!this.isLogged()) return;
    const j = await apiFetch('/api/user/stats');
    if (!j.ok || !j.user || !this.isLogged()) return;
    this.applyUser(j.user);
  },

  // --- поповер аккаунта: наведение на ПК, тап/клик и клавиатура — везде.
  renderProfilePopover(){
    const pop = this._ensurePopover();
    if (pop && !pop.classList.contains('hidden')) this._fillPopover(pop);
  },

  _fillPopover(pop){
    const u = this._state;
    const nick = u.display_name || (u.username||u.email||'Student').split('@')[0]||'Student';
    const coins = coinsOf(u);
    const earned = Number(u.earned_coins || 0);
    const spent = Number(u.spent_coins || 0);
    pop.innerHTML = html`
      <div class="popover-head">
        <div class="tname" title="${escAttr(nick)}">${esc(nick)}</div>
        <div class="coin-pill" title="Доступно coins">${coins} coins</div>
      </div>
      <div class="muted popover-email">${esc(u.email || '')}</div>
      ${u._isBanned ? '<div class="notice danger" style="margin-top:10px">Аккаунт заблокирован</div>' : ''}
      <div class="hr"></div>
      <ul class="stats">
        <li>Заработано: <b>${earned}</b>, потрачено: <b>${spent}</b></li>
        <li>Отзывов: <b>${u.comment_count||0}</b> <span class="muted">(+5 за каждый)</span></li>
        <li>Оценок по критериям: <b>${u.rating_count||0}</b> <span class="muted">(+1 за каждую)</span></li>
        <li>Реакции на ваши отзывы: 👍 <b>${u.received_likes||0}</b> · 👎 <b>${u.received_dislikes||0}</b> <span class="muted">(±1)</span></li>
        <li>Вы поставили: 👍 <b>${u.cast_likes||0}</b> · 👎 <b>${u.cast_dislikes||0}</b></li>
      </ul>
      <div class="popover-actions">
        ${u._isBanned ? '' : '<a class="btn small outline" href="#/shop">Магазин ников</a>'}
        <button class="btn small danger" id="popoverLogout" type="button">Выйти</button>
      </div>
    `;
  },

  _ensurePopover(){
    const badge = $('#userBadge');
    if (!badge) return null;
    let pop = $('#userPopover');
    if (pop) return pop;

    pop = document.createElement('div');
    pop.id = 'userPopover';
    pop.className = 'popover hidden';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Аккаунт');
    document.body.appendChild(pop);

    // Состояние и обработчики создаются ОДИН раз.
    const st = { hover: false, pinned: false, hideTimer: null };
    const canHover = !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

    const position = ()=>{
      const r = badge.getBoundingClientRect();
      const popWidth = pop.offsetWidth || 330;
      const viewportW = document.documentElement.clientWidth;
      let left = window.scrollX + r.right - popWidth;
      left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + viewportW - popWidth - 8));
      pop.style.left = Math.round(left) + 'px';
      pop.style.top  = Math.round(window.scrollY + r.bottom + 8) + 'px';
    };
    const show = ()=>{
      if (!Auth.isLogged()) return;
      this._fillPopover(pop);
      pop.classList.remove('hidden');
      position();
      badge.setAttribute('aria-expanded', 'true');
    };
    const hide = ()=>{
      clearTimeout(st.hideTimer);
      st.pinned = false;
      pop.classList.add('hidden');
      badge.setAttribute('aria-expanded', 'false');
    };
    const scheduleHide = ()=>{
      clearTimeout(st.hideTimer);
      st.hideTimer = setTimeout(()=>{ if (!st.hover && !st.pinned) hide(); }, 180);
    };
    const isOpen = ()=> !pop.classList.contains('hidden');

    if (canHover) {
      badge.addEventListener('mouseenter', ()=>{
        st.hover = true; clearTimeout(st.hideTimer);
        if (!isOpen()) { show(); Auth.refreshStatsAndPopover(); }
      });
      badge.addEventListener('mouseleave', ()=>{ st.hover = false; scheduleHide(); });
      pop.addEventListener('mouseenter', ()=>{ st.hover = true; clearTimeout(st.hideTimer); });
      pop.addEventListener('mouseleave', ()=>{ st.hover = false; scheduleHide(); });
    }
    badge.addEventListener('click', (e)=>{
      e.stopPropagation();
      if (!isOpen()) { st.pinned = true; show(); Auth.refreshStatsAndPopover(); }
      else if (canHover && !st.pinned) st.pinned = true; // открыт наведением — клик закрепляет
      else hide();
    });
    pop.addEventListener('click', (e)=>{
      if (e.target.closest('#popoverLogout')) { hide(); Auth.logout(); return; }
      if (e.target.closest('a[href^="#/"]')) hide();
    });
    document.addEventListener('click', (e)=>{
      if (isOpen() && !e.target.closest('#userPopover, #userBadge')) hide();
    });
    document.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape' && isOpen()) { hide(); badge.focus(); }
    });
    window.addEventListener('scroll', ()=>{ if (isOpen()) position(); }, { passive: true });
    window.addEventListener('resize', ()=>{ if (isOpen()) position(); });
    window.addEventListener('hashchange', hide);
    return pop;
  }
};

/* ---------- кэш списка учителей ---------- */
const TEACHERS_CACHE_KEY = 'letotalks:cache:teachers';
const TEACHERS_CACHE_TTL = 1000 * 60 * 3; // 3 минуты — баланс свежести и нагрузки
const teacherCacheState = { data: null, ts: 0, promise: null };

function readTeacherCacheFromStorage() {
  try {
    const raw = localStorage.getItem(TEACHERS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.data)) return null;
    const ts = Number(parsed.ts || 0);
    if (!Number.isFinite(ts)) return null;
    return { data: parsed.data, ts };
  } catch {
    return null;
  }
}
function writeTeacherCacheToStorage(data, ts) {
  try { localStorage.setItem(TEACHERS_CACHE_KEY, JSON.stringify({ data, ts })); } catch { /* квота */ }
}
function clearTeacherCacheInStorage() {
  try { localStorage.removeItem(TEACHERS_CACHE_KEY); } catch { /* ignore */ }
}

// Единая обёртка над fetch: всегда возвращает объект (не бросает), безопасно
// парсит JSON, нормализует ok по HTTP-статусу. Сетевые ошибки -> {ok:false,...}.
// Здесь же централизованно реагируем на 401 (сессия умерла) и 403 banned.
async function apiFetch(url, opts) {
  let r;
  try {
    r = await fetch(url, opts);
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, error: 'aborted', _status: 0, _aborted: true };
    return { ok: false, error: 'network_error', _status: 0 };
  }
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    // Не-JSON ответ (прокси, HTML-страница ошибки): ставим понятный код ошибки.
    data = r.ok ? {} : { error: r.status === 429 ? 'rate_limited' : `http_${r.status}` };
  }
  if (!('ok' in data)) data.ok = r.ok;
  else if (!r.ok) data.ok = false;
  data._status = r.status;

  const isAuthCall = /\/api\/auth\//.test(String(url));
  if (r.status === 401 && !isAuthCall) Auth.handleUnauthorized();
  if (r.status === 403 && data.error === 'banned') Auth.markBanned();
  return data;
}
const postJson = (url, body) => apiFetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {}) });

// Понятные тексты для кодов ошибок сервера.
function errorText(res, fallback = 'Что-то пошло не так. Попробуйте ещё раз.'){
  const code = res?.error;
  const map = {
    network_error: 'Нет соединения с сервером. Проверьте интернет.',
    rate_limited: res?.message || 'Слишком много запросов. Подождите немного.',
    unauthorized: 'Сессия завершилась — войдите снова.',
    banned: 'Ваш аккаунт заблокирован за нарушение правил.',
    forbidden: 'Недостаточно прав для этого действия.',
    not_found: 'Не найдено — возможно, уже удалено.',
    comment_not_found: 'Отзыв не найден — возможно, уже удалён.',
    teacher_not_found: 'Учитель не найден.',
    telegram_not_configured: 'Сервис модерации временно недоступен. Попробуйте позже.',
    telegram_failed: 'Не удалось связаться с модераторами. Попробуйте позже.',
    server_error: 'Ошибка на сервере. Попробуйте позже.',
  };
  return map[code] || fallback;
}

async function fetchTeachersFromServer() {
  const jr = await apiFetch('/api/teachers', { headers: { 'Cache-Control': 'no-cache' } });
  if (!jr.ok) throw new Error('teachers_fetch_failed');
  return Array.isArray(jr?.teachers) ? jr.teachers : [];
}

const DEPARTMENTS_TTL = 5 * 60 * 1000;
const departmentsCache = { list: null, ts: 0 };

const API = {
  // Кафедры меняются редко — держим их в памяти, а не запрашиваем на каждой странице.
  async departments({ force = false } = {}){
    if (!force && departmentsCache.list && Date.now() - departmentsCache.ts < DEPARTMENTS_TTL) return departmentsCache.list;
    const d = await apiFetch('/api/departments');
    if (!d.ok) return departmentsCache.list || [];
    departmentsCache.list = Array.isArray(d.departments) ? d.departments : [];
    departmentsCache.ts = Date.now();
    return departmentsCache.list;
  },

  // Лёгкий запрос для главной: топ-3 по каждой характеристике и по каждой кафедре.
  async home(){
    const d = await apiFetch('/api/home', { headers: { 'Cache-Control': 'no-cache' } });
    if (!d.ok) throw new Error('home_fetch_failed');
    return d;
  },

  // Страница «Все учителя» с подгрузкой порциями.
  async teachersPage({ limit = 30, offset = 0 } = {}){
    const p = new URLSearchParams();
    if (limit) p.set('limit', String(limit));
    if (offset) p.set('offset', String(offset));
    const j = await apiFetch(`/api/teachers?${p.toString()}`, { headers: { 'Cache-Control': 'no-cache' } });
    if (!j.ok) throw new Error('teachers_page_fetch_failed');
    return { teachers: Array.isArray(j?.teachers) ? j.teachers : [], total: Number(j?.total||0) };
  },

  // Полный список (для топов, кафедр и поиска): память -> localStorage -> сервер.
  async teachers(options = {}){
    const { force = false } = options;
    const now = Date.now();

    if (!force && teacherCacheState.data && (now - teacherCacheState.ts) < TEACHERS_CACHE_TTL) {
      return teacherCacheState.data;
    }
    if (!force && (!teacherCacheState.data || !teacherCacheState.data.length)) {
      const stored = readTeacherCacheFromStorage();
      if (stored && Array.isArray(stored.data)) {
        teacherCacheState.data = stored.data;
        teacherCacheState.ts = stored.ts || 0;
        if ((now - teacherCacheState.ts) < TEACHERS_CACHE_TTL) return teacherCacheState.data;
        if (!teacherCacheState.promise) API.teachers({ force: true }).catch(()=>{});
        return teacherCacheState.data;
      }
    }
    if (!force && teacherCacheState.promise) return teacherCacheState.promise;

    const fetchPromise = (async () => {
      try {
        const teachers = await fetchTeachersFromServer();
        teacherCacheState.data = teachers;
        teacherCacheState.ts = Date.now();
        writeTeacherCacheToStorage(teachers, teacherCacheState.ts);
        return teachers;
      } catch (err) {
        if (teacherCacheState.data && teacherCacheState.data.length) return teacherCacheState.data;
        throw err;
      } finally {
        if (teacherCacheState.promise === fetchPromise) teacherCacheState.promise = null;
      }
    })();
    teacherCacheState.promise = fetchPromise;
    return fetchPromise;
  },
  invalidateTeachersCache(){
    teacherCacheState.data = null;
    teacherCacheState.ts = 0;
    teacherCacheState.promise = null;
    clearTeacherCacheInStorage();
  },
  teacher(id){
    return apiFetch(`/api/teacher/${encodeURIComponent(id)}`, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
  },
  publish({ teacherId, text, ratings }){ return postJson('/api/comment-with-ratings', { teacherId, text, ratings }); },
  voteComment({ commentId, vote }){ return postJson('/api/comment/vote', { commentId, vote }); }, // vote: like | dislike | none
  deleteOwnComment(commentId){ return postJson('/api/comment/delete', { commentId }); },
  reportComment(commentId, reason){ return postJson('/api/report-comment', { commentId, reason }); },
  teacherRequest(formData){ return apiFetch('/api/teacher-request', { method: 'POST', body: formData }); },

  // --- admin ---
  adminRecentComments(limit=100){ return apiFetch(`/api/admin/comments?limit=${encodeURIComponent(limit)}`); },
  adminCommenters(){ return apiFetch('/api/admin/commenters'); },
  adminCommentsByUser(userId){ return apiFetch('/api/admin/comments/by-user?userId='+encodeURIComponent(userId)); },
  adminDeleteComment(id){ return postJson('/api/admin/comment/delete', { commentId:id }); },
  adminUsers(){ return apiFetch('/api/admin/users'); },
  adminBanUser({ userId, banned, reason }){ return postJson('/api/admin/user/ban', { userId, banned, reason }); },
  adminTeachers(){ return apiFetch('/api/admin/teachers'); },
  adminUpsertTeacher(payload){ return postJson('/api/admin/teacher/upsert', payload); },
  adminDeleteTeacher(id){ return postJson('/api/admin/teacher/delete', { id }); },
  adminUploadTeacherPhoto(formData){ return apiFetch('/api/admin/teacher/photo', { method:'POST', body: formData }); },
  adminListAdmins(){ return apiFetch('/api/admin/admins'); },
  adminAddAdmin(email){ return postJson('/api/admin/admins/add', { email }); },
  adminRemoveAdmin(email){ return postJson('/api/admin/admins/remove', { email }); },
};

/* ---------- роутер (hash) ---------- */
const RETURN_TO_KEY = 'letotalks:returnTo';
const Router = {
  routes: [],
  // Номер текущей навигации. Вьюха запоминает его в начале и после каждого await
  // проверяет isStale(): если пользователь уже ушёл на другую страницу (или его
  // разлогинило), устаревший рендер не должен затирать новый экран.
  seq: 0,
  navCount: 0,
  add(p,h){ this.routes.push({pattern:p, handler:h}); },
  isStale(seq){ return seq !== this.seq; },
  scrollTop(){
    try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); }
    catch { window.scrollTo(0,0); }
  },
  // replace: true — перенаправление без новой записи в истории (иначе «Назад»
  // возвращал на /login и тут же уводил обратно — ловушка).
  go(p, { replace = false } = {}){
    if (location.hash.slice(1) !== p) {
      if (replace) {
        history.replaceState(null, '', `#${p}`);
        this.scrollTop();
        this.match();
      } else {
        location.hash = p; // match() вызовет обработчик hashchange
      }
      return;
    }
    this.scrollTop();
    this.match();
  },
  // «Назад» внутри приложения; если страницу открыли по прямой ссылке — на главную.
  back(){
    if (this.navCount > 1) history.back();
    else this.go('/');
  },
  rememberReturnTo(h){
    try { if (h && h !== '/' && !h.startsWith('/login')) sessionStorage.setItem(RETURN_TO_KEY, h); } catch {}
  },
  takeReturnTo(){
    try {
      const v = sessionStorage.getItem(RETURN_TO_KEY);
      sessionStorage.removeItem(RETURN_TO_KEY);
      return v && v.startsWith('/') && !v.startsWith('/login') ? v : null;
    } catch { return null; }
  },

  async match(){
    const seq = ++this.seq;
    await Auth.ensure();
    if (this.isStale(seq)) return;
    const h = location.hash.slice(1) || '/';
    const pathName = h.split('?')[0] || '/';
    const isLoginRoute = pathName === '/login';
    // Жёсткая блокировка: незалогиненный видит ТОЛЬКО экран входа.
    if (!Auth.isLogged()) {
      document.body.classList.add('lockout');
      if (!isLoginRoute) {
        this.rememberReturnTo(h); // вернём туда после входа (например, ссылка на учителя)
        this.go('/login', { replace:true });
        return;
      }
      App.viewLogin();
      return;
    }
    document.body.classList.remove('lockout');
    if (isLoginRoute) {
      this.go(this.takeReturnTo() || '/', { replace:true });
      return;
    }
    this.navCount++;
    for (const r of this.routes) {
      const m = h.match(r.pattern);
      if (m) { await r.handler(...m); return; }
    }
    // Неизвестный адрес — на главную.
    this.go('/', { replace:true });
  },
  init(){
    addEventListener('hashchange', ()=>{
      this.scrollTop();
      this.match();
    });
    this.scrollTop();
    this.match();
  }
};

/* ---------- приложение ---------- */
const App = {
  ALL_TEACHERS: [],

  // Всё, что относится к конкретному пользователю, — сбрасываем при выходе.
  resetUserScopedState(){
    this._lastCommentNotice = null;
    clearTeacherCacheInStorage();
  },

  async getTeachers(options = {}){
    try{
      const list = await API.teachers(options);
      this.ALL_TEACHERS = Array.isArray(list) ? list : [];
      return this.ALL_TEACHERS;
    }catch(err){
      console.warn('[App] Не удалось загрузить список учителей', err);
      return null; // null = ошибка загрузки (в отличие от пустого списка)
    }
  },

  invalidateTeachers(){
    this.ALL_TEACHERS = [];
    API.invalidateTeachersCache();
  },

  async getDepartments(){
    try{ return await API.departments(); }catch{ return []; }
  },

  // Экран ошибки с кнопкой «Повторить».
  renderError(message, retry){
    $('#app').innerHTML = html`
      <section class="section">
        <div class="empty-state">
          <p>${esc(message)}</p>
          <button class="btn outline" type="button" id="retryBtn">Повторить</button>
        </div>
      </section>`;
    $('#retryBtn')?.addEventListener('click', ()=> retry ? retry() : Router.match());
  },

  async mountNavbar(){
    // Отключаем наблюдатель бесконечной ленты прошлой страницы.
    if (App._listObserver) { App._listObserver.disconnect(); App._listObserver = null; }
    // Останавливаем авто-карусели прошлой страницы.
    this.clearCarousels();
    const btn  = $('#deptBtn');
    const menu = $('#deptMenu');
    const searchInput = $('#searchInput');
    if (!btn || !menu) return;

    const defaultDeptLabel = 'Кафедры…';
    const h = (location.hash || '').slice(1) || '/';
    const [pathPart, queryPart = ''] = h.split('?');
    let currentDepartment = '';
    if (pathPart.startsWith('/department/')) {
      try { currentDepartment = decodeURIComponent(pathPart.slice('/department/'.length)); } catch { currentDepartment = ''; }
    }
    if (searchInput) {
      let q = '';
      if (pathPart === '/search') {
        try { q = new URLSearchParams(queryPart).get('q') || ''; } catch { q = ''; }
      }
      searchInput.value = normalizeSearchQuery(q);
    }
    btn.textContent = currentDepartment || defaultDeptLabel;
    btn.title = currentDepartment || '';
    btn.setAttribute('aria-expanded','false');
    menu.classList.add('hidden');

    const deps = await this.getDepartments();
    menu.innerHTML =
      `<button class="select-item" type="button" data-route="/teachers">Все учителя</button>` +
      deps.map(d=>html`<button class="select-item" type="button" data-route="/department/${encodeURIComponent(d)}" aria-selected="${d === currentDepartment}">${esc(d)}</button>`).join('');

    if (!App._navHandlersAttached) {
      App._navHandlersAttached = true;
      btn.addEventListener('click', () => {
        const willOpen = menu.classList.contains('hidden');
        menu.classList.toggle('hidden', !willOpen);
        btn.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) menu.querySelector('.select-item')?.focus();
      });
      menu.addEventListener('click', (e) => {
        const it = e.target.closest('.select-item'); if (!it) return;
        menu.classList.add('hidden');
        btn.setAttribute('aria-expanded','false');
        Router.go(it.dataset.route);
      });
      // Стрелки ↑/↓ по пунктам меню.
      menu.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = $$('.select-item', menu);
        const i = items.indexOf(document.activeElement);
        const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
        next?.focus();
      });
      document.addEventListener('click', (e)=>{
        if (!e.target.closest('#deptSelectWrap')) { menu.classList.add('hidden'); btn.setAttribute('aria-expanded','false'); }
      });
      document.addEventListener('keydown', (e)=>{
        if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
          menu.classList.add('hidden'); btn.setAttribute('aria-expanded','false'); btn.focus();
        }
      });
    }
  },

  search(){
    const input = $('#searchInput');
    const raw = normalizeSearchQuery(input?.value);
    if (input && input.value !== raw) input.value = raw;
    const q = raw.trim();
    if (!q) { input?.focus(); return; }
    Router.go(`/search?q=${encodeURIComponent(q)}`);
  },

  teacherTile(t, value){
    const fio = fullName(t);
    const votes = ratersCount(t);
    return html`
      <div class="list-item">
        <div class="portrait"><img src="${escAttr(t.photo || '')}" alt="" loading="lazy"></div>
        <div>
          <div class="tname"><a class="link" href="#/teacher/${encodeURIComponent(t.id)}">${esc(fio) || 'Без имени'}</a></div>
          <div class="meta">${esc(t.department)}${t.subjects?.length ? ' · ' + esc(t.subjects.join(', ')) : ''}</div>
        </div>
        <div class="list-rating">${fmtStars(value)}${votes ? html`<div class="rating-count">${countLabel(votes, RATING_FORMS)}</div>` : ''}</div>
      </div>`;
  },

  miniTeacher(t, value){
    const fio = [t.lastName, t.firstName].filter(Boolean).join(' ').trim();
    return html`
      <div class="mini-teacher">
        <div class="portrait"><img src="${escAttr(t.photo || '')}" alt="" loading="lazy"></div>
        <div class="info">
          <div class="tname"><a class="link" href="#/teacher/${encodeURIComponent(t.id)}">${esc(fio) || 'Без имени'}</a></div>
          <div class="tdept">${esc(t.department)}</div>
        </div>
        <div>${fmtStars(value)}</div>
      </div>`;
  },

  sortByValueThenAlpha(list, getVal){
    return list.sort((a,b)=>{
      const va = getVal(a), vb = getVal(b);
      if (vb !== va) return vb - va;
      return collator.compare(`${a.lastName} ${a.firstName}`.trim(), `${b.lastName} ${b.firstName}`.trim());
    });
  },

  /* --- главная --- */
  async viewHome(){
    const seq = Router.seq;
    await this.mountNavbar();
    let homeData = null;
    try{ homeData = await API.home(); }catch{ homeData = null; }
    if (Router.isStale(seq)) return;
    if (!homeData) {
      this.renderError('Не удалось загрузить главную страницу.', ()=>this.viewHome());
      return;
    }

    const card = ({ title, href, linkText, list, valueOf }) => html`
      <div class="card">
        <div class="card-header">
          <h3>${esc(title)}</h3>
          <a class="btn small primary" href="${escAttr(href)}">${linkText}</a>
        </div>
        <div class="card-content">
          <div class="hr"></div>
          ${list.length ? list.map(t => this.miniTeacher(t, valueOf(t))).join('') : '<div class="empty">Пока нет оценок</div>'}
        </div>
      </div>`;

    const charCards = CHARACTERISTICS.map(c => card({
      title: c.name, href: `#/top/${c.key}`, linkText: 'Смотреть всех',
      list: Array.isArray(homeData.characteristics?.[c.key]) ? homeData.characteristics[c.key] : [],
      valueOf: t => characteristicAvg(t, c.key)
    })).join('');

    const deptCards = (Array.isArray(homeData.departments) ? homeData.departments : [])
      .filter(d => Array.isArray(d.list) && d.list.length)
      .map(d => card({
        title: d.name, href: `#/department/${encodeURIComponent(d.name)}`, linkText: 'Все учителя',
        list: d.list, valueOf: t => overall(t)
      })).join('');

    // Для бесшовной бесконечной прокрутки — три одинаковых набора карточек;
    // крайние скрыты от скринридеров и клавиатуры (inert), живой — средний.
    const loopSets = (cards)=> `<div class="marquee-set" aria-hidden="true" inert>${cards}</div><div class="marquee-set">${cards}</div><div class="marquee-set" aria-hidden="true" inert>${cards}</div>`;
    const carousel = (title, cards) => cards ? html`
      <section class="section">
        <h2>${title}</h2>
        <div class="hscroll">
          <button class="hscroll-arrow left" type="button" aria-label="Прокрутить влево">‹</button>
          <div class="card-row">${loopSets(cards)}</div>
          <button class="hscroll-arrow right" type="button" aria-label="Прокрутить вправо">›</button>
        </div>
      </section>` : '';

    $('#app').innerHTML = html`
      ${carousel('Топ по характеристикам', charCards)}
      ${carousel('По кафедрам', deptCards)}
      <section class="section">
        <div class="cta-card">
          <div class="cta-text">
            <h2>Не нашли своего учителя?</h2>
            <p class="muted">Отправьте заявку — модераторы проверят информацию и добавят учителя в каталог.</p>
          </div>
          <a class="btn primary" href="#/teacher-request">Предложить учителя</a>
        </div>
      </section>
    `;
    this.wireCarousels();
  },

  // Бесконечные авто-карусели: медленно едут сами (requestAnimationFrame), стоят,
  // пока карусель вне экрана, под курсором, в фокусе или после ручной прокрутки.
  // При «уменьшении движения» в системе — не едут вовсе.
  _carouselCleanup: [],
  clearCarousels(){
    (this._carouselCleanup || []).forEach(fn=>{ try{ fn(); }catch{} });
    this._carouselCleanup = [];
  },
  wireCarousels(){
    this.clearCarousels();
    const reduceMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    $$('.hscroll').forEach(wrap=>{
      const row = wrap.querySelector('.card-row');
      const sets = row ? row.querySelectorAll('.marquee-set') : [];
      if (sets.length !== 3) return;
      const leftBtn = wrap.querySelector('.hscroll-arrow.left');
      const rightBtn = wrap.querySelector('.hscroll-arrow.right');

      // Карточки помещаются целиком — прокрутка не нужна: оставляем один набор.
      if (sets[1].scrollWidth <= row.clientWidth) {
        sets[0].remove(); sets[2].remove();
        leftBtn?.remove(); rightBtn?.remove();
        return;
      }

      let loop = 0;
      const measure = ()=>{ loop = sets[2].offsetLeft - sets[1].offsetLeft; };
      measure();
      let pos = loop;              // стартуем со среднего набора — влево тоже можно листать
      row.scrollLeft = pos;

      const SPEED = 28;            // px в секунду
      let hovering = false, focused = false, visible = true, pausedUntil = 0;
      let raf = 0, lastTs = 0, idleTimer = null;

      // Держим позицию в пределах среднего набора: сдвиг ровно на ширину набора
      // визуально незаметен (наборы одинаковые).
      const normalize = ()=>{
        if (!loop) return;
        let x = row.scrollLeft;
        if (x < loop * 0.5) x += loop;
        else if (x >= loop * 1.5) x -= loop;
        if (x !== row.scrollLeft) row.scrollLeft = x;
        pos = row.scrollLeft;
      };
      const pause = (ms)=>{ pausedUntil = Math.max(pausedUntil, performance.now() + ms); };

      const frame = (ts)=>{
        raf = requestAnimationFrame(frame);
        const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
        lastTs = ts;
        if (reduceMotion || hovering || focused || !visible || ts < pausedUntil) { pos = row.scrollLeft; return; }
        if (!loop) { measure(); return; }
        pos += SPEED * dt;
        if (pos >= loop * 1.5) pos -= loop;
        row.scrollLeft = pos;
      };
      raf = requestAnimationFrame(frame);

      const io = new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); });
      io.observe(wrap);

      const onResize = ()=>{ const ratio = loop ? row.scrollLeft / loop : 1; measure(); row.scrollLeft = pos = loop * ratio; };
      window.addEventListener('resize', onResize);

      wrap.addEventListener('mouseenter', ()=>{ hovering = true; });
      wrap.addEventListener('mouseleave', ()=>{ hovering = false; pause(600); });
      wrap.addEventListener('focusin', ()=>{ focused = true; });
      wrap.addEventListener('focusout', ()=>{ focused = false; pause(1500); });
      row.addEventListener('wheel', ()=> pause(2500), { passive:true });
      row.addEventListener('touchstart', ()=> pause(5000), { passive:true });
      row.addEventListener('pointerdown', ()=> pause(4000));
      // После ручной прокрутки (когда она закончилась) — нормализуем петлю.
      row.addEventListener('scroll', ()=>{
        clearTimeout(idleTimer);
        idleTimer = setTimeout(()=>{ if (performance.now() < pausedUntil || hovering || reduceMotion) normalize(); }, 180);
      }, { passive:true });

      const step = ()=> Math.max(260, Math.round(row.clientWidth * 0.8));
      leftBtn?.addEventListener('click', ()=>{ pause(3500); row.scrollBy({ left: -step(), behavior:'smooth' }); });
      rightBtn?.addEventListener('click', ()=>{ pause(3500); row.scrollBy({ left: step(), behavior:'smooth' }); });

      this._carouselCleanup.push(()=>{
        cancelAnimationFrame(raf);
        clearTimeout(idleTimer);
        io.disconnect();
        window.removeEventListener('resize', onResize);
      });
    });
  },

  /* --- заявка на добавление учителя --- */
  async viewTeacherRequest(){
    const seq = Router.seq;
    await this.mountNavbar();
    const departments = await this.getDepartments();
    if (Router.isStale(seq)) return;
    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head">
          <h2>Предложить учителя</h2>
          <a class="link" href="#/">← На главную</a>
        </div>
        <div class="panel roomy teacher-request-card" id="teacherRequestCard">
          <p class="muted">Заполните форму — заявка уйдёт модераторам, и после проверки учитель появится в каталоге.</p>
          <form id="teacherRequestForm" class="form-stack" novalidate>
            <div class="form-grid">
              <div class="field">
                <label for="reqLastName">Фамилия*</label>
                <input id="reqLastName" class="input" name="lastName" type="text" maxlength="120" required placeholder="Иванов" autocomplete="off">
              </div>
              <div class="field">
                <label for="reqFirstName">Имя*</label>
                <input id="reqFirstName" class="input" name="firstName" type="text" maxlength="120" required placeholder="Иван" autocomplete="off">
              </div>
              <div class="field">
                <label for="reqPatronymic">Отчество</label>
                <input id="reqPatronymic" class="input" name="patronymic" type="text" maxlength="120" placeholder="Иванович" autocomplete="off">
              </div>
              <div class="field">
                <label for="reqDepartment">Кафедра*</label>
                <select id="reqDepartment" class="input" name="department" required ${departments.length ? '' : 'disabled'}>
                  <option value="">${departments.length ? 'Выберите кафедру' : 'Список кафедр недоступен'}</option>
                  ${departments.map(d => html`<option value="${escAttr(d)}">${esc(d)}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label for="reqSubjects">Предметы*</label>
                <input id="reqSubjects" class="input" name="subjects" type="text" maxlength="240" required placeholder="Алгебра, геометрия" autocomplete="off">
                <div class="field-hint">Через запятую.</div>
              </div>
              <div class="field">
                <label for="reqSubmitterName">Как к вам обращаться</label>
                <input id="reqSubmitterName" class="input" name="submitterName" type="text" maxlength="160" placeholder="Имя или класс">
              </div>
              <div class="field">
                <label for="reqSubmitterContact">Контакт для связи</label>
                <input id="reqSubmitterContact" class="input" name="submitterContact" type="text" maxlength="160" placeholder="Telegram или почта (по желанию)">
              </div>
            </div>
            <div class="field">
              <label for="reqNotes">Комментарий</label>
              <textarea id="reqNotes" class="input" name="notes" rows="4" maxlength="1500" placeholder="Что преподаёт, в каких классах, чем запомнился."></textarea>
            </div>
            <div class="field">
              <label for="reqPhoto">Фото учителя</label>
              <input id="reqPhoto" class="input" name="photo" type="file" accept="image/jpeg,image/png,image/webp">
              <div class="field-hint">JPG, PNG или WebP, до 5 МБ. Лучше вертикальное, лицо по центру.</div>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn primary" id="teacherRequestSubmit">Отправить заявку</button>
              <a class="btn outline" href="#/">Отмена</a>
            </div>
            <p class="muted small" style="margin:0">* — обязательные поля.</p>
            <div id="teacherRequestFeedback" class="status-msg" role="status"></div>
          </form>
        </div>
      </section>
    `;
    const form = $('#teacherRequestForm');
    form?.addEventListener('submit', (e)=>{
      e.preventDefault();
      withBusy($('#teacherRequestSubmit'), ()=>this.submitTeacherRequestForm(form));
    });
  },

  teacherRequestErrorText(res){
    const map = {
      missing_name: 'Укажите фамилию и имя учителя.',
      missing_department: 'Выберите кафедру из списка.',
      invalid_department: 'Выберите кафедру из списка — новые не принимаются.',
      departments_unavailable: 'Список кафедр недоступен. Попробуйте позже.',
      missing_subjects: 'Добавьте хотя бы один предмет.',
      photo_too_large: 'Фото больше 5 МБ — выберите файл поменьше.',
      unsupported_photo_type: 'Фото должно быть в формате JPG, PNG или WebP.',
      upload_failed: 'Не удалось загрузить фото. Попробуйте выбрать его заново.',
      telegram_not_configured: 'Приём заявок временно недоступен. Попробуйте позже.',
      telegram_failed: 'Не удалось передать заявку модераторам. Попробуйте чуть позже.',
    };
    return map[res?.error] || errorText(res, 'Не удалось отправить заявку. Попробуйте позже.');
  },

  async submitTeacherRequestForm(form){
    const feedback = $('#teacherRequestFeedback');
    const setFeedback = (text, tone = '') => { if (feedback) { feedback.textContent = text; feedback.className = `status-msg ${tone}`; } };
    setFeedback('');
    if (!form.reportValidity()) return;

    const val = id => ($(id)?.value || '').trim();
    const subjects = val('#reqSubjects');
    if (!subjects.split(/[,|\n]+/).map(s=>s.trim()).filter(Boolean).length) {
      setFeedback('Добавьте хотя бы один предмет.', 'error');
      $('#reqSubjects')?.focus();
      return;
    }
    const file = $('#reqPhoto')?.files?.[0] || null;
    if (file) {
      if (!['image/jpeg','image/png','image/webp'].includes(file.type)) { setFeedback('Фото должно быть в формате JPG, PNG или WebP.', 'error'); return; }
      if (file.size > 5 * 1024 * 1024) { setFeedback('Фото больше 5 МБ — выберите файл поменьше.', 'error'); return; }
    }

    const formData = new FormData();
    formData.append('lastName', val('#reqLastName'));
    formData.append('firstName', val('#reqFirstName'));
    formData.append('patronymic', val('#reqPatronymic'));
    formData.append('department', val('#reqDepartment'));
    formData.append('subjects', subjects);
    formData.append('submitterName', val('#reqSubmitterName'));
    formData.append('submitterContact', val('#reqSubmitterContact'));
    formData.append('notes', val('#reqNotes'));
    if (file) formData.append('photo', file, file.name);

    setFeedback('Отправляем…');
    const res = await API.teacherRequest(formData);
    if (!res.ok) {
      setFeedback(this.teacherRequestErrorText(res), 'error');
      return;
    }
    // Успех: вместо формы — понятное подтверждение (раньше оно пряталось под формой).
    const card = $('#teacherRequestCard');
    if (card) {
      card.innerHTML = html`
        <h3 class="panel-title">Заявка отправлена</h3>
        <p>Спасибо! Модераторы проверят информацию, и учитель появится в каталоге после одобрения.</p>
        <div class="form-actions">
          <button type="button" class="btn outline" id="anotherRequestBtn">Отправить ещё одну</button>
          <a class="btn primary" href="#/">На главную</a>
        </div>`;
      $('#anotherRequestBtn')?.addEventListener('click', ()=>this.viewTeacherRequest());
      card.scrollIntoView({ block: 'center' });
    }
  },

  /* --- списки учителей --- */
  // «Все учителя»: первые 30 с сервера, дальше порциями при прокрутке.
  async listAll(){
    const seq = Router.seq;
    await this.mountNavbar();
    if (Router.isStale(seq)) return;
    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head">
          <h2>Все учителя</h2>
          <a class="link" href="#/">← На главную</a>
        </div>
        <div id="teacherList" class="list"></div>
        <div class="list-footer">
          <span id="listStatus">Загрузка…</span>
          <button id="listRetry" class="btn small outline hidden" type="button">Повторить</button>
          <div id="sentinel" style="height:1px"></div>
        </div>
      </section>`;

    const container = $('#teacherList');
    const status = $('#listStatus');
    const retryBtn = $('#listRetry');
    const sentinel = $('#sentinel');
    const limit = 30;
    let offset = 0, total = Infinity, loading = false, failed = false;

    const loadMore = async () => {
      if (loading || failed || offset >= total || Router.isStale(seq)) return;
      loading = true;
      status.textContent = 'Загрузка…';
      try{
        const { teachers, total: tot } = await API.teachersPage({ limit, offset });
        if (Router.isStale(seq)) return;
        total = Number.isFinite(tot) ? tot : total;
        offset += teachers.length;
        container.insertAdjacentHTML('beforeend', teachers.map(t => this.teacherTile(t, overall(t))).join(''));
        if (!teachers.length) total = offset; // сервер больше ничего не отдаёт
        status.textContent = offset >= total ? (total ? `Это все ${countLabel(total, ['учитель','учителя','учителей'])}` : 'Пока нет учителей') : 'Загрузка…';
      } catch {
        failed = true;
        status.textContent = 'Не удалось загрузить список.';
        retryBtn.classList.remove('hidden');
      } finally {
        loading = false;
      }
    };
    retryBtn.addEventListener('click', ()=>{ failed = false; retryBtn.classList.add('hidden'); loadMore(); });

    const io = new IntersectionObserver((entries)=>{
      if (entries.some(e => e.isIntersecting)) loadMore();
    }, { rootMargin: '300px 0px' });
    io.observe(sentinel);
    App._listObserver = io; // отключим при следующей навигации (см. mountNavbar)
    loadMore();
  },

  async listByCharacteristic(_, key){
    const seq = Router.seq;
    const c = CHARACTERISTICS.find(x=>x.key===key);
    if (!c) { Router.go('/', { replace:true }); return; }
    await this.mountNavbar();
    const all = await this.getTeachers();
    if (Router.isStale(seq)) return;
    if (!all) { this.renderError('Не удалось загрузить список учителей.', ()=>this.listByCharacteristic(_, key)); return; }
    const sorted = this.sortByValueThenAlpha([...all], t=>characteristicAvg(t,key));
    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head">
          <h2>Топ: ${esc(c.name)}</h2>
          <a class="link" href="#/">← На главную</a>
        </div>
        <div class="list">
          ${sorted.map(t => this.teacherTile({ ...t, ratings: { [key]: t.ratings?.[key] } }, characteristicAvg(t,key))).join('') || '<div class="empty">Пока нет учителей</div>'}
        </div>
      </section>`;
  },

  async listByDepartment(_, dept){
    const seq = Router.seq;
    await this.mountNavbar();
    const all = await this.getTeachers();
    if (Router.isStale(seq)) return;
    let name = '';
    try { name = decodeURIComponent(dept); } catch { name = String(dept || ''); }
    if (!all) { this.renderError('Не удалось загрузить список учителей.', ()=>this.listByDepartment(_, dept)); return; }
    const filtered = this.sortByValueThenAlpha(all.filter(t=>t.department===name), t=>overall(t));
    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head">
          <h2>${esc(name)}</h2>
          <a class="link" href="#/">← На главную</a>
        </div>
        ${filtered.length ? html`<p class="page-sub">${countLabel(filtered.length, ['учитель','учителя','учителей'])}</p>` : ''}
        <div class="list">
          ${filtered.map(t => this.teacherTile(t, overall(t))).join('') || '<div class="empty">На этой кафедре пока нет учителей</div>'}
        </div>
      </section>`;
  },

  async listBySearch(_, query){
    const seq = Router.seq;
    await this.mountNavbar();
    let decoded = '';
    try { decoded = decodeURIComponent(query) || ''; } catch { decoded = String(query || ''); }
    const q = normalizeSearchQuery(decoded).trim();
    if (!q) { Router.go('/teachers', { replace:true }); return; }
    const all = await this.getTeachers();
    if (Router.isStale(seq)) return;
    if (!all) { this.renderError('Не удалось выполнить поиск.', ()=>this.listBySearch(_, query)); return; }
    const matched = all.filter(t => matchesQuery(t, q));
    const sorted = this.sortByValueThenAlpha(matched, t=>overall(t));
    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head">
          <h2>Поиск: «${esc(q)}»</h2>
          <a class="link" href="#/">← На главную</a>
        </div>
        <div class="list">
          ${sorted.map(t => this.teacherTile(t, overall(t))).join('') || html`
            <div class="empty-state">
              <p>По запросу «${esc(q)}» никого не нашлось. Проверьте написание — искать можно по имени, фамилии или отчеству в любом порядке.</p>
              <a class="btn outline" href="#/teacher-request">Предложить учителя</a>
            </div>`}
        </div>
      </section>`;
  },

  /* --- правила --- */
  async viewPolicy(){
    const seq = Router.seq;
    await this.mountNavbar();
    if (Router.isStale(seq)) return;
    const effectiveDate = '24 сентября 2026';

    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head end">
          <a class="link" href="#/">← На главную</a>
        </div>

        <div class="prose policy">
          <h1>Правила сообщества, конфиденциальность и отказ от ответственности</h1>
          <p class="muted">Редакция от ${effectiveDate}</p>

          <h2>1. О проекте и отсутствие аффилированности</h2>
          <p>
            Сайт <strong>leto talks</strong> — некоммерческий студенческий проект, созданный исключительно в образовательных и информационных целях.
            Мы <strong>не</strong> являемся официальным ресурсом и <strong>не аффилированы</strong> со школой «Летово», её администрацией, сотрудниками или иными связанными организациями.
            Любые упоминания школы используются исключительно для идентификации предметной области обсуждений.
          </p>

          <h2>2. Пользовательский контент и модерация</h2>
          <p>
            Отзывы и оценки на сайте формируются пользователями и отражают их субъективные мнения. Администрация не может гарантировать
            их достоверность. Отзывы проходят автоматическую проверку, часть из них — ручную модерацию.
          </p>
          <p><strong>Запрещено публиковать:</strong></p>
          <ul>
            <li>брань, обсценную лексику (маты), оскорбления и угрозы;</li>
            <li>клевету, распространение персональных данных без согласия, сведения, нарушающие честь, достоинство и деловую репутацию;</li>
            <li>разжигание ненависти, дискриминацию, шантаж, травлю (буллинг), призывы к противоправным действиям;</li>
            <li>рекламу и спам, вредоносные ссылки, материалы, нарушающие авторские и смежные права.</li>
          </ul>
          <p>
            Мы вправе без предупреждения <strong>скрывать или удалять</strong> сообщения, нарушающие данные правила.
            Отзывы с нецензурной лексикой не публикуются, а после трёх таких попыток за месяц аккаунт блокируется автоматически; за другие нарушения доступ тоже может быть ограничен.
          </p>

          <h2>3. Конфиденциальность</h2>
          <ul>
            <li>Для входа мы храним адрес школьной почты. Другие пользователи его не видят.</li>
            <li>Отзывы публикуются анонимно: остальные видят только купленный в магазине ник или «Аноним». Администраторы видят автора — это нужно для модерации.</li>
            <li>Оценки учителям показываются только в виде средних значений.</li>
            <li>Для защиты от взлома и злоупотреблений сохраняются технические данные входа (IP-адрес, браузер, время) — не дольше 90 дней.</li>
          </ul>

          <h2>4. Отказ от ответственности</h2>
          <p>Вся информация на сайте предоставляется «как есть». Администрация не несёт ответственности за:</p>
          <ul>
            <li>содержание пользовательских отзывов и оценок;</li>
            <li>любой возможный ущерб, причины которого прямо или косвенно связаны с использованием сайта или размещённой на нём информации;</li>
            <li>временные сбои, перерывы в работе, изменение или удаление материалов.</li>
          </ul>
          <p>
            Мнения пользователей могут не совпадать с позицией администрации. При получении надлежащего уведомления о нарушении прав/закона
            мы оперативно рассмотрим обращение и примем необходимые меры.
          </p>

          <h2>5. Порядок уведомления и удаления (Notice &amp; Takedown)</h2>
          <p>
            Если вы считаете, что какой-либо отзыв нарушает закон, ваши права или данные правила, нажмите «Пожаловаться» под ним —
            жалоба сразу уходит модераторам. По остальным вопросам (в том числе если у вас нет аккаунта) пишите в Telegram:
            <a class="link" href="https://t.me/letotalks" target="_blank" rel="noopener">@letotalks</a>. Для ускорения рассмотрения укажите:
          </p>
          <ul>
            <li>основание претензии (например, клевета, нарушение авторских прав, разглашение персональных данных);</li>
            <li>при необходимости — как с вами связаться и подтверждающие сведения.</li>
          </ul>
          <p>Мы обычно рассматриваем обращения в течение <strong>трёх рабочих дней</strong>.</p>

          <h2>6. Фотографии и авторские права</h2>
          <p>
            Изображения на сайте используются в информационных целях. Если вы являетесь правообладателем и считаете,
            что материал использован неправомерно, напишите в Telegram <a class="link" href="https://t.me/letotalks" target="_blank" rel="noopener">@letotalks</a> —
            мы оперативно удалим или заменим изображение.
          </p>

          <h2>7. Изменения документа</h2>
          <p>
            Мы можем обновлять данный документ, чтобы отражать изменения в функциональности или требованиях законодательства.
            Дата актуальной редакции указывается вверху страницы. Продолжая пользоваться сайтом, вы соглашаетесь с обновлённой редакцией.
          </p>
        </div>
      </section>
    `;
  },

  /* --- профиль учителя --- */
  _lastCommentNotice: null,

  async teacherProfile(_, tid){
    const seq = Router.seq;
    const data = await API.teacher(tid);
    if (Router.isStale(seq)) return;
    await this.mountNavbar();
    if (Router.isStale(seq)) return;
    if (!data.ok) {
      if (data._status === 404) {
        $('#app').innerHTML = html`
          <section class="section">
            <div class="empty-state">
              <p>Такого учителя нет в каталоге — возможно, карточку удалили или ссылка неверная.</p>
              <a class="btn outline" href="#/teachers">Все учителя</a>
            </div>
          </section>`;
      } else {
        this.renderError(errorText(data, 'Не удалось загрузить страницу учителя.'), ()=>this.teacherProfile(_, tid));
      }
      return;
    }
    this.renderTeacherProfile(data);
  },

  renderTeacherProfile(t){
    const amAdmin = !!Auth._state._isAdmin;
    const banned = !!Auth._state._isBanned;
    const myRatings = t.myRatings || {};
    const fio = fullName(t);

    $('#app').innerHTML = html`
      <section class="section">
        <div class="profile-head">
          <button id="backBtn" class="btn small outline" type="button">← Назад</button>
          <h2>${esc(fio)}</h2>
        </div>

        <div class="profile">
          <aside class="panel profile-side">
            <div class="portrait-lg"><img src="${escAttr(t.photo||'')}" alt="Фото: ${escAttr(fio)}"></div>
            <dl>
              <dt>Кафедра</dt><dd>${esc(t.department) || '—'}</dd>
              <dt>Предметы</dt><dd>${esc(t.subjects?.join(', ')) || '—'}</dd>
              <dt>Общий рейтинг</dt><dd id="overallRating"></dd>
            </dl>
          </aside>

          <div class="panel">
            <h3 class="panel-title">Оценки по характеристикам</h3>
            <p class="muted small" style="margin:-6px 0 12px">${banned ? 'Оценивать нельзя: аккаунт заблокирован.' : 'Нажмите на звезду — оценка сохранится сразу. Изменить её можно в любой момент.'}</p>
            <div class="char-grid" id="charGrid">
              ${CHARACTERISTICS.map(c => html`
                <div class="char-card" data-key="${c.key}">
                  <h4>${c.name}</h4>
                  <div class="current"></div>
                  <div class="stars ${banned ? 'disabled' : ''}" role="radiogroup" aria-label="${escAttr(c.name)}">
                    ${[5,4,3,2,1].map(v=>html`
                      <input type="radio" id="stars-${c.key}-${v}" name="stars-${c.key}" value="${v}" ${myRatings[c.key] === v ? 'checked' : ''} ${banned ? 'disabled' : ''}>
                      <label for="stars-${c.key}-${v}" title="${v} из 5" aria-label="${v} из 5">★</label>
                    `).join('')}
                  </div>
                  <div class="mine"></div>
                </div>`).join('')}
            </div>

            <div class="hr"></div>

            <div class="comment-box">
              <h3 class="panel-title">Оставить отзыв</h3>
              ${banned
                ? '<div class="notice danger">Ваш аккаунт заблокирован за нарушение правил: отзывы, оценки и лайки недоступны.</div>'
                : html`
                  <div class="field">
                    <textarea id="commentText" class="input" maxlength="${COMMENT_MAX_LEN}" rows="4" placeholder="Как объясняет, как проходят уроки, что понравилось или нет…"></textarea>
                    <div class="field-counter"><span id="commentCount">0</span> / ${COMMENT_MAX_LEN}</div>
                  </div>
                  <div class="form-actions">
                    <span class="muted small">Другие ученики не видят, кто автор, — только ваш ник или «Аноним».</span>
                    <button class="btn primary" id="publishBtn" type="button">Опубликовать</button>
                  </div>`}
              <div id="commentStatus" class="status-msg" role="status" style="margin-top:8px"></div>
            </div>

            <div class="hr"></div>
            <h3 class="panel-title">Отзывы <span class="muted" id="commentsCount"></span></h3>
            <div id="comments" class="comments"></div>
          </div>
        </div>
      </section>`;

    const state = { teacher: t };
    const statusBox = $('#commentStatus');
    const setStatus = (text = '', tone = '') => {
      if (!statusBox) return;
      statusBox.textContent = text || '';
      statusBox.className = `status-msg ${tone}`;
    };
    const notice = this._lastCommentNotice;
    if (notice && notice.teacherId === t.id) setStatus(notice.text, notice.tone);
    this._lastCommentNotice = null;

    // Средние значения и «ваша оценка» — обновляются без перерисовки страницы.
    const renderRatings = () => {
      const cur = state.teacher;
      const my = cur.myRatings || {};
      $('#overallRating').innerHTML = fmtStars(overall(cur)) + (ratersCount(cur) ? html` <span class="rating-count">· ${countLabel(ratersCount(cur), RATING_FORMS)}</span>` : '');
      for (const c of CHARACTERISTICS) {
        const cardEl = $(`.char-card[data-key="${c.key}"]`);
        if (!cardEl) continue;
        const cnt = characteristicCount(cur, c.key);
        cardEl.querySelector('.current').innerHTML = `Средняя: ${fmtStars(characteristicAvg(cur, c.key))}` + (cnt ? html`<span class="rating-count">· ${countLabel(cnt, RATING_FORMS)}</span>` : '');
        cardEl.querySelector('.mine').textContent = my[c.key] ? `Ваша оценка: ${my[c.key]}` : '';
      }
    };

    const renderComments = () => {
      const cur = state.teacher;
      const list = Array.isArray(cur.comments) ? cur.comments : []; // сервер отдаёт новые сверху
      $('#commentsCount').textContent = list.length ? `(${list.length})` : '';
      $('#comments').innerHTML = list.length ? list.map(c => {
        const own = !!c.isOwn;
        return html`
          <div class="comment ${own ? 'own' : ''}" data-cid="${escAttr(c.id)}">
            <div class="meta">
              <span class="author ${c.authorRarity ? `rarity-${esc(c.authorRarity)}` : ''}">${esc(c.authorDisplay || 'Аноним')}</span>
              <span>${fmtDate(c.ts)}</span>
              ${own ? '<span class="badge">Ваш отзыв</span>' : ''}
              ${amAdmin && (c.author_email || c.author_uid) ? html`<span class="badge muted" title="Видно только администраторам">${esc(c.author_email || c.author_uid)}</span>` : ''}
            </div>
            <div class="ctext">${esc(c.text || '')}</div>
            <div class="cactions">
              <button class="iconbtn like ${c.myVote===1?'active':''}" type="button" aria-label="Нравится" aria-pressed="${c.myVote===1}" ${own || banned ? 'disabled' : ''} title="${own ? 'Нельзя голосовать за свой отзыв' : 'Нравится'}">👍 <span class="cnt">${c.likes||0}</span></button>
              <button class="iconbtn dislike ${c.myVote===-1?'active':''}" type="button" aria-label="Не нравится" aria-pressed="${c.myVote===-1}" ${own || banned ? 'disabled' : ''} title="${own ? 'Нельзя голосовать за свой отзыв' : 'Не нравится'}">👎 <span class="cnt">${c.dislikes||0}</span></button>
              <span class="spacer"></span>
              ${own ? '' : '<button class="linkbtn report-btn" type="button">Пожаловаться</button>'}
              ${own || amAdmin ? '<button class="linkbtn danger del-comment" type="button">Удалить</button>' : ''}
            </div>
          </div>`;
      }).join('') : '<div class="empty">Отзывов пока нет — будьте первым.</div>';
    };

    renderRatings();
    renderComments();

    $('#backBtn')?.addEventListener('click', ()=>Router.back());

    // Счётчик символов.
    const textarea = $('#commentText');
    textarea?.addEventListener('input', ()=>{ $('#commentCount').textContent = String(textarea.value.length); });

    // Оценка сохраняется сразу по клику на звезду (раньше выбранные звёзды
    // «висели» неотправленными и могли уйти вместе с чужим отзывом).
    $('#charGrid')?.addEventListener('change', async (e)=>{
      const input = e.target.closest('input[type="radio"]');
      if (!input) return;
      const key = input.name.replace('stars-', '');
      const value = Number(input.value);
      const prev = state.teacher.myRatings?.[key] || 0;
      const mineEl = input.closest('.char-card')?.querySelector('.mine');
      if (mineEl) mineEl.textContent = 'Сохраняем…';
      const res = await API.publish({ teacherId: t.id, ratings: { [key]: value } });
      if (res.ok && res.teacher) {
        state.teacher = { ...res.teacher };
        this.invalidateTeachers();
        renderRatings();
        Auth.refreshStatsAndPopover();
        UI.toast(prev ? 'Оценка обновлена' : 'Оценка сохранена', 'success', 2200);
      } else {
        // Откатываем выбор звезды к сохранённой оценке.
        $$(`input[name="stars-${key}"]`).forEach(r => { r.checked = Number(r.value) === prev; });
        renderRatings();
        if (res.error !== 'banned') UI.toast(errorText(res, 'Не удалось сохранить оценку.'), 'error');
      }
    });

    $('#publishBtn')?.addEventListener('click', (e)=>withBusy(e.currentTarget, async ()=>{
      const text = (textarea?.value || '').trim();
      if (!text) { setStatus('Напишите текст отзыва.', 'error'); textarea?.focus(); return; }
      if (text.length > COMMENT_MAX_LEN) { setStatus(`Слишком длинно: максимум ${COMMENT_MAX_LEN} символов.`, 'error'); return; }
      if (hasProfanity(text)) {
        setStatus('Уберите нецензурные слова: такие отзывы не публикуются, а за повторные попытки аккаунт блокируется.', 'error');
        return;
      }
      setStatus('Отправляем…');
      const res = await API.publish({ teacherId: t.id, text });
      if (res.ok) {
        const teacherPayload = res.teacher && typeof res.teacher === 'object' ? res.teacher : null;
        if (res.moderationUnavailable) {
          setStatus('Не удалось отправить отзыв на проверку — попробуйте позже. Текст сохранён в поле.', 'warn');
          return; // текст не теряем
        }
        if (textarea) { textarea.value = ''; $('#commentCount').textContent = '0'; }
        if (res.pendingReview) setStatus('Отзыв отправлен на проверку модератору и появится после одобрения.', 'warn');
        else { setStatus(''); UI.toast('Отзыв опубликован', 'success'); }
        if (teacherPayload) { state.teacher = teacherPayload; renderRatings(); renderComments(); }
        Auth.refreshStatsAndPopover();
        return;
      }
      const code = res.error;
      if (code === 'rate_limited') {
        const sec = Math.max(1, Math.ceil((res.retry_after_ms ?? 20000) / 1000));
        setStatus(`Слишком часто — подождите ${sec} сек. и отправьте снова.`, 'warn');
      } else if (code === 'comment_blocked') {
        if (res.reason === 'profanity') {
          if (res.banned) {
            setStatus('Аккаунт заблокирован за повторную нецензурную лексику.', 'error');
            Auth.me();
          } else {
            const left = Number(res.strikes_left) || 0;
            setStatus(`Отзыв не опубликован: нецензурная лексика.${left ? ` Ещё ${countLabel(left, ['нарушение','нарушения','нарушений'])} — и аккаунт заблокируют.` : ''}`, 'error');
          }
        } else {
          setStatus('Модерация не пропустила отзыв: похоже на оскорбление. Переформулируйте, пожалуйста.', 'error');
        }
      } else if (code === 'too_long') {
        setStatus(`Слишком длинно: максимум ${COMMENT_MAX_LEN} символов.`, 'error');
      } else if (code !== 'banned') {
        setStatus(errorText(res, 'Не удалось опубликовать отзыв. Попробуйте позже.'), 'error');
      }
    }));

    // Лайки/дизлайки, жалобы, удаление.
    $('#comments')?.addEventListener('click', async (e)=>{
      const commentEl = e.target.closest('.comment');
      const cid = commentEl?.dataset?.cid;
      if (!cid) return;

      const delBtn = e.target.closest('.del-comment');
      if (delBtn) {
        const own = commentEl.classList.contains('own');
        const ok = await UI.confirm({
          title: 'Удалить отзыв?',
          text: own ? 'Отзыв исчезнет насовсем, а монеты за него спишутся.' : 'Отзыв будет удалён без возможности восстановления.',
          confirmText: 'Удалить', danger: true
        });
        if (!ok) return;
        await withBusy(delBtn, async ()=>{
          const res = own ? await API.deleteOwnComment(cid) : await API.adminDeleteComment(cid);
          if (!res.ok) { UI.toast(errorText(res, 'Не удалось удалить отзыв.'), 'error'); return; }
          state.teacher.comments = (state.teacher.comments || []).filter(c => String(c.id) !== String(cid));
          renderComments();
          UI.toast('Отзыв удалён', 'success', 2200);
          Auth.refreshStatsAndPopover();
        });
        return;
      }

      const reportBtn = e.target.closest('.report-btn');
      if (reportBtn) {
        const reason = await UI.prompt({
          title: 'Пожаловаться на отзыв',
          text: 'Опишите, что не так: оскорбление, спам, личные данные… Жалоба уйдёт модераторам.',
          placeholder: 'Причина жалобы', confirmText: 'Отправить', required: true, maxLength: 500
        });
        if (!reason) return;
        await withBusy(reportBtn, async ()=>{
          const res = await API.reportComment(cid, reason);
          if (res.ok) UI.toast('Жалоба отправлена. Спасибо!', 'success');
          else UI.toast(errorText(res, 'Не удалось отправить жалобу.'), 'error');
        });
        return;
      }

      const likeBtn = e.target.closest('.iconbtn.like');
      const dislikeBtn = e.target.closest('.iconbtn.dislike');
      if (!likeBtn && !dislikeBtn) return;
      const btn = likeBtn || dislikeBtn;
      if (btn.disabled) return;
      const vote = btn.classList.contains('active') ? 'none' : (likeBtn ? 'like' : 'dislike');

      // Блокируем обе кнопки на время запроса — защита от двойного голоса.
      const likeEl = commentEl.querySelector('.iconbtn.like');
      const dislikeEl = commentEl.querySelector('.iconbtn.dislike');
      likeEl.disabled = dislikeEl.disabled = true;
      const res = await API.voteComment({ commentId: cid, vote });
      likeEl.disabled = dislikeEl.disabled = false;
      if (res.ok) {
        likeEl.querySelector('.cnt').textContent = res.likes || 0;
        dislikeEl.querySelector('.cnt').textContent = res.dislikes || 0;
        likeEl.classList.toggle('active', res.myVote === 1);
        dislikeEl.classList.toggle('active', res.myVote === -1);
        likeEl.setAttribute('aria-pressed', String(res.myVote === 1));
        dislikeEl.setAttribute('aria-pressed', String(res.myVote === -1));
        const saved = (state.teacher.comments || []).find(c => String(c.id) === String(cid));
        if (saved) Object.assign(saved, { likes: res.likes, dislikes: res.dislikes, myVote: res.myVote });
        Auth.refreshStatsAndPopover();
      } else if (res.error === 'forbidden') {
        UI.toast('Нельзя голосовать за свой отзыв.', 'warn');
      } else if (res.error !== 'banned') {
        UI.toast(errorText(res, 'Не удалось проголосовать.'), 'error');
      }
    });
  },

  /* --- экран входа (на весь экран, без шапки/подвала — body.lockout) --- */
  viewLogin(){
    document.body.classList.add('lockout');
    $('#app').innerHTML = html`
      <section class="login-screen">
        <div class="login-brand" aria-hidden="true">
          <div class="brand-icon">L</div>
          <div class="brand-text">leto<span>talks</span></div>
        </div>
        <div class="panel login-box" id="loginBox">
          <h2>Вход</h2>
          <!-- Шаг 1: почта -->
          <div id="stageEmail">
            <p class="muted">Введите школьную почту <strong>${EMAIL_DOMAIN}</strong> — пришлём на неё 6-значный код. Пароль не нужен.</p>
            <form id="emailForm" novalidate>
              <div class="field">
                <label for="loginEmail">Электронная почта</label>
                <input id="loginEmail" class="input" type="email" autocomplete="email" inputmode="email" placeholder="ivanov.ii${EMAIL_DOMAIN}" required>
              </div>
              <div class="form-actions">
                <button type="submit" id="sendCodeBtn" class="btn primary block">Получить код</button>
              </div>
              <div id="emailStatus" class="status-msg" role="status"></div>
            </form>
          </div>

          <!-- Шаг 2: код -->
          <div id="stageCode" class="hidden">
            <p class="muted" id="codeSentNote">Код отправлен на <strong id="sentToEmail"></strong>. Письмо может прийти через минуту — проверьте и «Спам».</p>
            <p class="muted hidden" id="codeDevNote">Почта не настроена (режим разработки): код для входа выведен в консоль сервера.</p>
            <form id="codeForm" novalidate>
              <div class="field">
                <label for="loginCode">Код из письма</label>
                <input id="loginCode" class="input code-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="••••••" required>
              </div>
              <div class="form-actions">
                <button type="submit" id="verifyBtn" class="btn primary block">Войти</button>
              </div>
              <div id="codeStatus" class="status-msg" role="status"></div>
              <div class="form-actions" style="justify-content:space-between;margin-top:6px">
                <button type="button" id="changeEmailBtn" class="btn small ghost">← Другая почта</button>
                <button type="button" id="resendBtn" class="btn small ghost" disabled>Отправить ещё раз</button>
              </div>
            </form>
          </div>
        </div>
        <a class="link small" href="#/login" id="policyLink">Правила и конфиденциальность</a>
      </section>
    `;

    let sessionId = null;
    let email = '';
    let resendTimer = null;
    const stageEmail = $('#stageEmail');
    const stageCode  = $('#stageCode');
    const emailInput = $('#loginEmail');
    const codeInput  = $('#loginCode');
    const resendBtn  = $('#resendBtn');
    const setStatus = (el, text, tone='')=>{
      if (!el) return;
      el.textContent = text || '';
      el.className = `status-msg ${tone}`;
    };
    const startResendCountdown = (sec = AUTH_CODE_RESEND_SEC) => {
      clearInterval(resendTimer);
      let left = Math.max(1, Math.ceil(sec));
      resendBtn.disabled = true;
      resendBtn.textContent = `Отправить ещё раз (${left})`;
      resendTimer = setInterval(()=>{
        left -= 1;
        if (!resendBtn.isConnected) { clearInterval(resendTimer); return; }
        if (left <= 0) { clearInterval(resendTimer); resendBtn.disabled = false; resendBtn.textContent = 'Отправить ещё раз'; }
        else resendBtn.textContent = `Отправить ещё раз (${left})`;
      }, 1000);
    };
    const showEmailStage = (message = '', tone = '') => {
      clearInterval(resendTimer);
      sessionId = null;
      stageCode.classList.add('hidden');
      stageEmail.classList.remove('hidden');
      if (codeInput) codeInput.value = '';
      setStatus($('#codeStatus'), '');
      setStatus($('#emailStatus'), message, tone);
      emailInput?.focus();
    };

    const requestCode = async (statusEl) => {
      const r = await apiFetch('/api/auth/request', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email })
      });
      if (r.ok) {
        sessionId = r.session_id;
        $('#sentToEmail').textContent = email;
        stageEmail.classList.add('hidden');
        stageCode.classList.remove('hidden');
        $('#codeSentNote').classList.toggle('hidden', !r.email_sent);
        $('#codeDevNote').classList.toggle('hidden', !!r.email_sent);
        setStatus($('#codeStatus'), '');
        startResendCountdown();
        codeInput?.focus();
        return;
      }
      if (r.error === 'code_cooldown') {
        const sec = Math.ceil((r.retry_after_ms || 60000) / 1000);
        if (sessionId) { setStatus(statusEl, `Новый код можно запросить через ${sec} сек.`, 'warn'); startResendCountdown(sec); }
        else setStatus(statusEl, `Код уже отправлен недавно. Новый можно запросить через ${sec} сек.`, 'warn');
        return;
      }
      const messages = {
        invalid_email: 'Введите корректный адрес почты.',
        email_not_allowed: `Вход только с почты ${EMAIL_DOMAIN}.`,
        too_many_codes: 'Слишком много запросов кода для этой почты. Попробуйте через час.',
        too_many_attempts: 'Слишком много неверных попыток. Попробуйте через час.',
        email_send_failed: 'Не удалось отправить письмо. Попробуйте чуть позже.',
      };
      setStatus(statusEl, messages[r.error] || r.message || errorText(r, 'Не удалось отправить код.'), 'error');
    };

    $('#emailForm')?.addEventListener('submit', (e)=>{
      e.preventDefault();
      email = (emailInput?.value || '').trim().toLowerCase();
      const statusEl = $('#emailStatus');
      if (!email) { setStatus(statusEl, 'Введите почту.', 'error'); emailInput?.focus(); return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setStatus(statusEl, 'Введите корректный адрес почты.', 'error'); return; }
      withBusy($('#sendCodeBtn'), async ()=>{
        setStatus(statusEl, 'Отправляем код…');
        await requestCode(statusEl);
      });
    });

    const submitCode = () => withBusy($('#verifyBtn'), async ()=>{
      const code = (codeInput?.value || '').replace(/\D/g, '');
      const statusEl = $('#codeStatus');
      if (code.length !== 6) { setStatus(statusEl, 'Код состоит из 6 цифр.', 'error'); codeInput?.focus(); return; }
      setStatus(statusEl, 'Проверяем…');
      const r = await apiFetch('/api/auth/verify', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ session_id: sessionId, code })
      });
      if (r.ok){
        clearInterval(resendTimer);
        Auth.applyUser(r.user);
        Router.go(Router.takeReturnTo() || '/', { replace:true });
        return;
      }
      if (r.error === 'invalid_code') {
        const left = Number(r.tries_left);
        setStatus(statusEl, Number.isFinite(left) && left > 0 ? `Неверный код. Осталось попыток: ${left}.` : 'Неверный код.', 'error');
        codeInput?.select();
      } else if (r.error === 'expired' || r.error === 'no_auth_session' || r.error === 'too_many_attempts') {
        showEmailStage(r.error === 'too_many_attempts'
          ? 'Слишком много неверных попыток — запросите новый код.'
          : 'Код больше не действует — запросите новый.', 'warn');
      } else {
        setStatus(statusEl, errorText(r, 'Не удалось войти. Попробуйте ещё раз.'), 'error');
      }
    });
    $('#codeForm')?.addEventListener('submit', (e)=>{ e.preventDefault(); submitCode(); });
    // Ввели 6 цифр — входим сразу (и при вставке из буфера).
    codeInput?.addEventListener('input', ()=>{
      const digits = codeInput.value.replace(/\D/g, '').slice(0, 6);
      if (codeInput.value !== digits) codeInput.value = digits;
      if (digits.length === 6) submitCode();
    });

    resendBtn?.addEventListener('click', ()=>withBusy(resendBtn, async ()=>{
      setStatus($('#codeStatus'), 'Отправляем новый код…');
      await requestCode($('#codeStatus'));
    }));
    $('#changeEmailBtn')?.addEventListener('click', ()=>showEmailStage());
    // Правила доступны и без входа — открываем их в модальном окне-просмотре.
    $('#policyLink')?.addEventListener('click', (e)=>{
      e.preventDefault();
      UI.confirm({
        title: 'Коротко о правилах',
        text: 'Отзывы анонимны для других учеников, администраторы видят автора для модерации. Запрещены мат, оскорбления, травля и личные данные — за повторный мат аккаунт блокируется автоматически. Полный текст правил — в подвале сайта после входа. Связь с нами: Telegram @letotalks.',
        confirmText: 'Понятно', cancelText: 'Закрыть'
      });
    });
    emailInput?.focus();
  },

  /* --- админ-панель --- */
  async ensureAdmin(){
    const seq = Router.seq;
    await this.mountNavbar();
    if (Router.isStale(seq)) return false;
    if (!Auth.isLogged() || !Auth._state._isAdmin) {
      $('#app').innerHTML = `<section class="section"><div class="empty-state"><p>Этот раздел доступен только администраторам.</p><a class="btn outline" href="#/">На главную</a></div></section>`;
      return false;
    }
    return true;
  },

  adminTabs(active){
    const tabs = [
      { id:'moderation', title:'Отзывы', route:'/admin/moderation' },
      { id:'bans', title:'Блокировки', route:'/admin/bans' },
      { id:'teachers', title:'Учителя', route:'/admin/teachers' }
    ];
    if (Auth._state._isSuperAdmin) tabs.push({ id:'admins', title:'Администраторы', route:'/admin/admins' });
    return html`<nav class="admin-tabs" aria-label="Разделы админки">${tabs.map(t=>html`<a class="admin-tab ${active===t.id?'active':''}" href="#${t.route}" ${active===t.id?'aria-current="page"':''}>${t.title}</a>`).join('')}</nav>`;
  },

  async viewAdminHome(){
    if (!(await this.ensureAdmin())) return;
    const cards = [
      { title:'Отзывы', text:'Свежие отзывы и отзывы по авторам, удаление нарушений.', route:'/admin/moderation' },
      { title:'Блокировки', text:'Блокировка и разблокировка пользователей. Заблокированный не может писать, оценивать и голосовать.', route:'/admin/bans' },
      { title:'Учителя', text:'Добавление, редактирование и удаление карточек учителей, загрузка фото.', route:'/admin/teachers' },
    ];
    if (Auth._state._isSuperAdmin) cards.push({ title:'Администраторы', text:'Выдача и снятие прав администратора.', route:'/admin/admins' });
    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head">
          <h2>Админ-панель</h2>
          <a class="link" href="#/">← На главную</a>
        </div>
        <div class="admin-dashboard">
          ${cards.map(c => html`
            <div class="panel admin-card">
              <h3>${c.title}</h3>
              <p>${c.text}</p>
              <a class="btn primary small" href="#${c.route}">Открыть</a>
            </div>`).join('')}
        </div>
      </section>
    `;
  },

  async viewAdminModeration(){
    const seq = Router.seq;
    if (!(await this.ensureAdmin())) return;
    const mode = (location.hash.split('?')[1] || '').includes('by=author') ? 'authors' : 'recent';

    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head">
          <h2>Отзывы</h2>
          <a class="link" href="#/admin">← Админ-панель</a>
        </div>
        ${this.adminTabs('moderation')}
        <div class="admin-toolbar">
          <a class="btn small ${mode==='recent'?'primary':'outline'}" href="#/admin/moderation">Свежие</a>
          <a class="btn small ${mode==='authors'?'primary':'outline'}" href="#/admin/moderation?by=author">По авторам</a>
        </div>
        <div id="moderationBody"><div class="muted">Загрузка…</div></div>
      </section>
    `;
    const body = $('#moderationBody');

    const commentCard = (c, { showTeacher = true, showAuthor = true } = {}) => html`
      <div class="comment" data-comment-id="${escAttr(c.id)}">
        <div class="meta">
          <span>${fmtDate(c.ts)}</span>
          ${showTeacher ? html`<a class="link" href="#/teacher/${encodeURIComponent(c.teacherId)}">${esc(c.teacher_name || c.teacherId)}</a>` : ''}
          ${showAuthor && c.author_email ? html`<span class="badge muted">${esc(c.author_email)}</span>` : ''}
        </div>
        <div class="ctext">${esc(c.text||'')}</div>
        <div class="cactions"><span class="spacer"></span><button class="btn small danger" type="button" data-del-cid="${escAttr(c.id)}">Удалить</button></div>
      </div>`;

    const deleteComment = async (btn, cid, onDone) => {
      const ok = await UI.confirm({ title:'Удалить отзыв?', text:'Отзыв будет удалён без возможности восстановления, монеты автора за него спишутся.', confirmText:'Удалить', danger:true });
      if (!ok) return;
      await withBusy(btn, async ()=>{
        const resp = await API.adminDeleteComment(cid);
        if (!resp.ok) { UI.toast(errorText(resp, 'Не удалось удалить отзыв.'), 'error'); return; }
        UI.toast('Отзыв удалён', 'success', 2200);
        onDone();
      });
    };

    if (mode === 'recent') {
      const r = await API.adminRecentComments(100);
      if (Router.isStale(seq)) return;
      if (!r.ok) { body.innerHTML = `<div class="empty">${esc(errorText(r, 'Не удалось загрузить отзывы.'))}</div>`; return; }
      let comments = Array.isArray(r.comments) ? r.comments : [];
      const render = () => {
        body.innerHTML = comments.length
          ? html`<div class="comments">${comments.map(c => commentCard(c)).join('')}</div>`
          : '<div class="empty">Отзывов пока нет.</div>';
      };
      render();
      body.addEventListener('click', (e)=>{
        const btn = e.target.closest('[data-del-cid]');
        if (!btn) return;
        const cid = btn.getAttribute('data-del-cid');
        deleteComment(btn, cid, ()=>{ comments = comments.filter(c => String(c.id) !== String(cid)); render(); });
      });
      return;
    }

    // Режим «по авторам».
    const r = await API.adminCommenters();
    if (Router.isStale(seq)) return;
    let commenters = r.ok ? (r.users || []) : [];
    body.innerHTML = html`
      <div class="admin-split">
        <div class="panel admin-pane">
          <input id="commenterFilter" class="input" type="search" placeholder="Фильтр по почте" aria-label="Фильтр по почте">
          <div id="commenterList" class="admin-list"></div>
        </div>
        <div class="panel admin-pane" id="commenterDetail">
          <div class="empty">Выберите автора, чтобы увидеть его отзывы.</div>
        </div>
      </div>`;
    if (!r.ok) $('#commenterList').innerHTML = `<div class="empty">${esc(errorText(r, 'Не удалось загрузить авторов.'))}</div>`;

    const listEl = $('#commenterList');
    const detailEl = $('#commenterDetail');
    const commentCache = new Map();
    let activeUserId = null;
    let filter = '';
    let loadSeq = 0;

    const renderList = () => {
      if (!r.ok) return;
      const shown = commenters.filter(u => !filter || String(u.email || u.username || '').toLowerCase().includes(filter));
      listEl.innerHTML = shown.length ? shown.map(u=>html`
        <button type="button" class="admin-list-item ${u.id===activeUserId?'active':''}" data-user="${escAttr(u.id)}">
          <span class="admin-list-primary">${esc(u.email || u.username || u.id)}</span>
          <span class="admin-list-meta">${countLabel(u.comment_count, COMMENT_FORMS)}${u.is_banned ? ' · <span class="badge danger">заблокирован</span>' : ''}</span>
        </button>`).join('') : '<div class="empty">Никого не найдено</div>';
    };
    const renderDetail = () => {
      if (!activeUserId) { detailEl.innerHTML = '<div class="empty">Выберите автора, чтобы увидеть его отзывы.</div>'; return; }
      const comments = commentCache.get(activeUserId);
      const selected = commenters.find(u=>u.id===activeUserId) || {};
      if (!comments) { detailEl.innerHTML = '<div class="muted">Загружаем отзывы…</div>'; return; }
      detailEl.innerHTML = html`
        <div class="admin-detail-head">
          <div>
            <div class="tname">${esc(selected.email || selected.username || selected.id || '—')}</div>
            <div class="muted small">${countLabel(comments.length, COMMENT_FORMS)}</div>
          </div>
          ${selected.is_banned ? '<span class="badge danger">заблокирован</span>' : '<a class="btn small outline" href="#/admin/bans">Блокировки</a>'}
        </div>
        <div class="comments">
          ${comments.length ? comments.map(c => commentCard(c, { showAuthor:false })).join('') : '<div class="empty">Отзывов нет</div>'}
        </div>`;
    };
    renderList();

    $('#commenterFilter')?.addEventListener('input', (e)=>{ filter = e.target.value.trim().toLowerCase(); renderList(); });
    listEl.addEventListener('click', async (e)=>{
      const btn = e.target.closest('[data-user]');
      if (!btn) return;
      const uid = btn.getAttribute('data-user');
      activeUserId = uid;
      renderList();
      renderDetail();
      if (commentCache.has(uid)) return;
      const mySeq = ++loadSeq;
      const resp = await API.adminCommentsByUser(uid);
      commentCache.set(uid, resp.ok ? (resp.comments || []) : []);
      if (mySeq === loadSeq && activeUserId === uid) renderDetail(); // быстрый клик по другому автору — не мигаем
    });
    detailEl.addEventListener('click', (e)=>{
      const btn = e.target.closest('[data-del-cid]');
      if (!btn) return;
      const cid = btn.getAttribute('data-del-cid');
      deleteComment(btn, cid, ()=>{
        const arr = (commentCache.get(activeUserId) || []).filter(c => String(c.id) !== String(cid));
        commentCache.set(activeUserId, arr);
        const entry = commenters.find(u=>u.id===activeUserId);
        if (entry) entry.comment_count = arr.length;
        if (!arr.length) { commenters = commenters.filter(u => u.id !== activeUserId); activeUserId = null; }
        renderList();
        renderDetail();
      });
    });
  },

  async viewAdminBans(){
    const seq = Router.seq;
    if (!(await this.ensureAdmin())) return;
    const r = await API.adminUsers();
    if (Router.isStale(seq)) return;
    const users = r.ok ? (r.users || []) : [];

    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head">
          <h2>Блокировки</h2>
          <a class="link" href="#/admin">← Админ-панель</a>
        </div>
        ${this.adminTabs('bans')}
        <p class="page-sub">Заблокированный пользователь не может публиковать отзывы, ставить оценки и лайки.</p>
        <div class="admin-toolbar">
          <input id="userFilter" class="input" type="search" placeholder="Поиск по почте" aria-label="Поиск по почте">
        </div>
        ${r.ok ? '' : html`<div class="notice danger">${esc(errorText(r, 'Не удалось загрузить пользователей.'))}</div>`}
        <div class="admin-columns">
          <div class="panel admin-pane">
            <h3 class="panel-title">Активные <span class="muted" id="allowedCount"></span></h3>
            <div id="adminUsersAllowed" class="admin-list"></div>
          </div>
          <div class="panel admin-pane">
            <h3 class="panel-title">Заблокированы <span class="muted" id="bannedCount"></span></h3>
            <div id="adminUsersBanned" class="admin-list"></div>
          </div>
        </div>
      </section>
    `;

    const myId = Auth._state.id;
    let filter = '';
    const renderColumns = () => {
      const shown = users.filter(u => !filter || String(u.email || u.username || '').toLowerCase().includes(filter));
      const allowed = shown.filter(u=>!u.is_banned);
      const banned = shown.filter(u=>u.is_banned);
      const card = (u, action) => html`
        <div class="admin-user-card">
          <div class="who">
            <div class="admin-list-primary">${esc(u.email || u.username || u.id)}${u.id === myId ? ' <span class="badge">вы</span>' : ''}</div>
            <div class="admin-list-meta">${countLabel(u.comment_count || 0, COMMENT_FORMS)} · ${countLabel(u.rating_count || 0, RATING_FORMS)}</div>
          </div>
          ${u.id === myId ? '' : html`<button class="btn small ${action==='ban'?'danger':'outline'}" type="button" data-user="${escAttr(u.id)}" data-action="${action}">${action==='ban'?'Заблокировать':'Разблокировать'}</button>`}
        </div>`;
      $('#adminUsersAllowed').innerHTML = allowed.length ? allowed.map(u => card(u, 'ban')).join('') : '<div class="empty">Нет пользователей</div>';
      $('#adminUsersBanned').innerHTML = banned.length ? banned.map(u => card(u, 'unban')).join('') : '<div class="empty">Никто не заблокирован</div>';
      $('#allowedCount').textContent = `(${allowed.length})`;
      $('#bannedCount').textContent = `(${banned.length})`;
    };
    renderColumns();
    $('#userFilter')?.addEventListener('input', (e)=>{ filter = e.target.value.trim().toLowerCase(); renderColumns(); });

    $('#app').querySelector('.admin-columns')?.addEventListener('click', async (e)=>{
      const btn = e.target.closest('[data-user][data-action]');
      if (!btn) return;
      const id = btn.getAttribute('data-user');
      const willBan = btn.getAttribute('data-action') === 'ban';
      const user = users.find(u=>u.id===id);
      let reason = '';
      if (willBan) {
        // Отмена в диалоге = отмена блокировки (раньше Cancel всё равно банил).
        const answer = await UI.prompt({
          title: `Заблокировать ${user?.email || 'пользователя'}?`,
          text: 'Причина увидят только администраторы (необязательно).',
          placeholder: 'Например: оскорбления в отзывах', confirmText: 'Заблокировать', danger: true, maxLength: 300
        });
        if (answer === null) return;
        reason = answer;
      }
      await withBusy(btn, async ()=>{
        const resp = await API.adminBanUser({ userId: id, banned: willBan, reason });
        if (!resp.ok) {
          const msg = {
            cannot_ban_self: 'Нельзя заблокировать самого себя.',
            cannot_ban_root: 'Главного администратора заблокировать нельзя.',
            cannot_ban_admin: 'Администратора может заблокировать только главный администратор.',
          }[resp.error];
          UI.toast(msg || errorText(resp, 'Не удалось изменить статус пользователя.'), 'error');
          return;
        }
        if (user) user.is_banned = willBan;
        UI.toast(willBan ? 'Пользователь заблокирован' : 'Пользователь разблокирован', 'success', 2200);
        renderColumns();
      });
    });
  },

  async viewAdminAdmins(){
    if (!(await this.ensureAdmin())) return;
    if (!Auth._state._isSuperAdmin) {
      $('#app').innerHTML = `<section class="section"><div class="empty-state"><p>Управлять администраторами может только главный администратор.</p><a class="btn outline" href="#/admin">Админ-панель</a></div></section>`;
      return;
    }

    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head">
          <h2>Администраторы</h2>
          <a class="link" href="#/admin">← Админ-панель</a>
        </div>
        ${this.adminTabs('admins')}
        <div class="panel">
          <h3 class="panel-title">Добавить администратора</h3>
          <form id="adminAddForm" class="form-actions" novalidate>
            <input type="email" id="adminAddEmail" class="input" placeholder="ivanov.ii${EMAIL_DOMAIN}" required autocomplete="off" style="flex:1;min-width:220px" aria-label="Почта нового администратора">
            <button class="btn primary" type="submit" id="adminAddBtn">Добавить</button>
          </form>
          <p class="muted small" style="margin:10px 0 0">Можно добавлять только адреса ${EMAIL_DOMAIN}. Администратор получает доступ к модерации, блокировкам и базе учителей.</p>
          <div class="status-msg" id="adminAdminsStatus" role="status" style="margin-top:6px"></div>
        </div>
        <div class="panel flush" style="margin-top:16px">
          <table class="table">
            <thead><tr><th>Почта</th><th>Роль</th><th class="actions">Действия</th></tr></thead>
            <tbody id="adminAdminsBody"><tr><td colspan="3"><div class="empty">Загрузка…</div></td></tr></tbody>
          </table>
        </div>
      </section>
    `;

    const statusEl = $('#adminAdminsStatus');
    const listBody = $('#adminAdminsBody');
    const addInput = $('#adminAddEmail');
    let admins = [];
    const setStatus = (message, tone = '') => { statusEl.textContent = message || ''; statusEl.className = `status-msg ${tone}`; };
    const renderList = () => {
      listBody.innerHTML = admins.length ? admins.map(a => html`
        <tr>
          <td>${esc(a.email)}</td>
          <td>${a.isRoot ? 'Главный администратор' : 'Администратор'}</td>
          <td class="actions">${a.isRoot ? '<span class="muted small">Нельзя удалить</span>' : html`<button class="btn small danger" type="button" data-email="${escAttr(a.email)}">Снять права</button>`}</td>
        </tr>`).join('') : '<tr><td colspan="3"><div class="empty">Список пуст</div></td></tr>';
    };

    const resp = await API.adminListAdmins();
    if (resp.ok) { admins = Array.isArray(resp.admins) ? resp.admins : []; renderList(); }
    else { setStatus(errorText(resp, 'Не удалось загрузить список администраторов.'), 'error'); listBody.innerHTML = '<tr><td colspan="3"><div class="empty">Ошибка загрузки</div></td></tr>'; }

    $('#adminAddForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = (addInput?.value || '').trim().toLowerCase();
      if (!email) { setStatus('Введите почту.', 'error'); addInput?.focus(); return; }
      withBusy($('#adminAddBtn'), async ()=>{
        setStatus('Добавляем…');
        const r = await API.adminAddAdmin(email);
        if (!r.ok) {
          const msg = { invalid_domain: `Можно добавлять только адреса ${EMAIL_DOMAIN}.`, invalid_email: 'Неверный адрес почты.' }[r.error];
          setStatus(msg || errorText(r, 'Не удалось добавить администратора.'), 'error');
          return;
        }
        admins = Array.isArray(r.admins) ? r.admins : [];
        renderList();
        setStatus(`${email} теперь администратор.`, 'success');
        if (addInput) addInput.value = '';
      });
    });

    listBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-email]');
      if (!btn) return;
      const email = btn.getAttribute('data-email');
      const ok = await UI.confirm({ title:'Снять права администратора?', text: email, confirmText:'Снять права', danger:true });
      if (!ok) return;
      await withBusy(btn, async ()=>{
        const r = await API.adminRemoveAdmin(email);
        if (!r.ok) {
          setStatus(r.error === 'cannot_remove_root' ? 'Главного администратора удалить нельзя.' : errorText(r, 'Не удалось снять права.'), 'error');
          return;
        }
        admins = Array.isArray(r.admins) ? r.admins : [];
        renderList();
        setStatus(`Права администратора для ${email} сняты.`, 'success');
      });
    });
  },

  async viewAdminTeachersList(){
    const seq = Router.seq;
    if (!(await this.ensureAdmin())) return;
    const r = await API.adminTeachers();
    if (Router.isStale(seq)) return;
    let teachers = r.ok ? (r.teachers || []) : [];

    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head">
          <h2>Учителя</h2>
          <a class="link" href="#/admin">← Админ-панель</a>
        </div>
        ${this.adminTabs('teachers')}
        <div class="admin-toolbar">
          <input id="teacherFilter" class="input" type="search" placeholder="Поиск по ФИО, кафедре или ID" aria-label="Поиск учителя">
          <a class="btn primary" href="#/admin/teachers/new">+ Добавить учителя</a>
          <span class="muted small" id="teacherCount"></span>
        </div>
        ${r.ok ? '' : html`<div class="notice danger">${esc(errorText(r, 'Не удалось загрузить учителей.'))}</div>`}
        <div class="panel flush">
          <table class="table">
            <thead><tr><th></th><th>ФИО</th><th>Кафедра</th><th>Предметы</th><th class="actions">Действия</th></tr></thead>
            <tbody id="teachersTableBody"></tbody>
          </table>
        </div>
      </section>
    `;

    const tbody = $('#teachersTableBody');
    let filter = '';
    const renderRows = () => {
      const shown = teachers.filter(t => !filter || matchesQuery(t, filter) || normName(t.department).includes(normName(filter)) || String(t.id).includes(filter));
      $('#teacherCount').textContent = countLabel(shown.length, ['учитель','учителя','учителей']);
      tbody.innerHTML = shown.length ? shown.map(t=>html`
        <tr>
          <td style="width:52px"><div class="portrait" style="width:36px"><img src="${escAttr(t.photo || '')}" alt="" loading="lazy"></div></td>
          <td><a class="link" href="#/teacher/${encodeURIComponent(t.id)}">${esc(fullName(t))}</a><div class="mono">${esc(t.id)}</div></td>
          <td>${esc(t.department||'')}</td>
          <td>${esc((t.subjects||[]).join(', '))}</td>
          <td class="actions">
            <a class="btn small outline" href="#/admin/teachers/edit/${encodeURIComponent(t.id)}">Изменить</a>
            <button class="btn small danger" type="button" data-delete="${escAttr(t.id)}">Удалить</button>
          </td>
        </tr>`).join('') : '<tr><td colspan="5"><div class="empty">Никого не найдено</div></td></tr>';
    };
    renderRows();
    $('#teacherFilter')?.addEventListener('input', (e)=>{ filter = e.target.value.trim(); renderRows(); });

    tbody.addEventListener('click', async (e)=>{
      const del = e.target.closest('[data-delete]');
      if (!del) return;
      const id = del.getAttribute('data-delete');
      const t = teachers.find(x => x.id === id);
      const ok = await UI.confirm({
        title: `Удалить карточку «${t ? fullName(t) : id}»?`,
        text: 'Вместе с ней удалятся все отзывы и оценки этого учителя. Действие необратимо.',
        confirmText: 'Удалить', danger: true
      });
      if (!ok) return;
      await withBusy(del, async ()=>{
        const resp = await API.adminDeleteTeacher(id);
        if (!resp.ok) { UI.toast(errorText(resp, 'Не удалось удалить учителя.'), 'error'); return; }
        this.invalidateTeachers();
        departmentsCache.list = null;
        teachers = teachers.filter(x=>x.id!==id);
        renderRows();
        UI.toast('Карточка удалена', 'success', 2200);
      });
    });
  },

  renderTeacherForm({ teacher={}, isNew=false, departments=[] }){
    const subjects = Array.isArray(teacher.subjects) ? teacher.subjects : [];
    const photo = String(teacher.photo || '').replace(/^\/?photos?\//,'');
    const photoValue = photo === 'default_photo.png' ? '' : photo;
    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head">
          <h2>${isNew ? 'Новый учитель' : 'Редактирование'}</h2>
          <a class="link" href="#/admin/teachers">← К списку</a>
        </div>
        ${this.adminTabs('teachers')}
        <form class="panel roomy form-stack" id="teacherForm" novalidate>
          <div class="form-grid">
            <div class="field">
              <label for="teacherLastName">Фамилия*</label>
              <input id="teacherLastName" class="input" required maxlength="120" value="${escAttr(teacher.lastName||'')}">
            </div>
            <div class="field">
              <label for="teacherFirstName">Имя*</label>
              <input id="teacherFirstName" class="input" required maxlength="120" value="${escAttr(teacher.firstName||'')}">
            </div>
            <div class="field">
              <label for="teacherPatronymic">Отчество</label>
              <input id="teacherPatronymic" class="input" maxlength="120" value="${escAttr(teacher.patronymic||'')}">
            </div>
            <div class="field">
              <label for="teacherDepartment">Кафедра*</label>
              <input id="teacherDepartment" class="input" required maxlength="160" list="departmentOptions" value="${escAttr(teacher.department||'')}" autocomplete="off">
              <datalist id="departmentOptions">${departments.map(d => html`<option value="${escAttr(d)}"></option>`).join('')}</datalist>
              <div class="field-hint">Выберите из списка; новое название создаст новую кафедру.</div>
            </div>
            <div class="field">
              <label for="teacherSubjects">Предметы</label>
              <input id="teacherSubjects" class="input" maxlength="240" value="${escAttr(subjects.join(', '))}" placeholder="Алгебра, геометрия">
              <div class="field-hint">Через запятую.</div>
            </div>
            <div class="field">
              <label for="teacherId">ID (адрес страницы)</label>
              <input id="teacherId" class="input" maxlength="100" value="${escAttr(teacher.id||'')}" ${isNew ? 'placeholder="сгенерируется из ФИО"' : 'readonly'}>
              <div class="field-hint">${isNew ? 'Можно оставить пустым. Формат: t-familiya-imya.' : 'ID существующего учителя не меняется.'}</div>
            </div>
          </div>
          <div class="field">
            <label for="teacherPhotoFile">Фото</label>
            <div class="row" style="align-items:flex-start;flex-wrap:wrap">
              <div class="portrait" style="width:90px"><img id="teacherPhotoPreview" src="${escAttr(teacher.photo || '/photo/default_photo.png')}" alt=""></div>
              <div style="flex:1;min-width:220px" class="form-stack">
                <input id="teacherPhotoFile" class="input" type="file" accept="image/jpeg,image/png,image/webp">
                <input id="teacherPhoto" class="input" maxlength="300" value="${escAttr(photoValue)}" placeholder="или имя файла в папке photos / ссылка https://…" aria-label="Имя файла фото">
                <div class="field-hint">JPG, PNG или WebP до 5 МБ. Пусто — стандартная заглушка.</div>
              </div>
            </div>
          </div>
          <div class="form-actions">
            <button id="teacherFormSave" class="btn primary" type="submit">${isNew ? 'Добавить' : 'Сохранить'}</button>
            <a class="btn outline" href="#/admin/teachers">Отмена</a>
          </div>
          <div class="status-msg" id="teacherFormStatus" role="status"></div>
        </form>
      </section>
    `;

    const statusEl = $('#teacherFormStatus');
    const setStatus = (text, tone = '') => { statusEl.textContent = text || ''; statusEl.className = `status-msg ${tone}`; };
    const photoInput = $('#teacherPhoto');
    const preview = $('#teacherPhotoPreview');
    const photoSrc = v => !v ? '/photo/default_photo.png' : (/^https?:\/\//i.test(v) ? v : `/photo/${encodeURIComponent(v)}`);
    photoInput?.addEventListener('change', ()=>{ preview.src = photoSrc(photoInput.value.trim()); });

    $('#teacherPhotoFile')?.addEventListener('change', async (e)=>{
      const file = e.target.files?.[0];
      if (!file) return;
      if (!['image/jpeg','image/png','image/webp'].includes(file.type)) { setStatus('Фото должно быть JPG, PNG или WebP.', 'error'); return; }
      if (file.size > 5 * 1024 * 1024) { setStatus('Фото больше 5 МБ.', 'error'); return; }
      const fd = new FormData();
      fd.append('photo', file, file.name);
      setStatus('Загружаем фото…');
      const res = await API.adminUploadTeacherPhoto(fd);
      if (!res.ok || !res.file) {
        const msg = { photo_too_large: 'Фото больше 5 МБ.', unsupported_photo_type: 'Фото должно быть JPG, PNG или WebP.' }[res.error];
        setStatus(msg || errorText(res, 'Не удалось загрузить фото.'), 'error');
        return;
      }
      photoInput.value = res.file;
      preview.src = photoSrc(res.file);
      setStatus('Фото загружено — не забудьте сохранить карточку.', 'success');
    });

    $('#teacherForm')?.addEventListener('submit', (e)=>{
      e.preventDefault();
      const form = e.currentTarget;
      if (!form.reportValidity()) return;
      const payload = {
        id: isNew ? String($('#teacherId').value||'').trim() : teacher.id,
        lastName: $('#teacherLastName').value.trim(),
        firstName: $('#teacherFirstName').value.trim(),
        patronymic: $('#teacherPatronymic').value.trim(),
        department: $('#teacherDepartment').value.trim(),
        subjects: String($('#teacherSubjects').value||'').split(/[,|]/).map(s=>s.trim()).filter(Boolean),
        photo: photoInput.value.trim()
      };
      withBusy($('#teacherFormSave'), async ()=>{
        setStatus('Сохраняем…');
        const resp = await API.adminUpsertTeacher(payload);
        if (!resp.ok) {
          const msg = {
            missing_name: 'Укажите фамилию и имя.',
            missing_department: 'Укажите кафедру.',
            invalid_id: 'ID должен начинаться с «t» и содержать только латиницу, цифры, «-» и «_».',
            photo_not_found: 'Файл фото не найден в папке photos. Загрузите фото кнопкой выше.',
          }[resp.error];
          setStatus(msg || errorText(resp, 'Не удалось сохранить.'), 'error');
          return;
        }
        this.invalidateTeachers();
        departmentsCache.list = null;
        UI.toast(isNew ? 'Учитель добавлен' : 'Изменения сохранены', 'success');
        Router.go('/admin/teachers');
      });
    });
  },

  async viewAdminTeacherNew(){
    const seq = Router.seq;
    if (!(await this.ensureAdmin())) return;
    const departments = await this.getDepartments();
    if (Router.isStale(seq)) return;
    this.renderTeacherForm({ teacher:{}, isNew:true, departments });
  },

  async viewAdminTeacherEdit(_, encodedId){
    const seq = Router.seq;
    if (!(await this.ensureAdmin())) return;
    let teacherId = '';
    try { teacherId = decodeURIComponent(encodedId); } catch { teacherId = String(encodedId || ''); }
    const [r, departments] = await Promise.all([API.adminTeachers(), this.getDepartments()]);
    if (Router.isStale(seq)) return;
    const teacher = r.ok ? ((r.teachers || []).find(t=>t.id===teacherId) || null) : null;
    if (!teacher) {
      $('#app').innerHTML = html`
        <section class="section">
          <div class="page-head">
            <h2>Учителя</h2>
            <a class="link" href="#/admin/teachers">← К списку</a>
          </div>
          ${this.adminTabs('teachers')}
          <div class="empty-state"><p>${r.ok ? html`Учитель с ID «${esc(teacherId)}» не найден.` : esc(errorText(r, 'Не удалось загрузить данные.'))}</p></div>
        </section>`;
      return;
    }
    this.renderTeacherForm({ teacher, isNew:false, departments });
  },

  /* --- магазин ников --- */
  normalizeShopState(raw) {
    const src = raw && typeof raw === 'object' ? (raw.shop ?? raw) : null;
    if (!src || !Array.isArray(src.items)) return null;
    const toNum = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
    return {
      items: src.items,
      balance: toNum(src.balance ?? src.available_coins, toNum(Auth._state.available_coins, 0)),
      earnedCoins: toNum(src.earnedCoins ?? src.earned_coins, toNum(Auth._state.earned_coins, 0)),
      spentCoins: toNum(src.spentCoins ?? src.spent_coins, toNum(Auth._state.spent_coins, 0)),
      activeNickname: src.activeNickname || src.active_nickname || null
    };
  },

  applyShopStateToAuth(shopState) {
    if (!shopState) return;
    const baseDisplay = Auth._state.username || (Auth._state.email ? Auth._state.email.split('@')[0] : '') || 'Student';
    Auth.set({
      available_coins: Number(shopState.balance ?? Auth._state.available_coins),
      earned_coins: Number(shopState.earnedCoins ?? Auth._state.earned_coins),
      spent_coins: Number(shopState.spentCoins ?? Auth._state.spent_coins),
      display_name: shopState.activeNickname || baseDisplay
    });
  },

  async viewShop(options = {}) {
    const seq = Router.seq;
    await this.mountNavbar();
    if (Router.isStale(seq)) return;

    if (Auth._state._isBanned) {
      $('#app').innerHTML = html`
        <section class="section">
          <div class="page-head"><h2>Магазин ников</h2><a class="link" href="#/">← На главную</a></div>
          <div class="notice danger">Магазин недоступен: аккаунт заблокирован за нарушение правил.</div>
        </section>`;
      return;
    }

    let shopData = this.normalizeShopState(options.prefetched);
    if (!shopData) {
      const data = await apiFetch('/api/shop/items');
      if (Router.isStale(seq)) return;
      shopData = data.ok ? this.normalizeShopState(data) : null;
      if (!shopData) { this.renderError(errorText(data, 'Не удалось загрузить магазин.'), ()=>this.viewShop()); return; }
    }
    this.applyShopStateToAuth(shopData);

    const itemButton = (item) => {
      if (item.purchased) {
        return item.isActive
          ? html`<button class="btn small outline block deactivate-btn" type="button" data-item="${escAttr(item.id)}">Снять ник</button>`
          : html`<button class="btn small primary block activate-btn" type="button" data-item="${escAttr(item.id)}">Выбрать</button>`;
      }
      if (shopData.balance >= item.price) {
        return html`<button class="btn small primary block buy-btn" type="button" data-item="${escAttr(item.id)}">Купить за ${Number(item.price)}</button>`;
      }
      return html`<button class="btn small outline block" type="button" disabled>Нужно ещё ${Number(item.price) - shopData.balance} coins</button>`;
    };

    $('#app').innerHTML = html`
      <section class="section">
        <div class="page-head">
          <h2>Магазин ников</h2>
          <a class="link" href="#/">← На главную</a>
        </div>

        <div class="panel balance-card">
          <div>
            <div class="muted small">Ваш баланс</div>
            <div class="balance-value">${shopData.balance} coins</div>
            <div class="muted small">Заработано ${shopData.earnedCoins} · потрачено ${shopData.spentCoins}</div>
          </div>
          <ul class="earn-rules">
            <li>💬 Отзыв — <b>+5</b></li>
            <li>⭐ Оценка по критерию — <b>+1</b></li>
            <li>👍 Лайк на ваш отзыв — <b>+1</b>, 👎 дизлайк — <b>−1</b></li>
          </ul>
        </div>
        <p class="page-sub" style="margin-top:12px">Выбранный ник показывается вместо «Аноним» у ваших отзывов — и светится цветом своей редкости. Сменить или снять ник можно в любой момент.</p>

        ${shopData.items.length ? SHOP_TIERS.map(tier => {
          const items = shopData.items.filter(item => (item.rarity || 'common') === tier.key);
          if (!items.length) return '';
          return html`
            <section class="shop-tier">
              <h3 class="shop-tier-title rarity-${tier.key}">${tier.title}</h3>
              <div class="shop-grid">
                ${items.map(item => html`
                  <div class="shop-item rarity-${esc(item.rarity || 'common')} ${item.purchased ? 'purchased' : ''} ${item.isActive ? 'active' : ''}">
                    <div class="shop-item-header">
                      <h4 class="shop-item-name">${esc(item.name)}</h4>
                      ${item.purchased
                        ? html`<span class="badge lg ${item.isActive ? 'success' : 'muted'}">${item.isActive ? 'Выбран' : 'Куплен'}</span>`
                        : html`<span class="badge lg price">${Number(item.price)} coins</span>`}
                    </div>
                    ${item.description ? html`<p class="shop-item-desc">${esc(item.description)}</p>` : ''}
                    ${itemButton(item)}
                  </div>`).join('')}
              </div>
            </section>`;
        }).join('') : html`
          <div class="empty-state">
            <p>Товары временно отсутствуют. Загляните позже.</p>
          </div>`}
      </section>
    `;

    if (!this._shopClickHandler) {
      this._shopClickHandler = (event) => {
        const btn = event.target.closest('.buy-btn, .activate-btn, .deactivate-btn');
        if (!btn || !btn.dataset.item) return;
        const itemId = btn.dataset.item;
        if (btn.classList.contains('buy-btn')) withBusy(btn, ()=>App.buyItem(itemId));
        else if (btn.classList.contains('activate-btn')) withBusy(btn, ()=>App.activateItem(itemId));
        else withBusy(btn, ()=>App.deactivateItem(itemId));
      };
      $('#app').addEventListener('click', this._shopClickHandler);
    }
  },

  // Общая логика покупки/активации/деактивации.
  async _shopAction(endpoint, itemId, { successText, errorMap = {} }) {
    const result = await postJson(endpoint, { itemId });
    const shopState = this.normalizeShopState(result);
    if (result.ok) {
      UI.toast(successText, 'success', 2500);
      if (location.hash === '#/shop') await this.viewShop(shopState ? { prefetched: shopState } : undefined);
      Auth.refreshStatsAndPopover();
      return;
    }
    if (result.error === 'already_purchased' && shopState && location.hash === '#/shop') {
      await this.viewShop({ prefetched: shopState });
    }
    if (result.error !== 'banned') UI.toast(errorMap[result.error] || errorText(result, 'Не удалось выполнить действие.'), 'error');
  },

  buyItem(itemId) {
    return this._shopAction('/api/shop/buy', itemId, {
      successText: 'Ник куплен и выбран!',
      errorMap: { not_enough_coins: 'Не хватает coins.', already_purchased: 'Этот ник уже куплен.', item_not_found: 'Такого ника больше нет.' }
    });
  },
  activateItem(itemId) {
    return this._shopAction('/api/shop/activate', itemId, {
      successText: 'Ник выбран — он появится у ваших отзывов.',
      errorMap: { item_not_owned: 'Этот ник ещё не куплен.', item_not_found: 'Такого ника больше нет.' }
    });
  },
  deactivateItem(itemId) {
    return this._shopAction('/api/shop/deactivate', itemId, {
      successText: 'Ник снят — отзывы снова подписаны «Аноним».',
      errorMap: { not_active: 'Этот ник уже не выбран.' }
    });
  },
};

/* ---------- маршруты ---------- */
Router.add(/^\/$/, ()=>App.viewHome());
Router.add(/^\/teachers$/, (...a)=>App.listAll(...a));
Router.add(/^\/top\/([a-z]+)$/, (...a)=>App.listByCharacteristic(...a));
Router.add(/^\/department\/(.+)$/, (...a)=>App.listByDepartment(...a));
Router.add(/^\/search\?q=(.*)$/, (...a)=>App.listBySearch(...a));
Router.add(/^\/teacher\/(t[\w-]+)$/, (...a)=>App.teacherProfile(...a));
Router.add(/^\/policy$/, (...a)=>App.viewPolicy(...a));
Router.add(/^\/teacher-request$/, (...a)=>App.viewTeacherRequest(...a));
Router.add(/^\/admin\/teachers\/edit\/(.+)$/, (...a)=>App.viewAdminTeacherEdit(...a));
Router.add(/^\/admin\/teachers\/new$/, (...a)=>App.viewAdminTeacherNew(...a));
Router.add(/^\/admin\/teachers$/, (...a)=>App.viewAdminTeachersList(...a));
Router.add(/^\/admin\/admins$/, (...a)=>App.viewAdminAdmins(...a));
Router.add(/^\/admin\/bans$/, (...a)=>App.viewAdminBans(...a));
Router.add(/^\/admin\/moderation(?:\?.*)?$/, (...a)=>App.viewAdminModeration(...a));
Router.add(/^\/admin$/, (...a)=>App.viewAdminHome(...a));
Router.add(/^\/shop$/, (...a)=>App.viewShop(...a));

/* ---------- запуск ---------- */
window.App = App; window.Router = Router; window.Auth = Auth;

addEventListener('DOMContentLoaded', ()=>{
  Auth.migrate();
  $('#searchForm')?.addEventListener('submit', (e)=>{ e.preventDefault(); App.search(); });
  const searchInput = $('#searchInput');
  if (searchInput) {
    searchInput.setAttribute('maxlength', String(SEARCH_QUERY_MAX_LEN));
    searchInput.addEventListener('input', (e)=>{
      const next = normalizeSearchQuery(e.target.value);
      if (e.target.value !== next) e.target.value = next;
    });
  }

  // Клик по ссылке на текущую же страницу (href совпадает с hash) — перерисовываем её.
  document.body.addEventListener('click', (e)=>{
    const a = e.target.closest('a[href^="#/"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.getAttribute('href') === location.hash) { e.preventDefault(); Router.go(a.getAttribute('href').slice(1)); }
  });

  $('#year').textContent = new Date().getFullYear();
  Auth.render();
  Auth.ensure().finally(()=>{
    Router.init();
    setInterval(()=>{ if (Auth.isLogged()) Auth.me().catch(()=>{}); }, AUTH_REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', ()=>{
      if (document.visibilityState === 'visible' && Auth.isLogged()) Auth.me().catch(()=>{});
    });
  });
});
