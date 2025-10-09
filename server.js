// server.js — Node 18+ : npm i express
// http://localhost:3000
//
// CSV:
//  data/letovo_teachers.csv
//  data/comments.csv          (может быть БЕЗ заголовка; поддерживает author_uid)
//  data/ratings.csv
//  data/login_events.csv
//  data/users.csv             ← учёт пользователей/статистики (+полученные/поставленные лайки/дизлайки)
//  data/comment_votes.csv     ← голосования по комментариям (commentId,userId,vote)
//  data/admins.csv            ← список админов (email[,role]) — неизменяемый во время работы сервера
//  data/banned_users.csv      ← баны на текстовые комментарии (userId,is_banned,reason,ts)
//
// Фото: photos/  -> /photo/<file>

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR    = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR    = path.join(ROOT_DIR, 'data');
const PHOTO_DIR   = path.join(ROOT_DIR, 'photos');

const TEACHERS_CSV = path.join(DATA_DIR, 'letovo_teachers.csv');
const COMMENTS_CSV = path.join(DATA_DIR, 'comments.csv');
const RATINGS_CSV  = path.join(DATA_DIR, 'ratings.csv');
const LOGIN_CSV    = path.join(DATA_DIR, 'login_events.csv');
const USERS_CSV    = path.join(DATA_DIR, 'users.csv');
const VOTES_CSV    = path.join(DATA_DIR, 'comment_votes.csv');

const ADMINS_CSV   = path.join(DATA_DIR, 'admins.csv');
const BANS_CSV     = path.join(DATA_DIR, 'banned_users.csv');

const ALLOWED_EMAIL_DOMAIN = '@student.letovo.ru';
const SESSION_COOKIE = 'lt_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 дней
const AUTH_SESSION_TTL_MS = 1000 * 60 * 10; // 10 минут
const AUTH_CHECK_INTERVAL_MS = 5000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/photo', express.static(PHOTO_DIR));

function ensureDirsAndFiles() {
  if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR, {recursive:true});
  if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, {recursive:true});
  if (!fs.existsSync(COMMENTS_CSV)) fs.writeFileSync(COMMENTS_CSV, 'id,teacherId,ts,ts_iso,author,text,author_uid\n');
  if (!fs.existsSync(RATINGS_CSV))  fs.writeFileSync(RATINGS_CSV,  'teacherId,key,sum,count\n');
  if (!fs.existsSync(LOGIN_CSV))    fs.writeFileSync(LOGIN_CSV,    'ts,ts_iso,action,email,ip,ua\n');
  if (!fs.existsSync(USERS_CSV))    fs.writeFileSync(USERS_CSV,
    'id,email,username,created_ts,last_login_ts,login_count,comment_count,rating_count,cast_likes,cast_dislikes,received_likes,received_dislikes\n'
  );
  if (!fs.existsSync(VOTES_CSV))    fs.writeFileSync(VOTES_CSV,    'commentId,userId,vote,ts\n');
  if (!fs.existsSync(ADMINS_CSV))   fs.writeFileSync(ADMINS_CSV,   'email,role\n', 'utf-8'); // создаём пустой список
  if (!fs.existsSync(BANS_CSV))     fs.writeFileSync(BANS_CSV,     'userId,is_banned,reason,ts\n', 'utf-8');
}
ensureDirsAndFiles();

/* --- CSV utils & migrations --- */
function parseCSV(text) {
  const rows = []; let row=[], field='', inQ=false;
  for (let i=0;i<text.length;i++){
    const ch=text[i], nx=text[i+1];
    if(inQ){
      if(ch==='"' && nx==='"'){ field+='"'; i++; }
      else if(ch==='"'){ inQ=false; }
      else { field+=ch; }
    }else{
      if(ch==='"'){ inQ=true; }
      else if(ch===','){ row.push(field); field=''; }
      else if(ch==='\n'){ row.push(field); rows.push(row.map(x=>x.trim())); row=[]; field=''; }
      else if(ch!=='\r'){ field+=ch; }
    }
  }
  if (field.length || row.length){ row.push(field); rows.push(row.map(x=>x.trim())); }
  return rows;
}
function toCSVRow(vals){
  return vals.map(v=>{ const s=String(v??''); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; }).join(',')+'\n';
}
function dataStartIndex(rows, headerHints){
  if (!rows.length) return 0;
  const joined = rows[0].map(x=>String(x||'').toLowerCase()).join(',');
  for (const h of headerHints){
    if (joined.includes(h)) return 1;
  }
  return 0;
}

function ensureUsersCsvSchema() {
  const wantedHeader = ['id','email','username','created_ts','last_login_ts','login_count','comment_count','rating_count','cast_likes','cast_dislikes','received_likes','received_dislikes'];
  if (!fs.existsSync(USERS_CSV)) {
    fs.writeFileSync(USERS_CSV, wantedHeader.join(',')+'\n');
    return;
  }
  const text = fs.readFileSync(USERS_CSV, 'utf-8');
  const rows = parseCSV(text);
  if (!rows.length) {
    fs.writeFileSync(USERS_CSV, wantedHeader.join(',')+'\n');
    return;
  }
  const header = rows[0];
  const haveAll = wantedHeader.every(h=>header.includes(h));
  if (haveAll) return;

  const idx = Object.fromEntries(header.map((h,i)=>[h,i]));
  let out = wantedHeader.join(',')+'\n';
  for (let i=1;i<rows.length;i++){
    const r = rows[i] || [];
    out += toCSVRow([
      r[idx.id]||'', r[idx.email]||'', r[idx.username]||'',
      r[idx.created_ts]||'', r[idx.last_login_ts]||'', r[idx.login_count]||'0',
      r[idx.comment_count]||'0', r[idx.rating_count]||'0',
      '0','0','0','0'
    ]);
  }
  fs.writeFileSync(USERS_CSV, out, 'utf-8');
}

function ensureCommentsSchema() {
  if (!fs.existsSync(COMMENTS_CSV)) return;
  const text = fs.readFileSync(COMMENTS_CSV, 'utf-8');
  const rows = parseCSV(text);
  if (!rows.length) return;
  const header = rows[0];
  if (header.includes('author_uid')) return;
  // upgrade: append empty author_uid column
  const newHeader = [...header, 'author_uid'];
  let out = newHeader.join(',')+'\n';
  for (let i=1;i<rows.length;i++){
    const r = rows[i] || [];
    out += toCSVRow([...r, '']);
  }
  fs.writeFileSync(COMMENTS_CSV, out, 'utf-8');
}
ensureUsersCsvSchema();
ensureCommentsSchema();

/* Teachers */
function slugify(s) {
  const map={'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'E','Ж':'Zh','З':'Z','И':'I','Й':'i','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T','У':'U','Ф':'F','Х':'Kh','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Shch','Ы':'Y','Э':'E','Ю':'Yu','Я':'Ya','Ъ':'','Ь':''};
  const t=s.replace(/[А-ЯЁ]/g,m=>map[m]??m).replace(/[а-яё]/g,m=>(map[m.toUpperCase()]??m).toLowerCase());
  return t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
}
function pick(obj,...names){ for(const n of names){ if(obj[n]!=null && String(obj[n]).trim()!=='') return String(obj[n]).trim(); } return ''; }
function readTeachers(){
  if (!fs.existsSync(TEACHERS_CSV)) return [];
  const rows=parseCSV(fs.readFileSync(TEACHERS_CSV,'utf-8'));
  if (rows.length===0) return [];
  const header=rows[0].map(h=>h.trim());

  const out=[];
  for(let i=1;i<rows.length;i++){
    const r=rows[i]; if(!r||r.length===0) continue;
    const rowObj=Object.fromEntries(header.map((h,ix)=>[h, r[ix]??'']));

    let fullName = pick(rowObj,'full_name','fullName','ФИО');
    let lastName = pick(rowObj,'last_name','lastName','фамилия');
    let firstName= pick(rowObj,'first_name','firstName','имя');
    let patronymic=pick(rowObj,'patronymic','middle_name','отчество');

    if (fullName && (!lastName || !firstName)){
      const parts=fullName.split(/\s+/).filter(Boolean);
      if (parts.length>=2){ lastName=lastName||parts[0]; firstName=firstName||parts[1]; patronymic=patronymic||parts.slice(2).join(' '); }
    }

    const department = pick(rowObj,'department','кафедра');
    const subjects = (pick(rowObj,'subjects','предметы')||'').split('|').map(s=>s.trim()).filter(Boolean);

    let photo = pick(rowObj,'photo_file','photo','фото');
    if (photo) photo = photo.replace(/^photos?\//i,'');
    const photoUrl = photo ? `/photo/${photo}` : null;

    const explicitId = pick(rowObj,'id','teacher_id');
    let id = explicitId || ('t-' + slugify(`${lastName}-${firstName}-${patronymic}`) || ('t-'+Date.now().toString(36)));

    out.push({ id, lastName, firstName, patronymic, department, subjects, photo: photoUrl });
  }
  return out;
}
function writeTeachers(all) {
  const header = ['id','last_name','first_name','patronymic','department','subjects','photo'];
  let out = header.join(',')+'\n';
  for (const t of all) {
    const subjectsStr = Array.isArray(t.subjects) ? t.subjects.join('|') : (t.subjects || '');
    const photo = (t.photo||'').replace(/^\/?photo\//,''); // храним имя файла
    out += toCSVRow([t.id, t.lastName||'', t.firstName||'', t.patronymic||'', t.department||'', subjectsStr||'', photo||'']);
  }
  fs.writeFileSync(TEACHERS_CSV, out, 'utf-8');
}
function upsertTeacher(row) {
  const id = String(row.id || '').trim();
  let all = readTeachers();
  if (id) {
    const ix = all.findIndex(x=>x.id===id);
    if (ix>=0) {
      all[ix] = { ...all[ix],
        lastName: row.lastName||'',
        firstName: row.firstName||'',
        patronymic: row.patronymic||'',
        department: row.department||'',
        subjects: Array.isArray(row.subjects)?row.subjects:(String(row.subjects||'').split('|').map(s=>s.trim()).filter(Boolean)),
        photo: row.photo ? `/photo/${row.photo.replace(/^\/?photo\//,'')}` : (all[ix].photo||null)
      };
    } else {
      all.push({
        id,
        lastName: row.lastName||'',
        firstName: row.firstName||'',
        patronymic: row.patronymic||'',
        department: row.department||'',
        subjects: Array.isArray(row.subjects)?row.subjects:(String(row.subjects||'').split('|').map(s=>s.trim()).filter(Boolean)),
        photo: row.photo ? `/photo/${row.photo.replace(/^\/?photo\//,'')}` : null
      });
    }
  } else {
    const newId = 't-' + slugify(`${row.lastName||''}-${row.firstName||''}-${row.patronymic||''}`) || ('t-'+Date.now().toString(36));
    all.push({
      id: newId,
      lastName: row.lastName||'',
      firstName: row.firstName||'',
      patronymic: row.patronymic||'',
      department: row.department||'',
      subjects: Array.isArray(row.subjects)?row.subjects:(String(row.subjects||'').split('|').map(s=>s.trim()).filter(Boolean)),
      photo: row.photo ? `/photo/${row.photo.replace(/^\/?photo\//,'')}` : null
    });
  }
  writeTeachers(all);
  TEACHERS = readTeachers();
}
function deleteTeacherById(id) {
  const all = readTeachers();
  const filtered = all.filter(t=>t.id!==id);
  writeTeachers(filtered);
  // зачистим рейтинги и комменты по учителю
  const ratings = readRatingsMap();
  if (ratings[id]) { delete ratings[id]; writeRatingsMap(ratings); }
  const commentsAll = readCommentsAll().filter(c=>c.teacherId!==id);
  let out='id,teacherId,ts,ts_iso,author,text,author_uid\n';
  for (const c of commentsAll) out+=toCSVRow([c.id,c.teacherId,c.ts,c.ts_iso,c.author,c.text,c.author_uid||'']);
  fs.writeFileSync(COMMENTS_CSV,out,'utf-8');
  // голоса по удалённым комментариям — удалим «мусор»
  const remainingIds = new Set(commentsAll.map(c=>String(c.id)));
  const votes = readVotesRows().filter(v => remainingIds.has(String(v.commentId)));
  writeVotesRows(votes);
  TEACHERS = readTeachers();
}

/* Ratings/Comments */
const CHARACTERISTICS_KEYS=['clarity','humor','strict','favorites'];

function readRatingsMap(){
  const map={}; if(!fs.existsSync(RATINGS_CSV)) return map;
  const rows=parseCSV(fs.readFileSync(RATINGS_CSV,'utf-8'));
  if(!rows.length) return map;
  const start = dataStartIndex(rows, ['teacherid','teacher_id,key']);
  for(let i=start;i<rows.length;i++){
    const [tid,key,sum,count]=rows[i]; if(!tid||!key) continue;
    (map[tid] ||= {})[key] = {sum:Number(sum||0), count:Number(count||0)};
  }
  return map;
}
function writeRatingsMap(map){
  let out='teacherId,key,sum,count\n';
  for(const tid of Object.keys(map)) for(const key of Object.keys(map[tid])){
    const {sum,count}=map[tid][key] || {sum:0,count:0}; out += toCSVRow([tid,key,sum,count]);
  }
  fs.writeFileSync(RATINGS_CSV,out,'utf-8');
}

function readCommentsAll(){
  if(!fs.existsSync(COMMENTS_CSV)) return [];
  const rows=parseCSV(fs.readFileSync(COMMENTS_CSV,'utf-8'));
  if(!rows.length) return [];
  const start = dataStartIndex(rows, ['id,teacherid','id,teacher_id','teacherid,ts','teacher_id,ts']);
  const out=[];
  for(let i=start;i<rows.length;i++){
    const [id,teacherId,ts,ts_iso,author,text,author_uid]=rows[i];
    if(!id) continue;
    out.push({id:Number(id),teacherId,ts:Number(ts),ts_iso,author,text,author_uid:author_uid||''});
  }
  return out;
}
function readCommentsFor(tid){
  return readCommentsAll().filter(c=>c.teacherId===tid);
}
function getCommentById(cid){
  const all = readCommentsAll();
  return all.find(c=>String(c.id)===String(cid)) || null;
}
function nextCommentId(){
  if(!fs.existsSync(COMMENTS_CSV)) return 1;
  const rows=parseCSV(fs.readFileSync(COMMENTS_CSV,'utf-8'));
  if(!rows.length) return 1;
  const start = dataStartIndex(rows, ['id,teacherid','id,teacher_id','teacherid,ts','teacher_id,ts']);
  let maxId = 0;
  for(let i=start;i<rows.length;i++){
    const n = Number(rows[i][0]);
    if (Number.isFinite(n)) maxId = Math.max(maxId, n);
  }
  return maxId + 1;
}
function appendCommentRow({teacherId,author='Аноним',text,author_uid=''}){
  const ts=Date.now(); const id = nextCommentId();
  fs.appendFileSync(COMMENTS_CSV,toCSVRow([id,teacherId,ts,new Date(ts).toISOString(),author,text,author_uid]),'utf-8');
  return id;
}
function overall(r){ let tot=0,cnt=0; for(const k of CHARACTERISTICS_KEYS){ const v=r[k]; if(v&&v.count){ tot+=v.sum/v.count; cnt++; } } return cnt?tot/cnt:0; }

/* Votes (likes/dislikes) */
function readVotesRows(){
  if(!fs.existsSync(VOTES_CSV)) return [];
  const rows=parseCSV(fs.readFileSync(VOTES_CSV,'utf-8'));
  if(!rows.length) return [];
  const start = dataStartIndex(rows, ['commentid,userid','commentid,userId']);
  const out=[];
  for(let i=start;i<rows.length;i++){
    const [commentId,userId,vote,ts]=rows[i];
    if(!commentId || !userId) continue;
    const v = Number(vote||0);
    if (![1,0,-1].includes(v)) continue;
    out.push({commentId:String(commentId), userId:String(userId), vote:v, ts:Number(ts||0)});
  }
  return out;
}
function writeVotesRows(rows){
  let out='commentId,userId,vote,ts\n';
  for(const r of rows){
    out += toCSVRow([r.commentId, r.userId, r.vote, r.ts||Date.now()]);
  }
  fs.writeFileSync(VOTES_CSV, out, 'utf-8');
}
function getUserVote(commentId, userId){
  const rows = readVotesRows();
  const it = rows.find(r=>r.commentId===String(commentId) && r.userId===String(userId));
  return it ? it.vote : 0;
}
function setUserVote(commentId, userId, newVote){
  const rows = readVotesRows();
  const ix = rows.findIndex(r=>r.commentId===String(commentId) && r.userId===String(userId));
  if (newVote===0){
    if (ix>=0){ rows.splice(ix,1); writeVotesRows(rows); }
  }else{
    if (ix>=0){ rows[ix].vote=newVote; rows[ix].ts=Date.now(); }
    else rows.push({commentId:String(commentId), userId:String(userId), vote:newVote, ts:Date.now()});
    writeVotesRows(rows);
  }
}
function countVotesForCommentBulk(commentIds, myUserId=null){
  const set = new Set(commentIds.map(String));
  const rows = readVotesRows().filter(r=>set.has(r.commentId));
  const counts = {}; const myVotes = {};
  for(const r of rows){
    const c = (counts[r.commentId] ||= {likes:0,dislikes:0});
    if (r.vote===1) c.likes++;
    else if (r.vote===-1) c.dislikes++;
    if (myUserId && r.userId===String(myUserId)) myVotes[r.commentId] = r.vote;
  }
  return {counts, myVotes};
}

/* Users & sessions */
function parseCookies(req){
  const header = req.headers['cookie'] || '';
  const out = {};
  header.split(';').forEach(p=>{
    const [k, ...v] = p.trim().split('=');
    if (!k) return;
    out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}
function readUsersRows(){
  if (!fs.existsSync(USERS_CSV)) return [];
  const rows = parseCSV(fs.readFileSync(USERS_CSV,'utf-8'));
  if (!rows.length) return [];
  const header = rows[0];
  const out = [];
  for (let i=1;i<rows.length;i++){
    const r = rows[i]; if(!r || !r.length) continue;
    const obj = Object.fromEntries(header.map((h,ix)=>[h, r[ix]??'']));
    out.push(obj);
  }
  return out;
}
function writeUsersRows(rows){
  const header = ['id','email','username','created_ts','last_login_ts','login_count','comment_count','rating_count','cast_likes','cast_dislikes','received_likes','received_dislikes'];
  let out = header.join(',')+'\n';
  for(const r of rows){
    out += toCSVRow(header.map(h=>r[h] ?? ''));
  }
  fs.writeFileSync(USERS_CSV, out, 'utf-8');
}
function findUserByEmail(email){
  const rows = readUsersRows();
  const lower = String(email||'').toLowerCase();
  return rows.find(r=>String(r.email||'').toLowerCase()===lower) || null;
}
function findUserById(uid){
  const rows = readUsersRows();
  return rows.find(r=>r.id===uid) || null;
}
function upsertUserOnLogin(email){
  const now = Date.now();
  const username = String(email).split('@')[0];
  const rows = readUsersRows();
  const lower = String(email||'').toLowerCase();
  let found = rows.find(r=>String(r.email||'').toLowerCase()===lower);
  if (!found){
    found = {
      id: 'u-' + crypto.randomBytes(8).toString('hex'),
      email,
      username,
      created_ts: String(now),
      last_login_ts: String(now),
      login_count: '1',
      comment_count: '0',
      rating_count: '0',
      cast_likes: '0',
      cast_dislikes: '0',
      received_likes: '0',
      received_dislikes: '0'
    };
    rows.push(found);
  } else {
    found.username = username;
    found.last_login_ts = String(now);
    found.login_count = String(Number(found.login_count||0)+1);
    found.cast_likes = String(Number(found.cast_likes||0));
    found.cast_dislikes = String(Number(found.cast_dislikes||0));
    found.received_likes = String(Number(found.received_likes||0));
    found.received_dislikes = String(Number(found.received_dislikes||0));
  }
  writeUsersRows(rows);
  return found;
}
function incUserStats(uid, {comments=0, ratings=0, cast_like=0, cast_dislike=0, recv_like=0, recv_dislike=0}={}){
  const rows = readUsersRows();
  const ix = rows.findIndex(r=>r.id===uid);
  if (ix<0) return;
  const r = rows[ix];
  r.comment_count = String(Number(r.comment_count||0) + comments);
  r.rating_count  = String(Number(r.rating_count||0)  + ratings);
  r.cast_likes    = String(Number(r.cast_likes||0)    + cast_like);
  r.cast_dislikes = String(Number(r.cast_dislikes||0) + cast_dislike);
  r.received_likes    = String(Number(r.received_likes||0)    + recv_like);
  r.received_dislikes = String(Number(r.received_dislikes||0) + recv_dislike);
  writeUsersRows(rows);
}

const SESSIONS = new Map();     // token -> { userId, created, ip, ua }
const PENDING_AUTH = new Map(); // sessionId -> { email, sid_token, code, created, seenIds:Set, verified:false, ip, ua }

app.set('trust proxy', true);

function getClientIp(req){
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || '0.0.0.0';
}
function setSessionCookie(res, token){
  const maxAge = SESSION_TTL_MS;
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge/1000)}`);
}
function clearSessionCookie(res){
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function createSession(userId, req){
  const token = 'st-' + crypto.randomBytes(18).toString('hex');
  SESSIONS.set(token, { userId, created:Date.now(), ip:getClientIp(req), ua:req.headers['user-agent']||'' });
  return token;
}
function getUserFromRequest(req){
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  const u = findUserById(s.userId);
  return u || null;
}

/* Anti-abuse limiters */
function limitPerIp(minIntervalMs){
  const lastByIp = new Map(); // ip -> lastTimestamp
  return function(req, res, next){
    const ip = getClientIp(req);
    const now = Date.now();
    const last = lastByIp.get(ip) || 0;
    const diff = now - last;
    if (diff < minIntervalMs){
      const retryMs = minIntervalMs - diff;
      const retrySec = Math.ceil(retryMs / 1000);
      res.setHeader('Retry-After', retrySec);
      return res.status(429).json({
        error: 'rate_limited',
        message: `Слишком часто. Попробуйте через ${retrySec} сек.`,
        retry_after_ms: retryMs
      });
    }
    lastByIp.set(ip, now);
    next();
  };
}
const commentPerMinuteLimiter = limitPerIp(30_000); // 30 сек
const postLimiter = limitPerIp(3_000);
const authRequestLimiter = limitPerIp(10_000);
const authPollLimiter    = limitPerIp(1_000);

function createSlidingWindowLimiter({ windowMs, maxRequests }) {
  const buckets = new Map();

  function pruneOldEntries(now) {
    for (const [ip, state] of buckets.entries()) {
      if (now - state.windowStart > windowMs * 2) {
        buckets.delete(ip);
      }
    }
  }

  return function(req, res, next) {
    const ip = getClientIp(req);
    const now = Date.now();
    let state = buckets.get(ip);
    if (!state || now - state.windowStart >= windowMs) {
      state = { windowStart: now, count: 0 };
    }
    state.count += 1;
    state.windowStart = state.windowStart ?? now;
    buckets.set(ip, state);

    if (state.count > maxRequests) {
      const retryMs = windowMs - (now - state.windowStart);
      const retrySec = Math.max(1, Math.ceil(retryMs / 1000));
      res.setHeader('Retry-After', retrySec);
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Слишком много запросов. Попробуйте немного позже.',
        retry_after_ms: Math.max(0, retryMs)
      });
    }

    if (buckets.size > 1000) pruneOldEntries(now);
    next();
  };
}

const apiRateLimiter = createSlidingWindowLimiter({ windowMs: 60_000, maxRequests: 120 });
app.use('/api', apiRateLimiter);

/* GuerrillaMail helpers (Node 18: fetch встроен) */
async function gmGetEmailAddress(){
  const url = 'https://api.guerrillamail.com/ajax.php?f=get_email_address&lang=ru';
  const r = await fetch(url).catch(()=>null);
  if (!r || !r.ok) throw new Error('gm_get_email_failed');
  const j = await r.json();
  return { email: j.email_addr, sid_token: j.sid_token };
}
async function gmCheckEmail(sid_token){
  const url = `https://api.guerrillamail.com/ajax.php?f=check_email&seq=1&sid_token=${encodeURIComponent(sid_token)}`;
  const r = await fetch(url).catch(()=>null);
  if (!r || !r.ok) return [];
  const j = await r.json();
  return Array.isArray(j.list) ? j.list : [];
}
async function gmFetchEmail(sid_token, id){
  const url = `https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${encodeURIComponent(id)}&sid_token=${encodeURIComponent(sid_token)}`;
  const r = await fetch(url).catch(()=>null);
  if (!r || !r.ok) return null;
  return await r.json();
}
function extractCode(text){
  if (!text) return null;
  const m = String(text).match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}
function extractPureEmail(s){
  if (!s) return '';
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : String(s)).trim().toLowerCase();
}

/* Admins & Bans */
function readAdminEmails() {
  if (!fs.existsSync(ADMINS_CSV)) return new Set();
  const rows = parseCSV(fs.readFileSync(ADMINS_CSV, 'utf-8'));
  if (!rows.length) return new Set();
  let start = 0;
  const headerJoin = rows[0].map(x => String(x||'').toLowerCase()).join(',');
  if (headerJoin.includes('email')) start = 1;
  const set = new Set();
  for (let i = start; i < rows.length; i++) {
    const email = String(rows[i][0] || '').trim().toLowerCase();
    if (email) set.add(email);
  }
  return set;
}
let ADMIN_EMAILS = readAdminEmails(); // читаем один раз при старте (CSV неизменяемый)
function isAdminUser(u) {
  const email = String(u?.email || '').toLowerCase();
  return ADMIN_EMAILS.has(email);
}

function readBansMap() {
  const map = {};
  if (!fs.existsSync(BANS_CSV)) return map;
  const rows = parseCSV(fs.readFileSync(BANS_CSV, 'utf-8'));
  if (!rows.length) return map;
  const start = dataStartIndex(rows, ['userid,is_banned']);
  for (let i=start;i<rows.length;i++){
    const [userId,is_banned,reason,ts] = rows[i];
    if (!userId) continue;
    map[String(userId)] = { is_banned: String(is_banned||'0')==='1', reason: reason||'', ts: Number(ts||0) };
  }
  return map;
}
function writeBansMap(map) {
  let out = 'userId,is_banned,reason,ts\n';
  for (const uid of Object.keys(map)) {
    const r = map[uid] || { is_banned:false, reason:'', ts: Date.now() };
    out += toCSVRow([uid, r.is_banned ? '1':'0', r.reason||'', r.ts||Date.now()]);
  }
  fs.writeFileSync(BANS_CSV, out, 'utf-8');
}
let BANS = readBansMap();
function isUserBanned(userId) { return !!(userId && BANS[String(userId)]?.is_banned); }

/* API — публичные */
app.get('/api/departments',(req,res)=>{
  const set=new Set(TEACHERS.map(t=>t.department).filter(Boolean));
  res.json({departments:[...set].sort(new Intl.Collator('ru',{sensitivity:'base'}).compare)});
});
app.get('/api/teachers',(req,res)=>{
  const rmap=readRatingsMap();
  const teachers=TEACHERS.map(t=>{
    const ratings={}; for(const k of CHARACTERISTICS_KEYS){ ratings[k]=rmap[t.id]?.[k] || {sum:0,count:0}; }
    return {...t, ratings, overall:overall(ratings)};
  });
  res.json({teachers});
});
app.get('/api/teacher/:id',(req,res)=>{
  const t=TEACHERS.find(x=>x.id===req.params.id);
  if(!t) return res.status(404).json({error:'not_found'});
  const rmap=readRatingsMap(); const ratings={}; for(const k of CHARACTERISTICS_KEYS) ratings[k]=rmap[t.id]?.[k] || {sum:0,count:0};
  const commentsRaw=readCommentsFor(t.id);
  const u = getUserFromRequest(req);
  const myId = u?.id || null;
  const amAdmin = isAdminUser(u);

  const ids = commentsRaw.map(c=>String(c.id));
  const {counts, myVotes} = countVotesForCommentBulk(ids, myId);

  const comments = commentsRaw.map(c=>{
    const base = {
      id: c.id,
      teacherId: c.teacherId,
      ts: c.ts,
      ts_iso: c.ts_iso,
      author: c.author,
      text: c.text,
      likes: (counts[String(c.id)]?.likes)||0,
      dislikes: (counts[String(c.id)]?.dislikes)||0,
      myVote: myVotes[String(c.id)]||0,
      isOwn: !!(myId && c.author_uid && String(c.author_uid)===String(myId))
    };
    if (amAdmin) {
      const au = c.author_uid ? findUserById(String(c.author_uid)) : null;
      return { ...base, author_uid: c.author_uid||'', author_email: au?.email || '' };
    }
    return base;
  });

  res.json({...t, ratings, comments, overall:overall(ratings)});
});

/* Сильная модерация мата */
// Нормализация и проверка: кир/лат, 1337, пробелы/символы, удвоения
const BAD_STEMS = [
  'бля','бляд','хуй','хуе','пизд','еб','ёб','сука','сук','мраз','гандон',
  'пидор','пидр','чмо','урод','нахуй','нехуй','охуе','долбоёб','долбаёб','долбаеб','долбоеб'
];
const LAT2CYR = { 'a':'а','b':'в','c':'с','e':'е','h':'н','k':'к','m':'м','o':'о','p':'р','t':'т','x':'х','y':'у' };
const LEET = { '0':'о','1':'i','3':'е','4':'а','5':'с','6':'б','7':'т','8':'в','9':'д' };

function normalizeForBadWords(s){
  let t = String(s||'').toLowerCase();
  t = t.replace(/[0-9]/g, ch => LEET[ch] || ch);
  t = t.replace(/[a-z]/g, ch => LAT2CYR[ch] || ch);     // латиница → «похожие» кириллические
  t = t.replace(/[\s\.\,\-\_\*\+\=\!\?\(\)\[\]\{\}\/\\\|\'\"\:;@#\$%^&`~]+/g,''); // убрать разделители
  t = t.replace(/(.)\1{2,}/g, '$1$1');                   // сжать длинные повторения
  return t;
}
function hasBadWords(text){
  const norm = normalizeForBadWords(text);
  return BAD_STEMS.some(st => norm.includes(st));
}

/* Комментарии + рейтинг + учёт статистики
   ТРЕБОВАНИЕ: если текст пустой, но есть оценки — сохраняем только оценки (коммент не публикуем).
   Бан блокирует ТОЛЬКО текстовые комментарии; оценки без текста разрешены. */
app.post('/api/comment-with-ratings', commentPerMinuteLimiter, (req,res)=>{
  const {teacherId,text,author,ratings}=req.body||{};
  if(!teacherId) return res.status(400).json({error:'bad_request'});

  const t=TEACHERS.find(x=>x.id===teacherId); if(!t) return res.status(404).json({error:'teacher_not_found'});

  const u = getUserFromRequest(req);
  const userId = u?.id || '';
  const authorName = String(author||'Аноним').slice(0,64);
  const textStr = String(text||'').trim();

  const hasRatings = ratings && typeof ratings==='object' && Object.keys(ratings).some(k=>{
    const v=Number(ratings[k]); return CHARACTERISTICS_KEYS.includes(k) && v>=1 && v<=5;
  });

  if(!textStr && !hasRatings){
    return res.status(400).json({error:'bad_request', message:'empty'});
  }
  if (textStr && u && isUserBanned(u.id)) {
    return res.status(403).json({ error:'banned', message:'commenting_banned' });
  }
  if (textStr && hasBadWords(textStr)) return res.status(400).json({ error: 'profanity_forbidden' });

  // (а) публикуем комментарий, только если есть текст
  if (textStr){
    appendCommentRow({teacherId,author:authorName,text:textStr,author_uid:userId});
  }

  // (б) обновляем рейтинг
  if(hasRatings){
    const map=readRatingsMap(); (map[teacherId] ||= {});
    for(const k of Object.keys(ratings)){ if(!CHARACTERISTICS_KEYS.includes(k)) continue;
      const v=Number(ratings[k]); if(!(v>=1&&v<=5)) continue;
      const cur=map[teacherId][k] || {sum:0,count:0}; cur.sum+=v; cur.count+=1; map[teacherId][k]=cur;
    }
    writeRatingsMap(map);
  }

  // --- учёт статистики пользователя ---
  if (u){
    let validRatings = 0;
    if (ratings && typeof ratings==='object'){
      for (const k of Object.keys(ratings)){
        const v = Number(ratings[k]);
        if (CHARACTERISTICS_KEYS.includes(k) && v>=1 && v<=5) validRatings++;
      }
    }
    incUserStats(u.id, { comments: textStr ? 1 : 0, ratings: validRatings });
  }

  const rmap=readRatingsMap(); const retRatings={}; for(const k of CHARACTERISTICS_KEYS) retRatings[k]=rmap[teacherId]?.[k] || {sum:0,count:0};
  const comments=readCommentsFor(teacherId);
  res.json({ok:true, teacher:{...t, ratings:retRatings, comments, overall:overall(retRatings)}});
});

/* Голосование за комментарии (лайк/дизлайк/снятие голоса) */
app.post('/api/comment/vote', postLimiter, (req,res)=>{
  const u = getUserFromRequest(req);
  if (!u) return res.json({error:'unauthorized'});

  const {commentId, vote} = req.body || {};
  const c = getCommentById(commentId);
  if (!c) return res.json({error:'not_found'});

  if (c.author_uid && String(c.author_uid)===String(u.id)){
    return res.json({error:'forbidden'});
  }

  const newVote = vote==='like' ? 1 : vote==='dislike' ? -1 : 0;
  const prev = getUserVote(commentId, u.id);

  if (prev === newVote){
    // idempotent: просто вернём текущее состояние
    const {counts} = countVotesForCommentBulk([String(commentId)], u.id);
    const cnt = counts[String(commentId)] || {likes:0,dislikes:0};
    return res.json({ok:true, likes:cnt.likes, dislikes:cnt.dislikes, myVote:newVote});
  }

  // применяем
  setUserVote(commentId, u.id, newVote);

  // дельты по статистике
  const cast_like     = (newVote===1?1:0)  - (prev===1?1:0);
  const cast_dislike  = (newVote===-1?1:0) - (prev===-1?1:0);
  const recv_like     = cast_like;    // для автора коммента
  const recv_dislike  = cast_dislike; // для автора коммента

  // обновим статистику голосовавшего
  if (cast_like || cast_dislike) incUserStats(u.id, { cast_like, cast_dislike });

  // обновим статистику автора комментария
  if (c.author_uid) incUserStats(String(c.author_uid), { recv_like, recv_dislike });

  const {counts} = countVotesForCommentBulk([String(commentId)], u.id);
  const cnt = counts[String(commentId)] || {likes:0,dislikes:0};
  res.json({ok:true, likes:cnt.likes, dislikes:cnt.dislikes, myVote:newVote});
});

/* Админ утилиты */
function requireAdmin(req,res,next){
  const u = getUserFromRequest(req);
  if (!u) return res.status(401).json({error:'unauthorized'});
  if (!isAdminUser(u)) return res.status(403).json({error:'forbidden'});
  req.user = u;
  next();
}

function deleteCommentById(commentId){
  const all = readCommentsAll();
  const target = all.find(c => String(c.id)===String(commentId));
  if (!target) return { ok:false, error:'not_found' };

  // считаем лайки/дизлайки по комменту для корректировки стат
  const { counts } = countVotesForCommentBulk([String(commentId)], null);
  const cnt = counts[String(commentId)] || { likes:0, dislikes:0 };

  // вычтем у автора полученные лайки/дизлайки и комментарий
  if (target.author_uid) {
    incUserStats(String(target.author_uid), {
      comments: -1,
      recv_like: -(cnt.likes||0),
      recv_dislike: -(cnt.dislikes||0)
    });
  }

  // сохраняем comments.csv без этого комментария
  let out = 'id,teacherId,ts,ts_iso,author,text,author_uid\n';
  for (const c of all) {
    if (String(c.id)===String(commentId)) continue;
    out += toCSVRow([c.id,c.teacherId,c.ts,c.ts_iso,c.author,c.text,c.author_uid||'']);
  }
  fs.writeFileSync(COMMENTS_CSV, out, 'utf-8');

  // чистим голоса по нему
  const votes = readVotesRows().filter(v => String(v.commentId)!==String(commentId));
  writeVotesRows(votes);

  return { ok:true };
}

/* --- Admin API --- */
// пользователи, оставлявшие комментарии
app.get('/api/admin/commenters', requireAdmin, (req,res)=>{
  const comments = readCommentsAll();
  const counts = {};
  const lastTs = {};
  for (const c of comments) {
    const uid = String(c.author_uid||'').trim();
    if (!uid) continue;
    counts[uid] = (counts[uid]||0) + 1;
    lastTs[uid] = Math.max(lastTs[uid]||0, Number(c.ts)||0);
  }

  const users = readUsersRows();
  const out = [];
  for (const u of users) {
    const uid = String(u.id||'');
    const cnt = counts[uid] || Number(u.comment_count||0) || 0;
    if (!cnt) continue;
    out.push({
      id: uid,
      email: u.email || '',
      username: u.username || '',
      comment_count: cnt,
      is_banned: isUserBanned(uid),
      last_comment_ts: lastTs[uid] || 0
    });
  }

  out.sort((a,b)=>{
    if (b.comment_count !== a.comment_count) return b.comment_count - a.comment_count;
    return (b.last_comment_ts||0) - (a.last_comment_ts||0);
  });

  res.json({ ok:true, users: out });
});

// комментарии конкретного пользователя
app.get('/api/admin/comments/by-user', requireAdmin, (req,res)=>{
  const userId = String(req.query.userId||'').trim();
  if (!userId) return res.status(400).json({ error:'bad_request' });

  const all = readCommentsAll().filter(c=>String(c.author_uid||'')===userId).sort((a,b)=>b.ts-a.ts);
  const teacherMap = new Map(TEACHERS.map(t=>[t.id, t]));
  const user = findUserById(userId);

  const comments = all.map(c=>{
    const teacher = teacherMap.get(c.teacherId);
    const fio = teacher ? [teacher.lastName, teacher.firstName, teacher.patronymic].filter(Boolean).join(' ') : '';
    return {
      id: c.id,
      teacherId: c.teacherId,
      teacher_name: fio,
      ts: c.ts,
      ts_iso: c.ts_iso,
      text: c.text || ''
    };
  });

  res.json({
    ok: true,
    user: user ? {
      id: user.id,
      email: user.email || '',
      username: user.username || '',
      is_banned: isUserBanned(user.id)
    } : { id: userId, email: '', username: '', is_banned: isUserBanned(userId) },
    comments
  });
});

// полный список пользователей с флагом бана
app.get('/api/admin/users', requireAdmin, (req,res)=>{
  const users = readUsersRows();
  const collator = new Intl.Collator('ru', { sensitivity:'base' });
  const out = users.map(u=>({
    id: u.id,
    email: u.email || '',
    username: u.username || '',
    comment_count: Number(u.comment_count||0) || 0,
    rating_count: Number(u.rating_count||0) || 0,
    is_banned: isUserBanned(u.id)
  })).sort((a,b)=>collator.compare(a.email||'', b.email||''));
  res.json({ ok:true, users: out });
});

// последние N комментариев (для модерации, быстрый просмотр)
app.get('/api/admin/comments', requireAdmin, (req,res)=>{
  const limit = Math.max(1, Math.min(500, Number(req.query.limit||100)));
  const all = readCommentsAll().sort((a,b)=>b.ts-a.ts).slice(0,limit);
  const out = all.map(c=>{
    const u = c.author_uid ? findUserById(String(c.author_uid)) : null;
    return {
      id:c.id, teacherId:c.teacherId, ts:c.ts, ts_iso:c.ts_iso,
      text:c.text, author:c.author,
      author_uid:c.author_uid||'',
      author_email:u?.email||''
    };
  });
  res.json({ ok:true, comments: out });
});

// удалить комментарий
app.post('/api/admin/comment/delete', requireAdmin, express.json(), (req,res)=>{
  const { commentId } = req.body || {};
  if (!commentId) return res.status(400).json({error:'bad_request'});
  const r = deleteCommentById(commentId);
  if (!r.ok) return res.status(404).json(r);
  return res.json({ ok:true });
});

// поиск пользователя и бан/разбан комментирования
app.get('/api/admin/user/find', requireAdmin, (req,res)=>{
  const email = String(req.query.email||'').toLowerCase().trim();
  if (!email) return res.status(400).json({error:'bad_request'});
  const u = findUserByEmail(email);
  if (!u) return res.status(404).json({error:'not_found'});
  return res.json({ ok:true, user: { id:u.id, email:u.email, username:u.username, is_banned:isUserBanned(u.id) } });
});

app.post('/api/admin/user/ban', requireAdmin, express.json(), (req,res)=>{
  const { email, userId, banned, reason } = req.body || {};
  let u = null;
  if (userId) u = findUserById(String(userId));
  if (!u && email) u = findUserByEmail(String(email).toLowerCase());
  if (!u) return res.status(404).json({ error:'user_not_found' });

  BANS = readBansMap();
  BANS[String(u.id)] = { is_banned: !!banned, reason: String(reason||''), ts: Date.now() };
  writeBansMap(BANS);
  return res.json({ ok:true, user: { id:u.id, email:u.email, is_banned: !!banned } });
});

// список учителей / CRUD учителей
app.get('/api/admin/teachers', requireAdmin, (req,res)=>{
  return res.json({ ok:true, teachers: TEACHERS });
});

app.post('/api/admin/teacher/upsert', requireAdmin, express.json(), (req,res)=>{
  const { id, lastName, firstName, patronymic, department, subjects, photo } = req.body || {};
  upsertTeacher({ id, lastName, firstName, patronymic, department, subjects, photo });
  return res.json({ ok:true, total: TEACHERS.length });
});

app.post('/api/admin/teacher/delete', requireAdmin, express.json(), (req,res)=>{
  const { id } = req.body || {};
  if (!id) return res.status(400).json({error:'bad_request'});
  deleteTeacherById(String(id));
  return res.json({ ok:true, total: TEACHERS.length });
});

/* Старый лог входа/выхода (опционально) */
app.post('/api/auth/log', postLimiter, (req,res)=>{
  const {action,email}=req.body||{}; const a=(action||'').toLowerCase();
  if(!['login','logout'].includes(a)) return res.status(400).json({error:'bad_action'});
  const ip=(req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '';
  const ua=req.headers['user-agent']||''; const ts=Date.now();
  fs.appendFileSync(LOGIN_CSV,toCSVRow([ts,new Date(ts).toISOString(),a,(email||'').slice(0,100),ip,ua]),'utf-8');
  res.json({ok:true});
});

/* ---- Email-based auth ---- */
app.post('/api/auth/request', authRequestLimiter, async (req,res)=>{
  try{
    let email, sid_token;
    try{
      const r = await gmGetEmailAddress();
      email = r.email; sid_token = r.sid_token;
    }catch{
      const random = Math.random().toString(36).slice(2,10);
      email = `${random}@guerrillamailblock.com`;
      sid_token = null;
    }

    const code = ('' + Math.floor(100000 + Math.random()*900000)).slice(0,6);
    const sessionId = 'a-' + crypto.randomBytes(9).toString('hex');

    PENDING_AUTH.set(sessionId, {
      email, sid_token, code,
      created: Date.now(),
      seenIds: new Set(),
      verified: false,
      ip: getClientIp(req),
      ua: req.headers['user-agent']||''
    });

    return res.json({
      ok:true,
      session_id: sessionId,
      email,
      code,
      check_every_ms: AUTH_CHECK_INTERVAL_MS,
      expires_in_ms: AUTH_SESSION_TTL_MS,
      required_domain: ALLOWED_EMAIL_DOMAIN
    });
  }catch{
    return res.status(500).json({ error:'auth_request_failed' });
  }
});

app.get('/api/auth/poll', authPollLimiter, async (req,res)=>{
  const sessionId = String(req.query.session_id||'');
  const rec = PENDING_AUTH.get(sessionId);
  if (!rec) return res.status(404).json({ error:'no_auth_session' });

  if (Date.now() - rec.created > AUTH_SESSION_TTL_MS){
    PENDING_AUTH.delete(sessionId);
    return res.status(410).json({ error:'expired' });
  }

  if (!rec.sid_token){
    return res.json({ status:'pending' });
  }

  const list = await gmCheckEmail(rec.sid_token);
  for (const m of list){
    const id = m.mail_id || m.id;
    if (!id || rec.seenIds.has(id)) continue;
    rec.seenIds.add(id);

    const full = await gmFetchEmail(rec.sid_token, id);
    if (!full) continue;

    const fromRaw = full.mail_from || '';
    const from = extractPureEmail(fromRaw);
    const subject = full.mail_subject || '';
    const excerpt = full.mail_excerpt || '';
    const body = full.mail_body || '';

    const codeFound = extractCode(subject) || extractCode(excerpt) || extractCode(body);
    if (!codeFound) continue;

    if (codeFound !== rec.code){
      continue;
    }

    if (!from.endsWith(ALLOWED_EMAIL_DOMAIN)){
      return res.json({
        status:'wrong_domain',
        sender_email: from,
        required_domain: ALLOWED_EMAIL_DOMAIN
      });
    }

    // авторизация ок
    rec.verified = true;
    const user = upsertUserOnLogin(from);
    const token = createSession(user.id, req);
    setSessionCookie(res, token);

    try{
      fs.appendFileSync(
        LOGIN_CSV,
        toCSVRow([Date.now(), new Date().toISOString(), 'login', user.email, getClientIp(req), req.headers['user-agent']||'']),
        'utf-8'
      );
    }catch{}

    PENDING_AUTH.delete(sessionId);
    return res.json({
      ok:true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        comment_count: Number(user.comment_count||0),
        rating_count: Number(user.rating_count||0),
        cast_likes: Number(user.cast_likes||0),
        cast_dislikes: Number(user.cast_dislikes||0),
        received_likes: Number(user.received_likes||0),
        received_dislikes: Number(user.received_dislikes||0),
        is_admin: isAdminUser(user),
        is_banned: isUserBanned(user.id)
      }
    });
  }
  return res.json({ status:'pending' });
});

// Текущий пользователь (+флаги admin/ban)
app.get('/api/auth/me', (req,res)=>{
  const u = getUserFromRequest(req);
  if (!u) return res.json({ loggedIn:false });
  const is_admin = isAdminUser(u);
  const is_banned = isUserBanned(u.id);
  return res.json({
    loggedIn:true,
    user: {
      id: u.id,
      email: u.email,
      username: u.username,
      comment_count: Number(u.comment_count||0),
      rating_count: Number(u.rating_count||0),
      cast_likes: Number(u.cast_likes||0),
      cast_dislikes: Number(u.cast_dislikes||0),
      received_likes: Number(u.received_likes||0),
      received_dislikes: Number(u.received_dislikes||0),
      is_admin,
      is_banned
    }
  });
});

// Логаут
app.post('/api/auth/logout', postLimiter, (req,res)=>{
  const u = getUserFromRequest(req);
  clearSessionCookie(res);
  try{
    if (u){
      fs.appendFileSync(
        LOGIN_CSV,
        toCSVRow([Date.now(), new Date().toISOString(), 'logout', u.email, getClientIp(req), req.headers['user-agent']||'']),
        'utf-8'
      );
    }
  }catch{}
  return res.json({ ok:true });
});

// Статистика пользователя (для поповера; без флагов admin/ban)
app.get('/api/user/stats', (req,res)=>{
  const u = getUserFromRequest(req);
  if (!u) return res.json({ ok:false, error:'unauthorized' });
  return res.json({
    ok:true,
    user: {
      id: u.id,
      email: u.email,
      username: u.username,
      comment_count: Number(u.comment_count||0),
      rating_count: Number(u.rating_count||0),
      cast_likes: Number(u.cast_likes||0),
      cast_dislikes: Number(u.cast_dislikes||0),
      received_likes: Number(u.received_likes||0),
      received_dislikes: Number(u.received_dislikes||0),
    }
  });
});

/* Cache */
let TEACHERS = readTeachers();

app.get(/^\/(?!.*\.).*$/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, ()=>{
  console.log(`Server on http://localhost:${PORT}`);
  if(!fs.existsSync(TEACHERS_CSV)) console.warn(`⚠️ Не найден ${TEACHERS_CSV}. Положи letovo_teachers.csv в папку data/`);
});
