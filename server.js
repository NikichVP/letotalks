// server.js — Node 18+ : npm i express
// http://localhost:3000
//
// CSV:
//  data/letovo_teachers.csv
//  data/comments.csv          (может быть БЕЗ заголовка)  ← фиксы
//  data/ratings.csv           (обычно с заголовком; тоже автодетект)
//  data/login_events.csv
// Фото: photos/  -> /photo/<file>

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR    = __dirname;
const DATA_DIR    = path.join(ROOT_DIR, 'data');
const PHOTO_DIR   = path.join(ROOT_DIR, 'photos');

const TEACHERS_CSV = path.join(DATA_DIR, 'letovo_teachers.csv');
const COMMENTS_CSV = path.join(DATA_DIR, 'comments.csv');
const RATINGS_CSV  = path.join(DATA_DIR, 'ratings.csv');
const LOGIN_CSV    = path.join(DATA_DIR, 'login_events.csv');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(ROOT_DIR));
app.use('/photo', express.static(PHOTO_DIR));

function ensureDirsAndFiles() {
  if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR, {recursive:true});
  if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, {recursive:true});
  if (!fs.existsSync(COMMENTS_CSV)) fs.writeFileSync(COMMENTS_CSV, 'id,teacherId,ts,ts_iso,author,text\n');
  if (!fs.existsSync(RATINGS_CSV))  fs.writeFileSync(RATINGS_CSV,  'teacherId,key,sum,count\n');
  if (!fs.existsSync(LOGIN_CSV))    fs.writeFileSync(LOGIN_CSV,    'ts,ts_iso,action,email,ip,ua\n');
}
ensureDirsAndFiles();

/* CSV utils */
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
// Определяем, есть ли заголовок в первой строке
function dataStartIndex(rows, headerHints){
  if (!rows.length) return 0;
  const joined = rows[0].map(x=>String(x||'').toLowerCase()).join(',');
  for (const h of headerHints){
    if (joined.includes(h)) return 1; // есть заголовок
  }
  return 0; // нет заголовка
}

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
  const idx=n=>header.indexOf(n);
  const get=(r,n)=> (idx(n)>=0? r[idx(n)] : '');

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

/* Ratings/Comments */
const CHARACTERISTICS=['clarity','humor','strict','favorites'];

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

function readCommentsFor(tid){
  if(!fs.existsSync(COMMENTS_CSV)) return [];
  const rows=parseCSV(fs.readFileSync(COMMENTS_CSV,'utf-8'));
  if(!rows.length) return [];
  // поддержка файла с заголовком И без него
  const start = dataStartIndex(rows, ['id,teacherid','id,teacher_id','teacherid,ts','teacher_id,ts']);
  const out=[];
  for(let i=start;i<rows.length;i++){
    const [id,teacherId,ts,ts_iso,author,text]=rows[i];
    if(teacherId===tid) out.push({id:Number(id),teacherId,ts:Number(ts),ts_iso,author,text});
  }
  return out;
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
function appendCommentRow({teacherId,author='Аноним',text}){
  const ts=Date.now(); const id = nextCommentId();
  fs.appendFileSync(COMMENTS_CSV,toCSVRow([id,teacherId,ts,new Date(ts).toISOString(),author,text]),'utf-8');
  return id;
}
function overall(r){ let tot=0,cnt=0; for(const k of CHARACTERISTICS){ const v=r[k]; if(v&&v.count){ tot+=v.sum/v.count; cnt++; } } return cnt?tot/cnt:0; }

/* Cache */
let TEACHERS = readTeachers();

/* ---------- Anti-abuse: trust proxy, IP utils, limiters ---------- */
app.set('trust proxy', true);

function getClientIp(req){
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || '0.0.0.0';
}
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
const commentPerMinuteLimiter = limitPerIp(60_000);
const postLimiter = limitPerIp(3_000); // мягкий лимит для «чувствительных» POST

/* API */
app.get('/api/departments',(req,res)=>{
  const set=new Set(TEACHERS.map(t=>t.department).filter(Boolean));
  res.json({departments:[...set].sort(new Intl.Collator('ru',{sensitivity:'base'}).compare)});
});
app.get('/api/teachers',(req,res)=>{
  const rmap=readRatingsMap();
  const teachers=TEACHERS.map(t=>{
    const ratings={}; for(const k of CHARACTERISTICS){ ratings[k]=rmap[t.id]?.[k] || {sum:0,count:0}; }
    return {...t, ratings, overall:overall(ratings)};
  });
  res.json({teachers});
});
app.get('/api/teacher/:id',(req,res)=>{
  const t=TEACHERS.find(x=>x.id===req.params.id);
  if(!t) return res.status(404).json({error:'not_found'});
  const rmap=readRatingsMap(); const ratings={}; for(const k of CHARACTERISTICS) ratings[k]=rmap[t.id]?.[k] || {sum:0,count:0};
  const comments=readCommentsFor(t.id);
  res.json({...t, ratings, comments, overall:overall(ratings)});
});

/* Профанация/спам-фильтр для комментариев */
const BAD_WORDS_RE = /\b(бля|бляд|ху[йяе]|пизд|еба|сук[аи]|мраз|гандон|пидор|чмо|урод)\w*\b/i;

app.post('/api/comment-with-ratings', commentPerMinuteLimiter, (req,res)=>{
  const {teacherId,text,author,ratings}=req.body||{};
  if(!teacherId || !text || !String(text).trim()) return res.status(400).json({error:'bad_request'});
  if (BAD_WORDS_RE.test(String(text||''))) return res.status(400).json({ error: 'profanity_forbidden' });

  const t=TEACHERS.find(x=>x.id===teacherId); if(!t) return res.status(404).json({error:'teacher_not_found'});
  appendCommentRow({teacherId,author:String(author||'Аноним').slice(0,64),text:String(text).slice(0,2000)});
  if(ratings && typeof ratings==='object'){
    const map=readRatingsMap(); (map[teacherId] ||= {});
    for(const k of Object.keys(ratings)){ if(!CHARACTERISTICS.includes(k)) continue;
      const v=Number(ratings[k]); if(!(v>=1&&v<=5)) continue;
      const cur=map[teacherId][k] || {sum:0,count:0}; cur.sum+=v; cur.count+=1; map[teacherId][k]=cur;
    }
    writeRatingsMap(map);
  }
  const rmap=readRatingsMap(); const retRatings={}; for(const k of CHARACTERISTICS) retRatings[k]=rmap[teacherId]?.[k] || {sum:0,count:0};
  const comments=readCommentsFor(teacherId);
  res.json({ok:true, teacher:{...t, ratings:retRatings, comments, overall:overall(retRatings)}});
});
app.post('/api/admin/reload-teachers', postLimiter, (req,res)=>{ TEACHERS=readTeachers(); res.json({ok:true,total:TEACHERS.length}); });
app.post('/api/auth/log', postLimiter, (req,res)=>{
  const {action,email}=req.body||{}; const a=(action||'').toLowerCase();
  if(!['login','logout'].includes(a)) return res.status(400).json({error:'bad_action'});
  const ip=(req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '';
  const ua=req.headers['user-agent']||''; const ts=Date.now();
  fs.appendFileSync(LOGIN_CSV,toCSVRow([ts,new Date(ts).toISOString(),a,(email||'').slice(0,100),ip,ua]),'utf-8');
  res.json({ok:true});
});

app.listen(PORT, ()=>{
  console.log(`Server on http://localhost:${PORT}`);
  if(!fs.existsSync(TEACHERS_CSV)) console.warn(`⚠️ Не найден ${TEACHERS_CSV}. Положи letovo_teachers.csv в папку data/`);
});
