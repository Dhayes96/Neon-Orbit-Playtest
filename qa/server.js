// Tiny read-only static server for the game checkout (never writes).
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.env.GAME_DIR || '..');
const PORT = Number(process.env.PORT || 4173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.css': 'text/css',
  '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.jpg': 'image/jpeg' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const type = TYPES[path.extname(f)] || 'application/octet-stream';
    // media files are fetched in ranges (Project Zero's footage and score), so answer them like a CDN would
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let a = m[1] ? Number(m[1]) : buf.length - Number(m[2]), b = m[1] && m[2] ? Number(m[2]) : buf.length - 1;
      b = Math.min(b, buf.length - 1);
      if (a > b || a < 0) { res.writeHead(416, { 'content-range': 'bytes */' + buf.length }); return res.end(); }
      res.writeHead(206, { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${buf.length}`, 'content-length': b - a + 1 });
      return res.end(buf.subarray(a, b + 1));
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes' });
    res.end(buf);
  });
}).listen(PORT, () => console.log('serving', ROOT, 'on', PORT));
