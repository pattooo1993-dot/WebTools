'use strict';
const { pretty } = require('./store');

const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const fmt = ts => ts ? new Date(ts).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '-';
const ICON = { new: '🟢 ใหม่', active: '🟡 กำลังใช้', used: '🔴 ใช้แล้ว', revoked: '⛔ ยกเลิก', expired: '⌛ หมดอายุ' };

class Bot {
  constructor({ token, admins, store, chips, siteUrl }) {
    this.token = token; this.admins = new Set(admins.map(String));
    this.store = store; this.chips = chips; this.siteUrl = siteUrl || '';
    this.offset = 0; this.stopped = false;
  }
  async api(method, body = {}, timeoutMs = 40000) {
    const r = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
    return j.result;
  }
  send(chat_id, text) {
    return this.api('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch(e => console.error('send:', e.message));
  }
  notifyAdmins(text) { for (const id of this.admins) this.send(id, text); }

  async start() {
    console.log('[bot] เริ่ม long-polling · admins =', [...this.admins].join(',') || '(ยังไม่ตั้ง)');
    while (!this.stopped) {
      try {
        const ups = await this.api('getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['message'] }, 45000);
        for (const u of ups) { this.offset = u.update_id + 1; if (u.message?.text) await this.handle(u.message).catch(e => console.error('[bot]', e)); }
      } catch (e) {
        console.error('[bot] poll error:', e.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  stop() { this.stopped = true; }

  async handle(m) {
    const chat = m.chat.id, uid = String(m.from.id);
    const [cmdRaw, ...args] = m.text.trim().split(/\s+/);
    const cmd = cmdRaw.split('@')[0].toLowerCase();

    if (cmd === '/start' || cmd === '/id') {
      return this.send(chat, `Telegram ID ของคุณ: <code>${uid}</code>\n` + (this.admins.has(uid) ? 'คุณเป็นแอดมิน · พิมพ์ /help' : 'ยังไม่ได้รับสิทธิ์ — ให้เจ้าของเพิ่ม ID นี้ใน ADMIN_IDS'));
    }
    if (!this.admins.has(uid)) return; // เงียบ ไม่ตอบคนนอก

    switch (cmd) {
      case '/help': return this.send(chat,
        '<b>คำสั่ง</b>\n' +
        '/gen [chip|any] [จำนวน] [โน้ต] — สร้างรหัสใช้ครั้งเดียว\n  เช่น <code>/gen ST7789</code>, <code>/gen ILI9341 3 ร้านA</code>\n' +
        '/status &lt;รหัส&gt; — ดูสถานะ\n/list [new|active|used|revoked|expired] — 20 รายการล่าสุด\n' +
        '/revoke &lt;รหัส&gt; — ยกเลิกรหัส\n/reset &lt;รหัส&gt; — เปิดสิทธิ์ใหม่ (กรณีลูกค้าโหลดพลาด)\n' +
        `ชิปที่รองรับ: ${this.chips.join(', ')}`);

      case '/gen': {
        let chip = null, count = 1; const rest = [...args];
        if (rest.length && (this.chips.some(c => c.toLowerCase() === rest[0].toLowerCase()) || rest[0].toLowerCase() === 'any')) {
          const w = rest.shift(); chip = w.toLowerCase() === 'any' ? null : this.chips.find(c => c.toLowerCase() === w.toLowerCase());
        }
        if (rest.length && /^\d+$/.test(rest[0])) count = Math.min(20, Math.max(1, +rest.shift()));
        const note = rest.join(' ');
        const codes = Array.from({ length: count }, () => this.store.create({ chip, note, by: uid }));
        return this.send(chat, `✅ สร้างรหัสแล้ว (${chip || 'ทุกชิป'}${note ? ' · ' + note : ''})\n\n` + codes.map(c => `<code>${c}</code>`).join('\n') +
          `\n\nใช้ได้ <b>ครั้งเดียว</b> · ส่งให้ลูกค้าไปกรอกที่ ${this.siteUrl || 'หน้าเว็บ'}`);
      }
      case '/status': {
        if (!args[0]) return this.send(chat, 'ใช้: /status XXXX-XXXX-XXXX');
        const r = this.store.get(args[0]); if (!r) return this.send(chat, '❓ ไม่พบรหัสนี้');
        return this.send(chat, this.describe(r));
      }
      case '/list': {
        const rows = this.store.list(args[0]);
        if (!rows.length) return this.send(chat, 'ไม่มีรายการ');
        return this.send(chat, rows.map(r => `${ICON[r.status]} <code>${pretty(r.code)}</code> ${r.chip || 'any'}${r.note ? ' · ' + r.note : ''}`).join('\n'));
      }
      case '/revoke': return this.send(chat, args[0] && this.store.revoke(args[0]) ? '⛔ ยกเลิกรหัสแล้ว' : '❓ ไม่พบรหัส');
      case '/reset': return this.send(chat, args[0] && this.store.reset(args[0]) ? '♻️ เปิดสิทธิ์ใหม่แล้ว (สถานะ: ใหม่)' : '❓ ไม่พบรหัส');
      default: return this.send(chat, 'ไม่รู้จักคำสั่ง · พิมพ์ /help');
    }
  }
  describe(r) {
    return `<code>${pretty(r.code)}</code>\nสถานะ: ${ICON[r.status]}\nชิป: ${r.chip || 'ทุกชิป'}${r.note ? '\nโน้ต: ' + r.note : ''}\n` +
      `สร้าง: ${fmt(r.createdAt)}\nหมดอายุ: ${fmt(r.expiresAt)}\nเริ่มใช้: ${fmt(r.activatedAt)}\nใช้เสร็จ: ${fmt(r.usedAt)}${r.ip ? '\nIP: ' + r.ip : ''}`;
  }
}
module.exports = { Bot };
