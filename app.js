// app.js — SPA с надёжной навигацией, мгновенным перерисованием после логина/логаута
const APP_VERSION = '2025-09-14-final-2';

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

// ---------- auth ----------
const Auth = {
  key: 'letotalks:auth',
  get(){ return JSON.parse(localStorage.getItem(this.key) || 'null'); },
  set(o){ localStorage.setItem(this.key, JSON.stringify(o)); this.render(); },
  async login(){
    const email = 'student@student.letovo.ru';
    this.set({loggedIn:true,email});
    try{ await fetch('/api/auth/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'login',email})}); }catch{}
    // ВАЖНО: мгновенно перерисовываем текущую страницу
    window.Router?.match();
  },
  async logout(){
    const email = this.get()?.email || 'student@student.letovo.ru';
    this.set({loggedIn:false,email:null});
    try{ await fetch('/api/auth/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'logout',email})}); }catch{}
    window.Router?.match();
  },
  isLogged(){ const a=this.get(); return a&&a.loggedIn; },
  render(){
    const loginBtn=$('#loginBtn'), userBadge=$('#userBadge'), logoutBtn=$('#logoutBtn');
    if(this.isLogged()){
      loginBtn?.classList.add('hidden');
      userBadge?.classList.remove('hidden');
      logoutBtn?.classList.remove('hidden');
      if (userBadge) userBadge.textContent='Student';
    }else{
      loginBtn?.classList.remove('hidden');
      userBadge?.classList.add('hidden');
      logoutBtn?.classList.add('hidden');
    }
  },
  async ensureSessionLoginLog(){
    if (!this.isLogged()) return;
    if (sessionStorage.getItem('letotalks:session-login-logged')==='1') return;
    const email = this.get()?.email || 'student@student.letovo.ru';
    try{
      await fetch('/api/auth/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'login',email})});
      sessionStorage.setItem('letotalks:session-login-logged','1');
    }catch{}
  },
  migrate(){
    const vkey='letotalks:version'; const old=localStorage.getItem(vkey);
    if (old!==APP_VERSION){ localStorage.setItem(vkey, APP_VERSION); }
  }
};

// ---------- api ----------
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
      throw err;
    }
    return await r.json();
  }
};

// ---------- router ----------
const Router = {
  routes: [],
  add(p,h){ this.routes.push({pattern:p, handler:h}); },

  // 👇 добавить:
  scrollTop(){
    try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); }
    catch { window.scrollTo(0,0); }
    // на всякий случай прокручиваем контейнер приложения
    document.getElementById('app')?.scrollIntoView({ block: 'start' });
  },

  go(p){
    if (location.hash.slice(1) !== p) location.hash = p;
    this.scrollTop();               // 👈 добавить
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
      this.scrollTop();            // 👈 добавить
      this.match();
    });
    this.scrollTop();              // 👈 добавить
    this.match();
  }
};

// ---------- app ----------
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
          <div class="row space-between">
            <h3 style="margin:0">${c.name}</h3>
            <a class="btn small primary" href="#/top/${c.key}">Смотреть всех</a>
          </div>
          <div class="hr"></div>
          ${preview || '<div class="empty">Пока нет данных</div>'}
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
          <div class="row space-between">
            <h3 style="margin:0">${d}</h3>
            <a class="btn small primary" href="#/department/${encodeURIComponent(d)}">Все учителя</a>
          </div>
          <div class="hr"></div>
          ${preview}
        </div>`;
    }).join('');

    $('#app').innerHTML = html`
      <section class="section"><h2>Топ по характеристикам</h2><div class="grid">${charCards}</div></section>
      <section class="section"><h2>По кафедрам</h2><div class="grid">${deptCards}</div></section>
    `;
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
    const t = await API.teacher(tid);
    if(!t || t.error){ Router.go('/'); return; }
    await this.mountNavbar();

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
      ? t.comments.slice().reverse().map(c=>html`
        <div class="comment">
          <div class="meta">Аноним · ${new Date(c.ts).toLocaleString('ru-RU',{dateStyle:'medium', timeStyle:'short'})}</div>
          <div>${String(c.text).replace(/</g,'&lt;')}</div>
        </div>`).join('')
      : '<div class="empty">Комментариев пока нет</div>';

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
                    <textarea id="commentText" placeholder="Напишите анонимный отзыв…"></textarea>
                    <div class="row" style="margin-top:8px;justify-content:space-between">
                      <div class="muted">Оценки отправятся вместе с комментарием. Не выбранные характеристики не изменяются.</div>
                      <button class="btn primary" id="publishBtn" data-tid="${t.id}">Опубликовать</button>
                    </div>`
                : html`<div class="empty">Чтобы оставить комментарий и оценку, нажмите «Залогиниться» сверху.</div>`
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
      if(!text) return alert('Комментарий пуст.');
      const ratings={...App.getPending(tid)};
      try{
        await API.publish({ teacherId:tid, text, ratings, author:'Student' });
        App.resetPending(tid); await App.teacherProfile(null,tid);
      }catch(err){
        if (err?.message === 'rate_limited'){
          const sec = Math.max(1, Math.ceil((err.retry_after_ms ?? 60_000) / 1000));
          alert(`Слишком часто. Можно не чаще 1 комментария в минуту.\nПопробуйте через ${sec} сек.`);
        } else if (err?.message === 'profanity_forbidden') {
          alert('Комментарий содержит запрещённую лексику. Пожалуйста, исправьте текст и попробуйте снова.');
        } else {
          alert('Не удалось опубликовать :(');
        }
      }
    });
  },
};

// ---------- routes (обёртки не ломают this) ----------
Router.add(/^\/$/, ()=>App.viewHome());
Router.add(/^\/teachers$/, (...a)=>App.listAll(...a));
Router.add(/^\/top\/([a-z]+)$/, (...a)=>App.listByCharacteristic(...a));
Router.add(/^\/department\/(.+)$/, (...a)=>App.listByDepartment(...a));
Router.add(/^\/search\?q=(.*)$/, (...a)=>App.listBySearch(...a));
Router.add(/^\/teacher\/(t[\w\-]+)$/, (...a)=>App.teacherProfile(...a));
Router.add(/^\/policy$/, (...a)=>App.viewPolicy(...a));


// ---------- boot ----------
window.App=App; window.Router=Router; window.Auth=Auth;

addEventListener('DOMContentLoaded', ()=>{
  Auth.migrate();
  $('#loginBtn')?.addEventListener('click', ()=>Auth.login());
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
  Auth.ensureSessionLoginLog();
});