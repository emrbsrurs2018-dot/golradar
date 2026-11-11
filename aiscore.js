'use strict';

/*
 * aiscore.js — AiScore'dan canlı skor/dakika okur (ikinci veri kaynağı).
 *
 * Neden böyle: api.aiscore.com doğrudan isteklerde 520/403 dönüyor (Cloudflare +
 * origin bot koruması). Mobil site m.aiscore.com ise sunucu tarafında render
 * ediliyor ve maç listesini window.__NUXT__ içine gömüyor. Bu modül o gömülü
 * durumu çözüp FotMob'un veri vermediği maçlarda skor/dakika sağlıyor.
 *
 * Kullanım:
 *   node aiscore.js --test      # çek ve ilk 10 maçı yazdır
 *   node aiscore.js --cerez     # çerezi tazele
 *
 * Programatik:
 *   const ai = require('./aiscore');
 *   const liste = await ai.canliMaclar();   // [{ id, ev, dep, skor:[h,a], dakika, lig }]
 *   const saglik = ai.saglik();
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const vm = require('vm');

const APP_DIR = __dirname;
const VERI = path.join(APP_DIR, 'aiscore.json');
const ON = 'window.__NUXT__=';
const CACHE_MS = 15000;
const COOKIE_OMUR_MS = 25 * 60 * 1000;

const CACHE_DOSYA = path.join(APP_DIR, 'aiscore-son.json');
let son = { ts: 0, liste: [], hata: null, kod: null, cerez: 0 };
try {
  const k = JSON.parse(fs.readFileSync(CACHE_DOSYA, 'utf8'));
  if (k && Array.isArray(k.liste)) son = { ...k, hata: 'önbellek' };
} catch (_) {}

function cerezOku() {
  try {
    const v = JSON.parse(fs.readFileSync(VERI, 'utf8'));
    if (!v.cookie || !v.ua) return null;
    return v;
  } catch (_) { return null; }
}

function httpGet(url, v) {
  return new Promise((res) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': v.ua,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'tr,en;q=0.9',
        'Cookie': v.cookie
      },
      timeout: 35000
    }, (r) => {
      let s = r;
      const e = r.headers['content-encoding'];
      if (e === 'gzip') s = r.pipe(zlib.createGunzip());
      else if (e === 'br') s = r.pipe(zlib.createBrotliDecompress());
      let d = '';
      s.setEncoding('utf8');
      s.on('data', (c) => (d += c));
      s.on('end', () => res({ kod: r.statusCode, d }));
    });
    req.on('error', (e) => res({ hata: e.message }));
    req.on('timeout', () => req.destroy(new Error('zaman aşımı')));
  });
}

function nuxtCoz(html) {
  const i = html.indexOf(ON);
  if (i < 0) return null;
  const bas = i + ON.length;
  const sonIx = html.indexOf('</script>', bas);
  if (sonIx < 0) return null;
  const sandbox = { console: { log() {}, warn() {}, error() {} }, document: {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ON + html.slice(bas, sonIx).trim(), sandbox, { timeout: 8000 });
  return sandbox.window.__NUXT__;
}

/*
 * Dakika hesabı — AiScore alanlarının gerçek anlamı:
 *
 *   statusId 1 = başlamadı, 2 = ilk yarı, 3 = devre arası,
 *            4 = ikinci yarı, 5 = bitti
 *   times.tmrSecs    = dönem çapası (devre arası 2700 = 45:00,
 *                      ikinci yarı 2700 = 45:00, bitiş 5400 = 90:00)
 *   times.tmrUpdated = o çapanın yazıldığı an (dönem başlangıcı)
 *   matchTime        = başlama saati
 *
 * Eski kod tmrSecs'i doğrudan dakika sayıp "site güncellemiyorsa ileri say"
 * diye her dakika +1 ekliyordu. Sonuç: ikinci yarısı 75' olan maç 45'
 * görünüyor, sonra 45'ten 56'ya doğru şişiyordu (bildirimlerdeki "56 / 45"
 * karmaşası). Artık ilk yarı başlama saatinden, ikinci yarı dönem çapasından
 * hesaplanıyor; dakika geri gitmiyor.
 */
const DURUM = { BASLAMADI: 1, ILK_YARI: 2, DEVRE_ARASI: 3, IKINCI_YARI: 4, BITTI: 5 };
const DEVRE_ARASI_DK = 15;
const saatBilgi = new Map(); // id -> { sonDk, durum, ts }

function dakikaCoz(m, simdiMs) {
  const t = m.times || {};
  const sn = Number(t.tmrSecs) || 0;
  const upd = Number(t.tmrUpdated) || 0;
  const durum = Number(m.statusId) || 0;
  const simdi = Number(simdiMs) || Date.now();
  const simdiSn = simdi / 1000;
  const b = saatBilgi.get(m.id) || { sonDk: null, durum: null, ts: 0 };
  const kalkis = Number(m.matchTime) || 0;
  const gecen = kalkis > 0 ? (simdiSn - kalkis) / 60 : null;

  let dk = null;
  if (durum === DURUM.DEVRE_ARASI) {
    dk = 45;
  } else if (durum === DURUM.BITTI) {
    dk = 90;
  } else if (durum === DURUM.BASLAMADI) {
    dk = 0;
  } else if (durum === DURUM.ILK_YARI) {
    // İlk yarı: başlama saatinden bu yana (45+uzatma dahil)
    if (gecen != null) dk = Math.min(gecen, 55);
    else if (sn > 0) dk = sn / 60;
  } else if (durum === DURUM.IKINCI_YARI) {
    // İkinci yarı: dönem çapası (tmrSecs + tmrUpdated) ile 45'ten ileri say
    const capadan = sn > 0 && upd > 0 ? (sn + (simdiSn - upd)) / 60 : null;
    const duvardan = gecen != null && gecen > 45 ? gecen - DEVRE_ARASI_DK : null;
    if (capadan != null && duvardan != null) {
      // İki tahmin kopuksa duvar saati daha güvenilir
      const sec = Math.abs(capadan - duvardan) <= 12 ? capadan : duvardan;
      dk = Math.max(45, sec);
    } else if (capadan != null) {
      dk = Math.max(45, capadan);
    } else if (duvardan != null) {
      dk = duvardan;
    }
  } else if (gecen != null) {
    dk = gecen; // bilinmeyen durum: duvar saatinden tahmin
  }

  if (dk == null) {
    saatBilgi.set(m.id, { ...b, durum, ts: simdi });
    return null;
  }

  dk = Math.max(0, Math.min(95, Math.round(dk))); // normal süre üst sınırı (90+5)
  if (b.sonDk != null) {
    // Fiziksel sınır: dakika, son gözlemden bu yana geçen süreden hızlı artamaz.
    // "2. yarı 96'" gibi şişmeleri ve ani zıplamaları keser.
    const gecenDk = (simdi - (b.ts || simdi)) / 60000;
    const ust = b.sonDk + gecenDk + 2;
    if (dk > ust) dk = Math.max(b.sonDk, Math.round(ust));
    // Geri gitme koruması. Devre arasına geçiş (45) tek istisna: o zaman düzeltme.
    if (dk < b.sonDk - 1 && durum !== DURUM.DEVRE_ARASI) dk = b.sonDk;
  }
  saatBilgi.set(m.id, { sonDk: dk, durum, ts: simdi });
  return dk;
}

function listeyeCevir(nuxt) {
  const fh = nuxt?.state?.['football/home'];
  if (!fh) return [];
  const ms = fh.matchesData_matches || {};
  const takim = fh.matchesTeamMap || {};
  const comp = fh.matchesCompMap || {};
  const out = [];
  for (const m of Object.values(ms)) {
    if (!m || !m.id) continue;
    const ev = takim[m.homeTeam?.id]?.name || m.homeTeam?.name;
    const dep = takim[m.awayTeam?.id]?.name || m.awayTeam?.name;
    if (!ev || !dep) continue;
    const hs = Array.isArray(m.homeScores) ? Number(m.homeScores[0]) || 0 : 0;
    const as = Array.isArray(m.awayScores) ? Number(m.awayScores[0]) || 0 : 0;
    out.push({
      id: m.id,
      ev,
      dep,
      skor: [hs, as],
      dakika: dakikaCoz(m),
      durum: m.statusId,
      // 3 (devre arası) de "canlı" sayılır: maç takipte ve ekranda kalır,
      // dakika 45'te durur. Uyarı üretimi baskiKontrol içindeki
      // macOynuyorMu() ile kesilir.
      canli: !!(m.times && m.times.ticking) || m.matchStatus === 2 || Number(m.statusId) === 3,
      lig: m.competition?.name || comp[m.competition?.id]?.name || null
    });
  }
  return out;
}

async function canliMaclar(zorla = false) {
  if (!zorla && Date.now() - son.ts < CACHE_MS) return son.liste;

  let v = cerezOku();
  if (!v) { son = { ts: Date.now(), liste: [], hata: 'çerez yok (node aiscoreCookie.js)', kod: null, cerez: 0 }; return son.liste; }

  if (Date.now() - v.ts > COOKIE_OMUR_MS) {
    try {
      const { cerezTazele } = require('./aiscoreCookie');
      v = await cerezTazele();
    } catch (_) { /* eski çerezle devam */ }
  }

  let r = await httpGet('https://m.aiscore.com/', v);
  for (let i = 0; i < 2 && (!r.d || r.kod !== 200); i++) {
    await new Promise((x) => setTimeout(x, 800 * (i + 1)));
    r = await httpGet('https://m.aiscore.com/', v);
  }
  // 403/520 = Cloudflare bot bloğu: çerez bayatlamış olur. Bir kez tazeleyip
  // tekrar dene; eskiden bu durumda 40 dakika boyunca boş liste dönüyordu.
  if (!r.d || r.kod !== 200) {
    const blok = [403, 503, 520, 521, 522].includes(Number(r.kod));
    if (blok) {
      try {
        const { cerezTazele } = require('./aiscoreCookie');
        v = await cerezTazele();
        await new Promise((x) => setTimeout(x, 1200));
        r = await httpGet('https://m.aiscore.com/', v);
      } catch (_) { /* çerez de olmadıysa aşağıdaki hata yoluna düşer */ }
    }
  }
  if (!r.d || r.kod !== 200) {
    const yas = Date.now() - (son.ts || 0);
    if (son.liste && son.liste.length) {
      son = { ...son, hata: `HTTP ${r.kod || r.hata} (${Math.round(yas / 1000)}s önceki liste)` };
      return son.liste;
    }
    son = { ts: Date.now(), liste: [], hata: `HTTP ${r.kod || r.hata}`, kod: r.kod, cerez: v.cookie.length };
    return son.liste;
  }
  const nx = nuxtCoz(r.d);
  const liste = nx ? listeyeCevir(nx) : [];
  try {
    if (liste.length) fs.writeFileSync(CACHE_DOSYA, JSON.stringify({ ts: Date.now(), liste }));
  } catch (_) {}
  son = {
    ts: Date.now(),
    liste,
    hata: liste.length ? null : 'maç bulunamadı',
    kod: r.kod,
    cerez: v.cookie.length
  };
  return liste;
}

function saglik() {
  return { ...son, yas: Date.now() - son.ts };
}

module.exports = { canliMaclar, saglik, cerezOku, nuxtCoz, listeyeCevir, dakikaCoz, httpGet };

// AiScore statsCevir: 22 = toplam şut, 21 = isabetli şut (isabet her zaman
// toplamdan küçük olmalı; ters eşlemede 6 şut / 2 isabet gibi saçma değerler
// çıkıyordu ve model yanlış besleniyordu).
const STAT = { sut: 22, isabet: 21, korner: 2, faul: 6, atak: 23, tehlikeli: 24, topla: 25 };
function statsCevir(items) {
  if (!items) return null;
  const al = (id) => {
    const x = items[id] || items[String(id)];
    return x ? [Number(x.home) || 0, Number(x.away) || 0] : null;
  };
  const sut = al(STAT.sut);
  const isabet = al(STAT.isabet);
  // AiScore alan sırası maça göre değişebiliyor: isabet her zaman toplamdan
  // küçük olmalı. Ters gelirse yer değiştir (0-1 şut / 2-4 isabet hatası).
  if (sut && isabet) {
    for (const i of [0, 1]) {
      if (Number(isabet[i]) > Number(sut[i])) {
        const t = sut[i];
        sut[i] = isabet[i];
        isabet[i] = t;
      }
    }
  }
  if (!sut && !isabet) return null;
  const korner = al(STAT.korner) || [0, 0];
  return { sut: sut || [0, 0], sot: isabet || [0, 0], korner, atak: al(STAT.atak), tehlikeli: al(STAT.tehlikeli), topla: al(STAT.topla) };
}
module.exports.statsCevir = statsCevir;

const detayCache = new Map();
async function detay(id, taze) {
  const c = detayCache.get(id);
  // Sıcak maçta (gol baskısı yüksek) önbellek atlanır: 25 sn'lik bayat veri
  // yüzünden uyarı gol geldikten sonra çıkıyordu.
  if (!taze && c && Date.now() - c.t < 25000) return c.v;
  const v = cerezOku();
  if (!v) return null;
  for (let i = 0; i < 3; i++) {
    const r = await httpGet('https://m.aiscore.com/match-x/' + id, v);
    if (r.d && r.kod === 200) {
      const nx = nuxtCoz(r.d);
      const d = nx && nx.state && nx.state['football/detail'];
      if (d) {
        const out = { stats: statsCevir(d.stats && d.stats.items), match: d.WebMatchData && d.WebMatchData.match };
        detayCache.set(id, { t: Date.now(), v: out });
        return out;
      }
    }
    await new Promise((r2) => setTimeout(r2, 400 * (i + 1)));
  }
  return null;
}
module.exports.detay = detay;

if (require.main === module) {
  (async () => {
    if (process.argv.includes('--cerez')) {
      const { cerezTazele } = require('./aiscoreCookie');
      const p = await cerezTazele();
      console.log('çerez tazelendi:', new Date(p.ts).toLocaleString('tr-TR'));
      return;
    }
    const liste = await canliMaclar(true);
    const s = saglik();
    console.log(`AiScore · ${liste.length} maç · HTTP ${s.kod} · hata: ${s.hata || '-'}`);
    for (const m of liste.slice(0, 15)) {
      console.log(`  ${m.canli ? '●' : ' '} ${m.dakika ?? '-'}' ${m.ev} ${m.skor[0]}-${m.skor[1]} ${m.dep}${m.lig ? ' · ' + m.lig : ''}`);
    }
  })().catch((e) => { console.error('hata:', e.message); process.exit(1); });
}

