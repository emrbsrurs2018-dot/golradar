'use strict';

/*
 * aiscoreCookie.js — AiScore'un Cloudflare çerezini tazeler.
 *
 * aiscore.com doğrudan Node isteklerini bot sayıp 403/520 döndürüyor.
 * Bu yüzden gerçek Chrome'u kısa süreliğine (görünmez pencerede) açıp
 * siteye girer, cf_clearance çerezini ve tarayıcı kimliğini aiscore.json'a yazar.
 *
 * Kullanım: node aiscoreCookie.js
 * Çıktı: aiscore.json  { cookie, ua, ts }
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_DIR = __dirname;
const CIKTI = path.join(APP_DIR, 'aiscore.json');
const PORT = 9341;
const CHROME =
  process.env.CHROME ||
  [
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe')
  ].find((p) => p && fs.existsSync(p));

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonAl = (u) =>
  new Promise((res, rej) => {
    http.get(u, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.bekleyen = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.bekleyen.has(m.id)) {
        const { res, rej } = this.bekleyen.get(m.id);
        this.bekleyen.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.bekleyen.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.bekleyen.has(id)) { this.bekleyen.delete(id); rej(new Error('cdp zaman aşımı: ' + method)); }
      }, 40000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.value;
  }
}

async function cerezTazele() {
  if (!CHROME) throw new Error('Chrome/Edge bulunamadı');
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'aiscore-prof-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profil}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-position=-32000,-32000',
    '--window-size=1000,800',
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    let hedef = null;
    for (let i = 0; i < 80; i++) {
      try {
        const liste = await jsonAl(`http://127.0.0.1:${PORT}/json/list`);
        hedef = liste.find((t) => t.type === 'page');
        if (hedef) break;
      } catch (_) {}
      await bekle(250);
    }
    if (!hedef) throw new Error('Chrome hata ayıklama portu açılmadı');

    const ws = new WebSocket(hedef.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = new CDP(ws);
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Network.enable');
    await c.send('Page.navigate', { url: 'https://www.aiscore.com/' });

    let baslik = '';
    for (let i = 0; i < 45; i++) {
      await bekle(1000);
      try { baslik = await c.eval('document.title'); } catch (_) {}
      if (baslik && !/moment|lütfen|lutfen/i.test(baslik)) break;
    }
    if (/moment|lütfen|lutfen/i.test(baslik || '')) throw new Error('Cloudflare doğrulaması geçilemedi');

    const ua = await c.eval('navigator.userAgent');
    const { cookies } = await c.send('Network.getAllCookies');
    const guzel = (cookies || []).filter((x) => /aiscore\.com$/.test(x.domain.replace(/^\./, '')) || /aiscore/.test(x.domain));
    const cookie = guzel.map((x) => `${x.name}=${x.value}`).join('; ');
    if (!/cf_clearance/.test(cookie)) throw new Error('cf_clearance çerezi alınamadı');

    const paket = { cookie, ua, ts: Date.now() };
    fs.writeFileSync(CIKTI, JSON.stringify(paket));
    ws.close();
    return paket;
  } finally {
    chrome.kill();
    await bekle(300);
    try { fs.rmSync(profil, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { cerezTazele, CIKTI };

if (require.main === module) {
  cerezTazele()
    .then((p) => console.log(`AiScore çerezi hazır (${p.cookie.length} karakter, ${new Date(p.ts).toLocaleTimeString('tr-TR')})`))
    .catch((e) => { console.error('Çerez alınamadı:', e.message); process.exit(1); });
}
