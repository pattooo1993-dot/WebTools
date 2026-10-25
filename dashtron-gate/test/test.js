'use strict';
// ทดสอบ end-to-end: Telegram ปลอม + เซิร์ฟเวอร์จริง
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.TELEGRAM_BOT_TOKEN = '123:FAKE'; process.env.ADMIN_IDS = '42';
process.env.SESSION_MINUTES = '30';

// --- Telegram ปลอม ---
const sent = []; let queue = [];
const tg = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const m = req.url.split('/').pop(); const body = b ? JSON.parse(b) : {};
    if (m === 'getUpdates') { const q = queue; queue = []; return setTimeout(() => res.end(JSON.stringify({ ok: true, result: q })), q.length ? 0 : 150); }
    if (m === 'sendMessage') sent.push(body.text);
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
});
let uid = 1; const say = (text, from = 42) => queue.push({ update_id: uid++, message: { text, chat: { id: from }, from: { id: from } } });
const wait = ms => new Promise(r => setTimeout(r, ms));
const lastCode = () => sent.filter(t => /สร้างรหัสแล้ว/.test(t)).pop().match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)[0];

(async () => {
  await new Promise(r => tg.listen(0, r));
  process.env.TELEGRAM_API = `http://127.0.0.1:${tg.address().port}`;
  const dataFile = path.join(__dirname, '..', 'data', 'codes.json'); fs.rmSync(dataFile, { force: true });
  const { start, store } = require('../server');
  const srv = await start({ port: 0 }); const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, o) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });

  // 1) แอดมิน gen รหัส / คนนอกสั่งไม่ได้
  say('/gen ST7789 1 ลูกค้าA'); say('/gen', 999); await wait(400);
  const code = lastCode(); console.log('code:', code);
  assert(!sent.some(t => t.includes('/gen') && false)); assert.strictEqual(sent.filter(t => /สร้างรหัสแล้ว/.test(t)).length, 1, 'คนนอกต้องสร้างรหัสไม่ได้');

  // 2) รหัสผิด
  let r = await post('/api/redeem', { code: 'AAAA-BBBB-CCCC' }); assert.strictEqual(r.status, 403);

  // 3) รหัสถูก (พิมพ์เล็ก/ไม่มีขีดก็ได้) → ได้เฉพาะ ST7789
  r = await post('/api/redeem', { code: code.toLowerCase().replace(/-/g, '') }); assert.strictEqual(r.status, 200);
  const j = await r.json(); assert.deepStrictEqual(j.variants.map(v => v.chip), ['ST7789']); assert.strictEqual(j.variants[0].files.length, 4);

  // 4) โหลดไฟล์ + sha256 ตรง
  const f = j.variants[0].files[0];
  const buf = Buffer.from(await (await fetch(base + f.url)).arrayBuffer());
  assert.strictEqual(require('crypto').createHash('sha256').update(buf).digest('hex'), f.sha256);
  // ชิปอื่นโหลดไม่ได้ (เดา index)
  const tok = f.url.split('/')[3]; assert.strictEqual((await fetch(`${base}/api/file/${tok}/1/0`)).status, 403);
  // token มั่ว
  assert.strictEqual((await fetch(`${base}/api/file/${'0'.repeat(48)}/0/0`)).status, 403);

  // 5) complete → รหัสถูกเผา
  assert.strictEqual((await post('/api/complete', { token: tok })).status, 200);
  r = await post('/api/redeem', { code }); assert.strictEqual(r.status, 403); assert((await r.json()).error.includes('ใช้งานไปแล้ว'));
  assert.strictEqual((await fetch(base + f.url)).status, 403, 'token ต้องใช้ไม่ได้หลังเสร็จ');

  // 6) แอดมินได้แจ้งเตือน + /status + /reset
  say(`/status ${code}`); say(`/reset ${code}`); await wait(500);
  assert(sent.some(t => t.includes('ติดตั้งสำเร็จ'))); assert(sent.some(t => t.includes('🔴 ใช้แล้ว')));
  r = await post('/api/redeem', { code }); assert.strictEqual(r.status, 200, 'reset แล้วต้องใช้ได้อีกครั้ง');

  // 7) หมดเวลาโดยยังไม่ได้โหลด → คืนสิทธิ์ ; โหลดแล้วหมดเวลา → เผา
  const c2 = store.create({}); const s2 = store.redeem(c2, 'x'); store.db.codes[c2.replace(/-/g, '')].sessionExp = Date.now() - 1;
  assert.strictEqual(store.get(c2).status, 'new');
  const c3 = store.create({}); const s3 = store.redeem(c3, 'x'); const k3 = c3.replace(/-/g, '');
  store.countDownload(k3, '0/0'); store.db.codes[k3].sessionExp = Date.now() - 1; assert.strictEqual(store.get(c3).status, 'used');

  // 8) rate limit
  for (let i = 0; i < 9; i++) r = await post('/api/redeem', { code: 'ZZZZ-ZZZZ-ZZZZ' }); assert.strictEqual(r.status, 429);

  // 9) revoke
  const c4 = store.create({}); say(`/revoke ${c4}`); await wait(400); assert.strictEqual(store.get(c4).status, 'revoked');

  // 10) path traversal บน static
  assert.strictEqual((await fetch(base + '/..%2fserver.js')).status, 404);
  assert.strictEqual((await fetch(base + '/')).status, 200); assert.strictEqual((await fetch(base + '/full.html')).status, 200);

  console.log('✅ ทุกการทดสอบผ่าน'); fs.rmSync(dataFile, { force: true }); process.exit(0);
})().catch(e => { console.error('❌', e); process.exit(1); });
