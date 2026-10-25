'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store, normalize, cfg } = require('./lib/store');
const { Bot } = require('./lib/bot');

// ---- โหลด .env แบบง่าย (ไม่ต้องใช้ dotenv) ----
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const ROOT = __dirname, PUBLIC = path.join(ROOT, 'public'), FW = path.join(ROOT, 'firmware');
const PORT = +process.env.PORT || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const store = new Store(path.join(ROOT, 'data', 'codes.json'));

function loadManifest() {
  return JSON.parse(fs.readFileSync(path.join(FW, 'manifest.json'), 'utf8'));
}

// ---- rate limit ความพยายามกรอกรหัสผิด ----
const fails = new Map(); // ip -> [timestamps]
function tooMany(ip) {
  const now = Date.now(), arr = (fails.get(ip) || []).filter(t => now - t < 10 * 60e3);
  fails.set(ip, arr); return arr.length >= 8;
}
const addFail = ip => fails.set(ip, [...(fails.get(ip) || []), Date.now()]);
const clientIp = req => (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const readBody = req => new Promise((resolve, reject) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 4096) { reject(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
});

const REASONS = {
  invalid: 'ไม่พบรหัสนี้ กรุณาตรวจสอบอีกครั้ง',
  used: 'รหัสนี้ถูกใช้งานไปแล้ว',
  revoked: 'รหัสนี้ถูกยกเลิก',
  expired: 'รหัสนี้หมดอายุแล้ว',
};

let bot = null;

async function api(req, res, url) {
  const ip = clientIp(req);

  // POST /api/redeem {code}
  if (req.method === 'POST' && url.pathname === '/api/redeem') {
    if (tooMany(ip)) return json(res, 429, { error: 'กรอกผิดหลายครั้งเกินไป กรุณารอ 10 นาที' });
    let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad request' }); }
    const r = store.redeem(body.code, ip);
    if (!r.ok) { addFail(ip); return json(res, 403, { error: REASONS[r.reason] }); }

    const mf = loadManifest();
    const variants = mf.variants
      .map((v, vi) => ({ v, vi }))
      .filter(({ v }) => !r.chip || v.chip.toLowerCase() === r.chip.toLowerCase())
      .map(({ v, vi }) => ({
        label: v.label, chip: v.chip, ts: v.ts,
        files: v.files.map((f, fi) => ({
          name: f.name, address: f.address, size: f.size, sha256: f.sha256,
          url: `/api/file/${r.token}/${vi}/${fi}`,
        })),
      }));
    if (r.first && bot) bot.notifyAdmins(`🟡 มีคนกรอกรหัส <code>${r.code.match(/.{4}/g).join('-')}</code> (${r.chip || 'any'}) · IP ${ip}`);
    return json(res, 200, { product: mf.product, version: mf.version, channel: 'licensed', expiresAt: r.sessionExp, variants });
  }

  // GET /api/file/:token/:vi/:fi
  let m = url.pathname.match(/^\/api\/file\/([0-9a-f]{48})\/(\d+)\/(\d+)$/);
  if (req.method === 'GET' && m) {
    const hit = store.byToken(m[1]);
    if (!hit) return json(res, 403, { error: 'เซสชันหมดอายุหรือรหัสถูกใช้แล้ว' });
    const mf = loadManifest(), v = mf.variants[+m[2]], f = v?.files[+m[3]];
    if (!f) return json(res, 404, { error: 'not found' });
    if (hit.rec.chip && v.chip.toLowerCase() !== hit.rec.chip.toLowerCase()) return json(res, 403, { error: 'รหัสนี้ใช้กับชิปอื่นไม่ได้' });
    const file = path.join(FW, f.path);
    if (!file.startsWith(FW + path.sep) || !fs.existsSync(file)) return json(res, 404, { error: 'ไม่พบไฟล์บนเซิร์ฟเวอร์' });
    if (!store.countDownload(hit.code, `${m[2]}/${m[3]}`)) return json(res, 429, { error: 'โหลดไฟล์นี้ซ้ำเกินกำหนดแล้ว' });
    res.writeHead(200, {
      'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size,
      'cache-control': 'no-store', 'content-disposition': `attachment; filename="${f.name}"`,
    });
    return fs.createReadStream(file).pipe(res);
  }

  // POST /api/complete {token}  — เรียกหลังติดตั้งสำเร็จ → เผารหัส
  if (req.method === 'POST' && url.pathname === '/api/complete') {
    let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad request' }); }
    const code = store.complete(body.token);
    if (!code) return json(res, 403, { error: 'เซสชันไม่ถูกต้อง' });
    if (bot) bot.notifyAdmins(`🔴 รหัส <code>${code.match(/.{4}/g).join('-')}</code> ติดตั้งสำเร็จ — ถูกใช้แล้ว`);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) { console.error(e); if (!res.headersSent) json(res, 500, { error: 'server error' }); }
});

function start({ port = PORT } = {}) {
  setInterval(() => store.sweep(), 60e3).unref();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    const admins = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    bot = new Bot({ token, admins, store, chips: loadManifest().variants.map(v => v.chip), siteUrl: process.env.SITE_URL });
    bot.start();
  } else console.warn('[bot] ไม่ได้ตั้ง TELEGRAM_BOT_TOKEN — บอทปิดอยู่');
  return new Promise(r => server.listen(port, () => { console.log(`[web] http://localhost:${server.address().port}`); r(server); }));
}
module.exports = { start, server, store, Bot };
if (require.main === module) start();
