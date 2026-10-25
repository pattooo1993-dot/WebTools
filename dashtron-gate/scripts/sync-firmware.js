'use strict';
// ดึงไฟล์ .bin (ชุด firmware-installer: bootloader/partitions/boot_app0/main) จาก manifest ของ GitHub มาเก็บในโฟลเดอร์ firmware/ ของเซิร์ฟเวอร์ (ตรวจ sha256 ด้วย)
// หลังจากนั้นควรตั้ง repo GitHub เป็น Private เพื่อไม่ให้ใครโหลดตรงได้
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const MANIFEST_URL = process.argv[2] || process.env.MANIFEST_URL ||
  'https://raw.githubusercontent.com/jmcumicrocontrollerunit-eng/JmcuMicrocontroller/main/firmware-installer/manifest.json';
const MAIN_ADDR = process.env.MAIN_ADDRESS || '0x10000'; // address ของ DashTron.ino.bin
const FW = path.join(__dirname, '..', 'firmware');

const { execFileSync } = require('child_process');
async function get(url) {
  const auth = process.env.FIRMWARE_GITHUB_TOKEN ? ['-H', `Authorization: token ${process.env.FIRMWARE_GITHUB_TOKEN}`] : [];
  // ใช้ curl เพราะรองรับ proxy ของระบบ (fetch ของ Node ไม่อ่าน HTTPS_PROXY)
  return execFileSync('curl', ['-fsSL', '--retry', '2', ...auth, url], { maxBuffer: 64 << 20 });
}
(async () => {
  const src = JSON.parse((await get(MANIFEST_URL)).toString());
  const out = { product: src.product, version: src.version || null, variants: [] };
  for (const v of src.variants) {
    const files = [];
    // รูปแบบใหม่ (installer): มี files[] พร้อม address ครบ · รูปแบบเก่า: main + ota
    const items = Array.isArray(v.files) && v.files.length
      ? v.files.map(f => ({ ...f, tag: f.kind || 'part' }))
      : [{ ...v, address: MAIN_ADDR, tag: 'main' }, ...(v.ota ? [{ ...v.ota, tag: 'ota' }] : [])];
    for (const f of items) {
      const buf = await get(f.url);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (f.sha256 && sha !== f.sha256) throw new Error(`sha256 ไม่ตรง: ${f.path}`);
      const rel = path.join(v.chip, f.tag, f.name);
      fs.mkdirSync(path.dirname(path.join(FW, rel)), { recursive: true });
      fs.writeFileSync(path.join(FW, rel), buf);
      files.push({ name: f.name, path: rel, address: f.address, size: buf.length, sha256: sha });
      console.log(`✔ ${v.chip}/${f.tag} ${f.name} ${buf.length} B @ ${f.address}`);
    }
    out.variants.push({ chip: v.chip, label: v.label, ts: v.ts, files });
  }
  fs.writeFileSync(path.join(FW, 'manifest.json'), JSON.stringify(out, null, 2));
  console.log('เขียน firmware/manifest.json แล้ว');
})().catch(e => { console.error('ผิดพลาด:', e.message); process.exit(1); });
