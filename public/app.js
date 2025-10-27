// app.js — SPA с авторизацией по почте, лайками/дизлайками, статистикой, админкой и предмодерацией
const APP_VERSION = '2025-10-04-admin-2';
const EMAIL_DOMAIN = '@student.letovo.ru';

const CHARACTERISTICS = [
  { key:'clarity',   name:'Понятно объясняет' },
  { key:'humor',     name:'Чувство юмора' },
  { key:'strict',    name:'Строгость' },
  { key:'favorites', name:'Есть любимчики' },
];

const $  = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>Array.from(r.querySelectorAll(s));
const html = (a,...v)=>a.reduce((x,s,i)=>x+s+(v[i]??''),'');
const fmtNum = v => Math.round((v||0)*10)/10;
const fmtStars = v => html`<span class="rating" title="${fmtNum(v)} / 5"><span class="star">★</span>${fmtNum(v)}</span>`;
function characteristicAvg(t,k){ const r=t.ratings?.[k]; return r&&r.count?(r.sum/r.count):0; }
function overall(t){ let tot=0,cnt=0; for(const c of CHARACTERISTICS){ const r=t.ratings?.[c.key]; if(r&&r.count){ tot+=r.sum/r.count; cnt++; } } return cnt?tot/cnt:0; }
const collator = new Intl.Collator('ru',{sensitivity:'base'});

function coinsOf(u){
  if (!u) return 0;

  const hasAvailable = typeof u.available_coins === 'number' && !Number.isNaN(u.available_coins);
  const hasEarned = typeof u.earned_coins === 'number' && !Number.isNaN(u.earned_coins);
  const hasSpent = typeof u.spent_coins === 'number' && !Number.isNaN(u.spent_coins);

  const comments = Number(u?.comment_count||0);
  const ratings  = Number(u?.rating_count||0);
  const recLikes = Number(u?.received_likes||0);
  const recDis   = Number(u?.received_dislikes||0);

  const earnedFallback = 5*comments + ratings + recLikes - recDis;
  const earned = hasEarned ? Number(u.earned_coins) : earnedFallback;
  const spent = hasSpent ? Number(u.spent_coins) : 0;
  const available = hasAvailable ? Number(u.available_coins) : (earned - spent);

  const normalized = Math.max(0, Number.isFinite(available) ? available : 0);

  console.log(`[DEBUG coinsOf] User ${u?.id}: earned=${earned}, spent=${spent}, available=${normalized}`);

  return normalized;
}

/* ---------- client-side предмодерация (минимальная, но умная) ---------- */
const BW_STEMS = ['бля','бляд','хуй','хуе','пизд','еб','ёб','сука','сук','мраз','гандон','пидор','пидр','чмо','урод','нахуй','нехуй','охуе','долбоёб','долбаёб','долбаеб','долбоеб'];
const LAT2CYR = { a:'а',b:'в',c:'с',e:'е',h:'н',k:'к',m:'м',o:'о',p:'р',t:'т',x:'х',y:'у' };
const LEET = { '0':'о','1':'i','3':'е','4':'а','5':'с','6':'б','7':'т','8':'в','9':'д' };
function normBW(s){
  let t = String(s||'').toLowerCase();
  t = t.replace(/[0-9]/g, ch => LEET[ch] || ch).replace(/[a-z]/g, ch => LAT2CYR[ch] || ch);
  t = t.replace(/[\s\.\,\-\_\*\+\=\!\?\(\)\[\]\{\}\/\\\|\'\"\:;@#\$%^&`~]+/g,'').replace(/(.)\1{2,}/g,'$1$1');
  return t;
}
function hasBW(s){ const n=normBW(s); return BW_STEMS.some(st=>n.includes(st)); }

/* ---------- auth (server-backed) ---------- */
const Auth = {
  key: 'letotalks:auth',
  _state: { loggedIn:false, id:null, email:null, username:null, comment_count:0, rating_count:0, cast_likes:0, cast_dislikes:0, received_likes:0, received_dislikes:0, available_coins:0, earned_coins:0, spent_coins:0, _isAdmin:false, _isBanned:false },

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
    try{ localStorage.setItem(this.key, JSON.stringify({ email: this._state.email })); }catch{}
    this.render();
    this.renderProfilePopover(); // обновление поповера
  },

  async me(){
    try{
      const r = await fetch('/api/auth/me');
      const j = await r.json();
      if (j.loggedIn){
        this.set({
          loggedIn:true,
          id: j.user.id,
          email: j.user.email,
          username: j.user.username,
          display_name: j.user.display_name || j.user.username || j.user.email.split('@')[0],
          comment_count: j.user.comment_count,
          rating_count: j.user.rating_count,
          cast_likes: j.user.cast_likes||0,
          cast_dislikes: j.user.cast_dislikes||0,
          received_likes: j.user.received_likes||0,
          received_dislikes: j.user.received_dislikes||0,
          available_coins: Number(j.user.available_coins ?? coinsOf(j.user)),
          earned_coins: Number(j.user.earned_coins ?? 0),
          spent_coins: Number(j.user.spent_coins ?? 0),
          _isAdmin: !!j.user.is_admin,
          _isBanned: !!j.user.is_banned
        });
      }else{
        this.set({ loggedIn:false, id:null, email:null, username:null, comment_count:0, rating_count:0, cast_likes:0, cast_dislikes:0, received_likes:0, received_dislikes:0, available_coins:0, earned_coins:0, spent_coins:0, _isAdmin:false, _isBanned:false });
      }
    }catch{
      this.set({ loggedIn:false, id:null, email:null, username:null, comment_count:0, rating_count:0, cast_likes:0, cast_dislikes:0, received_likes:0, received_dislikes:0, available_coins:0, earned_coins:0, spent_coins:0, _isAdmin:false, _isBanned:false });
    }
  },

  login(){ Router.go('/login'); },

  async logout(){
    try{ await fetch('/api/auth/logout',{method:'POST'}); }catch{}
    this.set({ loggedIn:false, id:null, email:null, username:null, comment_count:0, rating_count:0, cast_likes:0, cast_dislikes:0, received_likes:0, received_dislikes:0, available_coins:0, earned_coins:0, spent_coins:0, _isAdmin:false, _isBanned:false });
    window.Router?.match();
  },

  isLogged(){ return !!this._state.loggedIn; },

  render(){
  const loginBtn=$('#loginBtn'), userBadge=$('#userBadge'), logoutBtn=$('#logoutBtn');
  const adminLink=$('#adminLink');
  const shopLink=$('#shopLink'); // ← эта строка должна быть

  if(this.isLogged()){
    loginBtn?.classList.add('hidden');
    userBadge?.classList.remove('hidden');
    logoutBtn?.classList.remove('hidden');

    if (userBadge){
      const nick = this._state.display_name || (this._state.username || this._state.email || 'Student').split('@')[0] || 'Student';
      userBadge.textContent = nick;
    }

    // Админка показывается только администраторам
    if (this._state._isAdmin) adminLink?.classList.remove('hidden');
    else adminLink?.classList.add('hidden');

    // ↓↓↓ ВАЖНО: Магазин должен показываться всем авторизованным ↓↓↓
    if (!this._state._isBanned) {
      shopLink?.classList.remove('hidden');
    } else {
      shopLink?.classList.add('hidden');
    }
    // ↑↑↑ ВАЖНО: Магазин должен показываться всем авторизованным ↑↑↑

  }else{
    loginBtn?.classList.remove('hidden');
    userBadge?.classList.add('hidden');
    logoutBtn?.classList.add('hidden');
    adminLink?.classList.add('hidden');
    shopLink?.classList.add('hidden');
  }
    },

  migrate(){
    const vkey='letotalks:version'; const old=localStorage.getItem(vkey);
    if (old!==APP_VERSION){ localStorage.setItem(vkey, APP_VERSION); }
  },

  async refreshStatsAndPopover(){
    if (!this.isLogged()) return;
    try{
      const r = await fetch('/api/user/stats');
      const j = await r.json();
      if (j.ok){
        this.set({
          comment_count: j.user.comment_count,
          rating_count: j.user.rating_count,
          cast_likes: j.user.cast_likes,
          cast_dislikes: j.user.cast_dislikes,
          received_likes: j.user.received_likes,
          received_dislikes: j.user.received_dislikes,
          display_name: j.user.display_name || this._state.display_name,
          available_coins: Number(j.user.available_coins ?? coinsOf(j.user)),
          earned_coins: Number(j.user.earned_coins ?? 0),
          spent_coins: Number(j.user.spent_coins ?? 0)
        });
      }
    }catch{}
  },

  // --- поповер профиля при ховере на бейдже
  renderProfilePopover(){
    const badge = $('#userBadge');
    let pop = $('#userPopover');
    if (!badge) return;
    if (!pop){
      pop = document.createElement('div');
      pop.id = 'userPopover';
      pop.className = 'popover hidden';
      document.body.appendChild(pop);
    }
    const updateContent = ()=>{
      const u = this._state;
      const nick = u.display_name || (u.username||u.email||'Student').split('@')[0]||'Student';
      const coins = coinsOf(u);
      const earned = typeof u.earned_coins === 'number' ? Number(u.earned_coins) : coins + Number(u.spent_coins||0);
      const spent = typeof u.spent_coins === 'number' ? Number(u.spent_coins) : Math.max(0, earned - coins);
      pop.innerHTML = `
        <div class="popover-inner">
          <div class="row space-between" style="margin-bottom:6px">
            <div class="tname">@${nick}</div>
            <div class="badge">${coins} coins</div>
          </div>
          <div class="muted" style="margin-bottom:6px">${u.email || ''}</div>
          <div class="hr"></div>
          <ul class="stats">
            <li>Заработано: <b>${earned}</b> coins</li>
            <li>Потрачено: <b>${spent}</b> coins</li>
            <li>Комментарии: <b>${u.comment_count||0}</b> (×5 coins)</li>
            <li>Оценки по критериям: <b>${u.rating_count||0}</b> (×1 coin)</li>
            <li>Поставил лайков: <b>${u.cast_likes||0}</b>, дизлайков: <b>${u.cast_dislikes||0}</b></li>
            <li>Получил на своих комментариях: 👍 <b>${u.received_likes||0}</b>, 👎 <b>${u.received_dislikes||0}</b></li>
          </ul>
          <div class="hr"></div>
          <div class="muted" style="font-size:12px">Лайки/дизлайки учитываются только на ваших комментариях.</div>
        </div>
      `;
    };
    updateContent();

    let hover = false;
    let hideTimer = null;

    function positionPopover(){
      const r = badge.getBoundingClientRect();
      pop.style.minWidth = '280px';
      pop.style.left = Math.round(window.scrollX + r.left) + 'px';
      pop.style.top  = Math.round(window.scrollY + r.bottom + 8) + 'px';
    }
    function show(){
      if (!Auth.isLogged()) return;
      updateContent();
      positionPopover();
      pop.classList.remove('hidden');
    }
    function scheduleHide(){
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(()=>{ if(!hover) pop.classList.add('hidden'); }, 140);
    }

    badge.onmouseenter = async ()=>{
      await Auth.refreshStatsAndPopover();
      positionPopover();
      hover = true; show();
    };
    badge.onmouseleave = ()=>{
      hover = false; scheduleHide();
    };
    pop.onmouseenter = ()=>{
      hover = true; if (hideTimer) clearTimeout(hideTimer);
    };
    pop.onmouseleave = ()=>{
      hover = false; scheduleHide();
    };
    window.addEventListener('scroll', ()=>{ if(!pop.classList.contains('hidden')) positionPopover(); }, {passive:true});
    window.addEventListener('resize', ()=>{ if(!pop.classList.contains('hidden')) positionPopover(); });
  }
};

/* ---------- api ---------- */
const API = {
  async departments(){ const r=await fetch('/api/departments'); return (await r.json()).departments; },
  async teachers(){ const r=await fetch('/api/teachers'); return (await r.json()).teachers; },
  async teacher(id){ const r=await fetch(`/api/teacher/${id}`); return await r.json(); },
  async publish({teacherId, text, ratings, author}) {
    const r = await fetch('/api/comment-with-ratings', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ teacherId, text, ratings, author })
    });
    if (!r.ok) {
      let payload = null;
      try { payload = await r.json(); } catch {}
      const err = new Error(payload?.error || 'publish_failed');
      if (payload?.retry_after_ms != null) err.retry_after_ms = payload.retry_after_ms;
      if (payload?.message) err.message = payload.message; // e.g. commenting_banned
      throw err;
    }
    return await r.json();
  },
  async voteComment({commentId, vote}){ // vote: 'like' | 'dislike' | 'none'
    const r = await fetch('/api/comment/vote', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ commentId, vote })
    });
    return await r.json();
  },
  async myStats(){ const r = await fetch('/api/user/stats'); return await r.json(); },
  async teacherRequest(formData){
    const r = await fetch('/api/teacher-request', {
      method: 'POST',
      body: formData
    });
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    if (!r.ok || !data || data.ok === false) {
      const err = new Error(data?.error || 'teacher_request_failed');
      err.response = data;
      err.status = r.status;
      throw err;
    }
    return data;
  },

  // --- admin ---
  async adminComments(limit=100){ const r=await fetch(`/api/admin/comments?limit=${limit}`); return await r.json(); },
  async adminCommenters(){ const r=await fetch('/api/admin/commenters'); return await r.json(); },
  async adminCommentsByUser(userId){ const r=await fetch('/api/admin/comments/by-user?userId='+encodeURIComponent(userId)); return await r.json(); },
  async adminDeleteComment(id){ const r=await fetch('/api/admin/comment/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commentId:id})}); return await r.json(); },
  async adminFindUser(email){ const r=await fetch('/api/admin/user/find?email='+encodeURIComponent(email)); return await r.json(); },
  async adminUsers(){ const r=await fetch('/api/admin/users'); return await r.json(); },
  async adminBanUser({email,userId,banned,reason}){ const r=await fetch('/api/admin/user/ban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,userId,banned,reason})}); return await r.json(); },
  async adminTeachers(){ const r=await fetch('/api/admin/teachers'); return await r.json(); },
  async adminUpsertTeacher(payload){ const r=await fetch('/api/admin/teacher/upsert',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); return await r.json(); },
  async adminDeleteTeacher(id){ const r=await fetch('/api/admin/teacher/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})}); return await r.json(); },
};

/* ---------- router ---------- */
const Router = {
  routes: [],
  add(p,h){ this.routes.push({pattern:p, handler:h}); },
  scrollTop(){
    try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); }
    catch { window.scrollTo(0,0); }
    document.getElementById('app')?.scrollIntoView({ block: 'start' });
  },
  go(p){
    if (location.hash.slice(1) !== p) location.hash = p;
    this.scrollTop();
    this.match();
  },
  goHome(){ this.go('/'); },

  async match(){
    const h = location.hash.slice(1) || '/';
    for (const r of this.routes) {
      const m = h.match(r.pattern);
      if (m) { await r.handler(...m); return; }
    }
    await App.viewHome();
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

/* ---------- app ---------- */
const App = {
  ALL_TEACHERS: [],

  async mountNavbar(){
    const btn  = $('#deptBtn');
    const menu = $('#deptMenu');
    if (!btn || !menu) return;

    const deps = await API.departments();
    menu.innerHTML =
      `<button class="select-item" role="option" data-route="/teachers">Все учителя</button>` +
      deps.map(d=>html`<button class="select-item" role="option" data-route="/department/${encodeURIComponent(d)}">${d}</button>`).join('');

    btn.onclick = () => {
      menu.classList.toggle('hidden');
      btn.setAttribute('aria-expanded', menu.classList.contains('hidden') ? 'false':'true');
    };
    menu.onclick = (e) => {
      const it = e.target.closest('.select-item'); if(!it) return;
      const route = it.dataset.route;
      btn.textContent = it.textContent;
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded','false');
      Router.go(route);
    };
    document.addEventListener('click', (e)=>{
      if (!e.target.closest('#deptSelectWrap')) { menu.classList.add('hidden'); btn.setAttribute('aria-expanded','false'); }
    });
    document.addEventListener('keydown', (e)=>{
      if(e.key==='Escape'){ menu.classList.add('hidden'); btn.setAttribute('aria-expanded','false'); }
    });
  },

  search(){ const q=$('#searchInput')?.value.trim(); if(!q) return; Router.go(`/search?q=${encodeURIComponent(q)}`); },

  teacherTile(t, rightHtml){
    const fio = [t.lastName, t.firstName, t.patronymic].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
    return html`
      <div class="list-item">
        <div class="portrait"><img src="${t.photo || ''}" alt=""></div>
        <div>
          <div class="tname"><a class="link" href="#/teacher/${t.id}">${fio || 'Без имени'}</a></div>
          <div class="meta">${t.department} · ${t.subjects?.join(', ')||''}</div>
        </div>
        <div>${rightHtml||''}</div>
      </div>`;
  },

  sortByValueThenAlpha(list, getVal){
    return list.sort((a,b)=>{
      const va = getVal(a), vb = getVal(b);
      if (vb !== va) return vb - va;
      const an = `${a.lastName} ${a.firstName}`.trim();
      const bn = `${b.lastName} ${b.firstName}`.trim();
      return collator.compare(an, bn);
    });
  },

async viewHome(){
  await this.mountNavbar();
  this.ALL_TEACHERS = await API.teachers();

  const charCards = CHARACTERISTICS.map(c=>{
    const sorted = this.sortByValueThenAlpha([...this.ALL_TEACHERS], t=>characteristicAvg(t,c.key)).slice(0,3);
    const preview = sorted.map(t=>html`
      <div class="row" style="gap:10px;padding:8px 0">
        <div class="portrait"><img src="${t.photo||''}" alt=""></div>
        <div style="flex:1">
          <div class="tname">${[t.lastName,t.firstName].filter(Boolean).join(' ')}</div>
          <div class="tdept">${t.department}</div>
        </div>
        <div>${fmtStars(characteristicAvg(t,c.key))}</div>
      </div>`).join('');
    return html`
      <div class="card">
        <div class="card-header">
          <h3>${c.name}</h3>
          <a class="btn small primary" href="#/top/${c.key}">Смотреть всех</a>
        </div>
        <div class="card-content">
          <div class="hr"></div>
          ${preview || '<div class="empty">Пока нет данных</div>'}
        </div>
      </div>`;
  }).join('');

  const deps = await API.departments();
  const deptCards = deps.map(d=>{
    const list = this.sortByValueThenAlpha(this.ALL_TEACHERS.filter(t=>t.department===d), t=>overall(t)).slice(0,3);
    if (!list.length) return '';
    const preview = list.map(t=>html`
      <div class="row" style="gap:10px;padding:8px 0">
        <div class="portrait"><img src="${t.photo||''}" alt=""></div>
        <div style="flex:1">
          <div class="tname">${[t.lastName,t.firstName].filter(Boolean).join(' ')}</div>
          <div class="tdept">${t.department}</div>
        </div>
        <div>${fmtStars(overall(t))}</div>
      </div>`).join('');
    return html`
      <div class="card">
        <div class="card-header">
          <h3>${d}</h3>
          <a class="btn small primary" href="#/department/${encodeURIComponent(d)}">Все учителя</a>
        </div>
        <div class="card-content">
          <div class="hr"></div>
          ${preview}
        </div>
      </div>`;
  }).join('');

  $('#app').innerHTML = html`
    <section class="section"><h2>Топ по характеристикам</h2><div class="grid">${charCards}</div></section>
    <section class="section"><h2>По кафедрам</h2><div class="grid">${deptCards}</div></section>
    <section class="section teacher-request-cta">
      <div class="cta-card">
        <div class="cta-text">
          <h2>Не нашли своего учителя?</h2>
          <p class="muted">Отправьте заявку, и администраторы проверят информацию и добавят нового учителя в каталог.</p>
        </div>
        <a class="btn primary" href="#/teacher-request">Добавить учителя</a>
      </div>
    </section>
  `;
},

  async viewTeacherRequest(){
    await this.mountNavbar();
    $('#app').innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <h2>Добавить учителя</h2>
          <div class="list-controls"><a class="link" href="#/">← На главную</a></div>
        </div>
        <div class="teacher-request-card">
          <p class="muted">Заполните форму ниже. Мы отправим вашу заявку администраторам в Telegram и добавим учителя после подтверждения.</p>
          <form id="teacherRequestForm" class="teacher-request-form" novalidate>
            <div class="teacher-request-grid">
              <div class="teacher-request-field">
                <label for="reqLastName">Фамилия*</label>
                <input id="reqLastName" name="lastName" type="text" maxlength="120" required placeholder="Иванов">
              </div>
              <div class="teacher-request-field">
                <label for="reqFirstName">Имя*</label>
                <input id="reqFirstName" name="firstName" type="text" maxlength="120" required placeholder="Иван">
              </div>
              <div class="teacher-request-field">
                <label for="reqPatronymic">Отчество</label>
                <input id="reqPatronymic" name="patronymic" type="text" maxlength="120" placeholder="Иванович">
              </div>
              <div class="teacher-request-field">
                <label for="reqDepartment">Кафедра*</label>
                <input id="reqDepartment" name="department" type="text" maxlength="160" required placeholder="Математика">
              </div>
              <div class="teacher-request-field">
                <label for="reqSubjects">Предметы*</label>
                <input id="reqSubjects" name="subjects" type="text" maxlength="240" required placeholder="Алгебра, Геометрия">
                <div class="teacher-request-hint">Укажите через запятую или с новой строки.</div>
              </div>
              <div class="teacher-request-field">
                <label for="reqSubmitterName">Как к вам обращаться</label>
                <input id="reqSubmitterName" name="submitterName" type="text" maxlength="160" placeholder="Имя или класс">
              </div>
              <div class="teacher-request-field">
                <label for="reqSubmitterContact">Контакт для связи</label>
                <input id="reqSubmitterContact" name="submitterContact" type="text" maxlength="160" placeholder="Почта или Telegram (по желанию)">
              </div>
            </div>
            <div class="teacher-request-field">
              <label for="reqNotes">Комментарий или дополнительная информация</label>
              <textarea id="reqNotes" name="notes" rows="4" maxlength="1500" placeholder="Расскажите, чему обучает учитель, какие у него особенности или достижения."></textarea>
            </div>
            <div class="teacher-request-field">
              <label for="reqPhoto">Фото учителя (до 5 МБ, JPG/PNG/WebP)</label>
              <input id="reqPhoto" name="photo" type="file" accept="image/jpeg,image/png,image/webp">
            </div>
            <div class="teacher-request-actions">
              <button type="submit" class="btn primary" id="teacherRequestSubmit">Отправить заявку</button>
              <button type="button" class="btn outline" id="teacherRequestCancel">Отмена</button>
            </div>
            <div class="teacher-request-note muted">* — обязательные поля. Отправляя заявку, вы подтверждаете корректность данных.</div>
          </form>
          <div id="teacherRequestFeedback" class="teacher-request-feedback"></div>
        </div>
      </section>
    `;
    this.bindTeacherRequestForm();
  },

  bindTeacherRequestForm(){
    const form = $('#teacherRequestForm');
    if (!form) return;
    this.setTeacherRequestFeedback('');
    form.addEventListener('submit', (e)=>{
      e.preventDefault();
      this.submitTeacherRequestForm(form);
    });
    $('#teacherRequestCancel')?.addEventListener('click', ()=>Router.go('/'));
  },

  setTeacherRequestFeedback(message, type=''){
    const box = $('#teacherRequestFeedback');
    if (!box) return;
    box.textContent = message || '';
    box.classList.remove('success','error');
    if (type) box.classList.add(type);
  },

  teacherRequestErrorText(code, description){
    const map = {
      missing_name: 'Укажите фамилию и имя учителя.',
      missing_department: 'Укажите кафедру учителя.',
      missing_subjects: 'Добавьте хотя бы один предмет.',
      photo_too_large: 'Фото превышает лимит в 5 МБ.',
      unsupported_photo_type: 'Допускаются только изображения в форматах JPG, PNG или WebP.',
      telegram_not_configured: 'Сервис временно недоступен. Попробуйте позже.',
      telegram_failed: 'Не удалось связаться с Telegram. Попробуйте ещё раз чуть позже.',
      upload_failed: 'Не удалось загрузить файл. Попробуйте выбрать фото заново.',
      teacher_request_failed: 'Не удалось отправить заявку.',
      server_error: 'На сервере произошла ошибка. Попробуйте позже.'
    };
    return map[code] || description || 'Не удалось отправить заявку. Попробуйте ещё раз позже.';
  },

  async submitTeacherRequestForm(form){
    const submitBtn = $('#teacherRequestSubmit');
    if (submitBtn?.disabled) return;

    this.setTeacherRequestFeedback('');

    if (!form.reportValidity()) {
      return;
    }

    const lastName = $('#reqLastName')?.value?.trim() || '';
    const firstName = $('#reqFirstName')?.value?.trim() || '';
    const patronymic = $('#reqPatronymic')?.value?.trim() || '';
    const department = $('#reqDepartment')?.value?.trim() || '';
    const subjectsRaw = $('#reqSubjects')?.value || '';
    const subjectsValue = subjectsRaw.trim();
    const submitterName = $('#reqSubmitterName')?.value?.trim() || '';
    const submitterContact = $('#reqSubmitterContact')?.value?.trim() || '';
    const notes = $('#reqNotes')?.value?.trim() || '';
    const subjectsClean = subjectsValue.split(/[,|\n]+/).map(s=>s.trim()).filter(Boolean).join(', ');

    if (!subjectsClean) {
      this.setTeacherRequestFeedback('Добавьте хотя бы один предмет.', 'error');
      $('#reqSubjects')?.focus();
      return;
    }

    const photoInput = $('#reqPhoto');
    const file = photoInput?.files && photoInput.files[0] ? photoInput.files[0] : null;
    if (file) {
      const allowed = ['image/jpeg','image/png','image/webp'];
      if (!allowed.includes(file.type)) {
        this.setTeacherRequestFeedback('Допускаются только изображения в форматах JPG, PNG или WebP.', 'error');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        this.setTeacherRequestFeedback('Фото слишком большое (лимит 5 МБ).', 'error');
        return;
      }
    }

    const formData = new FormData();
    formData.append('lastName', lastName);
    formData.append('firstName', firstName);
    if (patronymic) formData.append('patronymic', patronymic);
    formData.append('department', department);
    formData.append('subjects', subjectsValue);
    if (submitterName) formData.append('submitterName', submitterName);
    if (submitterContact) formData.append('submitterContact', submitterContact);
    if (notes) formData.append('notes', notes);
    if (file) formData.append('photo', file, file.name);

    const resetButton = () => {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Отправить заявку';
      }
    };

    try {
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Отправка...';
      }
      const response = await API.teacherRequest(formData);
      form.reset();
      this.setTeacherRequestFeedback(`Готово! Заявка отправлена модераторам${response?.requestId ? ` (ID: ${response.requestId})` : ''}.`, 'success');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      const code = err?.response?.error || err?.message;
      const description = err?.response?.description;
      const requestId = err?.response?.requestId;
      let message = this.teacherRequestErrorText(code, description);
      if (requestId) {
        message += ` (ID: ${requestId})`;
      }
      this.setTeacherRequestFeedback(message, 'error');
      console.warn('teacher request failed', err);
    } finally {
      resetButton();
    }
  },

  async listAll(){
    await this.mountNavbar();
    const all = await API.teachers();
    const sorted = this.sortByValueThenAlpha(all, t=>overall(t));
    $('#app').innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <h2>Все учителя</h2>
          <div class="list-controls"><a class="link" href="#/">← На главную</a></div>
        </div>
        <div class="list">
          ${sorted.map(t => this.teacherTile(t, fmtStars(overall(t)))).join('') || '<div class="empty">Пока нет учителей</div>'}
        </div>
      </section>`;
  },

  async listByCharacteristic(_, key){
    await this.mountNavbar();
    const all = await API.teachers();
    const c = CHARACTERISTICS.find(x=>x.key===key); if(!c) return Router.go('/');
    const sorted = this.sortByValueThenAlpha(all, t=>characteristicAvg(t,key));
    $('#app').innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <h2>Топ учителей — ${c.name}</h2>
          <div class="list-controls"><a class="link" href="#/">← На главную</a></div>
        </div>
        <div class="list">
          ${sorted.map(t => this.teacherTile(t, fmtStars(characteristicAvg(t,key)))).join('')}
        </div>
      </section>`;
  },

  async listByDepartment(_, dept){
    await this.mountNavbar();
    const all = await API.teachers();
    const name = decodeURIComponent(dept);
    const list = this.sortByValueThenAlpha(all.filter(t=>t.department===name), t=>overall(t));
    $('#app').innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <h2>Кафедра — ${name}</h2>
          <div class="list-controls"><a class="link" href="#/">← На главную</a></div>
        </div>
        <div class="list">
          ${list.map(t => this.teacherTile(t, fmtStars(overall(t)))).join('') || '<div class="empty">Пока нет учителей</div>'}
        </div>
      </section>`;
  },

  async listBySearch(_, query){
    await this.mountNavbar();
    const q = (decodeURIComponent(query)||'').trim().toLowerCase();
    const all = await API.teachers();
    const matched = all.filter(t => ([t.lastName, t.firstName, t.patronymic].filter(Boolean).join(' ')).toLowerCase().includes(q));
    const sorted = this.sortByValueThenAlpha(matched, t=>overall(t));
    $('#app').innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <h2>Результаты поиска: “${q}”</h2>
          <div class="list-controls"><a class="link" href="#/">← На главную</a></div>
        </div>
        <div class="list">
          ${sorted.map(t => this.teacherTile(t, fmtStars(overall(t)))).join('') || '<div class="empty">Ничего не найдено</div>'}
        </div>
      </section>`;
  },

  async viewPolicy(){
    await this.mountNavbar();
    const effectiveDate = '14 сентября 2025';

    $('#app').innerHTML = html`
      <section class="section">
        <div class="list-controls" style="display:flex; justify-content:flex-end">
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
            Комментарии и оценки на сайте формируются пользователями и отражают их субъективные мнения. Администрация не проверяет каждое сообщение
            до публикации и не может гарантировать его достоверность.
          </p>
          <p><strong>Запрещено публиковать:</strong></p>
          <ul>
            <li>брань, обсценную лексику (маты), оскорбления и угрозы;</li>
            <li>клевету, распространение персональных данных без согласия, сведения, нарушающие честь, достоинство и деловую репутацию;</li>
            <li>разжигание ненависти, дискриминацию, шантаж, травлю (буллинг), призывы к противоправным действиям;</li>
            <li>рекламу и спам, вредоносные ссылки, материалы, нарушающие авторские и смежные права.</li>
          </ul>
          <p>
            Мы вправе без предупреждения <strong>скрывать, редактировать или удалять</strong> сообщения, нарушающие данные правила.
            Повторные нарушения могут повлечь ограничение доступа.
          </p>

          <h2>3. Отказ от ответственности</h2>
          <p>
            Вся информация на сайте предоставляется «как есть». Администрация не несёт ответственности за:
          </p>
          <ul>
            <li>содержание пользовательских комментариев и оценок;</li>
            <li>любой возможный ущерб, причины которого прямо или косвенно связаны с использованием сайта или размещённой на нём информации;</li>
            <li>временные сбои, перерывы в работе, изменение или удаление материалов.</li>
          </ul>
          <p>
            Мнения пользователей могут не совпадать с позициями администрации. При получении надлежащего уведомления о нарушении прав/закона
            мы оперативно рассмотрим обращение и примем необходимые меры.
          </p>

          <h2>4. Порядок уведомления и удаления (Notice &amp; Takedown)</h2>
          <p>
            Если вы считаете, что какой-либо материал нарушает закон, ваши права или данные правила, направьте нам обращение.
            Для ускорения рассмотрения укажите:
          </p>
          <ul>
            <li>прямую ссылку на страницу и точную цитату спорного фрагмента;</li>
            <li>основание претензии (например, клевета, нарушение авторских прав, разглашение персональных данных);</li>
            <li>своё имя и контакт для связи; при необходимости — подтверждающие документы/правоустанавливающие сведения.</li>
          </ul>
          <p>
            Мы обычно рассматриваем обращения в течение <strong>трёх рабочих дней</strong> и сообщаем о результатах на указанный контакт.
          </p>

          <h2>5. Фотографии и авторские права</h2>
          <p>
            Изображения на сайте используются в информационных целях. Если вы являетесь правообладателем и считаете,
            что материал использован неправомерно, направьте обращение — мы оперативно удалим или заменим изображение.
          </p>

          <h2>6. Изменения документа</h2>
          <p>
            Мы можем обновлять данный документ, чтобы отражать изменения в функциональности или требованиях законодательства.
            Дата актуальной редакции указывается вверху страницы. Продолжая пользоваться сайтом, вы соглашаетесь с обновлённой редакцией.
          </p>

          <div class="callout">
            <strong>Важно:</strong> данный текст подготовлен в информационных целях и не является юридической консультацией.
          </div>
        </div>
      </section>
    `;
  },

  // --- pending ratings
  pendingRatings: {},
  setPending(tid,key,v){ if(!this.pendingRatings[tid]) this.pendingRatings[tid]={}; this.pendingRatings[tid][key]=v; },
  getPending(tid){ return this.pendingRatings[tid]||{}; },
  resetPending(tid){ this.pendingRatings[tid]={}; },

  async teacherProfile(_, tid){
    const data = await API.teacher(tid);
    if(!data || data.error){ Router.go('/'); return; }
    await this.mountNavbar();

    const t = data; // содержит comments с like/dislike агрегацией и myVote/own (+author_email для админов)
    const amAdmin = !!Auth._state._isAdmin;

    const charCards = CHARACTERISTICS.map(c=>{
      const cur = characteristicAvg(t,c.key);
      const g = `stars-${c.key}`;
      return html`
        <div class="char-card">
          <h4>${c.name}</h4>
          <div class="current">Средняя: ${fmtStars(cur)}</div>
          <div class="stars" role="radiogroup" aria-label="${c.name}">
            ${[5,4,3,2,1].map(v=>html`
              <input type="radio" id="${g}-${v}" name="${g}" value="${v}" ${Auth.isLogged()?'':'disabled'}/>
              <label for="${g}-${v}" title="${v}">★</label>
            `).join('')}
          </div>
        </div>`;
    }).join('');

    const commentsHtml = (t.comments&&t.comments.length)
      ? t.comments.slice().reverse().map(c=>{
        const authorName = c.authorDisplay || c.author || 'Аноним';
        return html`
        <div class="comment" data-cid="${c.id}">
          <div class="meta">
            ${authorName} · ${new Date(c.ts).toLocaleString('ru-RU',{dateStyle:'medium', timeStyle:'short'})}
            ${amAdmin && (c.author_email||c.author_uid) ? html`
              <span class="badge" title="Видно только администраторам" style="margin-left:8px">
                ${c.author_email || c.author_uid}
              </span>` : ''}
          </div>
          <div class="ctext">${String(c.text||'').replace(/</g,'&lt;')}</div>
          <div class="cactions" style="display:flex;gap:8px;align-items:center">
            <button class="iconbtn like ${c.myVote===1?'active':''}" ${!Auth.isLogged() || c.isOwn ? 'disabled' : ''} title="${c.isOwn?'Нельзя голосовать за свой комментарий':''}">👍 <span class="cnt">${c.likes||0}</span></button>
            <button class="iconbtn dislike ${c.myVote===-1?'active':''}" ${!Auth.isLogged() || c.isOwn ? 'disabled' : ''} title="${c.isOwn?'Нельзя голосовать за свой комментарий':''}">👎 <span class="cnt">${c.dislikes||0}</span></button>
            <button class="btn small outline report-btn">🚩 Пожаловаться</button>
            ${amAdmin ? html`<button class="btn small outline del-comment">Удалить</button>`:''}
          </div>
        </div>`;
      }).join('')
      : '<div class="empty">Комментариев пока нет</div>';

    const banned = !!Auth._state._isBanned;

    $('#app').innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <div class="row" style="gap:14px">
            <button id="backBtn" class="btn small outline" type="button">← Назад</button>
            <h2 style="margin:0">${[t.lastName,t.firstName,t.patronymic].filter(Boolean).join(' ')}</h2>
          </div>
        </div>

        <div class="profile" style="margin-top:12px">
          <div class="kv">
            <div class="portrait-lg"><img src="${t.photo||''}" alt=""></div>
            <dl>
              <dt>Кафедра</dt><dd>${t.department}</dd>
              <dt>Предметы</dt><dd>${t.subjects?.join(', ')||''}</dd>
              <dt>Общий рейтинг</dt><dd>${fmtStars(overall(t))}</dd>
            </dl>
          </div>

          <div class="kv">
            <h3 style="margin:0 0 10px;color:var(--blue-700)">Оценки по характеристикам</h3>
            <div class="char-grid">${charCards}</div>
            <div class="hr"></div>

            <div class="comment-box">
              <h3 style="margin:6px 0 8px;color:var(--blue-700)">Оставить комментарий</h3>
              ${Auth.isLogged()
                ? html`
                    ${banned ? html`<div class="empty">У вашего аккаунта запрещены <b>текстовые</b> комментарии. Вы всё ещё можете отправлять <b>только оценки</b> без текста.</div>`:''}
                    <textarea id="commentText" placeholder="${banned ? 'Текст сейчас отправить нельзя (бан на комментарии). Можно выставить оценки выше и нажать «Опубликовать» без текста.' : 'Напишите анонимный отзыв… (можно пусто — тогда отправятся только оценки)'}" ${banned?'':''}></textarea>
                    <div class="row" style="margin-top:8px;justify-content:space-between">
                      <div class="muted">Оценки отправятся вместе с комментарием. Можно отправить только оценки без текста.</div>
                      <button class="btn primary" id="publishBtn" data-tid="${t.id}">Опубликовать</button>
                    </div>`
                : html`<div class="empty">Чтобы оставить комментарий и оценку, нажмите «Войти» сверху.</div>`
              }
            </div>

            <div class="hr"></div>
            <h3 style="margin:0 0 8px;color:var(--blue-700)">Комментарии</h3>
            <div id="comments">${commentsHtml}</div>
          </div>
        </div>
      </section>`;

    // обработчики профиля
    $('#backBtn')?.addEventListener('click', ()=>history.back());
    for(const c of CHARACTERISTICS) for(const v of [1,2,3,4,5]){
      const el = document.getElementById(`stars-${c.key}-${v}`);
      if(el) el.addEventListener('change', ()=>App.setPending(t.id,c.key,v));
    }
    $('#publishBtn')?.addEventListener('click', async(e)=>{
      const tid = e.currentTarget.dataset.tid;
      if(!Auth.isLogged()) return alert('Нужно войти.');
      const text=$('#commentText').value.trim();
      const ratings={...App.getPending(tid)};
      const hasRatings = Object.keys(ratings).length>0;

      // клиентская предмодерация
      if (text && hasBW(text)) {
        return alert('Комментарий содержит запрещённую лексику. Пожалуйста, исправьте текст.');
      }
      if (Auth._state._isBanned && text){
        return alert('У вашего аккаунта запрещено оставлять текстовые комментарии. Можно отправить только оценки без текста.');
      }

      if(!text && !hasRatings){
        return alert('Нужно написать комментарий или выбрать хотя бы одну оценку.');
      }
      try{
        await API.publish({ teacherId:tid, text, ratings, author:'Student' });
        App.resetPending(tid); await App.teacherProfile(null,tid);
        Auth.refreshStatsAndPopover();
      }catch(err){
        if (err?.message === 'rate_limited'){
          const sec = Math.max(1, Math.ceil((err.retry_after_ms ?? 60_000) / 1000));
          alert(`Слишком часто. \nПопробуйте через ${sec} сек.`);
        } else if (err?.message === 'profanity_forbidden') {
          alert('Комментарий содержит запрещённую лексику. Пожалуйста, исправьте текст и попробуйте снова.');
        } else if (err?.message === 'commenting_banned' || err?.message === 'banned') {
          alert('Вам запрещено оставлять текстовые комментарии. Можно отправлять только оценки без текста.');
        } else if (err?.code === 'toxic_comment' || (typeof err?.score === 'number' && err.score >= 0.5)) {
          const scoreText = typeof err.score === 'number' ? ` (вероятность токсичности: ${Math.round(err.score * 100)}%)` : '';
          alert('Комментарий был отклонён системой модерации как токсичный.' + scoreText);
        } else {
          alert('Не удалось опубликовать :(');
        }
      }
    });

    // лайки/дизлайки + удаление коммента (админ)
    $('#comments')?.addEventListener('click', async (e)=>{
      const delBtn = e.target.closest('.del-comment');
      if (delBtn && Auth._state._isAdmin) {
        const commentEl = e.target.closest('.comment');
        const cid = commentEl?.dataset?.cid;
        if (!cid) return;
        if (!confirm('Удалить комментарий?')) return;
        try{
          const r = await API.adminDeleteComment(cid);
          if (r.ok) commentEl.remove();
          else alert('Не удалось удалить комментарий.');
        }catch{
          alert('Ошибка сети.');
        }
        return;
      }
      // жалоба на комментарий
      const reportBtn = e.target.closest('.report-btn');
      if (reportBtn) {
        const commentEl = e.target.closest('.comment');
        const cid = commentEl?.dataset?.cid;
        if (!cid) return;
        const reasonRaw = prompt('Причина жалобы (оскорбления, спам и т.д.):');
        const reason = reasonRaw?.trim();
        if (!reason) return;
        try {
          const r = await fetch('/api/report-comment', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ commentId: cid, reason })
          });
          let data = null;
          try {
            data = await r.json();
          } catch {}
          if (r.ok && data?.ok !== false) {
            alert('Жалоба отправлена. Спасибо!');
          } else {
            const errorText = data?.description || data?.error || 'не удалось отправить жалобу.';
            alert('Ошибка: ' + errorText);
          }
        } catch {
          alert('Ошибка соединения');
        }
        return;
      }
      const likeBtn = e.target.closest('.iconbtn.like');
      const dislikeBtn = e.target.closest('.iconbtn.dislike');
      if (!likeBtn && !dislikeBtn) return;

      const commentEl = e.target.closest('.comment');
      const cid = commentEl?.dataset?.cid;
      if (!cid) return;

      const isLike = !!likeBtn;
      const btn = isLike ? likeBtn : dislikeBtn;
      if (btn.disabled) return;

      const isActive = btn.classList.contains('active');
      const vote = isActive ? 'none' : (isLike ? 'like' : 'dislike');

      try{
        const res = await API.voteComment({ commentId: cid, vote });
        if (res.ok){
          // обновим счётчики в DOM
          const likeEl = commentEl.querySelector('.iconbtn.like');
          const dislikeEl = commentEl.querySelector('.iconbtn.dislike');
          if (likeEl) {
            likeEl.querySelector('.cnt').textContent = res.likes || 0;
            likeEl.classList.toggle('active', res.myVote===1);
          }
          if (dislikeEl){
            dislikeEl.querySelector('.cnt').textContent = res.dislikes || 0;
            dislikeEl.classList.toggle('active', res.myVote===-1);
          }
          // обновим поповер/статы
          Auth.refreshStatsAndPopover();
        }else if (res.error === 'forbidden'){
          alert('Нельзя голосовать за свой комментарий.');
        }else if (res.error === 'unauthorized'){
          alert('Нужно войти.');
        }else{
          alert('Не удалось выполнить действие.');
        }
      }catch{
        alert('Ошибка сети.');
      }
    });
  },

  // --- экран логина
  async viewLogin(){
    await this.mountNavbar();

    $('#app').innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <h2>Вход по школьной почте</h2>
          <div class="list-controls"><a class="link" href="#/">← На главную</a></div>
        </div>

        <div class="kv" id="loginBox">
          <p>Чтобы войти, отправьте письмо <strong>со своей школьной почты (${EMAIL_DOMAIN})</strong> на сгенерированный ниже адрес с <strong>6-значным кодом</strong> в теме или тексте.</p>

          <div id="stageIdle">
            <button id="genBtn" class="btn primary">Сгенерировать адрес и код</button>
          </div>

          <div id="stageActive" class="hidden">
            <div class="row wrap" style="gap:12px; align-items:flex-start">
              <div>
                <div class="muted">Временный адрес</div>
                <div id="tmpEmail" class="badge" style="user-select:all"></div>
              </div>
              <div>
                <div class="muted">Ваш код</div>
                <div id="tmpCode" class="badge" style="user-select:all"></div>
              </div>
              <button id="copyAll" class="btn small outline">Скопировать адрес и код</button>
            </div>

            <div class="empty" id="statusLine" style="margin-top:10px">Ждём письмо…</div>
            <div class="muted" id="hintLine">Отправьте письмо со своей почты, оканчивающейся на ${EMAIL_DOMAIN}.</div>

            <div class="row" style="margin-top:10px">
              <button id="cancelBtn" class="btn outline">Сбросить</button>
            </div>
          </div>
        </div>
      </section>
    `;

    let sessionId = null;
    let pollTimer = null;
    const $email = $('#tmpEmail');
    const $code  = $('#tmpCode');
    const $status= $('#statusLine');
    const $stageIdle = $('#stageIdle');
    const $stageActive = $('#stageActive');

    function setActive(on){
      $stageIdle.classList.toggle('hidden', !!on);
      $stageActive.classList.toggle('hidden', !on);
    }

    $('#genBtn')?.addEventListener('click', async ()=>{
      try{
        const r = await fetch('/api/auth/request',{method:'POST'});
        const j = await r.json();
        if (!j.ok) throw new Error('request_failed');
        sessionId = j.session_id;
        $email.textContent = j.email;
        $code.textContent  = j.code;
        setActive(true);
        $status.textContent = 'Ждём письмо…';

        const interval = Math.max(1000, Number(j.check_every_ms||5000));
        pollTimer = setInterval(async ()=>{
          try{
            const r2 = await fetch(`/api/auth/poll?session_id=${encodeURIComponent(sessionId)}`);
            const p = await r2.json();
            if (p.ok){
              clearInterval(pollTimer); pollTimer=null;
              Auth.set({
                loggedIn:true,
                id: p.user.id,
                email: p.user.email,
                username: p.user.username,
                comment_count: p.user.comment_count,
                rating_count: p.user.rating_count,
                cast_likes: p.user.cast_likes||0,
                cast_dislikes: p.user.cast_dislikes||0,
                received_likes: p.user.received_likes||0,
                received_dislikes: p.user.received_dislikes||0,
                _isAdmin: !!p.user.is_admin,
                _isBanned: !!p.user.is_banned
              });
              Router.go('/');
            } else if (p.status === 'wrong_domain'){
              $status.textContent = `Получено письмо с ${p.sender_email}, но требуется ${p.required_domain}`;
            } else if (p.error === 'expired'){
              clearInterval(pollTimer); pollTimer=null;
              $status.textContent = 'Истёк срок ожидания. Сгенерируйте новый адрес и код.';
            } else {
              // pending
            }
          }catch{}
        }, interval);
      }catch{
        alert('Не удалось сгенерировать временный адрес. Попробуйте позже.');
      }
    });

    $('#cancelBtn')?.addEventListener('click', ()=>{
      if (pollTimer){ clearInterval(pollTimer); pollTimer=null; }
      setActive(false);
      sessionId = null; $email.textContent=''; $code.textContent='';
    });

    $('#copyAll')?.addEventListener('click', async ()=>{
      try{
        await navigator.clipboard.writeText(`Временный адрес: ${$email.textContent}\nКод: ${$code.textContent}`);
        $status.textContent = 'Скопировано!';
        setTimeout(()=>{ $status.textContent='Ждём письмо…'; }, 1200);
      }catch{}
    });
  },

  // --- админ-панель
  async ensureAdmin(){
    await this.mountNavbar();
    if (!Auth.isLogged() || !Auth._state._isAdmin) {
      $('#app').innerHTML = `<section class="section"><div class="empty">Требуются права администратора.</div></section>`;
      return false;
    }
    return true;
  },

  adminTabs(active){
      const tabs = [
        { id:'moderation', title:'Модерация комментариев', route:'/admin/moderation' },
        { id:'bans', title:'Бан/разбан комментирования', route:'/admin/bans' },
        { id:'teachers', title:'Изменения базы учителей', route:'/admin/teachers' }
      ];
      return html`<div class="admin-tabs">${tabs.map(t=>html`<a class="admin-tab ${active===t.id?'active':''}" href="#${t.route}">${t.title}</a>`).join('')}</div>`;
    },

  async viewAdminHome(){
    if (!(await this.ensureAdmin())) return;
    $('#app').innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <h2>Админ-панель</h2>
          <div class="list-controls"><a class="link" href="#/">← На главную</a></div>
        </div>
        <div class="admin-dashboard">
          <div class="card admin-card">
            <h3>Модерация комментариев</h3>
            <p class="muted">Просмотр всех авторов и удаление их комментариев.</p>
            <button class="btn primary" data-route="/admin/moderation">Перейти</button>
          </div>
          <div class="card admin-card">
            <h3>Бан/Разбан комментирования</h3>
            <p class="muted">Управление правами на публикацию комментариев.</p>
            <button class="btn primary" data-route="/admin/bans">Перейти</button>
          </div>
          <div class="card admin-card">
            <h3>Изменения базы учителей</h3>
            <p class="muted">Добавление, редактирование и удаление карточек учителей.</p>
            <button class="btn primary" data-route="/admin/teachers">Перейти</button>
          </div>
        </div>
      </section>
    `;

    $('#app').querySelectorAll('[data-route]')?.forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        const route = e.currentTarget.getAttribute('data-route');
        if (route) Router.go(route);
      });
    });
  },

  async viewAdminModeration(){
    if (!(await this.ensureAdmin())) return;

    let commenters = [];
    try { const r = await API.adminCommenters(); if (r.ok) commenters = r.users || []; } catch {}

    $('#app').innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <h2>Модерация комментариев</h2>
          <div class="list-controls"><a class="link" href="#/admin">← Центр администрирования</a></div>
        </div>
        ${this.adminTabs('moderation')}
        <div class="admin-split">
          <div class="kv admin-pane">
            <h3 style="margin-top:0">Пользователи</h3>
            <div id="commenterList" class="admin-list"></div>
          </div>
          <div class="kv admin-pane" id="commenterDetail">
            <div class="empty">Выберите пользователя, чтобы увидеть комментарии.</div>
          </div>
        </div>
      </section>
    `;

    const listEl = $('#commenterList');
    const detailEl = $('#commenterDetail');
    const commentCache = new Map();
    const userMeta = new Map();
    let activeUserId = null;
    let loading = false;

    function renderList(){
      if (!commenters.length) {
        listEl.innerHTML = '<div class="empty">Нет пользователей с комментариями</div>';
        return;
      }
      listEl.innerHTML = commenters.map(u=>html`
        <button type="button" class="admin-list-item ${u.id===activeUserId?'active':''}" data-user="${u.id}">
          <span class="admin-list-primary">${u.email || u.username || u.id}</span>
          <span class="admin-list-meta">Комментарии: ${u.comment_count}</span>
          ${u.is_banned ? '<span class="badge danger">Забанен</span>' : ''}
        </button>
      `).join('');
    }

    function renderDetail(){
      if (!activeUserId) {
        detailEl.innerHTML = '<div class="empty">Выберите пользователя, чтобы увидеть комментарии.</div>';
        return;
      }
      if (loading) {
        detailEl.innerHTML = '<div class="muted">Загружаем комментарии…</div>';
        return;
      }
      const comments = commentCache.get(activeUserId) || [];
      const selected = commenters.find(u=>u.id===activeUserId) || {};
      const meta = userMeta.get(activeUserId) || {};
      const identity = meta.email || selected.email || meta.username || selected.username || selected.id || '—';
      const commentCount = selected.comment_count ?? comments.length;
      const banned = meta.is_banned ?? selected.is_banned;
      const fmtDate = (ts)=>{
        const num = Number(ts||0);
        if (!Number.isFinite(num)) return '';
        try { return new Date(num).toLocaleString('ru-RU',{dateStyle:'medium', timeStyle:'short'}); }
        catch { return new Date(num).toISOString(); }
      };
      detailEl.innerHTML = html`
        <div class="admin-detail-head">
          <div>
            <div class="tname">${identity}</div>
            <div class="muted">Комментариев: ${commentCount}</div>
            ${banned ? '<div class="badge danger" style="margin-top:6px">Забанен</div>' : ''}
          </div>
          <button class="btn small outline" data-open-bans>Бан/разбан</button>
        </div>
        <div class="hr"></div>
        <div id="userCommentsWrap" class="admin-comments">
          ${comments.length ? comments.map(c=>html`
            <div class="comment" data-comment-id="${c.id}">
              <div class="meta">${fmtDate(c.ts)} · ${c.teacher_name || ('teacherId: '+c.teacherId)}</div>
              <div class="ctext" style="margin:6px 0">${String(c.text||'').replace(/</g,'&lt;')}</div>
              <button class="btn small outline" data-del-cid="${c.id}">Удалить</button>
            </div>
          `).join('') : '<div class="empty">Нет комментариев</div>'}
        </div>
      `;
    }

    renderList();

    listEl.addEventListener('click', async (e)=>{
      const btn = e.target.closest('[data-user]');
      if (!btn) return;
      const uid = btn.getAttribute('data-user');
      if (!uid) return;
      if (uid !== activeUserId) {
        activeUserId = uid;
        renderList();
      }
      if (!commentCache.has(uid)) {
        loading = true;
        renderDetail();
        try {
          const resp = await API.adminCommentsByUser(uid);
          if (resp.ok) {
            commentCache.set(uid, resp.comments || []);
            const entry = commenters.find(u=>u.id===uid);
            if (entry) {
              if (resp.user?.email) entry.email = resp.user.email;
              if (resp.user?.username) entry.username = resp.user.username;
              if (typeof resp.user?.is_banned === 'boolean') entry.is_banned = resp.user.is_banned;
            }
            userMeta.set(uid, { ...resp.user, comment_count: entry?.comment_count ?? (resp.comments?.length || 0) });
          } else {
            commentCache.set(uid, []);
          }
        } catch {
          commentCache.set(uid, []);
        }
        loading = false;
      }
      renderDetail();
    });

    detailEl.addEventListener('click', async (e)=>{
      if (e.target.closest('[data-open-bans]')) {
        Router.go('/admin/bans');
        return;
      }
      const delBtn = e.target.closest('[data-del-cid]');
      if (!delBtn) return;
      const cid = delBtn.getAttribute('data-del-cid');
      if (!cid) return;
      if (!confirm('Удалить комментарий?')) return;
      delBtn.disabled = true;
      const resp = await API.adminDeleteComment(cid);
      delBtn.disabled = false;
      if (!resp.ok) {
        alert('Не удалось удалить комментарий');
        return;
      }
      const arr = commentCache.get(activeUserId) || [];
      const ix = arr.findIndex(c=>String(c.id)===String(cid));
      if (ix>=0) arr.splice(ix,1);
      commentCache.set(activeUserId, arr);
      const entry = commenters.find(u=>u.id===activeUserId);
      if (entry) {
        entry.comment_count = Math.max(0, (entry.comment_count||0) - 1);
        if (!entry.comment_count) {
          commenters = commenters.filter(u=>u.id!==entry.id);
          commentCache.delete(entry.id);
          userMeta.delete(entry.id);
          activeUserId = null;
        }
      }
      if (activeUserId && userMeta.has(activeUserId)) {
        userMeta.get(activeUserId).comment_count = arr.length;
      }
      renderList();
      renderDetail();
    });
  },

    async viewAdminBans(){
    if (!(await this.ensureAdmin())) return;

    let users = [];
    try { const r = await API.adminUsers(); if (r.ok) users = r.users || []; } catch {}

    $('#app').innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <h2>Бан/Разбан комментирования</h2>
          <div class="list-controls"><a class="link" href="#/admin">← Центр администрирования</a></div>
        </div>
        ${this.adminTabs('bans')}
        <div class="admin-split">
          <div class="kv admin-pane">
            <h3 style="margin-top:0">Могут комментировать</h3>
            <div id="adminUsersAllowed" class="admin-user-column"></div>
          </div>
          <div class="kv admin-pane">
            <h3 style="margin-top:0">Заблокированы</h3>
            <div id="adminUsersBanned" class="admin-user-column"></div>
          </div>
        </div>
      </section>
    `;

    const allowedEl = $('#adminUsersAllowed');
    const bannedEl = $('#adminUsersBanned');

    function renderColumns(){
      const allowed = users.filter(u=>!u.is_banned);
      const banned = users.filter(u=>u.is_banned);
      const renderList = (arr, action)=>{
        if (!arr.length) return '<div class="empty">Нет пользователей</div>';
        return arr.map(u=>html`
          <div class="admin-user-card">
            <div class="admin-list-primary">${u.email || u.username || u.id}</div>
            <div class="admin-list-meta">Комментарии: ${u.comment_count}</div>
            <button class="btn small outline" data-user="${u.id}" data-action="${action}">${action==='ban'?'Забанить':'Разбанить'}</button>
          </div>
        `).join('');
      };
      allowedEl.innerHTML = renderList(allowed, 'ban');
      bannedEl.innerHTML = renderList(banned, 'unban');
    }

    renderColumns();

    const bansWrap = $('#app').querySelector('.admin-split');
    bansWrap?.addEventListener('click', async (e)=>{
      const btn = e.target.closest('[data-user][data-action]');
      if (!btn) return;
      const id = btn.getAttribute('data-user');
      const action = btn.getAttribute('data-action');
      if (!id || !action) return;
      const willBan = action === 'ban';
      let reason = '';
      if (willBan) {
        reason = prompt('Причина бана (необязательно):','') || '';
      }
      btn.disabled = true;
      const resp = await API.adminBanUser({ userId: id, banned: willBan, reason });
      btn.disabled = false;
      if (!resp.ok) {
        alert('Не удалось обновить статус пользователя');
        return;
      }
      const user = users.find(u=>u.id===id);
      if (user) {
        user.is_banned = willBan;
      }
      renderColumns();
    });
  },

  async viewAdminTeachersList(){
    if (!(await this.ensureAdmin())) return;

    let teachers = [];
    try { const r = await API.adminTeachers(); if (r.ok) teachers = r.teachers || []; } catch {}

    $('#app').innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <h2>Изменения базы учителей</h2>
          <div class="list-controls"><a class="link" href="#/admin">← Центр администрирования</a></div>
        </div>
        ${this.adminTabs('teachers')}
        <div class="row wrap" style="margin:12px 0">
          <button id="teacherAddBtn" class="btn primary">Добавить учителя</button>
        </div>
        <div class="kv" style="padding:0; overflow:auto">
          <table style="width:100%; border-collapse:collapse">
            <thead><tr><th>ID</th><th>ФИО</th><th>Кафедра</th><th>Предметы</th><th></th></tr></thead>
            <tbody id="teachersTableBody"></tbody>
          </table>
        </div>
      </section>
    `;

    const tbody = $('#teachersTableBody');

    function renderRows(){
      if (!teachers.length) {
        tbody.innerHTML = '<tr><td colspan="5"><div class="empty">Список учителей пуст</div></td></tr>';
        return;
      }
      tbody.innerHTML = teachers.map(t=>html`
        <tr data-teacher="${t.id}">
          <td>${t.id}</td>
          <td>${[t.lastName,t.firstName,t.patronymic].filter(Boolean).join(' ')}</td>
          <td>${t.department||''}</td>
          <td>${(t.subjects||[]).join(', ')}</td>
          <td>
            <button class="btn small outline" data-edit="${t.id}">Редактировать</button>
            <button class="btn small outline" data-delete="${t.id}">Удалить</button>
          </td>
        </tr>
      `).join('');
    }

    renderRows();

    $('#teacherAddBtn')?.addEventListener('click', ()=>Router.go('/admin/teachers/new'));

    tbody.addEventListener('click', async (e)=>{
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-delete]');
      if (edit) {
        const id = edit.getAttribute('data-edit');
        if (id) Router.go('/admin/teachers/edit/'+encodeURIComponent(id));
        return;
      }
      if (del) {
        const id = del.getAttribute('data-delete');
        if (!id) return;
        if (!confirm('Удалить карточку учителя? Все его комментарии и рейтинги тоже будут удалены.')) return;
        del.disabled = true;
        const resp = await API.adminDeleteTeacher(id);
        del.disabled = false;
        if (!resp.ok) {
          alert('Не удалось удалить учителя');
          return;
        }
        teachers = teachers.filter(t=>t.id!==id);
        renderRows();
      }
    });
  },

  renderTeacherForm({ teacher={}, isNew=false }){
    const escapeAttr = (v)=>String(v??'').replace(/"/g,'&quot;');
    const subjects = Array.isArray(teacher.subjects) ? teacher.subjects : [];
    const photo = (teacher.photo||'').replace(/^\/?photo\//,'');
    $('#app').innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <h2>${isNew ? 'Добавить учителя' : 'Редактировать учителя'}</h2>
          <div class="list-controls"><a class="link" href="#/admin/teachers">← Назад к списку</a></div>
        </div>
        ${this.adminTabs('teachers')}
        <div class="kv admin-form">
          <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
            <div><div class="muted">ID</div><input id="teacherId" value="${escapeAttr(teacher.id||'')}" placeholder="t-ivanov-ivan" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:10px"></div>
            <div><div class="muted">Фамилия</div><input id="teacherLastName" value="${escapeAttr(teacher.lastName||'')}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:10px"></div>
            <div><div class="muted">Имя</div><input id="teacherFirstName" value="${escapeAttr(teacher.firstName||'')}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:10px"></div>
            <div><div class="muted">Отчество</div><input id="teacherPatronymic" value="${escapeAttr(teacher.patronymic||'')}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:10px"></div>
            <div><div class="muted">Кафедра</div><input id="teacherDepartment" value="${escapeAttr(teacher.department||'')}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:10px"></div>
            <div><div class="muted">Предметы (через |)</div><input id="teacherSubjects" value="${escapeAttr(subjects.join('|'))}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:10px"></div>
            <div><div class="muted">Фото (имя файла в /photos)</div><input id="teacherPhoto" value="${escapeAttr(photo)}" placeholder="ivanov.jpg" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:10px"></div>
          </div>
          <div class="row" style="margin-top:12px">
            <button id="teacherFormSave" class="btn primary">Сохранить</button>
            <button id="teacherFormCancel" class="btn outline">Отмена</button>
          </div>
        </div>
      </section>
    `;

    $('#teacherFormCancel')?.addEventListener('click', ()=>Router.go('/admin/teachers'));
    $('#teacherFormSave')?.addEventListener('click', async ()=>{
      const payload = {
        id: String($('#teacherId').value||'').trim() || (isNew ? undefined : teacher.id),
        lastName: $('#teacherLastName').value||'',
        firstName: $('#teacherFirstName').value||'',
        patronymic: $('#teacherPatronymic').value||'',
        department: $('#teacherDepartment').value||'',
        subjects: String($('#teacherSubjects').value||'').split('|').map(s=>s.trim()).filter(Boolean),
        photo: $('#teacherPhoto').value||''
      };
      const resp = await API.adminUpsertTeacher(payload);
      if (resp.ok) {
        alert('Сохранено');
        Router.go('/admin/teachers');
      } else {
        alert('Не удалось сохранить');
      }
    });
  },

  async viewAdminTeacherNew(){
    if (!(await this.ensureAdmin())) return;
    this.renderTeacherForm({ teacher:{}, isNew:true });
  },

  async viewAdminTeacherEdit(_, encodedId){
    if (!(await this.ensureAdmin())) return;
    const teacherId = decodeURIComponent(encodedId);
    let teacher = null;
    try {
      const r = await API.adminTeachers();
      if (r.ok) teacher = (r.teachers || []).find(t=>t.id===teacherId) || null;
    } catch {}
    if (!teacher) {
      $('#app').innerHTML = html`
        <section class="section">
          <div class="row space-between wrap">
            <h2>Изменения базы учителей</h2>
            <div class="list-controls"><a class="link" href="#/admin/teachers">← Назад к списку</a></div>
          </div>
          ${this.adminTabs('teachers')}
          <div class="empty">Учитель с ID ${teacherId} не найден.</div>
        </section>
      `;
      return;
    }
    this.renderTeacherForm({ teacher, isNew:false });
  },

  // --- Магазин ---
  async viewShop() {
    await this.mountNavbar();

    if (!Auth.isLogged()) {
      try { await Auth.me(); } catch {}
    }
    if (!Auth.isLogged()) {
      Router.go('/login');
      return;
    }

    let shopData = {
      items: [],
      balance: coinsOf(Auth._state),
      earnedCoins: Auth._state.earned_coins || 0,
      spentCoins: Auth._state.spent_coins || 0
    };

    try {
      const response = await fetch('/api/shop/items');
      const data = await response.json();
      if (data.ok) {
        shopData = {
          items: Array.isArray(data.items) ? data.items : [],
          balance: Number(data.balance || 0),
          earnedCoins: Number(data.earnedCoins || 0),
          spentCoins: Number(data.spentCoins || 0)
        };
        Auth.set({
          available_coins: shopData.balance,
          earned_coins: shopData.earnedCoins,
          spent_coins: shopData.spentCoins
        });
      }
    } catch (error) {
      console.error('Ошибка загрузки магазина:', error);
    }

    const purchasedItems = shopData.items.filter(item => item.purchased);
    const appEl = $('#app');

    appEl.innerHTML = html`
      <section class="section">
        <div class="row space-between wrap">
          <h2>🎁 Магазин ников</h2>
          <div class="list-controls">
            <a class="link" href="#/">← На главную</a>
          </div>
        </div>

        <div class="card" style="margin-bottom: 20px;">
          <div class="card-content">
            <div class="row space-between" style="align-items: center;">
              <div>
                <h3 style="margin: 0 0 4px 0;">Ваш баланс</h3>
                <div class="tname" style="font-size: 24px; color: var(--gold-500);">${shopData.balance} coins</div>
                <div class="muted" style="font-size: 13px;">Заработано: ${shopData.earnedCoins} • Потрачено: ${shopData.spentCoins}</div>
              </div>
              <div class="muted" style="text-align: right;">
                Токены начисляются за активность:<br>
                💬 Комментарии: 5 coins<br>
                ⭐ Оценки: 1 coin за критерий<br>
                👍 Лайки: +1 coin за полученный лайк
              </div>
            </div>
          </div>
        </div>

        ${shopData.items.length > 0 ? html`
          <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px;">
            ${shopData.items.map(item => html`
              <div class="card shop-item ${item.purchased ? 'purchased' : ''} ${item.isActive ? 'active' : ''}">
                <div class="card-content">
                  <div class="row space-between shop-item-header">
                    <h3 style="margin: 0;">${item.name}</h3>
                    ${item.purchased
                      ? html`<div class="badge status ${item.isActive ? 'success' : 'muted'}">${item.isActive ? 'Активен' : 'Не активен'}</div>`
                      : html`<div class="badge price">${item.price} coins</div>`}
                  </div>

                  ${item.purchased
                    ? (item.isActive
                      ? html`<button class="btn small outline deactivate-btn" data-item="${item.id}">Сделать неактивным</button>`
                      : html`<button class="btn small primary activate-btn" data-item="${item.id}">Сделать активным</button>`)
                    : (shopData.balance >= item.price
                      ? html`<button class="btn small primary buy-btn" data-item="${item.id}">Купить за ${item.price}</button>`
                      : html`<button class="btn small outline" disabled>Не хватает coins</button>`)}
                </div>
              </div>
            `).join('')}
          </div>
        ` : html`
          <div class="card">
            <div class="card-content">
              <div style="text-align: center; padding: 40px;">
                <h3 style="color: var(--muted);">🛒 Товары временно отсутствуют</h3>
                <p class="muted">Попробуйте обновить страницу или зайти позже.</p>
                <button class="btn outline" onclick="location.reload()">Обновить страницу</button>
              </div>
            </div>
          </div>
        `}

        ${purchasedItems.length ? html`
          <div class="shop-purchased-section">
            <h3>Ваши купленные ники</h3>
            <div class="list shop-purchased-list">
              ${purchasedItems.map(item => html`
                <div class="list-item purchased-nick">
                  <div class="tname">${item.name}</div>
                  <div class="nick-actions">
                    <span class="badge status ${item.isActive ? 'success' : 'muted'}">${item.isActive ? 'Активен' : 'Не активен'}</span>
                    ${item.isActive
                      ? html`<button class="btn small outline deactivate-btn" data-item="${item.id}">Сделать неактивным</button>`
                      : html`<button class="btn small primary activate-btn" data-item="${item.id}">Сделать активным</button>`}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </section>
    `;

    if (!this._shopClickHandler) {
      this._shopClickHandler = async (event) => {
        const targetBtn = event.target.closest('.buy-btn, .activate-btn, .deactivate-btn');
        if (!targetBtn) return;
        const itemId = targetBtn.dataset.item;
        if (!itemId) return;

        if (targetBtn.classList.contains('buy-btn')) {
          await App.buyItem(itemId);
        } else if (targetBtn.classList.contains('activate-btn')) {
          await App.activateItem(itemId);
        } else if (targetBtn.classList.contains('deactivate-btn')) {
          await App.deactivateItem(itemId);
        }
      };
    }
    appEl.removeEventListener('click', this._shopClickHandler);
    appEl.addEventListener('click', this._shopClickHandler);
  },

  async buyItem(itemId) {
  if (!Auth.isLogged()) return;

  try {
    const response = await fetch('/api/shop/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId })
    });

    const result = await response.json();

    if (result.ok) {
      alert(result.message);
      Auth.set({
        available_coins: Number(result.balance ?? Auth._state.available_coins),
        earned_coins: Number(result.earnedCoins ?? Auth._state.earned_coins),
        spent_coins: Number(result.spentCoins ?? Auth._state.spent_coins)
      });
      await this.viewShop();
      await Auth.me();
    } else {
      alert('Ошибка при покупке: ' + (result.error === 'not_enough_coins' ? 'Недостаточно coins' :
            result.error === 'already_purchased' ? 'Этот ник уже куплен' : 'Ошибка сервера'));
    }
  } catch (error) {
    alert('Ошибка сети при покупке');
  }
},

async activateItem(itemId) {
  if (!Auth.isLogged()) return;

  try {
    const response = await fetch('/api/shop/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId })
    });

    const result = await response.json();

    if (result.ok) {
      alert(result.message);
      Auth.set({
        available_coins: Number(result.balance ?? Auth._state.available_coins),
        earned_coins: Number(result.earnedCoins ?? Auth._state.earned_coins),
        spent_coins: Number(result.spentCoins ?? Auth._state.spent_coins)
      });
      await this.viewShop();
      await Auth.me();
    } else {
      alert('Ошибка при активации: ' + (result.error === 'item_not_owned' ? 'Этот ник не куплен' : 'Ошибка сервера'));
    }
  } catch (error) {
    alert('Ошибка сети при активации');
  }
},

async deactivateItem(itemId) {
  if (!Auth.isLogged()) return;

  try {
    const response = await fetch('/api/shop/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId })
    });

    const result = await response.json();

    if (result.ok) {
      alert(result.message);
      Auth.set({
        available_coins: Number(result.balance ?? Auth._state.available_coins),
        earned_coins: Number(result.earnedCoins ?? Auth._state.earned_coins),
        spent_coins: Number(result.spentCoins ?? Auth._state.spent_coins)
      });
      await this.viewShop();
      await Auth.me();
    } else {
      const msg = result.error === 'not_active'
        ? 'Этот ник уже отключен'
        : result.error === 'item_not_found'
          ? 'Ник не найден'
          : 'Ошибка сервера';
      alert('Ошибка при отключении: ' + msg);
    }
  } catch (error) {
    alert('Ошибка сети при отключении');
  }
},

};

/* ---------- routes ---------- */
Router.add(/^\/$/, ()=>App.viewHome());
Router.add(/^\/teachers$/, (...a)=>App.listAll(...a));
Router.add(/^\/top\/([a-z]+)$/, (...a)=>App.listByCharacteristic(...a));
Router.add(/^\/department\/(.+)$/, (...a)=>App.listByDepartment(...a));
Router.add(/^\/search\?q=(.*)$/, (...a)=>App.listBySearch(...a));
Router.add(/^\/teacher\/(t[\w\-]+)$/, (...a)=>App.teacherProfile(...a));
Router.add(/^\/policy$/, (...a)=>App.viewPolicy(...a));
Router.add(/^\/login$/, (...a)=>App.viewLogin(...a));
Router.add(/^\/teacher-request$/, (...a)=>App.viewTeacherRequest(...a));
Router.add(/^\/admin\/teachers\/edit\/(.+)$/, (...a)=>App.viewAdminTeacherEdit(...a));
Router.add(/^\/admin\/teachers\/new$/, (...a)=>App.viewAdminTeacherNew(...a));
Router.add(/^\/admin\/teachers$/, (...a)=>App.viewAdminTeachersList(...a));
Router.add(/^\/admin\/bans$/, (...a)=>App.viewAdminBans(...a));
Router.add(/^\/admin\/moderation$/, (...a)=>App.viewAdminModeration(...a));
Router.add(/^\/admin$/, (...a)=>App.viewAdminHome(...a));
Router.add(/^\/shop$/, (...a)=>App.viewShop(...a));

/* ---------- boot ---------- */
window.App=App; window.Router=Router; window.Auth=Auth;

addEventListener('DOMContentLoaded', ()=>{
  Auth.migrate();
  $('#loginBtn')?.addEventListener('click', ()=>Router.go('/login'));
  $('#logoutBtn')?.addEventListener('click', ()=>Auth.logout());
  $('#searchBtn')?.addEventListener('click', ()=>App.search());
  $('#searchInput')?.addEventListener('keydown', e=>{ if(e.key==='Enter') App.search(); });

  // Делегирование кликов по ссылкам вида href="#/..."
  document.body.addEventListener('click', (e)=>{
    const a = e.target.closest('a[href^="#/"]');
    if(a){ e.preventDefault(); Router.go(a.getAttribute('href').slice(1)); }
  });

  $('#year').textContent = new Date().getFullYear();
  Auth.render();
  Router.init();

  // Узнаём состояние по cookie-сессии
  Auth.me();
});
