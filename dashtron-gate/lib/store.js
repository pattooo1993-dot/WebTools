'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ตัวอักษรที่ไม่สับสน (ตัด 0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 12;

const cfg = () => ({
  codeTtlMs: (+process.env.CODE_TTL_HOURS || 168) * 3600e3,
  sessionMs: (+process.env.SESSION_MINUTES || 30) * 60e3,
  maxFileDl: +process.env.MAX_FILE_DOWNLOADS || 5,
});

function normalize(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function pretty(code) {
  return code.match(/.{1,4}/g).join('-');
}

class Store {
  constructor(file) {
    this.file = file;
    this.db = { codes: {} };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) this.db = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file); // atomic
  }

  create({ chip = null, note = '', by = null } = {}) {
    let code;
    do {
      code = Array.from({ length: CODE_LEN }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
    } while (this.db.codes[code]);
    const now = Date.now();
    this.db.codes[code] = {
      status: 'new', chip, note, by,
      createdAt: now, expiresAt: now + cfg().codeTtlMs,
      token: null, sessionExp: null, activatedAt: null, usedAt: null, ip: null, dl: {},
    };
    this._save();
    return pretty(code);
  }

  // เปลี่ยนสถานะตามเวลา (lazy) — เรียกทุกครั้งก่อนอ่าน
  _refresh(code) {
    const r = this.db.codes[code];
    if (!r) return null;
    const now = Date.now();
    if (r.status === 'new' && now > r.expiresAt) { r.status = 'expired'; this._save(); }
    if (r.status === 'active' && now > r.sessionExp) {
      const served = Object.keys(r.dl).length > 0;
      if (served) { r.status = 'used'; r.usedAt = now; }       // เริ่มโหลดแล้ว → ถือว่าใช้แล้ว
      else { r.status = 'new'; r.token = null; r.sessionExp = null; } // ยังไม่ได้โหลดเลย → คืนสิทธิ์
      this._save();
    }
    return r;
  }

  get(input) {
    const code = normalize(input);
    const r = this._refresh(code);
    return r ? { code, ...r } : null;
  }

  // กรอกรหัสบนเว็บ → เปิดเซสชัน
  redeem(input, ip) {
    const code = normalize(input);
    const r = this._refresh(code);
    if (!r) return { ok: false, reason: 'invalid' };
    if (r.status === 'used') return { ok: false, reason: 'used' };
    if (r.status === 'revoked') return { ok: false, reason: 'revoked' };
    if (r.status === 'expired') return { ok: false, reason: 'expired' };
    if (r.status === 'new') {
      r.status = 'active';
      r.token = crypto.randomBytes(24).toString('hex');
      r.sessionExp = Date.now() + cfg().sessionMs;
      r.activatedAt = Date.now();
      r.ip = ip;
      this._save();
      return { ok: true, first: true, token: r.token, chip: r.chip, sessionExp: r.sessionExp, code };
    }
    // active: รีเฟรชหน้าเว็บภายในเซสชันเดิม
    return { ok: true, first: false, token: r.token, chip: r.chip, sessionExp: r.sessionExp, code };
  }

  byToken(token) {
    if (!/^[0-9a-f]{48}$/.test(token || '')) return null;
    for (const code of Object.keys(this.db.codes)) {
      const r = this.db.codes[code];
      if (r.token === token) { this._refresh(code); return r.status === 'active' && r.token === token ? { code, rec: r } : null; }
    }
    return null;
  }

  // บันทึกการโหลดไฟล์ — คืน false ถ้าเกินโควตา
  countDownload(code, key) {
    const r = this.db.codes[code];
    const n = (r.dl[key] || 0) + 1;
    if (n > cfg().maxFileDl) return false;
    r.dl[key] = n;
    this._save();
    return true;
  }

  complete(token) {
    const hit = this.byToken(token);
    if (!hit) return null;
    hit.rec.status = 'used';
    hit.rec.usedAt = Date.now();
    this._save();
    return hit.code;
  }

  revoke(input) {
    const code = normalize(input); const r = this.db.codes[code];
    if (!r) return false;
    r.status = 'revoked'; r.token = null; this._save(); return true;
  }
  // แอดมินเปิดสิทธิ์ใหม่ (เช่น ลูกค้าโหลดพลาด)
  reset(input) {
    const code = normalize(input); const r = this.db.codes[code];
    if (!r) return false;
    Object.assign(r, { status: 'new', token: null, sessionExp: null, activatedAt: null, usedAt: null, dl: {}, expiresAt: Date.now() + cfg().codeTtlMs });
    this._save(); return true;
  }
  list(status, limit = 20) {
    return Object.keys(this.db.codes).map(c => { this._refresh(c); return { code: c, ...this.db.codes[c] }; })
      .filter(r => !status || r.status === status)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  sweep() { Object.keys(this.db.codes).forEach(c => this._refresh(c)); }
}

module.exports = { Store, normalize, pretty, cfg };
