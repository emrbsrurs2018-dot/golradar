'use strict';

/*
 * GolRadar — canlı maçlarda "gol yaklaşıyor" uyarısı veren terminal sistemi.
 * Veri: FotMob açık uç noktaları (xG, şut haritası, momentum).
 * Uyarı: Windows bildirimi + ses + terminal.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const model = require('./model');
const baskiModul = require('./baskiYeni');
const zamanlayiciKur = require('./zamanlayici');
const anomali = require('./anomali');
const piyasa = require('./piyasa');
const piyasaUyari = require('./piyasaUyari');
const aiscore = require('./aiscore');
const patlama = require('./patlama');
const { benzer } = require('./oran');
const baski = (mac) => baskiModul(mac, { KAL, KAL2, KISA, model });

const APP_DIR = __dirname;
const LOG_FILE = path.join(APP_DIR, 'uyarilar.log');
const TAHMIN_FILE = path.join(APP_DIR, 'tahminler.json');
const SKOR_FILE = path.join(APP_DIR, 'skorlar.json');

// Ortam değişkenleri (cloud deployment için)
const PORT = process.env.PORT || 8080;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;
const ARGS = process.argv.slice(2);
const TEST_MODE = ARGS.includes('--test');
const LOG_ONLY = ARGS.includes('--log');

const VARSAYILAN = {
  taramaSaniye: 40,        // canlı maç listesi yenileme
  detaySaniye: 70,         // aynı maçın istatistiğini yenileme
  maxMac: 18,              // aynı anda izlenecek maç sayısı
  minDakika: 8,            // bu dakikadan önce uyarı yok
  pencereDakika: 12,       // "son X dakika" analiz penceresi
  uyariEsigi: 48,          // model yoksa kullanılan eski puan eşiği
  cokSicakEsigi: 68,       // model yoksa kullanılan eski sıcak eşiği
  uyariYuzde: 30,          // model varken: uyarı için gereken gol olasılığı (%)
  cokSicakYuzde: 42,       // model varken: "çok sıcak" eşiği (%)
  yariYuzde: 70,           // 2. yarı: "yarı sonuna kadar gol" eşiği
  yariYuzde1: 65,          // 1. yarı eşiği (taban oran daha düşük)
  yariSicakYuzde1: 74,     // 1. yarı "çok yakın" eşiği
  yariSicakYuzde: 80,      // yarı modeli "çok sıcak" ekran eşiği
  yariUyari: true,         // yarı modeli uyarı üretir (yarı sonuna kadar gol)
  yariKalanMax: null,      // null = yarının tamamı (ilk dakikadan itibaren)
  yariTekrarDakika: 10,    // yarı uyarısı kaç dakikada bir güncellenir
  yariTekrarMax: 4,        // yarı başına en fazla uyarı
  onDkUyari: true,         // 10 dakikalık model = ana uyarı ("gol yakın")
  uyariYuzde10: 28,        // 10 dk eşiği (sabit)
  uyariYuzde5: 12,         // 5 dk onay eşiği
  anlikSut5: 2,            // anlık baskı: son 5 dk bu kadar şut varsa eşik bekleme
  anlikXg5: 0.3,           // anlık baskı: son 5 dk toplam xG bu ise eşik bekleme
  otokalibre: false,       // eşiği otomatik kaydırma (sabit eşikle çakışmasın)
  uyariP5: 24,             // 5 dk'lık model tek başına "çok yakın" diyebilsin
  uyariP5Yan: 28,          // bunun için 10 dk en az kaç olmalı
  cokSicakYuzde10: 34,     // 10 dk "çok yakın" eşiği
  uyariAralikSaniye: 30,   // iki uyarı arası global minimum süre (yağmur önleme)
  sogumaDakika: 7,         // aynı maç için tekrar uyarı süresi
  hazirlikUyari: true,     // "OYNA"dan önce hazırlık uyarısı (karar süresi kazandırır)
  hazirlikYuzde10: 22,     // hazırlık eşiği (OYNA eşiği 28'in altı)
  hazirlikSogumaDakika: 6, // aynı maçta hazırlık uyarıları arası süre
  hazirlikAralikSaniye: 45, // iki hazırlık uyarısı arası global süre
  hazirlikHizPuan: 2,      // hazırlık verilen maçta asıl uyarı eşiği kaç puan aşağı iner
  golSonrasiSaniye: 180,   // goldan sonra sessizlik (sn, en az 180) — "gol geliyor" golün arkasından gelmesin
  golSonrasiDakika: 3,     // goldan sonra sessizlik (maç dakikası) — 68'de gol → 71'e kadar alarm yok
  uyariTazelikSaniye: 90,  // detay verisi bundan eskiyse "gol yakın" uyarısı üretilmez
  minLift: 0,              // 0 = kapalı; >1 ise temel orana göre kazanç filtresi
  akilliSaatFiltresi: false, // sadece istatistiksel olarak en isabetli dakikalarda uyar
  ligler: [],              // boş = tüm ligler; örn: ["Süper Lig", "Premier League"]
  engelliLigler: ['esoccer', 'virtual', 'cyber', 'simulated', 'e-spor', 'esport', 'baller league'],
  aiscore: true,           // ikinci kaynak: m.aiscore.com (skor/dakika yedeği)
  aiscoreSaniye: 20,       // AiScore yenileme aralığı (skor taze kalsın)
  oncelikliLigler: [
    'Süper Lig', 'Premier League', 'LaLiga', 'Serie A', 'Bundesliga', 'Ligue 1',
    'Champions League', 'Europa League', 'Conference League', 'Eredivisie',
    'Primeira Liga', 'Championship', 'World Cup', 'Euro', 'TFF 1. Lig'
  ],
  bildirim: true,          // Windows toast
  ses: true,               // terminal bip
  logDosyasi: true
};

let CFG = { ...VARSAYILAN };
try {
  const raw = fs.readFileSync(path.join(APP_DIR, 'ayarlar.json'), 'utf8').replace(/^\uFEFF/, '');
  CFG = { ...CFG, ...JSON.parse(raw) };
} catch (e) {
  // Sessizce varsayılana düşmek tehlikeli: yanlış eşikle çalışır
  if (e.code !== 'ENOENT') console.error(`UYARI: ayarlar.json okunamadı (${e.message}) — varsayılan ayarlar kullanılıyor.`);
}

// Geçmiş maç kalibrasyonu (backtest.js + fit.js üretir)
let KAL = null;
try {
  KAL = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'kalibrasyon.json'), 'utf8'));
  if (KAL.pencereDakika) CFG.pencereDakika = KAL.pencereDakika;
  if (KAL.esikYuzde) CFG.uyariYuzde = KAL.esikYuzde;
  if (KAL.cokSicakYuzde) CFG.cokSicakYuzde = KAL.cokSicakYuzde;
} catch (_) { /* kalibrasyon yoksa varsayılanlar */ }

const MODEL_VAR = !!(KAL && Array.isArray(KAL.katsayilar));

let KAL2 = null;
try {
  KAL2 = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'kalibrasyon2.json'), 'utf8'));
} catch (_) {}

let TABAN = null;
let KISA = null;
try {
  KISA = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'kalibrasyonKisa.json'), 'utf8'));
} catch (_) {}
// Yarı modeli: "bu yarının sonuna kadar gol" (fitYari2.js üretir)
let YARI_M = null;
try {
  YARI_M = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'yariModel.json'), 'utf8'));
} catch (_) {}
try {
  TABAN = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'taban.json'), 'utf8'));
} catch (_) {}

// Dakika bazlı "bu yarıda gol olur" temel oranı (tabanYari.js üretir)
let TABAN_YARI = null;
try {
  TABAN_YARI = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'tabanYari.json'), 'utf8'));
} catch (_) {}

function yariTaban(dakika) {
  if (!TABAN_YARI) return null;
  // 45. dakika anahtarı ikinci yarının tabanı (0.816). İlk yarıda 45'e
  // gelindiğinde o değeri döndürmek yanlış: ilk yarı sonu için 40'ı kullan.
  const duz = dakika >= 41 && dakika <= 45 ? 40 : dakika;
  const k = Math.floor(duz / 5) * 5;
  if (TABAN_YARI[k] !== undefined) return TABAN_YARI[k];
  const anahtarlar = Object.keys(TABAN_YARI).map(Number);
  if (!anahtarlar.length) return null;
  const en = anahtarlar.reduce((a, b) => (Math.abs(b - k) < Math.abs(a - k) ? b : a));
  return TABAN_YARI[en];
}

// Yeni yarı modelinin dakika bazlı taban oranı (anlikVeri'den, 5 dk bantları).
// Anahtar: yarı içinde geçen dakika (0-40). İkinci yarıda 45 çıkarılır.
function yariTaban2(dakika) {
  if (!YARI_M?.tabanDk) return yariTaban(dakika);
  const yari = dakika <= 45 ? 1 : 2;
  const gecen = Math.max(0, dakika - (yari === 1 ? 0 : 45));
  const k = Math.floor(gecen / 5) * 5;
  if (YARI_M.tabanDk[k] !== undefined) return YARI_M.tabanDk[k];
  return yariTaban(dakika);
}

function isabetYuzdesi(puan) {
  return null;
}

if (TEST_MODE) {
  CFG.uyariEsigi = 12;
  CFG.cokSicakEsigi = 25;
  CFG.uyariYuzde = 10;
  CFG.cokSicakYuzde = 15;
  CFG.minDakika = 1;
  CFG.sogumaDakika = 1;
}

const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
  'Referer': 'https://www.fotmob.com/'
};

/* ----------------------------- yardımcılar ----------------------------- */

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[91m', green: '\x1b[92m', yellow: '\x1b[93m',
  blue: '\x1b[94m', magenta: '\x1b[95m', cyan: '\x1b[96m', white: '\x1b[97m', gray: '\x1b[90m'
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => Date.now();
const saat = () => new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hhmm = () => new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

function getJson(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HDR, timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const bufs = [];
      const akis = res.headers['content-encoding'] === 'gzip' ? res.pipe(require('zlib').createGunzip()) : res;
      akis.on('data', (c) => bufs.push(c));
      akis.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(bufs).toString('utf8'))); }
        catch (e) { reject(new Error('JSON çözümlenemedi')); }
      });
      akis.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('zaman aşımı')));
  });
}

const ymd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

// FotMob maç listesi UTC gününe göre ayrılır
const ymdUTC = (d) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

function dakikaCoz(short, liveTime) {
  // Bilinmeyen dakika 0 değil null döner: "0'" diye saçma bildirim gitmesin.
  if (!short) {
    // liveTime.long "62:31" biçiminde olabilir; ondan dakika çıkar
    const lg = String(liveTime?.long || '').match(/^\s*(\d{1,3})[:.]\d{2}\s*$/);
    if (lg) return parseInt(lg[1], 10);
    return null;
  }
  if (/HT|Half|Devre/i.test(short)) return 45;
  if (/FT|Bitti|Full/i.test(short)) return 90;
  const cleaned = String(short).replace(/[^\d+]/g, '');
  if (!cleaned) {
    const lg = String(liveTime?.long || '').match(/^\s*(\d{1,3})[:.]\d{2}\s*$/);
    return lg ? parseInt(lg[1], 10) : null;
  }
  const [base, add] = cleaned.split('+');
  const n = parseInt(base, 10);
  if (isNaN(n)) return null;
  return n + (add ? parseInt(add, 10) || 0 : 0);
}

/*
 * Dakika düzeltmesi.
 *
 * Kaynak (FotMob / AiScore) bazen dakikayı boş, geride veya birkaç dakika ileri
 * gönderiyor: devre arasında 45 yerine 56-60, uzatma sonrası 0 vb. Bildirimler
 * "56' ... 45'" diye zıplamasın diye maçın kendi zaman çizgisi tutulur:
 * dakika geri gitmez, ani sıçrama yapmaz.
 */
function dakikaDuzelt(mac, ham) {
  const onceki = mac.dakikaSon ?? null;
  if (!Number.isFinite(ham) || ham <= 0) return onceki;
  const hamDk = Math.min(120, Math.round(ham));
  let dk = hamDk;
  // KAYNAK TAKILMASI: AiScore 87'de kalıp maç 90+2 olabiliyor. Kaynak değeri
  // değişmediği sürece geçen gerçek dakikayı ekle (en fazla 92).
  if (mac.kaynakDk !== hamDk) {
    mac.kaynakDk = hamDk;
    mac.kaynakZaman = now();
  } else if (mac.kaynakZaman) {
    const drift = Math.floor((now() - mac.kaynakZaman) / 60000);
    if (drift >= 2) {
      const ust = dk <= 45 ? 50 : 92;
      const tahmin = Math.min(ust, dk + drift);
      if (onceki != null) dk = Math.max(onceki, tahmin);
      else dk = tahmin;
    }
  }
  if (onceki != null) {
    if (dk < onceki) {
      // Geri gitme kabul edilmez; tek istisna devre arası / maç sonu düzeltmesi
      const htDuzeltme = (dk === 45 && onceki <= 60) || (dk === 90 && onceki <= 100);
      if (!htDuzeltme) dk = onceki;
    } else if (dk > onceki + 20 && now() - (mac.dakikaZaman || 0) < 5 * 60 * 1000) {
      // 5 dakikada 20 dakikadan fazla atlama olamaz: kaynak sıçraması
      dk = onceki + 2;
    }
  }
  mac.dakikaSon = dk;
  mac.dakikaZaman = now();
  return dk;
}

function skorCoz(scoreStr) {
  const m = String(scoreStr || '').match(/(\d+)\s*-\s*(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [0, 0];
}

function kirp(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ------------------ şut haritası olmayan maçlar için veri ------------------ */

/*
 * FotMob bazı liglerde (AFC, Azadegan, alt ligler, kadın ligleri) şut haritası
 * vermiyor ama content.stats içinde "Total shots / Shots on target / Big chances"
 * sayıları var. Bu sayılar 01.11.2026 raporunda "tahmin yok" denen maçların
 * yarısında mevcuttu ve sistem bunları hiç kullanmıyordu.
 *
 * ham.json (500 maç, 14.061 şut) üzerinden ölçülen şut başına xG:
 *   ceza sahası içi 0.1484 · ceza sahası dışı 0.0387 · genel 0.1105
 */
const XG_IC = 0.1484;
const XG_DIS = 0.0387;

function istatistikCoz(stats) {
  const gruplar = stats?.Periods?.All?.stats;
  if (!Array.isArray(gruplar)) return null;
  const al = (key) => {
    for (const g of gruplar) for (const s of g.stats || []) if (s.key === key) return s;
    return null;
  };
  const say = (key) => {
    const s = al(key);
    if (!s) return [null, null];
    const oku = (i) => {
      const v = s.stats?.[i] ?? s.rawStats?.[i]?.value;
      const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    return [oku(0), oku(1)];
  };
  const sut = say('total_shots');
  if (sut[0] === null && sut[1] === null) return null;
  const sot = say('ShotsOnTarget');
  const box = say('shots_inside_box');
  const big = say('big_chance');
  const korner = say('corners');
  // Gol çeşidi sinyalleri: kaçan büyük şans, rakip ceza sahası teması, direk
  const kacti = say('big_chance_missed_title');
  const kutuTemas = say('touches_opp_box');
  const direk = say('shots_woodwork');
  const kurtaris = say('keeper_saves');
  const xg = [0, 1].map((i) => {
    const s = sut[i] ?? 0;
    if (box[i] === null) return Math.round(s * 0.1105 * 1000) / 1000;
    const ic = Math.min(box[i], s);
    return Math.round((ic * XG_IC + Math.max(0, s - ic) * XG_DIS) * 1000) / 1000;
  });
  return { sut, sot, box, big, korner, kacti, kutuTemas, direk, kurtaris, xg, kaynak: 'fotmob' };
}

function istGecmisEkle(mac, dk, istat) {
  if (!mac || !istat) return;
  if (!Array.isArray(mac.istGecmis)) mac.istGecmis = [];
  const z = now();
  const c = {
    sut: istat.sut || [0, 0],
    sot: istat.sot || [0, 0],
    box: istat.box || [null, null],
    big: istat.big || [null, null],
    xg: istat.xg || [0, 0],
    korner: istat.korner || [null, null],
    kacti: istat.kacti || [null, null],
    kutuTemas: istat.kutuTemas || [null, null],
    kurtaris: istat.kurtaris || [null, null]
  };
  const son = mac.istGecmis[mac.istGecmis.length - 1];
  // VERİ SIÇRAMASI KORUMASI: 90 sn içinde 4+ şut / 3+ isabet artışı gerçek
  // değil, kaynak sayacı topluca yazmış demektir. Bu sıçrama 5-10 dk boyunca
  // "son 5 dk 10 şut" gibi sahte baskı ve yüksek "patlama" üretiyordu
  // (Pakhtakor II 0-2 Kattaqorgon, 64': 10 şut / patlama %51).
  if (son && Array.isArray(son.ist?.sut)) {
    const dt = (z - (son.z || 0)) / 1000;
    const dsut = (Number(c.sut[0]) || 0) + (Number(c.sut[1]) || 0)
      - ((Number(son.ist.sut[0]) || 0) + (Number(son.ist.sut[1]) || 0));
    const dsot = (Number(c.sot[0]) || 0) + (Number(c.sot[1]) || 0)
      - ((Number(son.ist.sot[0]) || 0) + (Number(son.ist.sot[1]) || 0));
    if (dt > 0 && dt <= 90 && (dsut > 3 || dsot > 2)) {
      mac.istGecmis = []; // seriyi sıfırla: yeni baz bu an
      mac.veriSicrama = { ts: z, dsut, dsot, dt };
    }
  }
  const son2 = mac.istGecmis[mac.istGecmis.length - 1];
  if (son2 && Math.abs(son2.dk - dk) < 0.01) mac.istGecmis[mac.istGecmis.length - 1] = { dk, ist: c, z };
  else mac.istGecmis.push({ dk, ist: c, z });
  if (mac.istGecmis.length > 80) mac.istGecmis.shift();
}

function istPencere(mac, pencere) {
  const g = mac.istGecmis || [];
  if (!g.length) return null;
  const cur = g[g.length - 1];
  const bas = Math.max(0, cur.dk - pencere);
  let ref = null;
  for (const s of g) { if (s.dk <= bas) ref = s; else break; }
  const olcek = !ref ? pencere / Math.max(cur.dk, 6) : null;
  const al = (key, i) => {
    const c = cur.ist[key]?.[i];
    if (c === null || c === undefined) return null;
    if (olcek !== null) return c * olcek;
    const r = ref.ist[key]?.[i] ?? 0;
    return Math.max(0, c - r);
  };
  const taraf = (i) => ({
    sut: al('sut', i) ?? 0,
    sot: al('sot', i) ?? 0,
    box: al('box', i),
    big: al('big', i),
    xg: al('xg', i) ?? 0,
    korner: al('korner', i)
  });
  return { ev: taraf(0), dep: taraf(1), dk: cur.dk };
}

/*
 * Şut haritası yokken kullanılan yedek model. Özellikler son 15/5 dakikalık
 * istatistik farklarından üretilir; xG yerine yukarıdaki şut başına xG vekili
 * kullanılır. Amaç gerçek xG hassasiyeti değil, "veri yok" deyip maçı tamamen
 * kaybetmek yerine makul bir olasılık üretmek.
 */
function yariIstatistik(mac) {
  const d = mac.detay;
  if (!d) return null;
  const p15 = istPencere(mac, CFG.pencereDakika || 15);
  if (!p15) return null;
  const yari = d.dakika <= 45 ? 1 : 2;
  const bas = yari === 1 ? 0 : 45;
  const bit = yari === 1 ? 45 : 90;
  const g = mac.istGecmis || [];
  const cur = g[g.length - 1]?.ist;
  if (!cur) return null;
  // Gol sonrası geçmiş silindiği için yarı başı referansı ayrıca saklanır.
  let ref = mac.yariBazIstat || null;
  if (!ref) for (const s of g) { if (s.dk <= bas) ref = s; else break; }
  const yariAl = (key, i) => {
    const c = cur[key]?.[i];
    if (c === null || c === undefined) return 0;
    const r = ref?.ist?.[key]?.[i] ?? 0;
    return Math.max(0, c - r);
  };
  // xG bilinmiyorsa null döner (0 değil): model null'ı ortalama ile doldurur.
  const yariAlXg = (i) => {
    const c = cur.xg?.[i];
    if (typeof c !== 'number') return null;
    const r = ref?.ist?.xg?.[i];
    return Math.max(0, c - (typeof r === 'number' ? r : 0));
  };
  const mom = (d.momentum || []).filter((x) => x.dk >= d.dakika - 15 && x.dk <= d.dakika);
  const momTop = mom.length ? mom.reduce((a, x) => a + Math.abs(x.deger), 0) / mom.length : 0;
  const toplam = d.skor[0] + d.skor[1];
  const topla = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a + b : null);
  // 15 dk / 5 dk geriye bakış (tehlikeli atak ve son 5 şut için)
  const tt = (a) => (Array.isArray(a) ? (Number(a[0]) || 0) + (Number(a[1]) || 0) : 0);
  const geri = (hedef) => {
    for (let k = g.length - 1; k >= 0; k--) if (g[k].dk <= hedef) return g[k];
    return null;
  };
  const a15 = geri(d.dakika - 15), a5 = geri(d.dakika - 5);
  const tehNow = tt(cur.tehlikeli);
  const teh15 = Math.max(0, tehNow - (a15 ? tt(a15.ist?.tehlikeli) : 0));
  const sutNow = tt(cur.sut);
  const d5sut = Math.max(0, sutNow - (a5 ? tt(a5.ist?.sut) : 0));
  const gecenYari = d.dakika - bas;
  return {
    yari,
    gecenYari,
    kalanYari: bit - d.dakika,
    xg15: topla(p15.ev.xg, p15.dep.xg),
    isabet15: topla(p15.ev.sot, p15.dep.sot),
    sut15: topla(p15.ev.sut, p15.dep.sut),
    teh15: Array.isArray(cur.tehlikeli) ? teh15 : null,
    xgYari: topla(yariAlXg(0), yariAlXg(1)),
    sutYari: yariAl('sut', 0) + yariAl('sut', 1),
    isabetYari: yariAl('sot', 0) + yariAl('sot', 1),
    tehYari: Array.isArray(cur.tehlikeli) ? yariAl('tehlikeli', 0) + yariAl('tehlikeli', 1) : null,
    golYari: Math.max(0, toplam - (mac.yariBaslangicGol ?? 0)),
    macGol: toplam,
    skorFarkAbs: Math.abs(d.skor[0] - d.skor[1]),
    d5sut,
    tempo: (sutNow / Math.max(d.dakika, 10)) * 90,
    momTop
  };
}

function baskiIstatistik(mac) {
  const d = mac.detay;
  if (!d) return null;
  const p15 = istPencere(mac, CFG.pencereDakika || 15);
  if (!p15) return null;
  const p5 = istPencere(mac, KAL?.kisaPencere || 5) || p15;
  const kur = (p) => {
    const f = model.macOzellikCikar(d, d.dakika);
    // BİLİNMEYEN xG/BÜYÜK ŞANS = 0 DEĞİL, null olmalı.
    // AiScore istatistiğinde xg yok; "null + null" JavaScript'te 0 ediyordu ve
    // model bunu "hiç tehlike yok" sanıyordu. Model null değeri ortalama ile
    // dolduruyor (model.olasilik içinde), 0 ile doldurmuyor.
    const top = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a + b : null);
    f.xgTop = top(p.ev.xg, p.dep.xg);
    f.sotTop = top(p.ev.sot, p.dep.sot);
    f.sutTop = top(p.ev.sut, p.dep.sut);
    f.buyukTop = top(p.ev.big, p.dep.big);
    f.xg5Top = top(p5.ev.xg, p5.dep.xg);
    f.xgDecayTop = typeof f.xgTop === 'number' ? f.xgTop * 0.55 : null;
    const k = mac.istGecmis[mac.istGecmis.length - 1].ist;
    const kx = (typeof k.xg?.[0] === 'number' && typeof k.xg?.[1] === 'number')
      ? k.xg[0] + k.xg[1]
      : null;
    f.xgMacTop = kx !== null && kx > 0 ? (kx / Math.max(d.dakika, 10)) * 90 : null;
    return f;
  };
  const p10 = KISA ? model.olasilik(kur(p15), KISA.m10) : null;
  const pO = KISA ? model.olasilik(kur(p5), KISA.m5) : null;
  const yariO = YARI_M
    ? model.olasilik(yariIstatistik(mac), YARI_M)
    : (KAL2 ? model.olasilik(yariIstatistik(mac), KAL2) : null);
  if (p10 === null && pO === null && yariO === null) return null;
  const paket = (t) => ({
    olasilik: null,
    puan: 0,
    xg: Math.round(t.xg * 100) / 100,
    isabet: Math.round(t.sot),
    sut: Math.round(t.sut),
    mom: null,
    xg5: Math.round(t.xg * (5 / 15) * 100) / 100,
    sot5: Math.round(t.sot * (5 / 15)),
    buyuk: t.big === null ? 0 : Math.round(t.big)
  });
  return {
    ev: paket(p15.ev),
    dep: paket(p15.dep),
    macOlasilik: null,
    yariOlasilik: yariO,
    p5: pO,
    p10,
    kaynak: 'istatistik'
  };
}

/* ------------------------------- durum -------------------------------- */

const maclar = new Map(); // id -> { meta, detay, sonDetay, uyariZamani:{home,away}, skor:[h,a], logu }

// Restart hafızası: radar yeniden başladığında son skorlar kaybolmasın,
// aksi halde aradaki goller "ilk skor" sayılıp bildirilmiyordu.
let skorlar = {};
try { skorlar = JSON.parse(fs.readFileSync(SKOR_FILE, 'utf8')) || {}; } catch (_) { skorlar = {}; }
function skorlariKaydet() {
  try {
    const c = {};
    for (const [id, m] of maclar) {
      const s = m.skor || m.meta?.skor;
      if (Array.isArray(s)) c[id] = s;
    }
    fs.writeFileSync(SKOR_FILE, JSON.stringify(c), 'utf8');
  } catch (_) {}
}
const uyariGecmisi = [];
let sonTarama = 0;
let taramaCalisiyor = false;

/* -------------------- ikinci kaynak: AiScore köprüsü ------------------- */
// FotMob şut haritası/istatistiği vermeyen maçlarda skor ve dakika buradan gelir.
let AI = { liste: [], ts: 0, hata: null };
let aiCalisiyor = false;

function aiTazele() {
  if (CFG.aiscore === false) return;
  if (aiCalisiyor || now() - AI.ts < (CFG.aiscoreSaniye || 45) * 1000) return;
  aiCalisiyor = true;
  aiscore.canliMaclar()
    .then((l) => { AI = { liste: l, ts: now(), hata: aiscore.saglik().hata }; })
    .catch((e) => { AI = { liste: [], ts: now(), hata: e.message }; })
    .finally(() => { aiCalisiyor = false; });
}

function aiDetayTazele(mac) {
  if (CFG.aiscore === false || !mac?.detay) return;
  // FotMob maçıysa AiScore'da aynı maçı bul: şut haritası/istatistik FotMob'da
  // yoksa (alt ligler, U19, Asya ligleri) istatistik oradan gelir. "Veri yok"
  // denen maçların çoğunda AiScore'da şut/isabet vardı.
  let aiId = null;
  if (mac.meta.kaynak === 'aiscore') aiId = String(mac.meta.id).replace(/^ai:/, '');
  else {
    if (mac.detay.istat) return; // FotMob istatistiği varsa dokunma
    const x = aiBul(mac.meta.ev, mac.meta.dep);
    if (x) aiId = x.id;
  }
  if (!aiId) return;
  // SICAK MAÇ: modelin p'si eşiğe yaklaşmışsa veriyi 6 sn'de bir, önbelleği
  // atlayarak çek. Diğer maçlar 12 sn'de bir (kota koruması).
  const sicak = (mac.baski?.p10 ?? 0) >= 0.25
    || (mac.uyariZamani?.on && now() - mac.uyariZamani.on < 10 * 60 * 1000);
  const bekle = sicak ? 6000 : 12000;
  if (now() - (mac.aiDetayZaman || 0) < bekle) return;
  mac.aiDetayZaman = now();
  aiscore.detay(aiId, sicak)
    .then((d) => {
      if (!d || !d.stats) return;
      const s = d.stats;
      const dk = mac.dakikaSon ?? mac.meta.dakika ?? mac.detay.dakika;
      if (dk != null) mac.detay.dakika = dk;
      mac.detay.skor = mac.meta.skor || mac.detay.skor;
      mac.detay.istat = { sut: s.sut, sot: s.sot, xg: null, box: [null, null], big: [null, null], korner: s.korner, tehlikeli: s.tehlikeli || null, atak: s.atak || null, topla: s.topla || null };
      mac.istatZaman = now();
      istGecmisEkle(mac, mac.detay.dakika, mac.detay.istat);
      mac.bos = false;
      anlikKaydet(mac, mac.detay);
      baskiKontrol(mac);
    })
    .catch(() => {});
}

// Piyasa (Pinnacle canlı oran) kaynaklı 10 dakikalık gol olasılığı.
// Oran çekmek asenkron; uyarı üretimi senkron olduğu için burada önbelleğe
// alınıp baskiKontrol'den okunuyor.
const PIYASA10 = new Map(); // macId -> { p10, kalan, ts }
let piyasaCalisiyor = false;
let piyasaSon = 0;
async function piyasaTazele() {
  if (CFG.piyasaUyari === false) return;
  if (piyasaCalisiyor || now() - piyasaSon < 60 * 1000) return;
  if (typeof piyasa.getir10 !== 'function') return;
  piyasaSon = now();
  piyasaCalisiyor = true;
  try {
    const aday = [...maclar.values()]
      .filter((m) => m.detay && m.detay.canli && !m.detay.bitti)
      .filter((m) => (m.baski?.p10 ?? 0) >= 0.20)
      .sort((a, b) => (b.baski?.p10 ?? 0) - (a.baski?.p10 ?? 0))
      .slice(0, 6);
    for (const m of aday) {
      const d = m.detay;
      const r = await piyasa.getir10(d.ev, d.dep, d.skor[0] + d.skor[1], d.dakika).catch(() => null);
      if (r && Number.isFinite(r.p10)) PIYASA10.set(String(m.meta.id), { ...r, ts: now() });
    }
  } catch (_) {
  } finally {
    piyasaCalisiyor = false;
  }
}

function piyasaP10(mac) {
  const v = PIYASA10.get(String(mac?.meta?.id));
  if (!v || now() - v.ts > 180 * 1000) return null;
  return v.p10 * 100;
}

function aiBul(ev, dep) {  if (!AI.liste.length) return null;
  let en = null;
  // Uzun kelime eşleşmesi: "Zakynthos APS" ↔ "A.P.S. Zakynthos" gibi
  // noktalama yüzünden benzerlik 0.50'de kalıp maç bulunamıyordu.
  const ana = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 2).sort((a, b) => b.length - a.length)[0] || '';
  let sk = 0.5;
  for (const x of AI.liste) {
    const p = Math.min(benzer(ev, x.ev), benzer(dep, x.dep));
    const ayni = ana(ev) === ana(x.ev) && ana(dep) === ana(x.dep);
    if (p > sk || (ayni && p >= 0.5)) { sk = p; en = x; }
  }
  return en;
}

// AiScore'un dakikası maç saatinden hesaplandığı için FotMob'dan daha ileride
// olabiliyor (FotMob 1. yarı uzatmasını saymıyor: 56' vs 60'). Hangisi ileriyse
// onu kullan.
function aiDakikaBul(ev, dep) {
  const x = aiBul(ev, dep);
  return x && Number.isFinite(x.dakika) ? x.dakika : null;
}

/*
 * ANLIK VERİ KAYDI (eğitim için).
 * Korner / tehlikeli atak / topla oynama canlıda geliyor ama geçmişte yok.
 * Şu andan itibaren dakika dakika dosyaya yazıyoruz; 1-2 hafta sonra bu
 * dosyayla model eğitilecek. Her maç için en fazla 30 saniyede bir satır.
 */
const ANLIK_DOSYA = path.join(APP_DIR, 'anlikVeri.jsonl');
const anlikSon = new Map();
function anlikKaydet(mac, d) {
  try {
    if (!d || !mac.meta || !Number.isFinite(d.dakika) || d.dakika <= 0) return;
    const id = String(mac.meta.id);
    if (now() - (anlikSon.get(id) || 0) < 10000) return;
    anlikSon.set(id, now());
    const i = d.istat || {};
    const satir = {
      t: new Date().toISOString(),
      id,
      lig: mac.meta.lig || d.lig || '',
      dk: d.dakika,
      skor: d.skor,
      sut: i.sut || null,
      sot: i.sot || null,
      korner: i.korner || null,
      tehlikeli: i.tehlikeli || null,
      atak: i.atak || null,
      xg: i.xg || null,
      kaynak: mac.meta.kaynak || 'fotmob'
    };
    fs.appendFileSync(ANLIK_DOSYA, JSON.stringify(satir) + '\n');
  } catch (_) {}
}

// Son ~5 dakikadaki tehlikeli atak artışı (varsa). AiScore verisi.
function tehlike5(mac, d) {
  const g = mac.istGecmis || [];
  if (!g.length) return null;
  const suan = g[g.length - 1];
  const t = suan?.ist?.tehlikeli;
  if (!Array.isArray(t)) return null;
  let eski = null;
  for (const x of g) {
    if (x.dk <= d.dakika - 4 && (!eski || x.dk > eski.dk)) eski = x;
  }
  const e = eski?.ist?.tehlikeli;
  if (!Array.isArray(e)) return null;
  return Math.max(0, (Number(t[0]) || 0) + (Number(t[1]) || 0) - (Number(e[0]) || 0) - (Number(e[1]) || 0));
}
let sonBildirim = 0;
let sonGlobalUyari = 0;
let sonHazirlik = 0;
const durum = { sonHata: '', duraklat: 0 };

let tahminler = [];
try { tahminler = JSON.parse(fs.readFileSync(TAHMIN_FILE, 'utf8')); } catch (_) {}
// Eski kayıtlarda "yari" alanı yoktu; dakikadan geri doldur. Yoksa yarı
// tahmini yarı sonunda "tutmadi" olarak kapanmıyordu.
for (const t of tahminler) {
  if ((t.tip || 'yari') === 'yari' && !t.yari) t.yari = t.dk <= 45 ? 1 : 2;
}
function tahminKaydet() {
  try { fs.writeFileSync(TAHMIN_FILE, JSON.stringify(tahminler.slice(-600)), 'utf8'); } catch (_) {}
}

function tahminEkle(mid, ad, lig, dk, p, bitisDk, tip = '10dk') {
  // Aynı maç için bekleyen tahmin varsa tekrar ekleme (istatistiği bozar)
  if (tahminler.some((t) => t.mid === mid && t.sonuc === 'bekliyor' && (t.tip || '10dk') === tip)) return;
  const kayit = {
    mid, ad, lig, dk, tip,
    p: Math.round(p), sonuc: 'bekliyor', zaman: now(), bitisDk
  };
  if (tip === 'yari') kayit.yari = dk <= 45 ? 1 : 2;
  tahminler.push(kayit);
  tahminKaydet();
}

function tahminKapat(mid, sonuc, dk) {
  for (let i = tahminler.length - 1; i >= 0; i--) {
    const t = tahminler[i];
    if (t.mid !== mid || t.sonuc !== 'bekliyor') continue;
    // 10dk tahmini yarıya yayılmaz: 1. yarı tahminini 2. yarı golü kapatmaz.
    if (t.tip === '10dk' && ((t.dk <= 45) !== (dk <= 45))) continue;
    // 10 dakikalık tahminde gol, pencerenin dışındaysa bu tahmini kapatma
    if (t.tip === '10dk' && typeof t.bitisDk === 'number' && dk > t.bitisDk) continue;
    // Yarı tahmininde gol başka yarıda geldiyse bu tahmin tutmuş sayılmaz
    if ((t.tip || 'yari') === 'yari' && t.yari && t.yari !== (dk <= 45 ? 1 : 2)) continue;
    t.sonuc = sonuc;
    t.sonDk = dk;
    break;
  }
  tahminKaydet();
}
let toplamIstek = 0;

/* ------------------------------ veri çekme ----------------------------- */

async function canliMaclariGetir() {
  // FotMob günü UTC'ye göre böler. Gece yarısı (TR saati) civarında canlı maçlar
  // hâlâ "dün"ün listesinde olur; bu yüzden dün + bugün (UTC) birlikte çekilir.
  const simdi = new Date();
  const tarihler = [simdi, new Date(simdi.getTime() - 24 * 60 * 60 * 1000)];
  const liste = [];
  const gorulen = new Set();
  for (const gun of tarihler) {
    const j = await getJson(`https://www.fotmob.com/api/data/matches?date=${ymdUTC(gun)}`);
    toplamIstek++;
    for (const lig of j.leagues || []) {
      for (const m of lig.matches || []) {
        const st = m.status || {};
        if (!st.started || st.finished || st.cancelled) continue;
        if (gorulen.has(m.id)) continue;
        gorulen.add(m.id);
        liste.push({
          id: m.id,
          lig: lig.name || 'Bilinmeyen',
          ulke: lig.ccode || '',
          ev: m.home?.name || 'Ev',
          dep: m.away?.name || 'Deplasman',
          evId: m.home?.id,
          depId: m.away?.id,
          skor: [m.home?.score ?? 0, m.away?.score ?? 0],
          dakika: dakikaCoz(st.liveTime?.short, st.liveTime),
          durum: st.reason?.short || st.liveTime?.short || ''
        });
      }
    }
  }
  return liste;
}

async function detayGetir(id) {
  const j = await getJson(`https://www.fotmob.com/api/data/matchDetails?matchId=${id}`);
  toplamIstek++;
  return j;
}

function detayiIsle(j) {
  const g = j.general || {};
  const h = j.header || {};
  const st = h.status || {};
  const c = j.content || {};
  const dakika = dakikaCoz(st.liveTime?.short, st.liveTime);
  const skor = skorCoz(st.scoreStr || `${h.teams?.[0]?.score ?? 0} - ${h.teams?.[1]?.score ?? 0}`);

  const atislar = (c.shotmap?.shots || []).map((s) => ({
    dk: (s.min || 0) + (s.minAdded ? s.minAdded / 100 : 0),
    xg: Number(s.expectedGoals) || 0,
    isabet: !!s.isOnTarget,
    gol: s.eventType === 'Goal',
    kendiKalesi: !!s.isOwnGoal,
    takimId: s.teamId,
    oyuncu: s.playerName || '',
    cezaSahasi: !!s.isFromInsideBox
  }));

  const momentum = (c.momentum?.main?.data || [])
    .filter((x) => typeof x.value === 'number')
    .map((x) => ({ dk: x.minute, deger: x.value }));

  const kartlar = [];
  const olaylar = c.matchFacts?.events?.events || [];
  for (const e of olaylar) {
    const tip = String(e.type || '').toLowerCase();
    if (!tip.includes('card')) continue;
    const cins = String(e.card || e.cardType || '').toLowerCase();
    kartlar.push({
      dk: Number(e.time) || 0,
      takimId: e.isHome ? (g.homeTeam?.id ?? h.teams?.[0]?.id) : (g.awayTeam?.id ?? h.teams?.[1]?.id),
      kirmizi: cins.includes('red')
    });
  }

  return {
    evId: g.homeTeam?.id ?? h.teams?.[0]?.id,
    depId: g.awayTeam?.id ?? h.teams?.[1]?.id,
    ev: g.homeTeam?.name || h.teams?.[0]?.name || 'Ev',
    dep: g.awayTeam?.name || h.teams?.[1]?.name || 'Deplasman',
    lig: g.leagueName || '',
    dakika,
    skor,
    canli: !!st.started && !st.finished && !st.cancelled,
    bitti: !!st.finished,
    durum: st.reason?.short || st.liveTime?.short || '',
    atislar,
    momentum,
    kartlar,
    // Şut haritası yoksa model için kümülatif istatistik (şut/isabet/xG vekili)
    istat: istatistikCoz(c.stats)
  };
}

/* --------------------------- baskı hesabı ----------------------------- */

function snapshotEkle(mac, d) {
  const k = d.kumulatif;
  if (!k || (!k.sut && !k.sot)) return;
  const yeni = { dk: d.dakika, ...k };
  const son = mac.gecmis[mac.gecmis.length - 1];
  if (son && son.dk === yeni.dk) mac.gecmis[mac.gecmis.length - 1] = yeni;
  else mac.gecmis.push(yeni);
  if (mac.gecmis.length > 40) mac.gecmis.shift();
}

// Şut haritası olmayan maçlarda: iki ölçüm arasındaki farktan pencere değerleri
function istatistikPenceresi(mac) {
  const g = mac.gecmis;
  if (!g.length) return null;
  const cur = g[g.length - 1];
  const bas = Math.max(0, cur.dk - CFG.pencereDakika);

  let ref = null;
  for (const s of g) {
    if (s.dk <= bas) ref = s;
    else break;
  }

  const olcek = !ref || cur.dk - ref.dk < 3 ? CFG.pencereDakika / Math.max(cur.dk, 6) : null;

  const hesapla = (idx) => {
    const al = (key) => {
      const c = cur[key]?.[idx];
      if (c === null || c === undefined) return null;
      if (olcek !== null) return c * olcek;
      const r = ref[key]?.[idx] ?? 0;
      return Math.max(0, c - r);
    };
    return {
      sut: al('sut'), sot: al('sot'), korner: al('korner'),
      xg: al('xg'), box: al('box'), big: al('big')
    };
  };

  return { ev: hesapla(0), dep: hesapla(1) };
}

function baskiEski(mac) {
  const d = mac.detay;
  if (!d) return null;
  const bitis = d.dakika;
  const bas = Math.max(0, bitis - CFG.pencereDakika);
  const basK = Math.max(0, bitis - (KAL?.kisaPencere || 5));
  const ist = null;

  const taraf = (evMi) => {
    const id = evMi ? d.evId : d.depId;
    const s = ist ? (evMi ? ist.ev : ist.dep) : null;

    let sut, sot, box, big, xg, xg5, sot5;

    if (d.atislar.length) {
      const a = d.atislar.filter(
        (x) => x.takimId === id && x.dk >= bas && x.dk <= bitis && !x.kendiKalesi
      );
      sut = a.length;
      sot = a.filter((x) => x.isabet).length;
      box = a.filter((x) => x.cezaSahasi).length;
      big = a.filter((x) => x.xg >= 0.2).length;
      xg = a.reduce((t, x) => t + x.xg, 0);

      const k = a.filter((x) => x.dk >= basK);
      xg5 = k.reduce((t, x) => t + x.xg, 0);
      sot5 = k.filter((x) => x.isabet).length;
    } else if (s) {
      sut = s.sut ?? 0;
      sot = s.sot ?? 0;
      box = s.box;
      big = s.big;
      xg = s.xg;
      // kısa pencere, uzun pencereden yaklaşık türetilir (şut haritası yoksa)
      xg5 = xg === null ? null : xg * 0.4;
      sot5 = sot * 0.4;
    } else {
      sut = 0; sot = 0; box = null; big = null; xg = null; xg5 = null; sot5 = null;
    }

    const korner = s?.korner ?? null;

    const momDeger = d.momentum
      .filter((x) => x.dk >= bas && x.dk <= bitis)
      .map((x) => (evMi ? x.deger : -x.deger));
    const mom = momDeger.length ? momDeger.reduce((a, b) => a + b, 0) / momDeger.length : null;

    const ozellik = {
      xg, sot, sut, buyuk: big, mom,
      dakika: bitis,
      kalan: Math.max(0, Math.min(10, 92 - bitis)),
      skorFark: evMi ? d.skor[0] - d.skor[1] : d.skor[1] - d.skor[0],
      ev: evMi ? 1 : 0,
      xg5, sot5
    };

    const olasilikDegeri = KAL && KAL.hedef === 'takim' ? model.olasilik(ozellik, KAL) : null;
    const puan = model.puanHesapla({ xg, sot, sut, box, big, mom, dakika: bitis });

    return {
      olasilik: olasilikDegeri,
      puan: Math.round(puan),
      xg: xg === null ? null : Math.round(xg * 100) / 100,
      isabet: Math.round(sot),
      sut: Math.round(sut),
      korner: korner === null ? null : Math.round(korner),
      mom: mom === null ? null : Math.round(mom),
      xg5: xg5 === null ? null : Math.round(xg5 * 100) / 100,
      sot5: Math.round(sot5),
      buyuk: big === null ? 0 : Math.round(big)
    };
  };

  const ev = taraf(true);
  const dep = taraf(false);

  let macOlasilik = null;
  if (KAL && KAL.hedef === 'mac') {
    macOlasilik = model.olasilik(
      {
        xgTop: (ev.xg ?? 0) + (dep.xg ?? 0),
        sotTop: ev.isabet + dep.isabet,
        sutTop: ev.sut + dep.sut,
        buyukTop: ev.buyuk + dep.buyuk,
        momTop: Math.max(ev.mom ?? 0, dep.mom ?? 0),
        xg5Top: (ev.xg5 ?? 0) + (dep.xg5 ?? 0),
        sot5Top: ev.sot5 + dep.sot5,
        dakika: bitis,
        kalan: Math.max(0, Math.min(10, 92 - bitis)),
        skorFarkAbs: Math.abs(d.skor[0] - d.skor[1])
      },
      KAL
    );
  }

  return { ev, dep, macOlasilik };
}

function golCesitOzet(d, pencereDk) {
  const bas = d.dakika - (pencereDk || 15);
  let ic = 0, dis = 0, buyuk = 0, xg = 0;
  for (const a of d.atislar || []) {
    if (a.kendiKalesi || a.dk < bas) continue;
    if (a.cezaSahasi) ic++; else dis++;
    if (a.xg >= 0.2) buyuk++;
    xg += a.xg;
  }
  return { ic, dis, buyuk, xg };
}

// Satırdaki ana yüzde: "gole yakınlık" sırası → 10 dk modeli, sonra yarı, sonra maç modeli
function satirDegeri(b) {
  if (b.p10 !== null && b.p10 !== undefined) return b.p10 * 100;
  if (b.macOlasilik !== null && b.macOlasilik !== undefined) return b.macOlasilik * 100;
  if (b.yariOlasilik !== null && b.yariOlasilik !== undefined) return b.yariOlasilik * 100;
  return Math.max(uyariDegeri(b.ev), uyariDegeri(b.dep));
}

// Uyarı eşiğiyle karşılaştırılacak değer: model varsa yüzde, yoksa eski puan
function uyariDegeri(taraf) {
  return taraf.olasilik !== null && taraf.olasilik !== undefined
    ? taraf.olasilik * 100
    : taraf.puan;
}

function esikDegeri(sicak) {
  // Ana uyarı artık 10 dakikalık model: renk ve sıralama onun eşiğine göre
  if (KISA && KISA.m10) {
    return sicak ? (CFG.cokSicakYuzde10 ?? 34) : (CFG.uyariYuzde10 ?? 28);
  }
  if (KAL2) return sicak ? (CFG.yariSicakYuzde ?? 80) : (CFG.yariYuzde ?? 65);
  const modelVar = !!(KAL && KAL.katsayilar);
  if (modelVar) return sicak ? CFG.cokSicakYuzde : CFG.uyariYuzde;
  return sicak ? CFG.cokSicakEsigi : CFG.uyariEsigi;
}

/* ----------------------------- uyarılar ------------------------------- */

function uyariYaz(seviye, baslik, satir1, satir2, mid) {
  const zaman = hhmm();
  uyariGecmisi.unshift({ zaman, seviye, baslik, satir1, satir2 });
  if (uyariGecmisi.length > 40) uyariGecmisi.pop();

  if (CFG.logDosyasi) {
    try {
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${baslik} | ${satir1} | ${satir2}\n`, 'utf8');
    } catch (_) {}
  }

  if (LOG_ONLY) {
    const renk = seviye === 'sicak' ? C.red : seviye === 'gol' ? C.magenta : C.yellow;
    console.log(`${C.gray}${zaman}${C.reset} ${renk}${C.bold}${baslik}${C.reset} ${satir1} ${C.dim}${satir2}${C.reset}`);
  }

  // Gol bildirimi kapatılabilir: sadece loga yazılır, toast/Telegram gitmez.
  if (seviye === 'gol' && CFG.golBildirim === false) return;

  if (CFG.ses) process.stdout.write('\u0007');
  if (CFG.bildirim && seviye !== 'bilgi') {
    const t = now();
    if (t - sonBildirim > 1500) {
      sonBildirim = t;
      try { bildir(`${baslik}`, `${satir1}`); } catch (_) {}
    }
  }
  // Telegram bildirimi (cloud deployment için)
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    telegramBildir(`${baslik} | ${satir1} | ${satir2}`, 0, mid);
  }
}

// Aynı maçın uyarıları Telegram'da tek konu altında toplansın: maç id -> ilk mesaj id
const telegramKonu = new Map();

function telegramBildir(mesaj, deneme, mid) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const n = deneme || 0;
  const konu = mid ? telegramKonu.get(mid) : null;
  // İlk uyarı normal mesaj; sonrakiler BİR ÖNCEKİ uyarıya yanıt olarak gider.
  const yanit = konu ? `&reply_to_message_id=${konu.id}&allow_sending_without_reply=true` : '';
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(mesaj)}${yanit}`;
  https.get(url, (res) => {
    let govde = '';
    res.on('data', (c) => { govde += c; });
    res.on('end', () => {
      durum.telegramSon = { zaman: saat(), kod: res.statusCode, hata: res.statusCode === 200 ? null : String(govde).slice(0, 120) };
      if (res.statusCode === 200) {
        // ZİNCİR: her uyarı BİR ÖNCEKİ uyarıya yanıt olur; en baştakine değil.
        // Böylece maçın uyarıları sırayla birbirine bağlı ilerler.
        if (mid) {
          try {
            const j = JSON.parse(govde);
            if (j.ok && j.result && j.result.message_id) {
              telegramKonu.set(mid, { id: j.result.message_id, ts: now() });
              if (telegramKonu.size > 400) telegramKonu.delete(telegramKonu.keys().next().value);
            }
          } catch (_) {}
        }
      } else {
        console.log(`[TELEGRAM] HATA ${res.statusCode}: ${String(govde).slice(0, 200)}`);
        // Bildirim sessizce kaybolmasın: 3 kez tekrar dene
        if (n < 3) setTimeout(() => telegramBildir(mesaj, n + 1, mid), 4000);
      }
    });
    res.resume();
  }).on('error', (e) => {
    durum.telegramSon = { zaman: saat(), kod: 0, hata: e.message };
    console.log(`[TELEGRAM] baglanti hatasi: ${e.message}`);
    if (n < 3) setTimeout(() => telegramBildir(mesaj, n + 1, mid), 4000);
  });
}

// Windows toast bildirimi (toast.ps1). Hata fırlatmaz, akışı bozmaz.
let bildirimMesgul = false;
function bildir(baslik, mesaj) {
  if (bildirimMesgul) return;
  bildirimMesgul = true;
  const bitir = () => { bildirimMesgul = false; };
  try {
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(APP_DIR, 'toast.ps1'),
        '-Title', String(baslik),
        '-Message', String(mesaj)
      ],
      { windowsHide: true, stdio: 'ignore' }
    );
    ps.on('close', bitir);
    ps.on('error', bitir);
  } catch (_) {
    bitir();
  }
}

function golKontrol(mac, yeniSkor, dakika) {
  const eski = mac.skor;
  if (!eski) return false;
  if (eski[0] === yeniSkor[0] && eski[1] === yeniSkor[1]) return false;
  // Skor düştüyse (VAR iptali) gol sayma; sadece skoru güncelle.
  if (yeniSkor[0] < eski[0] || yeniSkor[1] < eski[1]) return false;

  const evAtti = yeniSkor[0] > eski[0];
  const delta =
    Math.max(0, yeniSkor[0] - eski[0]) + Math.max(0, yeniSkor[1] - eski[1]);
  const takim = evAtti ? mac.detay.ev : mac.detay.dep;
  const sonGol = mac.detay.atislar
    .filter((a) => a.gol && a.takimId === (evAtti ? mac.detay.evId : mac.detay.depId))
    .sort((a, b) => b.dk - a.dk)[0];

  const t = mac.sonTahmin;
  // BASKI ARTIYOR uyarısı da takip edilir: gol AYNI YARIDA geldiyse
  // "TUTTU" yazar (10 dakika şartı yok; yarı bitmeden gol = tuttu).
  const bu = mac.sonBaskiUyari;
  const buGecerli = bu && Number.isFinite(bu.dk) && dakika >= bu.dk
    && ((dakika <= 45 && bu.dk <= 45) || (dakika > 45 && bu.dk > 45));
  let durum = mac.bos
    ? 'skor takibi (şut verisi yok)'
    : mac.sonUyariDk ? `bekleyen tahmin yok (son uyarı ${mac.sonUyariDk}')` : 'hiç uyarı üretilmemişti';
  if (t && dakika >= t.dk) {
    const fark = dakika - t.dk;
    if (t.tip === '10dk') {
      durum = fark <= 10
        ? `✅ TUTTU (${fark} dk sonra)`
        : `❌ tutmadı (${fark} dk sonra, 10 dk penceresi kaçtı)`;
    } else {
      const ayniYari = t.yari === (dakika <= 45 ? 1 : 2);
      durum = ayniYari
        ? `✅ TUTTU (${fark} dk sonra)`
        : `❌ tutmadı (${fark} dk sonra)`;
    }
  } else if (!t && buGecerli) {
    durum = `✅ TUTTU (${dakika - bu.dk} dk sonra · ${bu.baslik})`;
  } else if (mac.sonOlasilikYari && CFG.yariUyari !== false) {
    durum = `yarı eşiği altıydı: %${Math.round(mac.sonOlasilikYari.p)} (${mac.sonOlasilikYari.dk}')`;
  } else if (mac.sonOlasilik) {
    const esik = CFG.uyariYuzde10 ?? CFG.uyariYuzde ?? 23;
    const p = Math.round(mac.sonOlasilik.p);
    const sonDk = mac.sonOlasilik.dk;
    const limit = CFG.uyariSonDakika ?? 90;
    // Etiket gerçeği söylesin: %31 ölçülmüşse "eşik altındaydı" yazmak yalan.
    durum = p < esik
      ? `uyarı yoktu · o an %${p} (${sonDk}')`
      : sonDk > limit
        ? `son ölçüm %${p} (${sonDk}') · ${limit}' sonrası uyarı kapalı`
        : `uyarı yoktu · o an %${p} (${sonDk}')`;
  }
  // Gerçek engeli yaz: "eşik altıydı" diyip %31 göstermek yerine sebep.
  const nb = mac.sonBlok;
  // TUTTU/tutmadi yazısı engel metniyle ezilmesin.
  const sonucBelli = durum.startsWith('✅') || durum.startsWith('❌');
  if (nb && now() - nb.ts < 12 * 60 * 1000 && !sonucBelli
    && !(durum.startsWith('uyarı yoktu') && nb.neden.startsWith('eşik altı'))) {
    durum += ` · engel: ${nb.neden}`;
  } else if (mac.sonOlasilikYari && !sonucBelli) {
    durum = `10dk modeli yok, yarı %${Math.round(mac.sonOlasilikYari.p)} (${mac.sonOlasilikYari.dk}')`;
  }
  mac.sonTahmin = null;
  mac.yariUyari = null;
  mac.sonBaskiUyari = null;
  // Sayaç sıfırlanır: golden sonra yeni "gol geliyor" dalgası için 4 uyarı
  // hakkı yeniden açılır. Eskiden sayaç maç boyu birikiyordu ve 4. uyarıdan
  // sonra maçın kalanında (Twente: 44'→76' arası 3 gol) hiç uyarı çıkmıyordu.
  mac.uyariSayisi = 0;
  mac.uyariZamani.mac = 0;
  mac.uyariZamani.on = 0; // gol sonrası bekleme yok: baskı yeniden kurulunca uyar
  // Sayaç gerçekten baştan başlasın: "üst üste N. uyarı" etiketi de sıfırlanır.
  mac.sonUyariZaman = 0;
  mac.sonUyariDk = null;
  mac.sogudu = false;
  mac.golSonrasi = true; // gol sonrası kısa sessizlik
  mac.golSonrasiZaman = now(); // süresi CFG.golSonrasiSaniye (en az 180 sn)
  mac.sonGolDk = dakika; // golün maç dakikası: "baskı artıyor" susturma
  // GOL SONRASI TAM SIFIRLAMA: gol öncesi şut/isabet/xG geçmişi silinir,
  // sistem o maç için baştan başlar. Yeni alarm ancak taze veriyle çıkar.
  golSonrasiSifirla(mac, dakika);
  golSessizligiYay(mac, dakika);
  // Gol sonrası ARTIS takibi sıfırdan başlar: yeni bantlar yeniden sayılır.
  mac.trendBant = 0;
  mac.trendSayisi = 0;
  mac.p10Gecmis = [];
  mac.hazirlikZaman = 0;
  mac.uyariIzi = [];
  tahminKapat(mac.meta.id, 'tuttu', dakika);
  const sk = `${yeniSkor[0]}-${yeniSkor[1]}`;
  const dkYazi = dakika > 0 ? `${dakika}'` : 'dk ?';
  uyariYaz(
    'gol',
    durum.startsWith('✅') ? '⚽ GOL — TUTTU' : '⚽ GOL',
    `${dkYazi} ${mac.detay.ev} ${sk} ${mac.detay.dep}`,
    `${takim}${sonGol?.oyuncu ? ' — ' + sonGol.oyuncu : ''} · ${durum}` +
      (delta > 1 ? ` · ara gol (+${delta})` : '') +
      ` · ${mac.meta.lig}`,
    mac.meta.id
  );

  mac.uyariZamani.ev = now() + 2 * 60 * 1000;
  mac.uyariZamani.dep = now() + 2 * 60 * 1000;
  return true;
}

function surjAnaliz(mac) {
  const d = mac.detay;
  // GOL SONRASI TAZE VERİ: golden önceki şutlar yeni baskı sayılmaz.
  // (İstatistik yolunda istBazZaman bunu zaten yapıyor; şut haritasında
  //  d.atislar tüm maçı taşıdığı için kesme noktası burada uygulanır.)
  const golDk = Number.isFinite(mac.sonGolDk) ? mac.sonGolDk : -1;
  const t = (id) => {
    const a = (d.atislar || []).filter((s) => s.takimId === id && !s.kendiKalesi && s.dk > golDk);
    // GOLÜ ATAN ŞUT "BASKI" SAYILMAZ. Eskiden gol şutu da son 5 dakikaya
    // giriyordu; gol olduğu saniye sut5/xg5 şişip "BASKI ARTIYOR · OYNA"
    // gidiyordu. Artık pencere sadece gol olmayan (süren) hücumları sayar.
    const acik = a.filter((s) => !s.gol);
    const s5 = acik.filter((s) => s.dk >= d.dakika - 5);
    const s3 = acik.filter((s) => s.dk >= d.dakika - 3);
    return {
      sut5: s5.length,
      sot5: s5.filter((s) => s.isabet).length,
      xg5: s5.reduce((x, s) => x + s.xg, 0),
      buyuk5: s5.filter((s) => s.xg >= 0.2).length,
      sut3: s3.length
    };
  };
  return { ev: t(d.evId), dep: t(d.depId) };
}

// Son 5 dakikanın baskısı. Şut haritası varsa ondan; yoksa (çoğu maçta
// harita gelmiyor) istatistik anlık görüntülerinin farkından hesaplanır.
function anlikBaski(mac, d) {
  if ((d.atislar || []).length) {
    const s = surjAnaliz(mac);
    const sut = s.ev.sut5 + s.dep.sut5;
    const sot = s.ev.sot5 + s.dep.sot5;
    if (sot > sut) return null; // imkânsız veri: alarm üretme
    return { sut, sot, xg: s.ev.xg5 + s.dep.xg5, tip: 'harita' };
  }
  const tum = mac.istGecmis || [];
  // GOL SONRASI YENİ BAZ: gol öncesi istatistik anlık görüntüleri baskı
  // hesabına girmez. Yoksa golün kendi şutu (ve golden önceki ataklar) 4-8
  // dakika boyunca "son 5 dk baskı" gibi görünüyordu.
  const baz = mac.istBazZaman || 0;
  const g = baz ? tum.filter((x) => (x.z || 0) >= baz) : tum;
  if (g.length < 2) return null;
  const suan = g[g.length - 1];
  if (!Array.isArray(suan.ist?.sut)) return null;
  let eski = null;
  for (const x of g) {
    if (x.dk <= d.dakika - 4 && (!eski || x.dk > eski.dk)) eski = x;
  }
  if (!eski || !Array.isArray(eski.ist?.sut)) return null;
  const gecen = suan.dk - eski.dk;
  // Devre arası boşluğu ya da çok seyrek ölçüm → güvenilmez, kullanma
  if (gecen < 2.5 || gecen > 8) return null;
  const topla = (x) => (x.ist.sut[0] || 0) + (x.ist.sut[1] || 0);
  const toplaSot = (x) => (Array.isArray(x.ist.sot) ? (x.ist.sot[0] || 0) + (x.ist.sot[1] || 0) : null);
  const sotSuan = toplaSot(suan);
  const sotEski = toplaSot(eski);
  const sut = Math.max(0, topla(suan) - topla(eski));
  const sot = sotSuan === null || sotEski === null ? null : Math.max(0, sotSuan - sotEski);
  // Sayaç sıfırlaması/veri zıplaması: isabet şuttan fazla olamaz. Bu satırlar
  // "son 5 dk 3 şut (4 isabet)" gibi imkânsız alarmlar üretiyordu.
  if (sot !== null && sot > sut) return null;
  if (sut > 60) return null; // 4-8 dk'da 60+ şut = bozuk veri
  // Fiziksel üst sınır: iki takım toplamı dakikada 2,2 şutun üzerindeyse veri
  // sıçramasıdır (Pakhtakor II: 4 dk'da 10 şut → sahte baskı).
  if (gecen > 0 && sut / gecen > 2.2) return null;
  return {
    sut,
    sot,
    xg: null,
    tip: 'istatistik',
    gecen
  };
}

// Maç gerçekten oynanıyor mu? Devre arasında (HT) veya bitmiş maçta
// "gol yakın" uyarısı üretilmez. İlk yarı bitince gelen saçma bildirimi keser.
function macOynuyorMu(mac) {
  const d = mac.detay || {};
  if (d.bitti) return false;
  if (d.canli === false) return false;
  const durum = String(mac.meta?.durum ?? d.durum ?? '').trim();
  if (/^HT$/i.test(durum) || /devre|half.?time|break/i.test(durum)) return false;
  // AiScore durum kodu: 1 = başlamadı, 3 = devre arası, 5 = bitti
  const kod = Number(durum);
  if (kod === 1 || kod === 3 || kod === 5) return false;
  // AiScore bitiş durumları: 8 = bitti, 9 = uzatma sonu, 13 = iptal/ertelendi.
  // Bunlar kontrol edilmediği için bitmiş maçlara uyarı gidiyordu.
  if (kod === 8 || kod === 9 || kod === 13) return false;
  return true;
}

// Uyarı izi: aynı maçta daha önce çıkan uyarıların kısa özeti.
// Yeni uyarının alt satırına "önceki: 62' %29 · 65' %30" olarak eklenir ki
// listede eski mesajı aramak gerekmesin.
function uyariIzi(mac, dk, p, baslik) {
  const iz = (mac.uyariIzi = mac.uyariIzi || []);
  // Önceki uyarıların BAŞLIĞI alıntılanır (sadece yüzde değil):
  // "62' ⚽ GOL YAKIN %29 | 65' ⚡ GOL GELMEK ÜZERE %30"
  const onceki = iz.slice(-2).map((x) => `${x.dk}' ${x.baslik}`).join(' | ');
  const kisa = String(baslik || '').replace(/\s+/g, ' ').slice(0, 70);
  iz.push({ dk: Math.round(dk), p: Math.round(p), baslik: kisa });
  if (iz.length > 6) iz.shift();
  return onceki;
}

// Önceki uyarıya göre artış var mı? "↑ artış var" / "→ artış yok"
function artisYazi(onceki, p10, p5, gc) {
  if (!onceki) return '→ ilk uyarı';
  const fark = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : 0);
  const dP10 = fark(p10, onceki.p10);
  const dP5 = fark(p5, onceki.p5);
  const dBig = fark(gc?.buyuk, onceki.buyuk);
  const dIc = fark(gc?.ic, onceki.ic);
  // "artış var" sadece ANA olasılık gerçekten artmışsa yazılır. Eskiden 5dk
  // veya ceza sahası şutundaki küçük oynama da "↑ artış var" yapıyordu; ana
  // olasılık düşerken "artış var" yazması yanlıştı.
  const yukari = dP10 >= 1;
  const asagi = dP10 <= -2;
  const etiket = yukari ? '↑ artış var' : asagi ? '↓ düşüş' : '→ aynı seviye';
  const isaret = (n, birim = '') => (n > 0 ? `+${Math.round(n * 10) / 10}${birim}` : `${Math.round(n * 10) / 10}${birim}`);
  const parca = [];
  if (typeof onceki.p10 === 'number') parca.push(`ana %${Math.round(onceki.p10)}→%${Math.round(p10)} (${isaret(dP10, ' puan')})`);
  if (typeof onceki.p5 === 'number' && typeof p5 === 'number') parca.push(`5dk %${Math.round(onceki.p5)}→%${Math.round(p5)} (${isaret(dP5)})`);
  if (typeof onceki.buyuk === 'number' && gc) parca.push(`büyük şans ${onceki.buyuk}→${gc.buyuk} (${isaret(dBig)})`);
  if (dIc) parca.push(`ceza sahası ${isaret(dIc)} şut`);
  return etiket + (parca.length ? ` (${parca.join(' · ')})` : '');
}

// Şut/istatistik verisi olmayan maçlar (çoğunlukla sadece AiScore): model
// üretilemiyor. Sadece dakika + skor + gol sayısına bakan kaba bir tetik;
// etiket bunu açıkça söyler ki "tahmin" gibi okunmasın.
function bosBaski(mac, d) {
  if (!d || !d.canli || d.bitti) return;
  if (d.dakika < (CFG.bosMinDakika ?? 50) || d.dakika > (CFG.bosMaxDakika ?? 80)) return;
  if (mac.bosUyariZaman && now() - mac.bosUyariZaman < (CFG.bosSogumaDakika ?? 20) * 60 * 1000) return;
  // Veri birazdan gelebilir: "veri yok" uyarısı için 5 dk kesintisiz verisizlik şart.
  if (!mac.bosIlkZaman || now() - mac.bosIlkZaman < (CFG.bosGraceDakika ?? 5) * 60 * 1000) return;
  const taban = yariTaban(d.dakika);
  if (!taban) return;
  const toplamGol = d.skor[0] + d.skor[1];
  // Açık maçta kalan sürede gol daha olası (veriden: 2+ gollü maçlar ~+5 puan)
  const acik = toplamGol >= 4 ? 0.06 : toplamGol >= 2 ? 0.03 : 0;
  const p = Math.min(95, Math.round((taban + acik) * 100));
  if (p < (CFG.bosEsik ?? 55)) return;
  mac.bosUyariZaman = now();
  uyariYaz(
    'baski',
    `⚡ BASKI · %${p} (veri yok)`,
    `${d.dakika}' ${d.ev} ${d.skor[0]}-${d.skor[1]} ${d.dep}`,
    `şut verisi gelmiyor · sadece dakika + skor tahmini · ${mac.meta.lig}`,
    mac.meta.id
  );
}

// Trend takibi: olasılığın son dakikalardaki gerçek değişimi.
// Eşik beklemez; "yükseliyor mu" sorusuna cevap verir ve etiketinde trend olduğu yazar.
function trendKontrol(mac, b, d, dkYazi, uyariYaz) {
  if (CFG.trendUyari === false) return; // 📈 ARTIS kapalı
  // ARTIS maç sonuna kadar takip eder (varsayılan 90'), diğer uyarılar 85'te keser.
  if (Number.isFinite(d.dakika) && d.dakika > (CFG.trendSonDakika ?? 90)) return;
  if (!b || b.p10 === null || b.p10 === undefined) return;
  const p = b.p10 * 100;
  const g = (mac.p10Gecmis = mac.p10Gecmis || []);
  g.push({ z: now(), p });
  while (g.length > 12) g.shift();
  const eski = g.find((x) => now() - x.z >= 3 * 60 * 1000) || g[0];
  const fark = p - eski.p;
  if (p < (CFG.trendTaban ?? 28)) return;
  // SINIR GEÇİŞİ: her 2 puanlık yeni bant (28-29, 30-31, 32-33 ...) bir kez
  // haber verilir. Aynı bantta kalan salınım tekrar mesaj üretmez; yükseldikçe
  // her sınırda yeni ARTIS gelir.
  const bantAdim = CFG.trendBantAdim ?? 2;
  const bant = Math.floor(p / bantAdim) * bantAdim;
  if (bant <= (mac.trendBant || 0)) return;
  // Bant geçişi için kısa soğuma yeterli (varsayılan 1 dk).
  if (now() - (mac.trendZaman || 0) < (CFG.trendBantSogumaDk ?? 1) * 60 * 1000) return;
  mac.trendBant = bant;
  mac.trendZaman = now();
  mac.trendSayisi = (mac.trendSayisi || 0) + 1;
  const dk = Math.round((now() - eski.z) / 60000);
  const ak = anlikBaski(mac, d);
  const sutYazi = ak ? ` · son 5 dk ${ak.sut} şut${ak.sot ? ` (${ak.sot} isabet)` : ''}` : '';
  // Artışın büyüklüğü sinyalin gücü: +4 ve üstü güçlü, +2,5-4 orta, altı hafif.
  const guc = fark >= 4 ? 'GÜÇLÜ' : fark >= 2.5 ? 'ORTA' : 'HAFİF';
  const artisBaslik = `📈 ARTIS · %${Math.round(p)} (+${fark.toFixed(1)}) · ${guc}`;
  const iz = uyariIzi(mac, d.dakika, p, artisBaslik);
  uyariYaz(
    'baski',
    artisBaslik,
    `${dkYazi} ${d.ev} ${d.skor[0]}-${d.skor[1]} ${d.dep}`,
    `son ${dk} dk: %${Math.round(eski.p)} → %${Math.round(p)}${sutYazi}` +
      (iz ? ` · önceki: ${iz}` : '') + ` · ${mac.meta.lig}`,
    mac.meta.id
  );
}

/*
 * "Gol geliyor" uyarısı golün arkasından gelmesin.
 *
 * Liste taraması (FotMob 20 sn / AiScore 20 sn) detay yenilemesinden (30 sn+)
 * daha sık çalışıyor. Listedeki skor detaydaki skordan yüksekse gol olmuş,
 * detay henüz yetişmemiş demektir. Bu durumda "gol yaklaşıyor" demek yerine
 * susulur; golün kendisini golKontrol bildirir.
 */
function skorGerideMi(mac, d) {
  if (!d || !Array.isArray(d.skor)) return false;
  const detayTop = (Number(d.skor[0]) || 0) + (Number(d.skor[1]) || 0);
  const adaylar = [];
  if (mac.meta && Array.isArray(mac.meta.skor)) adaylar.push(mac.meta.skor);
  const ai = typeof aiBul === 'function' ? aiBul(mac.meta.ev, mac.meta.dep) : null;
  if (ai && Array.isArray(ai.skor)) adaylar.push(ai.skor);
  return adaylar.some((s) => (Number(s[0]) || 0) + (Number(s[1]) || 0) > detayTop);
}

// Uyarı neden çıkmadı? Gol satırında "eşik altıydı" gibi yanlış/eksik etiket
// yerine gerçek engeli yazabilmek için son engeli maçta tutar.
function blok(mac, neden) {
  mac.sonBlok = { neden, ts: now() };
  return;
}

// GOL SONRASI SESSİZLİK — iki şart birlikte:
//   1) en az CFG.golSonrasiSaniye (en az 180 sn = 3 gerçek dakika)
//   2) golün olduğu maç dakikasından itibaren CFG.golSonrasiDakika (varsayılan 5) maç dakikası
// Eskiden sadece 90 sn'ye bakılıyordu: 68'de gol → 70-71'de "BASKI ARTIYOR"
// gidiyordu. Dakika şartı, saati geriden gelen (gecikmeli skor) maçlarda da
// golün kendi şutunun baskı sayılmasını engeller. Yarı değişiminde dakika
// şartı uygulanmaz (45'te gol → 46'da 2. yarı başlıyor).
function golSonrasiSessiz(mac, d) {
  if (!mac.golSonrasiZaman) return null;
  // Alt sınır 30 sn: kullanıcı "golden sonra gol gelecekse uyarı gelsin" diyor.
  // Ölçüm: golden sonraki 0-3 dk içinde 10 dk gol oranı %29,9 (taban %27,4).
  const saniye = Math.max(30, Number(CFG.golSonrasiSaniye) || 60);
  const gecen = now() - mac.golSonrasiZaman;
  if (gecen < saniye * 1000) {
    return `gol sonrası sessizlik (${Math.ceil((saniye * 1000 - gecen) / 1000)} sn)`;
  }
  const dk = Number.isFinite(d?.dakika) ? d.dakika : null;
  // Gol sonrası TAZE VERİ şartı: geçmiş silindiği için en az 2 yeni ölçüm ve
  // 3 maç dakikası birikmeden hiçbir alarm üretilmez. Eski kümülatif veriyle
  // olasılık hesaplanmaz.
  if (mac.istBazZaman && mac.detay?.istat && dk != null) {
    const taze = (mac.istGecmis || []).filter((x) => (x.z || 0) >= mac.istBazZaman);
    if (taze.length < 2 || dk - taze[0].dk < 1) return 'gol sonrası yeni veri bekleniyor';
  }
  const golDk = mac.sonGolDk;
  if (dk == null || !Number.isFinite(golDk)) return null;
  const ayniYari = (dk <= 45 && golDk <= 45) || (dk > 45 && golDk > 45);
  if (!ayniYari) return null;
  const sinir = Number(CFG.golSonrasiDakika) || 0;
  const kalan = sinir - (dk - golDk);
  if (kalan > 0) return `gol sonrası sessizlik (${kalan} maç dk)`;
  return null;
}

// GOL SONRASI TAM SIFIRLAMA — maç için sistem yeniden başlamış gibi davranır.
// Gol öncesi şut/isabet/xG geçmişi silinir; sadece o andan sonra gelen veri
// birikir. Yarı modelinin referansı ayrıca saklanır ki yarı başı verisi kaybolmasın.
function golSonrasiSifirla(mac, dakika) {
  if (!mac) return;
  const g = mac.istGecmis || [];
  const yariBas = Number.isFinite(dakika) && dakika > 45 ? 45 : 0;
  let yariRef = null;
  for (const x of g) if (x.dk <= yariBas) yariRef = x;
  if (yariRef) mac.yariBazIstat = yariRef;
  mac.istGecmis = [];
  mac.gecmis = [];
  mac.p10Gecmis = [];
  mac.trendBant = 0;
  mac.trendSayisi = 0;
  mac.hazirlikZaman = 0;
  mac.uyariIzi = [];
  mac.sonUyari = null;
  mac.sonUyariSut = null;
  mac.sonOlasilik = null;
  mac.sonOlasilikYari = null;
  mac.baski = null;
  mac.seriZaman = 0;
  mac.istBazZaman = now();
  // Yeni baz: gol anındaki istatistik. Sonraki farklar buradan hesaplanır.
  if (mac.detay?.istat && Number.isFinite(dakika)) istGecmisEkle(mac, dakika, mac.detay.istat);
}

// Aynı maç iki kaynakta ayrı takip edilebiliyor (FotMob + AiScore). Gol bir
// kopyada yakalanınca sessizliği diğerine de taşı; yoksa golü görmeyen kopya
// 20 saniye sonra "BASKI ARTIYOR" basıyordu (logdaki sızıntının kaynağı).
function golSessizligiYay(mac, dakika) {
  if (!mac?.meta) return;
  for (const m of maclar.values()) {
    if (m === mac || !m.meta) continue;
    if (benzer(m.meta.ev, mac.meta.ev) >= 0.6 && benzer(m.meta.dep, mac.meta.dep) >= 0.6) {
      m.golSonrasiZaman = now();
      m.sonGolDk = dakika;
      golSonrasiSifirla(m, dakika);
    }
  }
}


function baskiKontrol(mac) {
  const d = mac.detay;
  if (!d) return;
  // Devre arası / bitmiş maçta uyarı üretilmez (ilk yarı bitince gelen saçma
  // bildirim). Baskı yine hesaplanır ki ekranda yüzde görünsün.
  const oynuyor = macOynuyorMu(mac);
  // Dakika bilinmiyorsa "0'" yazılmasın
  const dkYazi = d.dakika > 0 ? `${d.dakika}'` : 'dk ?';
  // Yarı başlangıcındaki skoru tut: "bu yarıda kaç gol oldu" özelliği için.
  const yariSimdi = d.dakika <= 45 ? 1 : 2;
  if (mac.sonYari !== yariSimdi) {
    mac.sonYari = yariSimdi;
    mac.yariBaslangicGol = yariSimdi === 1 ? 0 : d.skor[0] + d.skor[1];
    // 2. yarı bazı: 45'teki kümülatif istatistik. Gol sıfırlaması bu referansı
    // silmesin, yoksa yarı modeli tüm maçın toplamını "bu yarı" sanır.
    if (yariSimdi === 2) {
      const gg = mac.istGecmis || [];
      if (gg.length) mac.yariBazIstat = gg[gg.length - 1];
    } else {
      mac.yariBazIstat = null;
    }
    // YARI BAŞI TEMİZ SAYFA: 1. yarıda çıkan uyarılar 2. yarıya taşınmaz.
    // Sayaç, soğumalar, etiketler ve bekleyen tahmin sıfırlanır; istatistik
    // geçmişi korunur (model maçın bütününü görmeye devam eder).
    mac.uyariSayisi = 0;
    mac.uyariZamani.on = 0;
    mac.uyariZamani.mac = 0;
    mac.sonUyariZaman = 0;
    mac.sonUyariDk = null;
    mac.sonUyari = null;
    mac.sonUyariSut = null;
    mac.sonBaskiUyari = null;
    mac.sonTahmin = null;
    mac.sonOlasilik = null;
    mac.sogudu = false;
    mac.seriZaman = 0;
    mac.bosUyariZaman = 0;
    mac.hazirlikZaman = 0;
    mac.trendBant = 0;
    mac.trendSayisi = 0;
    mac.p10Gecmis = [];
    mac.uyariIzi = [];
    mac.sonBlok = null;
    // İlk yarıda atılan golün sessizliği 2. yarıya sarkmasın.
    if (yariSimdi === 2 && mac.sonGolDk != null && mac.sonGolDk <= 45) {
      mac.golSonrasiZaman = null;
      mac.sonGolDk = null;
      mac.istBazZaman = null;
    }
  }
  let b = baski(mac);
  // Şut haritası yok → istatistik tabanlı yedek model (varsa)
  if ((!b || (b.p10 == null && b.p5 == null && b.macOlasilik == null)) && mac.istGecmis?.length) {
    const bi = baskiIstatistik(mac);
    if (bi) b = bi;
  }
  if (!oynuyor) return blok(mac, 'maç canlı değil (devre arası/bitmiş)');
  // Maç sonu: varsayılan 90'dan sonra gol/baskı uyarısı üretilmez.
  // 85'te kesiliyordu; 86-90 arası "son dakika baskısı" (seriUyari yolu)
  // tamamen kör kalıyordu — 93'/95' golleri bu yüzden hiç uyarı üretmedi.
  const gecDakika = Number.isFinite(d.dakika) && d.dakika > (CFG.uyariSonDakika ?? 90);
  // Gol zaten olmuşsa (liste skoru detaydan ileride) uyarı yok: geç gelen
  // "gol yaklaşıyor" mesajının önünü keser.
  if (skorGerideMi(mac, d)) return blok(mac, 'skor listede önde (gol sayılmış)');
  // Kullanılan detay verisi bayatsa da uyarı yok: eski veriyle "gol geliyor"
  // demek, gol olduktan sonra konuşmakla aynı şey.
  if (mac.sonDetay && now() - mac.sonDetay > (CFG.uyariTazelikSaniye ?? 90) * 1000) {
    return blok(mac, `veri bayat (${Math.round((now() - mac.sonDetay) / 1000)} sn)`);
  }
  // GOL SONRASI SESSİZLİK — "gol olduğu saniye BASKI ARTIYOR · OYNA" gitmesin.
  // Golü atan takımın son 5 dakikası şiştiği için anlık baskı tam golda
  // patlıyordu. Yüzde yine güncellenir, sadece bildirim gitmez.
  const golSessiz = golSonrasiSessiz(mac, d);
  if (golSessiz) {
    if (b) mac.baski = b;
    return blok(mac, golSessiz);
  }
  // Şut verisi olmayan maçlar (sadece skor geliyor): model üretilemiyor, kaba
  // tetik devrede. Model kontrolünden ÖNCE çağrılmalı, yoksa hiç çalışmıyor.
  if (mac.bos && !d.istat) { bosBaski(mac, d); return blok(mac, 'şut/istatistik verisi yok'); }
  if (!b) return blok(mac, 'model üretilemedi');
  mac.baski = b;
  trendKontrol(mac, b, d, dkYazi, uyariYaz);
  // 85'ten sonra ARTIS dışındaki uyarılar kapalı.
  if (gecDakika) return blok(mac, `${CFG.uyariSonDakika ?? 90}' sonrası kapalı`);
  // ANLIK GOL YAKLAŞIMI: son 3-5 dakikadaki şut/isabet/xG patlaması.
  // Modele ve eşiğe bağlı değil; maçın o anki baskısını ölçer.
  // Şut haritası olmayan maçlarda (alt ligler) istatistik farkından aynı
  // mantıkla "BASKI ARTIYOR" üretilir; yoksa o maçlarda bu uyarı hiç gelmiyordu.
  if (CFG.seriUyari !== false && !(d.atislar || []).length && d.canli && !d.bitti) {
    const a = anlikBaski(mac, d);
    // Kalite şartı: 3 şut tek başına yetmez, en az 1 isabetli şut gerekir.
    // "12 şut / 2 isabet" gibi boşa akan baskı "✅ OYNA" alıyordu.
    const kaliteOk = (a?.sot ?? 0) >= (CFG.seriIstatSot5 ?? 1)
      || (tehlike5(mac, d) ?? 0) >= (CFG.tehlikeEsik ?? 6);
    if (a && kaliteOk && a.sut >= (CFG.seriIstatSut5 ?? 3)
      && now() - (mac.seriZaman || 0) > (CFG.seriIstatSoguma ?? 5) * 60 * 1000) {
      const taraf = (b.ev?.xg ?? 0) >= (b.dep?.xg ?? 0) ? d.ev : d.dep;
      mac.seriZaman = now();
      mac.sonBlok = null;
      // BASKI ARTIYOR da bir uyarı sayılır: sonraki mesaj 'ust uste 2' + artis olsun
      mac.uyariSayisi = (mac.uyariSayisi || 0) + 1;
      mac.sonUyariZaman = now();
      mac.sonUyariDk = d.dakika;
      // Gol gelirse "TUTTU" yazılsın diye son BASKI ARTIYOR uyarısı saklanır.
      mac.sonBaskiUyari = { dk: d.dakika, baslik: 'BASKI ARTIYOR · istatistik', zaman: now() };
      uyariYaz(
        'baski',
        // İstatistik farkıyla üretilen baskı "OYNA" demez: kaynak sayacı
        // sıçradığında sahte sinyal oluyordu (Pakhtakor II 64'). Sadece bilgi.
        '⚡ BASKI ARTIYOR · istatistik',
        `${dkYazi} ${d.ev} ${d.skor[0]}-${d.skor[1]} ${d.dep}`,
        `son 5 dk ${a.sut} şut${a.sot ? ` (${a.sot} isabet)` : ''} · baskı: ${taraf}` +
          ` · şut haritası yok, istatistik farkı · ${mac.meta.lig}`,
        mac.meta.id
      );
      return;
    }
  }
  if (CFG.seriUyari !== false && (d.atislar || []).length && d.canli && !d.bitti) {
    const s = surjAnaliz(mac);
    const guc = (x) => {
      if (x.sut5 >= (CFG.seriSut5 ?? 4) && x.xg5 >= (CFG.seriXg5 ?? 0.55)) return 2;
      if (x.sot5 >= (CFG.seriSut5b ?? 2) && x.xg5 >= (CFG.seriXg5b ?? 0.45)) return 1;
      return 0;
    };
    const aday = [['ev', s.ev, d.ev], ['dep', s.dep, d.dep]]
      .map((z) => [z[0], z[1], z[2], guc(z[1])])
      .filter((z) => z[3] > 0)
      .sort((a, z) => z[3] - a[3] || z[1].xg5 - a[1].xg5);
    if (aday.length && now() - (mac.seriZaman || 0) > (CFG.seriSoguma ?? 2) * 60 * 1000) {
      mac.seriZaman = now();
      mac.sonBlok = null;
      // BASKI ARTIYOR da bir uyarı sayılır: sonraki mesaj 'ust uste 2' + artis olsun
      mac.uyariSayisi = (mac.uyariSayisi || 0) + 1;
      mac.sonUyariZaman = now();
      mac.sonUyariDk = d.dakika;
      const [, x, takim, seviye] = aday[0];
      // Gol gelirse "TUTTU" yazılsın diye son uyarı saklanır.
      mac.sonBaskiUyari = { dk: d.dakika, baslik: seviye === 2 ? 'GOL YAKLAŞIYOR · OYNA' : 'BASKI ARTIYOR', zaman: now() };
      uyariYaz(
        seviye === 2 ? 'sicak' : 'baski',
        seviye === 2 ? '🔥 GOL YAKLAŞIYOR · ✅ OYNA' : '⚡ BASKI ARTIYOR · ✅ OYNA',
        `${dkYazi} ${d.ev} ${d.skor[0]}-${d.skor[1]} ${d.dep}`,
        `${takim} son 5 dk: ${x.sut5} şut · ${x.sot5} isabet · xG ${x.xg5.toFixed(2)}` +
          (x.buyuk5 ? ` · ${x.buyuk5} büyük fırsat` : '') +
          ` · ${mac.meta.lig}`,
        mac.meta.id
      );
      return;
    }
  }
  if (process.env.P10_LOG && b.p10 !== null && b.p10 !== undefined) {
    try {
      fs.appendFileSync(path.join(APP_DIR, 'p10.log'),
        `${new Date().toISOString()} | ${d.ev} - ${d.dep} | ${d.dakika}' | p10=${(b.p10 * 100).toFixed(1)} | p5=${b.p5 !== null && b.p5 !== undefined ? (b.p5 * 100).toFixed(1) : '-'} | xg=${((b.ev?.xg ?? 0) + (b.dep?.xg ?? 0)).toFixed(2)}\n`);
    } catch (_) {}
  }
  if (b.p10 !== null && b.p10 !== undefined) {
    mac.sonOlasilik = { p: b.p10 * 100, dk: mac.detay.dakika };
  } else if (b.macOlasilik !== null && b.macOlasilik !== undefined) {
    mac.sonOlasilik = { p: b.macOlasilik * 100, dk: mac.detay.dakika };
  }
  if (b.yariOlasilik !== null && b.yariOlasilik !== undefined) {
    mac.sonOlasilikYari = { p: b.yariOlasilik * 100, dk: d.dakika };
  }
  // Gol sonrası kısa soğuma: skor değişti diye 10 dakika kör kalmak, tam da
  // maçın açıldığı dakikaları kaçırtıyordu.
  if (golSonrasiSessiz(mac, d)) return;
  if (!d.canli || d.bitti) return;
  if (CFG.minDakika && d.dakika < CFG.minDakika) return blok(mac, `${CFG.minDakika}' öncesi uyarı yok`);
  if (CFG.akilliSaatFiltresi) {
    const uygun =
      (d.dakika >= 30 && d.dakika < 60) ||
      (d.skor[0] === 0 && d.skor[1] === 0 && d.dakika >= 60);
    if (!uygun) return;
  }
  if (d.skor[0] === 0 && d.skor[1] === 0 && d.dakika > 85) return;

  // Piyasa sinyali: şut verisi olmayan maçlarda da çalışır.
  // Modül yarım/bozuksa modeli kilitlemesin: hata yutulur, model devam eder.
  let pyZaman = null;
  try {
    const pyFn = typeof piyasaUyari === 'function' ? piyasaUyari : piyasaUyari?.uyari;
    if (typeof pyFn === 'function') {
      pyZaman = pyFn({ mac, d, piyasa, CFG, now, sonGlobalUyari, uyariYaz, tahminEkle });
    }
  } catch (_) { pyZaman = null; }
  if (pyZaman !== null && pyZaman !== undefined) { sonGlobalUyari = pyZaman; return; }

  if (mac.bos && !b.kaynak) return; // bosBaski yukarıda çalıştı

  // YARI MODELİ — ana uyarı kaynağı.
  // Hedef: "bu yarının kalanında gol olur mu". 500 maçlık geri testte
  // eşik %65 → isabet %73, eşik %75 → isabet %80 (temel oran %48).
  // Lift filtresi kaldırıldı: taban oran yüksekken (46. dakika %82) modelin
  // 1.1x üstüne çıkması matematiksel olarak imkânsızdı ve uyarıyı öldürüyordu.
  // KALAN SINIRI: yok (CFG.yariKalanMax null) — yarının her dakikasında geçerli.
  // Bu yarıda gol olduysa uyarı kesilmez, metni "bir gol daha" olur.
  const buYaridaGol = (d.skor[0] + d.skor[1]) - (mac.yariBaslangicGol ?? 0) > 0;
  // ANA KARAR ANLIK (10 dk) MODELDE. Yarı modeli varsayılan olarak kapalı:
  // "yarı sonuna kadar gol" yerine "şu an gol geliyor mu" sorusu sorulur.
  // Açmak için ayarlar.json -> "yariKarar": true.
  if (CFG.yariKarar === true && CFG.yariUyari !== false && b.yariOlasilik !== null && b.yariOlasilik !== undefined) {
    const y = b.yariOlasilik * 100;
    const taban = yariTaban2(d.dakika);
    const lift = taban > 0 ? y / 100 / taban : 0;
    const yariNo = d.dakika <= 45 ? 1 : 2;
    const bit = yariNo === 1 ? 45 : 90;
    const kalan = Math.max(0, bit - d.dakika);
    // Ölçüm (anlikVeri, 9-11 Kas): modelin o dakikadaki taban oranı geçmesi
    // gerekiyor. Fark≥8 → 1. yarı %75, 2. yarı %76 (taban %64 / %54).
    const fark = Number(CFG.yariFarkPuan ?? 8);
    const altSinir = Number(CFG.yariYuzde ?? 40);
    const pencereOk = !CFG.yariKalanMax || kalan <= CFG.yariKalanMax; // null/0 = sınırsız
    const yariAktif = CFG.yariSadeceIlkYari === false || yariNo === 1;
    if (yariAktif && taban !== null && y >= taban * 100 + fark && y >= altSinir && kalan >= 3 && pencereOk) {
      // Yarı uyarısı yarıda TEK DEĞİL: yarı ilerledikçe olasılık değişiyor,
      // 10 dakikada bir güncelleme gelir (yarı başına en fazla 4 kez).
      const sogumaY = (CFG.yariTekrarDakika ?? 10) * 60 * 1000;
      const sayi = mac.yariSayisiYari === yariNo ? (mac.yariSayisi || 0) : 0;
      if (now() - (mac.uyariZamani.yari || 0) >= sogumaY && sayi < (CFG.yariTekrarMax ?? 4)) {
        // Bekleyen yarı tahmini varsa yenisi eklenmez, sadece uyarı gönderilir
        const zaten = tahminler.some(
          (t) => t.mid === mac.meta.id && t.sonuc === 'bekliyor' &&
            (t.tip || 'yari') === 'yari' && t.yari === yariNo
        );
        const oncekiY = mac.sonYariYuzde ?? null;
        if (now() - sonGlobalUyari >= (CFG.uyariAralikSaniye ?? 30) * 1000) {
          sonGlobalUyari = now();
          mac.uyariZamani.yari = now();
          mac.yariUyari = yariNo;
          mac.yariSayisiYari = yariNo;
          mac.yariSayisi = sayi + 1;
          mac.sonYariYuzde = y;
          // Sıcak (OYNA) = taban ortalamayı en az 12 puan geçen. Sadece bu
          // katman tahmin kaydı açar; TAKİP istatistiği kirletmez.
          const sicak = (y - (taban ? taban * 100 : 0)) >= (CFG.yariSicakFarkPuan ?? 12);
          if (!zaten && sicak) {
            mac.sonTahmin = { dk: d.dakika, tip: 'yari', yari: yariNo, p: y };
            tahminEkle(mac.meta.id, `${d.ev} - ${d.dep}`, mac.meta.lig, d.dakika, y, bit, 'yari');
          }
          // Bu yarıda gol olduysa soru "bir gol daha gelir mi" olur. Uyarı
          // kesilmez: modelin olasılığı zaten KALAN süre için.
          const ekGol = buYaridaGol;
          uyariYaz(
            sicak ? 'sicak' : 'baski',
            sicak
              ? (ekGol ? `🔥 Yarıda YENİ gol %${Math.round(y)} ✅ OYNA` : `🔥 Yarıda gol %${Math.round(y)} ✅ OYNA`)
              : (ekGol ? `👀 TAKİP · Yarıda yeni gol %${Math.round(y)}` : `👀 TAKİP · Yarıda gol %${Math.round(y)}`),
            `${dkYazi} ${d.ev} ${d.skor[0]}-${d.skor[1]} ${d.dep} · ${yariNo}. yarı · kalan ${kalan} dk`,
            (ekGol ? 'yarıda bir gol daha: ' : 'yarı sonuna kadar gol: ') + `%${Math.round(y)}` +
              (oncekiY !== null && Math.round(oncekiY) !== Math.round(y)
                ? ` (önceki %${Math.round(oncekiY)})`
                : sayi > 0 ? ' · güncelleme' : '') +
              (taban ? ` · dakika ortalaması %${Math.round(taban * 100)} (${lift.toFixed(1)}x)` : '') +
              ` · ${mac.meta.lig}`,
            mac.meta.id
          );
          return;
        }
      }
    }
  }

  // ANA UYARI — "GOL YAKIN": gol yaklaşırken sık bildirim.
  // 10 dakikalık model varsa ana ölçü odur; yoksa (şut haritası/istatistik
  // modeli) maç modelinin gol ihtimali kullanılır. Böylece 10 dk modeli
  // üretilemeyen maçlarda da uyarı gelir.
  const p10var = b.p10 !== null && b.p10 !== undefined;
  const macVar = !b.kaynak && b.macOlasilik !== null && b.macOlasilik !== undefined;
  const anaDeger = p10var ? b.p10 * 100 : macVar ? b.macOlasilik * 100 : null;

  if (CFG.onDkUyari !== false && anaDeger !== null) {
    const esikSabit = p10var ? (CFG.uyariYuzde10 ?? 28) : (CFG.uyariYuzde ?? 24);
    // Eşik SABİT: "o anki en iyi maç" mantığı eşiği 29-36 arasında oynatıp
    // uyarıyı kaçırıyordu. Tek referans var: %28.
    const esik = d.dakika <= 45 ? (CFG.uyariYuzde10IlkYari ?? 30) : esikSabit;
    const sicakEsik = p10var ? (CFG.cokSicakYuzde10 ?? 34) : (CFG.cokSicakYuzde ?? 30);
    // Gol çeşidine göre eşik: büyük şans varsa erken uyar, sadece uzaktan
    // şut varsa (dönüşüm %4,2) gereksiz uyarıyı kes.
    const gcEsik = golCesitOzet(d, 15);
    const kurtarisTop = d.istat?.kurtaris ? (d.istat.kurtaris[0] || 0) + (d.istat.kurtaris[1] || 0) : 0;
    const kutuTop = d.istat?.kutuTemas ? (d.istat.kutuTemas[0] || 0) + (d.istat.kutuTemas[1] || 0) : 0;
    const esikDuz = ((gcEsik.buyuk >= 2 || (gcEsik.buyuk >= 1 && gcEsik.ic >= 3)) ? -3 : 0)
      + (gcEsik.ic === 0 && gcEsik.dis >= 4 ? 3 : 0)
      + (kurtarisTop >= 5 ? -2 : 0)
      + (kutuTop >= 50 ? -2 : 0)
      // Tehlikeli atak baskısı: son 5 dakikada 6+ tehlikeli atak varsa eşik
      // 2 puan aşağı (daha erken uyarı). AiScore'un canlı verisi.
      + (tehlike5(mac, d) >= (CFG.tehlikeEsik ?? 6) ? -2 : 0)
      // PİYASA: bahisçinin gol beklentisi. Model yüksek diyorsa ama piyasa
      // "gol gelmez" diyorsa eşik yükselir (uyarı kısılır), piyasa da sıcaksa
      // eşik düşer (daha erken uyarı). Piyasa 0,5'e yakınken etkisiz.
      + (() => {
        const py = piyasaP10(mac);
        if (py === null) return 0;
        if (py < 18) return 5;
        if (py < 23) return 2;
        if (py >= 30) return -2;
        return 0;
      })();
    // Gerçek pencere: maç bitişine (90+2) kalan süre ile 10 dakikanın küçüğü.
    const pencere = Math.max(0, Math.min(10, 92 - d.dakika));
    if (pencere < 5) return blok(mac, 'kalan süre 5 dk altı');

    const p5 = b.p5 !== null && b.p5 !== undefined ? b.p5 * 100 : null;
    const yakin5 = p10var && p5 !== null && p5 >= (CFG.uyariP5 ?? 24) && anaDeger >= (CFG.uyariP5Yan ?? 28);
    const esik5 = CFG.uyariYuzde5 ?? 12;
    // İlk yarının başı (15-30) ölçümde en zayıf bant (%27 isabet): burada
    // eşik 3 puan yukarı, 5 dk onayı da zorunlu. Diğer bantlar değişmedi.
    const erkenYari = d.dakika >= 15 && d.dakika < 30;
    const erkenYariDuz = erkenYari ? (CFG.erkenYariDuz ?? 3) : 0;
    const onayOk = erkenYari
      ? p5 !== null && p5 >= esik5
      : b.kaynak === 'istatistik' || p5 === null || p5 >= esik5;
    // ANLIK BASKI: son 5 dakikadaki gerçek olaylar. Model eşiği beklemez;
    // "eşik %28'i geçsin" diye gol kaçırmak yerine sahadaki patlamaya bakar.
    const anlik = anlikBaski(mac, d);
    const sut5 = anlik ? anlik.sut : null;
    const sot5 = anlik ? anlik.sot : null;
    const xg5Top = anlik ? anlik.xg : null;
    const anlikVar = (sut5 !== null && sut5 >= (CFG.anlikSut5 ?? 2))
      || (xg5Top !== null && xg5Top >= (CFG.anlikXg5 ?? 0.3));
    // Gürültü koruması: anlık baskı da olsa maçın olasılığı eşiğin 10 puan
    // altındaysa uyarı üretilmez (yoksa her 2 şutta bildirim yağar).
    // İLK YARI: bugün 23 uyarı → 0 gol. İlk yarıda anlık baskı muafiyeti
    // kapatıldı; sadece model eşiği geçerse uyarı çıkar.
    const anlikUygun = anlikVar && d.dakika > 45 && anaDeger >= esik + erkenYariDuz - 10;
    // HAZIRLIK verilmiş maçta eşik 2 puan aşağı iner: "maç ısındı" dedikten
    // sonra değer bir tık yükselince asıl uyarı çıksın. Aksi hâlde değer
    // 25,6'da takılıp sürekli HAZIRLIK yazıyor, golü kaçırıyorduk.
    const hazirlikta = !!mac.hazirlikZaman && now() - mac.hazirlikZaman < 25 * 60 * 1000;
    const esikUyari = hazirlikta ? Math.max(1, esik - (CFG.hazirlikHizPuan ?? 2)) : esik;
    // AÇIK MAÇ: 4+ gollü maçlarda önümüzdeki 10 dakikada gol oranı %36
    // (0-1 gollü maçlarda %30). Aynı eşikle bu maçları kaçırıyorduk.
    const acikMac = (d.skor[0] + d.skor[1]) >= (CFG.acikMacGol ?? 4);
    const acikDuz = acikMac ? (CFG.acikMacDuz ?? 3) : 0;
    const esikSon = Math.max(1, esikUyari - acikDuz);
    // PATLAMA MODELİ: anlikVeri'den eğitilen 10 dk modeli + patlama koşulu.
    // Model yoksa (istatistik gelmiyorsa) eski davranış korunur.
    const pat = patlama.hesapla(mac, d);
    mac.patlama = pat;
    // EKRANDAKİ YÜZDE = modelin 10 dk gol olasılığı (v2, kalibre).
    // Eski anaDeger karışık bir skordu; "gol yakın" yazıp modelin p'si %26
    // olabiliyordu. Artık gösterilen sayı ile karar veren sayı aynı.
    const gosterge = pat ? Math.max(1, Math.min(99, pat.p * 100)) : anaDeger;
    // KARAR YÜZDESİ: patlama modeli varsa o, yoksa eski model.
    // Eski model (xgTop tabanlı, AUC 0,52) artık sadece yedek.
    const kararP = pat ? gosterge : anaDeger;
    // PATLAMA ŞARTI: "maç kapalı" ise uyarı çıkmaz.
    const patEsik = CFG.patlamaEsik ?? patlama.esik;
    const patGuc = pat && pat.patlama ? pat.p * 100 : null;
    // Model yoksa (şut/isabet verisi gelmiyorsa) OYNA YOK: eski modelin
    // xG'siz tahmini %29'u "OYNA" diye yazıyordu. Veri yoksa sadece TAKİP.
    const oynaOk = !!pat && pat.patlama && patGuc >= patEsik;
    const takipOk = !oynaOk && ((pat && pat.patlama && patGuc >= (CFG.patlamaIzle ?? 25)) || acikMac);
    const patlamaOk = oynaOk || takipOk;
    // 25-30 arası: OYNA DEĞİL, sadece "izle" uyarısı (isabet istatistiğine girmez).
    const patlamaZayif = !oynaOk && takipOk;
    // Uyarı şartı: patlama modeli varsa tek referans o. Eski modelin eşiği
    // (anaDeger) sadece patlama verisi yokken devreye girer.
    const ana = patlamaOk
      && (pat ? kararP >= patEsik
        : ((anaDeger >= esikSon + esikDuz + erkenYariDuz && (p10var ? onayOk : true)) || anlikUygun));
    // Tekrar uyarısı: maç hâlâ eşiğin üstündeyse ya da son 5 dakikada taze
    // şut/isabet patlaması varsa haber verilir. Amaç dakikalar içinde 2-3
    // uyarı; gol olduysa skorGerideMi + golSonrasiSaniye zaten susuyor.
    const tazeSut = sut5 !== null && sut5 >= (CFG.tekrarSut5 ?? 2);
    // YENİ ŞUT: son uyarıdan bu yana şut sayısı arttı mı? Aynı 2 şut pencere
    // içinde durdukça her 2 dakikada tekrar uyarı gidiyordu (Gezira 24-33':
    // 6 uyarı). Artık tekrar için ya olasılık artacak ya yeni şut gelecek.
    const yeniSut = sut5 !== null && sut5 > (mac.sonUyariSut ?? -1);
    const uyariVar = (mac.uyariSayisi || 0) >= 1;
    if (uyariVar && kararP < patEsik && !tazeSut && !anlikUygun) {
      return blok(mac, `eşik altı (%${Math.round(kararP)} < %${Math.round(patEsik)})`);
    }
    // AYNI SEVİYEDE TEKRAR YOK: bir önceki uyarıya göre en az `tekrarArtis`
    // puan artmadıysa yeni mesaj gönderilmez. Emniyet: uzun süre sessiz
    // kalındıysa (varsayılan 6 dk) baskı sürüyor diye bir hatırlatma geçer.
    if (uyariVar && mac.sonUyari && typeof mac.sonUyari.p10 === 'number') {
      const artis = kararP - mac.sonUyari.p10;
      const sessizDk = (now() - (mac.sonUyariZaman || 0)) / 60000;
      if (artis < (CFG.tekrarArtis ?? 1) && sessizDk < (CFG.tekrarHatirlatmaDk ?? 6) && !yeniSut) {
        return blok(mac, `artış yok (%${Math.round(mac.sonUyari.p10)}→%${Math.round(kararP)})`);
      }
    }
    // TEKRAR İÇİN BASKI ŞARTI: son 5 dakikada en az 2 şut yoksa aynı maçta
    // yeni "OYNA" gönderilmez. Tek yüzdeye bakıp 1 şutla tekrar uyarı vermek
    // (Inter Kashi 82') yanlış alarm üretiyordu.
    if (uyariVar && !tazeSut) {
      return blok(mac, 'tekrar: son 5 dk baskı yok (2 şut altı)');
    }
    // Tekrar üst sınırı: 0 = sınırsız. Soğuma (2 dk) korunduğu için spam olmaz;
    // sınır varken maç 6 uyarıdan sonra susuyor ve gollerin ~%36'sı kaçıyordu.
    const tekrarLimit = CFG.tekrarMax ?? 4;
    if (uyariVar && tekrarLimit > 0 && (mac.uyariSayisi || 0) >= tekrarLimit) {
      return blok(mac, `uyarı hakkı dolu (${mac.uyariSayisi}/${tekrarLimit})`);
    }

    /*
     * HAZIRLIK KATMANI — "OYNA" gelmeden önce maçın ısındığını haber verir.
     * Amaç tahmin isabeti değil, karar süresi: OYNA gelince maç/pazar hazır
     * olsun. Bu mesaj "oyna" değildir; sadece izleme listesine alır.
     * Yalnızca henüz OYNA uyarısı çıkmamış maçlarda ve kendi soğumasıyla.
     */
    if (CFG.hazirlikUyari !== false && !uyariVar && !ana && !yakin5) {
      const hzEsik = CFG.hazirlikYuzde10 ?? 22;
      if (anaDeger >= hzEsik
        && anaDeger < esik
        && now() - (mac.hazirlikZaman || 0) >= (CFG.hazirlikSogumaDakika ?? 6) * 60 * 1000
        && now() - sonHazirlik >= (CFG.hazirlikAralikSaniye ?? 45) * 1000) {
        sonHazirlik = now();
        mac.hazirlikZaman = now();
        const yakinlik = anlikVar
          ? `son 5 dk ${sut5} şut${sot5 ? ` (${sot5} isabet)` : ''}`
          : 'baskı yükseliyor';
        uyariYaz(
          'baski',
          `⚡ HAZIRLIK · %${Math.floor(anaDeger)} · OYNA DEĞİL`,
          `${dkYazi} ${d.ev} ${d.skor[0]}-${d.skor[1]} ${d.dep} · maç ısınıyor · ${yakinlik}`,
          `ısınma skoru %${anaDeger.toFixed(1)} (OYNA için model p≥%${Math.round(patEsik ?? 33)} gerekir)` +
            (p5 !== null ? ` · 5dk %${Math.round(p5)}` : '') +
            ` · ${mac.meta.lig}`,
          mac.meta.id
        );
        return;
      }
    }

    // Uyarı verilmiş maçta baskı düştüyse "oyun soğudu" haberi (gol gelmeden).
    if ((mac.uyariSayisi || 0) >= 1 && kararP < patEsik - 6 && !mac.sogudu && !anlikUygun) {
      mac.sogudu = true;
      mac.uyariSayisi = 0;
      if (now() - sonGlobalUyari >= ((CFG.uyariAralikSaniye ?? 30) * 1000)) {
        sonGlobalUyari = now();
        uyariYaz(
          'baski',
          `❄️ GOL İHTİMALİ DÜŞTÜ · %${Math.round(kararP)}`,
          `${dkYazi} ${d.ev} ${d.skor[0]}-${d.skor[1]} ${d.dep} · baskı bitti`,
          `gol yakınlığı %${Math.round(anaDeger)} (eşik %${Math.round(esik)}) · ${mac.meta.lig}`,
          mac.meta.id
        );
      }
      return;
    }
    if (!ana && !yakin5) {
      const gerekli = Math.round(esikSon + esikDuz + erkenYariDuz);
      const neden = !patlamaOk
        ? `model p %${pat ? Math.round(pat.p * 100) : '-'} < eşik %${Math.round(patEsik)}`
        : anaDeger < gerekli
          ? `eşik altı (%${Math.round(anaDeger)} < %${gerekli}` +
            (esikDuz || erkenYariDuz ? ` = %${Math.round(esikSon)}+${esikDuz + erkenYariDuz} ceza` : '') + ')'
          : `5dk onayı yok (5dk %${p5 === null ? '-' : Math.round(p5)} < %${esik5})`;
      return blok(mac, neden);
    }

    // İlk uyarı: olasılıkla ters soğuma (eşikte ~4 dk, çok sıcakta ~1 dk).
    // Tekrar uyarılar: sabit ve kısa (varsayılan 2 dk) → dakikalar içinde
    // "üst üste 2./3. uyarı" gelebilsin.
    const tabanDk = CFG.sogumaDakika ?? 7;
    const kat = anaDeger >= sicakEsik ? 0.2 : anaDeger >= esik + 5 ? 0.35 : 0.55;
    const soguma = uyariVar
      ? Math.max(45 * 1000, (CFG.tekrarSogumaDakika ?? 2) * 60 * 1000)
      : Math.max(60 * 1000, tabanDk * kat * 60 * 1000);
    if (now() - (mac.uyariZamani.on || 0) < soguma) {
      return blok(mac, `soğuma (${Math.ceil((soguma - (now() - (mac.uyariZamani.on || 0))) / 60000)} dk)`);
    }

    // Global aralık: aynı anda birçok maç eşiği geçince uyarı yağmuru olmasın.
    // Bu kontrol maçın soğuma sayacını tüketmez; sırası gelen sonraki turda uyarır.
    const aralik = (CFG.uyariAralikSaniye ?? 30) * 1000;
    if (now() - sonGlobalUyari < aralik) {
      return blok(mac, 'global aralık (30 sn) — sıra bekliyor');
    }

    sonGlobalUyari = now();
    mac.uyariZamani.on = now();
    mac.sonBlok = null;
    // Aynı maçta kaçıncı uyarı? İkinciden itibaren "gol gelmek üzere" tonu.
    mac.uyariSayisi = (mac.uyariSayisi || 0) + 1;
    mac.sogudu = false;
    const tekrar = mac.uyariSayisi >= 2 || (mac.sonUyariZaman && now() - mac.sonUyariZaman < 15 * 60 * 1000);
    const oncekiUyari = mac.sonUyari || null;
    // Takip penceresi: kullanıcı "dakikası değil, gol gelsin" diyor. Ölçüm:
    // uyarı sonrası 10 dk %36, 20 dk %50, 30 dk %59. Kayıt 20 dk üzerinden
    // tutulur; model eşiği değişmez, sadece "tuttu" penceresi geniş.
    if (!patlamaZayif) {
      const izleme = Math.min(CFG.izlemePencereDk ?? 20, 95 - d.dakika);
      mac.sonTahmin = { dk: d.dakika, tip: '10dk', bitisDk: d.dakika + izleme, p: gosterge };
      tahminEkle(mac.meta.id, `${d.ev} - ${d.dep}`, mac.meta.lig, d.dakika, gosterge, d.dakika + izleme);
    }
    // Bir sonraki uyarıda "artış var mı" karşılaştırması için sakla
    mac.sonUyari = { p10: kararP, p5, buyuk: gcEsik.buyuk, ic: gcEsik.ic };
    mac.sonUyariSut = sut5; // tekrar uyarı için "yeni şut" ölçüsü
    mac.sonUyariDk = d.dakika;
    mac.sonUyariZaman = now();

    // Karşılaştırma yuvarlanmış değerle: ekranda %32 yazıp "OYNA" vermemesi kafa karıştırıyordu
    const sicak = !patlamaZayif && !!pat && gosterge >= patEsik;
    // ÖNEMLİ: izYazi burada tanımlanmalı. Aşağıda `let` ile tanımlanınca
    // yukarıdaki kullanım TDZ hatası veriyordu ("Cannot access 'izYazi'
    // before initialization") ve HER uyarı sessizce yutuluyordu: logda sadece
    // HAZIRLIK kalıyor, GOL YAKIN / GOL GELMEK ÜZERE hiç çıkmıyordu.
    let izYazi = '';
    const gc = golCesitOzet(d, 15);
    // Artık karar İSTATİSTİKTEN (şut/isabet sayacı) veriliyor: AiScore'da şut
    // haritası olmasa da model aynı özellikleri kullanıyor. Bu yüzden
    // "istatistik" etiketi kaldırıldı; eşiği geçen her uyarı OYNA'dır.
    const baslik = patlamaZayif
      ? `👀 TAKİP · %${Math.round(gosterge)} · 10dk GOL (OYNA DEĞİL)`
      : sicak
      ? `🔥 10dk GOL %${Math.round(gosterge)} · ✅ OYNA`
      : tekrar
        ? `⚡ 10dk GOL %${Math.round(gosterge)} · ⚠️ DÜŞÜK GÜVEN`
        : `⚽ 10dk GOL %${Math.round(gosterge)}`;
    izYazi = uyariIzi(mac, d.dakika, anaDeger, baslik);
    // Son 5 dakika sayıları: şut haritası yoksa istatistikten (pat.ozellik).
    const s5sut = sut5 !== null ? sut5 : (pat && pat.ozellik ? pat.ozellik.d5sut : null);
    const s5sot = sut5 !== null ? sot5 : (pat && pat.ozellik ? pat.ozellik.d5sot : null);
    const s5Yazi = s5sut !== null && s5sut > 0
      ? `son 5 dk ${s5sut} şut${s5sot ? ` (${s5sot} isabet)` : ''}`
      : null;
    // BASKI: tehlikeli atak + atak sayısı (son 5 dk). Karar değiştirmez,
    // sadece "baskı var mı" göstergesi olarak mesaja yazılır.
    const baskYazi = (() => {
      const o = pat && pat.ozellik;
      if (!o || (o.teh5 === null && o.atk5 === null)) return null;
      const p = [];
      if (o.teh5 !== null) p.push(`${o.teh5} tehlikeli atak`);
      if (o.atk5 !== null) p.push(`${o.atk5} atak`);
      if (o.d5korner) p.push(`${o.d5korner} korner`);
      return p.length ? `baskı: son 5 dk ${p.join(' · ')}` : null;
    })();
    const durumYazi = tekrar
      ? `üst üste ${mac.uyariSayisi}. uyarı · ${artisYazi(oncekiUyari, anaDeger, p5, gcEsik)}` +
        (s5Yazi ? ` · ${s5Yazi}` : '')
      // Anlık baskı verisi varsa HER ZAMAN yazılır: eşiği geçmese bile
      // "son 5 dk 1 şut (1 isabet)" bilgisi mesajda görünsün.
      : s5Yazi
        ? `anlık baskı · ${s5Yazi}` +
          (xg5Top !== null && xg5Top > 0 ? ` · xG ${xg5Top.toFixed(2)}` : '')
        : 'baskı sürüyor';
    if (patlamaZayif) mac.sonBaskiUyari = { dk: d.dakika, baslik: 'TAKİP', zaman: now() };
    uyariYaz(
      sicak ? 'sicak' : 'baski',
      baslik,
      `${dkYazi} ${d.ev} ${d.skor[0]}-${d.skor[1]} ${d.dep} · ${durumYazi}`,
      `10dk gol olasılığı %${Math.round(gosterge)}` +
        (() => {
          // Kullanıcının bahsi "yarı bitmeden gol": 10 dk'lık olasılığı kalan
          // süreye yay (bağımsız bloklar): 1-(1-p)^(kalan/10).
          const kalan = (d.dakika <= 45 ? 45 : 90) - d.dakika;
          const blok = Math.max(0, kalan / 10);
          if (blok <= 0) return '';
          const py = 1 - Math.pow(1 - gosterge / 100, blok);
          return ` · yarı sonuna kadar %${Math.round(Math.min(95, py * 100))} (${kalan} dk kaldı)`;
        })() +
        (s5Yazi ? ` · ${s5Yazi}` : '') +
        (baskYazi ? ` · ${baskYazi}` : '') +
        (patlamaZayif ? ' · TAKİP katmanı (istatistiğe girmez)' : '') +
        (gc.ic || gc.buyuk
          ? ` · ceza sahası ${gc.ic} şut${gc.buyuk ? ` · ${gc.buyuk} büyük şans` : ''}`
          : '') +
        (() => {
          const k = d.istat?.kacti;
          const n = k ? (k[0] || 0) + (k[1] || 0) : 0;
          return n > 0 ? ` · ${n} büyük şans kaçtı` : '';
        })() +
        (() => {
          const k = d.istat?.kurtaris;
          const n = k ? (k[0] || 0) + (k[1] || 0) : 0;
          return n >= 3 ? ` · kaleci ${n} kurtarış` : '';
        })() +
        (CFG.yariKarar === true && b.yariOlasilik !== null && b.yariOlasilik !== undefined
          ? ` · yarı %${Math.round(b.yariOlasilik * 100)}`
          : '') +
        (izYazi ? ` · önceki: ${izYazi}` : '') +
        (() => {
          const py = piyasaP10(mac);
          return py === null ? '' : ` · piyasa %${Math.round(py)}`;
        })() +
        ` · ${mac.meta.lig}`,
      mac.meta.id
    );
    return;
  }

  // Maç bazlı model: tek uyarı, tüm maç için
  if (!b.kaynak && b.macOlasilik !== null && b.macOlasilik !== undefined) {
    const deger = b.macOlasilik * 100;
    if (deger < CFG.uyariYuzde) return;
    if (now() - (mac.uyariZamani.mac || 0) < Math.max(2, CFG.sogumaDakika * 0.5) * 60 * 1000) return;

    mac.uyariZamani.mac = now();
    const sicak = deger >= CFG.cokSicakYuzde;
    const baskiTaraf = (b.ev.xg ?? 0) >= (b.dep.xg ?? 0) ? d.ev : d.dep;
    const toplamXg = ((b.ev.xg ?? 0) + (b.dep.xg ?? 0)).toFixed(2);

    uyariYaz(
      sicak ? 'sicak' : 'baski',
      sicak ? '🔥 ÇOK SICAK' : '⚽ Gol yakın',
      `${dkYazi} ${d.ev} ${d.skor[0]}-${d.skor[1]} ${d.dep}`,
      `maçta gol ihtimali %${Math.round(deger)} (${KAL.ufukDakika || 10} dk) · ` +
        `baskı: ${baskiTaraf} · toplam xG ${toplamXg} · ${mac.meta.lig}`,
      mac.meta.id
    );
    return;
  }

  for (const [anahtar, taraf] of [['ev', b.ev], ['dep', b.dep]]) {
    const deger = uyariDegeri(taraf);
    if (deger < esikDegeri(false)) continue;
    if (now() - (mac.uyariZamani[anahtar] || 0) < Math.max(2, CFG.sogumaDakika * 0.5) * 60 * 1000) continue;

    mac.uyariZamani[anahtar] = now();
    const takim = anahtar === 'ev' ? d.ev : d.dep;
    const sicak = deger >= esikDegeri(true);

    const parca = [`${taraf.sut} şut`, `${taraf.isabet} isabet`];
    if (taraf.xg !== null) parca.push(`xG ${taraf.xg.toFixed(2)}`);
    if (taraf.mom !== null) parca.push(`mom ${taraf.mom > 0 ? '+' : ''}${taraf.mom}`);

    const baslik = sicak ? '🔥 ÇOK SICAK' : '⚽ Gol yakın';
    const olcu = MODEL_VAR
      ? `%${Math.round(deger)} gol ihtimali`
      : `baskı ${taraf.puan}/100`;

    uyariYaz(
      sicak ? 'sicak' : 'baski',
      baslik,
      `${dkYazi} ${d.ev} ${d.skor[0]}-${d.skor[1]} ${d.dep}`,
      `${takim} · ${olcu} · ${parca.join(', ')} · ${mac.meta.lig}`,
      mac.meta.id
    );
  }
}

/* ------------------------------- döngü -------------------------------- */

async function tarama() {
  if (taramaCalisiyor) return;
  taramaCalisiyor = true;
  sonTarama = now();
  try {
    let liste = await canliMaclariGetir();

    const engel = (lig) =>
      (CFG.engelliLigler || []).some((e) => lig.toLowerCase().includes(String(e).toLowerCase()));

    liste = liste.filter((m) => !engel(m.lig));
    if (CFG.ligler && CFG.ligler.length) {
      liste = liste.filter((m) => CFG.ligler.some((l) => m.lig.toLowerCase().includes(String(l).toLowerCase())));
    }

    const oncelik = (m) => {
      const i = (CFG.oncelikliLigler || []).findIndex((l) =>
        m.lig.toLowerCase().includes(String(l).toLowerCase())
      );
      return i === -1 ? 999 : i;
    };
    liste.sort((a, b) => oncelik(a) - oncelik(b) || b.dakika - a.dakika);

    const secilen = CFG.maxMac > 0 ? liste.slice(0, CFG.maxMac) : liste;
    const secilenIdler = new Set(secilen.map((m) => m.id));

    for (const m of secilen) {
      const mevcut = maclar.get(m.id);
      if (mevcut) {
        const eskiSkor = mevcut.skor;
        mevcut.meta = { ...mevcut.meta, ...m };
        mevcut.meta.skor = m.skor;
        mevcut.meta.dakika = m.dakika;
        mevcut.sonGorulme = now();
        // HIZLI GOL: liste skoru (20 sn) detaydan (30 sn+ ve tur başına az maç)
        // önce değişir. Gol burada yakalanır — AiScore'da olmayan maçlarda da
        // "gol oldu ama bildirim gelmedi" durumunu bitirir.
        if (mevcut.detay && Array.isArray(eskiSkor) && Array.isArray(m.skor)) {
          const artti = (m.skor[0] + m.skor[1]) > (eskiSkor[0] + eskiSkor[1]);
          if (artti) {
            const dkListe = Number.isFinite(m.dakika) && m.dakika > 0
              ? Math.round(m.dakika)
              : (mevcut.detay.dakika || 0);
            if (dkListe > 0) mevcut.detay.dakika = Math.max(mevcut.detay.dakika || 0, dkListe);
            try {
              golKontrol(mevcut, m.skor, mevcut.detay.dakika || dkListe);
            } finally {
              mevcut.skor = m.skor;
            }
          }
        }
      } else {
        maclar.set(m.id, {
          meta: m,
          detay: null,
          gecmis: [],
          istGecmis: [],
          sonDetay: 0,
          sonGorulme: now(),
          uyariZamani: { ev: 0, dep: 0, mac: 0, yari: 0, on: 0 },
          skor: Array.isArray(skorlar[m.id]) ? skorlar[m.id] : m.skor,
          baski: null
        });
      }
    }

    // Listeden geçici olarak düşen maçı hemen silme: soğuma süresi, tahmin ve
    // geçmiş sıfırlanınca aynı maç için uyarılar tekrar tekrar basılıyordu.
    const silmeEsigi = 10 * 60 * 1000;
    for (const [id, m] of [...maclar.entries()]) {
      if (secilenIdler.has(id)) continue;
      if (now() - (m.sonGorulme || 0) < silmeEsigi) continue;
      maclar.delete(id);
    }

    // AiScore'da olup FotMob'da olmayan canlı maçları da takibe al
    if (CFG.aiscore !== false && AI.liste.length) {
      for (const x of AI.liste) {
        if (!x.canli) continue;
        // Dakika artık aiscore.js içinde maç saatinden hesaplanıyor (devre arası
        // düşülerek). Burada ayrıca süre eklemek dakikayı şişiriyordu (45 → 56).
        const dkAi = Number.isFinite(x.dakika) ? Math.round(x.dakika) : null;
        const varMi = [...maclar.values()].some(
          (m) => m.meta.kaynak !== 'aiscore' &&
            benzer(m.meta.ev, x.ev) >= 0.45 && benzer(m.meta.dep, x.dep) >= 0.45
        );
        if (varMi) continue;
        const id = 'ai:' + x.id;
        const mevcut = maclar.get(id);
        if (mevcut) {
          const eski = mevcut.skor || [0, 0];
          const duz = dakikaDuzelt(mevcut, dkAi);
          mevcut.meta.skor = x.skor;
          mevcut.meta.dakika = duz;
          mevcut.meta.durum = x.durum;
          if (mevcut.detay) {
            mevcut.detay.durum = x.durum;
            // AiScore bitiş/erteleme durumları: canlı sayılmaz. Yoksa FT'den
            // sonra da "gol yakın" uyarısı üretilmeye devam ediyordu.
            const aiKod = Number(x.durum);
            // Devre arası (3) da canlı sayılır: maç ekranda/takipte kalır,
            // uyarı üretimini macOynuyorMu() zaten kesiyor.
            mevcut.detay.canli = aiKod === 2 || aiKod === 3 || aiKod === 4;
            mevcut.detay.bitti = aiKod === 5 || aiKod === 8 || aiKod === 9 || aiKod === 13;
          }
          mevcut.sonGorulme = now();
          mevcut.sonDetay = now(); // liste verisi taze: uyarı tazelik kontrolü için
          mevcut.detay.dakika = duz != null ? duz : mevcut.detay.dakika;
          mevcut.detay.skor = x.skor;
          if (x.skor[0] > eski[0] || x.skor[1] > eski[1]) {
            mevcut.skor = x.skor;
            // Skoru AiScore'dan yakaladık: bekleyen tahmini burada da kapat.
            // Kapatılmazsa pencere dolunca "tutmadi" yazılıyor ve isabet
            // istatistiği olduğundan kötü görünüyordu.
            const dkGol = mevcut.detay.dakika;
            let buGecerliAi = false, buAi = null;
            if (dkGol > 0) {
              buAi = mevcut.sonBaskiUyari;
              buGecerliAi = !!(buAi && Number.isFinite(buAi.dk) && dkGol >= buAi.dk
                && ((dkGol <= 45 && buAi.dk <= 45) || (dkGol > 45 && buAi.dk > 45)));
              tahminKapat(id, 'tuttu', dkGol);
              mevcut.sonTahmin = null;
              mevcut.sonBaskiUyari = null;
              // Sayaç gol sonrası baştan: uyarı hakkı maç boyu yeniden çalışır.
              mevcut.uyariSayisi = 0;
              mevcut.uyariZamani.on = 0;
              mevcut.uyariZamani.mac = 0;
              mevcut.sogudu = false;
              mevcut.sonUyariZaman = 0;
              mevcut.sonUyariDk = null;
              mevcut.golSonrasiZaman = now();
              mevcut.sonGolDk = dkGol; // "baskı artıyor" susturma (maç dakikası)
              golSonrasiSifirla(mevcut, dkGol); // geçmiş tamamen sıfır
              golSessizligiYay(mevcut, dkGol);
              // Gol sonrası ARTIS takibi sıfırdan: yeni bantlar yeniden sayılır.
              mevcut.trendBant = 0;
              mevcut.trendSayisi = 0;
              mevcut.p10Gecmis = [];
              mevcut.hazirlikZaman = 0;
              mevcut.uyariIzi = [];
            }
            const dkYazi = mevcut.detay.dakika > 0 ? `${mevcut.detay.dakika}'` : "dk ?";
            const ist = mevcut.detay.istat;
            const istYazi = ist && ist.sut
              ? ` · ${ist.sut[0]}-${ist.sut[1]} şut` +
                (ist.sot ? ` (${ist.sot[0]}-${ist.sot[1]} isabet)` : '')
              : '';
            uyariYaz(
              'gol',
              buGecerliAi ? '⚽ GOL — TUTTU (AiScore)' : '⚽ GOL (AiScore)',
              `${dkYazi} ${x.ev} ${x.skor[0]}-${x.skor[1]} ${x.dep}`,
              `AiScore skoru${istYazi}` +
                (buGecerliAi ? ` · ✅ TUTTU (${dkGol - buAi.dk} dk sonra · ${buAi.baslik})` : '') +
                ` · ${x.lig || ''}`,
              id
            );
          }
        } else {
          maclar.set(id, {
            meta: { id, kaynak: 'aiscore', lig: x.lig || 'Bilinmeyen', ev: x.ev, dep: x.dep, skor: x.skor, dakika: x.dakika, durum: x.durum },
            detay: {
              ev: x.ev, dep: x.dep, lig: x.lig || '', dakika: dkAi ?? 0, skor: x.skor, durum: x.durum,
              canli: [2, 3, 4].includes(Number(x.durum)),
              bitti: [5, 8, 9, 13].includes(Number(x.durum)), atislar: [], momentum: [], kartlar: [], istat: null
            },
            gecmis: [], istGecmis: [], sonDetay: now(), sonGorulme: now(),
            uyariZamani: { ev: 0, dep: 0, mac: 0, yari: 0, on: 0 },
            skor: Array.isArray(skorlar[id]) ? skorlar[id] : x.skor, baski: null, bos: true, dakikaSon: dkAi ?? null
          });
        }
        const kayit = maclar.get(id);
        if (kayit) aiDetayTazele(kayit);
        // AiScore'da da istatistik yoksa Flashscore'dan dene: "veri yok"
        // denen maçların bir kısmında şut/isabet orada oluyor.
        if (kayit && !kayit.detay?.istat) {
          require('./kaynak2').bul(kayit.detay.ev, kayit.detay.dep).then((s) => {
            if (!s || (!s.sut && !s.isabet)) return;
            const evS = s.sut?.[0] ?? 0, depS = s.sut?.[1] ?? 0;
            const evI = s.isabet?.[0] ?? 0, depI = s.isabet?.[1] ?? 0;
            kayit.detay.istat = {
              sut: [evS, depS], sot: [evI, depI],
              xg: s.xg || [evS * 0.1105, depS * 0.1105],
              box: [null, null], big: [null, null],
              korner: s.korner || [null, null]
            };
            kayit.bos = false;
            istGecmisEkle(kayit, kayit.detay.dakika, kayit.detay.istat);
          }).catch(() => {});
        }
      }
    }

    durum.sonHata = '';
    skorlariKaydet();
  } catch (e) {
    durum.sonHata = e.message;
  } finally {
    taramaCalisiyor = false;
  }
  aiTazele();
  piyasaTazele();
}

async function detayDongusu() {
  const adaylar = [...maclar.values()]
    .filter((m) => m.meta.kaynak !== 'aiscore')
    .filter((m) => now() - m.sonDetay > CFG.detaySaniye * 1000)
    .sort((a, b) => a.sonDetay - b.sonDetay);

  // FotMob'da şut haritası/istatistik vermeyen (boş) maçlarda AiScore'daki
  // şut-isabet verisini kullan. "Veri yok" denen maçların çoğunda AiScore'da
  // istatistik vardı ama hiç denenmiyordu.
  for (const m of adaylar.filter((x) => x.bos && !x.detay?.istat).slice(0, 2)) {
    aiDetayTazele(m);
  }

  // Aynı turda birden fazla maç: detay 30 sn'de bir yenileniyordu ama tur
  // başına 2 maç olduğu için 23 maçlık listede sıra dakikalarca gelmiyordu.
  // Artık her turda 6 maç (CFG.detayTurAdet) ve tur 5 sn'de bir.
  for (const secili of adaylar
    .filter((m) => !(m.bos && now() - (m.bosZaman || 0) < 15 * 60 * 1000 && m.detay?.istat))
    .slice(0, CFG.detayTurAdet ?? 6)) {
    secili.sonDetay = now();
    try {
      const j = await detayGetir(secili.meta.id);
      const d = detayiIsle(j);
      // AiScore'dan alınmış istatistik varsa FotMob onu boş döndürünce silme
      const aiIstat = secili.detay?.istat || null;
      if (!d.istat && aiIstat) d.istat = aiIstat;
      const duz = dakikaDuzelt(secili, d.dakika);
      d.dakika = duz != null ? duz : secili.dakikaSon ?? 0;
      secili.detay = d;
      secili.meta.lig = secili.meta.lig || d.lig;
      if (d.istat) secili.istatZaman = now(); // verinin gerçek yaşı (FotMob dahil)

      // Yarı değişiminde gol sonrası sessizliği taşıma: 45+'ta atılan gol
      // 2. yarıda yeni alarmı engellemesin. (Dakika şartı zaten yarıya duyarlı.)
      if (d.dakika >= 46 && d.dakika <= 47
        && secili.sonGolDk != null && secili.sonGolDk <= 45) {
        secili.golSonrasiZaman = null;
        secili.sonGolDk = null;
        secili.istBazZaman = null;
      }

      let golOldu = false;
      try {
        golOldu = golKontrol(secili, d.skor, d.dakika);
      } finally {
        secili.skor = d.skor;
      }

      const veriVar = d.atislar.length > 0;
      secili.bos = !veriVar && !d.istat;
      anlikKaydet(secili, d);
      if (secili.bos) {
        secili.bosZaman = now();
        if (!secili.bosIlkZaman) secili.bosIlkZaman = now();
      } else {
        secili.bosIlkZaman = 0;
      }
      if (!secili.bos && d.istat) istGecmisEkle(secili, d.dakika, d.istat);

      if (!golOldu) baskiKontrol(secili);
      // FotMob'da şut haritası/istatistik yoksa AiScore'daki şut-isabet ile doldur
      if (secili.bos || !d.istat) aiDetayTazele(secili);
      // AiScore bulamadıysa Flashscore'dan şut/isabet dene (2 dk soğuma).
      if ((secili.bos || !d.istat) && now() - (secili.kaynak2Zaman || 0) > 120000) {
        secili.kaynak2Zaman = now();
        require('./kaynak2').bul(d.ev, d.dep).then((s) => {
          if (!s || secili.detay.istat) return;
          const eS = s.sut?.[0] ?? 0, dS = s.sut?.[1] ?? 0;
          if (eS + dS <= 0) return;
          const eI = s.isabet?.[0] ?? 0, dI = s.isabet?.[1] ?? 0;
          secili.detay.istat = { sut: [eS, dS], sot: [eI, dI], xg: s.xg || [eS * 0.1105, dS * 0.1105], box: [null, null], big: [null, null], korner: s.korner || [null, null] };
          secili.bos = false;
          secili.bosIlkZaman = 0;
          istGecmisEkle(secili, secili.detay.dakika, secili.detay.istat);
          baskiKontrol(secili);
        }).catch(() => {});
      }
    } catch (e) {
      durum.sonHata = e.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* ------------------------------ ekran --------------------------------- */

function cubuk(puan, genislik = 10) {
  const dolu = Math.round((puan / 100) * genislik);
  const esik = esikDegeri(false);
  const sicak = esikDegeri(true);
  const renk = puan >= sicak ? C.red : puan >= esik ? C.yellow : puan >= esik - 5 ? C.cyan : C.gray;
  return renk + '█'.repeat(dolu) + C.gray + '░'.repeat(genislik - dolu) + C.reset;
}

function skorRenk(a, b) {
  return a > b ? C.green : a < b ? C.red : C.white;
}

function tahminGuncelle() {
  let deg = false;
  const suAn = now();
  for (const t of tahminler) {
    if (t.sonuc !== 'bekliyor') continue;
    const m = maclar.get(t.mid);
    if (!m || !m.detay) {
      // Maç takipten çıktı: 3 saat sonra sonucu "bilinmiyor" say
      if (t.zaman && suAn - t.zaman > 3 * 60 * 60 * 1000) { t.sonuc = 'bilinmiyor'; deg = true; }
      continue;
    }
    const d = m.detay;
    let bitti;
    if (t.tip === '10dk') {
      // 10 dakikalık pencere geçtiyse, yarı bittiyse veya maç bittiyse tutmadı
      bitti = (typeof t.bitisDk === 'number' && d.dakika > t.bitisDk)
        || d.bitti || !d.canli
        || (t.dk <= 45 && d.dakika > 45);
    } else {
      bitti = (t.yari === 1 && d.dakika > 45) || (t.yari === 2 && (d.dakika >= 90 || !d.canli));
    }
    if (bitti) { t.sonuc = 'tutmadi'; t.sonDk = d.dakika; deg = true; }
  }
  if (deg) tahminKaydet();
}

// Otokalibrasyon: son uyarıların gerçek isabetine göre 10 dk eşiğini ayarlar.
// Veri azsa dokunmaz; değişim 1 puandır ve 27-38 aralığında kalır.
// KAPALI (CFG.otokalibre): eşik %28'de sabit tutuluyor, otomatik kaydırma
// sabit eşikle çakışıp uyarı sayısını düşürüyordu.
function esikOtokalibre() {
  if (CFG.otokalibre !== true) return null;
  const b = tahminler.filter((t) => (t.tip || '10dk') === '10dk' && (t.sonuc === 'tuttu' || t.sonuc === 'tutmadi')).slice(-40);
  if (b.length < 30) return null;
  const tut = b.filter((t) => t.sonuc === 'tuttu').length;
  const oran = tut / b.length;
  const mevcut = CFG.uyariYuzde10 ?? 28;
  let yeni = mevcut;
  if (oran < 0.22) yeni = mevcut + 1;
  else if (oran > 0.38) yeni = mevcut - 1;
  yeni = Math.max(27, Math.min(38, yeni));
  if (yeni === mevcut) return null;
  CFG.uyariYuzde10 = yeni;
  try {
    const a = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'ayarlar.json'), 'utf8').replace(/^\uFEFF/, ''));
    a.uyariYuzde10 = yeni;
    fs.writeFileSync(path.join(APP_DIR, 'ayarlar.json'), JSON.stringify(a, null, 2), 'utf8');
  } catch (_) {}
  return { eski: mevcut, yeni, oran, n: b.length };
}

function tahminIstatistik() {
  // Aynı maç + yarı için tek kayıt say (tekrar uyarılar istatistiği bozmasın)
  const gorulen = new Set();
  let tutan = 0, tutmayan = 0, bekleyen = 0;
  for (const t of tahminler) {
    const k = `${t.mid}|${t.yari}`;
    if (gorulen.has(k)) continue;
    gorulen.add(k);
    if (t.sonuc === 'tuttu') tutan++;
    else if (t.sonuc === 'tutmadi') tutmayan++;
    else if (t.sonuc === 'bekliyor') bekleyen++;
  }
  const biten = tutan + tutmayan;
  return { tutan, tutmayan, bekleyen, biten, oran: biten ? Math.round((tutan / biten) * 100) : 0 };
}

function ekranCiz() {
  tahminGuncelle();
  if (LOG_ONLY) {
    const canli = [...maclar.values()].filter((m) => m.detay?.canli);
    const aktif = canli.length;
    const en = canli
      .filter((m) => m.baski?.p10 !== null && m.baski?.p10 !== undefined)
      .sort((a, b) => b.baski.p10 - a.baski.p10)[0];
    const yakin = en
      ? ` · EN YAKIN: ${en.detay.ev} ${en.detay.skor[0]}-${en.detay.skor[1]} ${en.detay.dep} ${en.detay.dakika}' ` +
        `%${Math.round(en.baski.p10 * 100)} (5dk %${Math.round((en.baski.p5 ?? 0) * 100)})`
      : '';
    const aiYazi = CFG.aiscore === false ? '' : ` · AiScore ${AI.liste.length}${AI.hata ? ` (${kirp(AI.hata, 20)})` : ''}`;
    process.stdout.write(`\r${C.gray}[${saat()}] ${aktif} canlı maç takipte · ${maclar.size} maç · toplam ${toplamIstek} istek${aiYazi}${yakin}${durum.sonHata ? ' · hata: ' + durum.sonHata : ''}${C.reset}   `);
    return;
  }

  const satirlar = [];
  const W = 100;
  const cizgi = C.gray + '─'.repeat(W) + C.reset;

  satirlar.push('');
  satirlar.push(
    `  ${C.cyan}${C.bold}◉ GOL RADAR${C.reset} ${C.gray}canlı gol yakınlık takibi${C.reset}` +
      ' '.repeat(30) + `${C.gray}${saat()}${C.reset}`
  );
  satirlar.push('  ' + cizgi);

  const aktif = [...maclar.values()].filter((m) => m.detay?.canli);
  const sirali = aktif
    .map((m) => {
      let b = m.baski;
      if (!b || (b.p10 == null && m.istGecmis?.length)) {
        b = baskiIstatistik(m) || baski(m) || b;
      }
      if (!b && m.meta.kaynak === 'aiscore') {
        const taraf = () => ({ olasilik: null, puan: 0, xg: null, isabet: 0, sut: 0, mom: null, xg5: null, sot5: 0, buyuk: 0 });
        b = { ev: taraf(), dep: taraf(), macOlasilik: null, yariOlasilik: null, p5: null, p10: null, kaynak: 'aiscore' };
      }
      return b ? { m, b } : null;
    })
    .filter(Boolean)
    .sort((x, y) => (x.m.meta.kaynak === 'aiscore' ? 1 : 0) - (y.m.meta.kaynak === 'aiscore' ? 1 : 0) || satirDegeri(y.b) - satirDegeri(x.b));

  const esikYazi = KISA && KISA.m10
    ? `uyarı: 10dk %${CFG.uyariYuzde10 ?? 28} · çok yakın %${CFG.cokSicakYuzde10 ?? 34} · 5dk onay %${CFG.uyariYuzde5 ?? 12} · anlık ${CFG.anlikSut5 ?? 2} şut/${CFG.anlikXg5 ?? 0.3} xG`
    : KAL2
    ? `uyarı: YARI %${CFG.yariYuzde ?? 65} · sıcak %${CFG.yariSicakYuzde ?? 80} · 10dk sadece ekran`
    : MODEL_VAR
    ? `eşik %${CFG.uyariYuzde} · model AUC ${KAL.auc ?? '-'}`
    : `eşik ${CFG.uyariEsigi} · model yok`;

  satirlar.push(
    `  ${C.gray}Takipte ${aktif.length} maç · ${esikYazi} · pencere son ${CFG.pencereDakika} dk · ` +
      `tarama ${CFG.taramaSaniye}s` +
      (KISA && KISA.m10 && KISA.m10.esikIsabet
        ? ` · 10dk test isabet %${KISA.m10.esikIsabet}`
        : KAL2
        ? ` · test isabet %${KAL2.esikIsabet} (eşik %${KAL2.esikYuzde ?? '?'})`
        : MODEL_VAR
        ? ` · isabet %${CFG.akilliSaatFiltresi ? (KAL.filtreIsabet ?? KAL.esikIsabet) : KAL.esikIsabet}`
        : '') +
      `${durum.sonHata ? ` · ${C.red}${durum.sonHata}${C.gray}` : ''}${C.reset}`
  );
  satirlar.push('');

  satirlar.push(
    `  ${C.gray}${'10DK%'.padEnd(6)} ${'MAÇ'.padEnd(36)}${'DK'.padStart(4)} ${'SKOR'.padStart(6)}  SON PENCERE${C.reset}`
  );

  if (!sirali.length) {
    const mesaj = maclar.size
      ? 'İstatistikler yükleniyor...'
      : 'Şu anda canlı maç yok. Tarama devam ediyor.';
    satirlar.push(`  ${C.dim}${mesaj}${C.reset}`);
  }

  for (const { m, b } of sirali.slice(0, 16)) {
    const d = m.detay;
    const en = satirDegeri(b);
    const hangi = (b.ev.xg ?? -1) >= (b.dep.xg ?? -1) ? b.ev : b.dep;
    const takim = (b.ev.xg ?? -1) >= (b.dep.xg ?? -1) ? d.ev : d.dep;
    const macAdi = kirp(`${d.ev} - ${d.dep}`, 36).padEnd(36);
    const dk = String(d.dakika) + "'";
    const sk = `${d.skor[0]}-${d.skor[1]}`;
    const esik = esikDegeri(false);
    const renk = en >= esikDegeri(true) ? C.red : en >= esik ? C.yellow : en >= esik - 5 ? C.cyan : C.white;

    const py = m.bos ? null : piyasa.getir(d.ev, d.dep, d.skor[0] + d.skor[1]);
    const kisaYazi =
      b.p5 !== null && b.p10 !== null
        ? `${C.cyan}5dk%${Math.round(b.p5 * 100)}` +
          (CFG.yariKarar === true && b.yariOlasilik !== null && b.yariOlasilik !== undefined
            ? ` yarı%${Math.round(b.yariOlasilik * 100)}`
            : '') + `${C.reset}` +
          (py ? ` ${C.blue}P%${Math.round(py.gol * 100)}${C.reset}` : '')
        : '';
    const anom = m.meta.kaynak === 'aiscore' ? [] : TABAN ? anomali(b, d, TABAN) : [];
    const ai = m.bos ? aiBul(d.ev, d.dep) : null;
    const veri = anom.length
      ? `${C.magenta}⚠ ${kirp(anom[0], 24)}${C.reset}`
      : m.bos
      ? ai
        ? `${C.magenta}AI${C.reset} ${ai.skor[0]}-${ai.skor[1]}`
        : m.fs
        ? `${C.magenta}FS${C.reset} ${C.dim}${m.fs.sut?.[0] ?? 0}-${m.fs.sut?.[1] ?? 0}ş ${m.fs.isabet?.[0] ?? 0}-${m.fs.isabet?.[1] ?? 0}i${C.reset}`
        : `${C.gray}veri yok${C.reset}`
      : `${C.dim}${kirp(takim, 13).padEnd(13)} ${hangi.sut}ş ${hangi.isabet}i xG${hangi.xg === null ? '-' : hangi.xg.toFixed(2)}${C.reset} ${kisaYazi}`;

    const deger = m.bos ? '—' : MODEL_VAR ? `%${Math.round(en)}` : String(Math.round(en));

    satirlar.push(
      `  ${renk}${deger.padStart(4)}${C.reset} ${cubuk(m.bos ? 0 : en, 6)} ` +
        `${C.white}${macAdi}${C.reset} ` +
        `${C.gray}${dk.padStart(4)}${C.reset} ` +
        `${skorRenk(d.skor[0], d.skor[1])}${sk.padStart(6)}${C.reset}  ${veri}`
    );
  }

  satirlar.push('');
  satirlar.push('  ' + cizgi);
  satirlar.push(`  ${C.gray}${C.bold}SON UYARILAR${C.reset}`);

  if (!uyariGecmisi.length) {
    satirlar.push(`  ${C.dim}Henüz uyarı yok. Eşik aşıldığında burada görünecek.${C.reset}`);
  }

  for (const u of uyariGecmisi.slice(0, 7)) {
    const renk = u.seviye === 'sicak' ? C.red : u.seviye === 'gol' ? C.magenta : C.yellow;
    satirlar.push(`  ${C.gray}${u.zaman}${C.reset} ${renk}${C.bold}${kirp(u.baslik, 14)}${C.reset} ${kirp(u.satir1, 58)}`);
    satirlar.push(`              ${C.dim}${kirp(u.satir2, 92)}${C.reset}`);
  }

  satirlar.push('');
  const ist = tahminIstatistik();
  satirlar.push('');
  satirlar.push(
    `  ${C.gray}TAHMİN: ${C.green}${ist.tutan} tuttu${C.gray} · ${C.red}${ist.tutmayan} tutmadı${C.gray} · ` +
      `%${ist.oran} isabet · ${ist.bekleyen} bekliyor${C.reset}`
  );
  satirlar.push(`  ${C.gray}Ctrl+C ile çıkış · uyarılar: uyarilar.log${C.reset}`);
  satirlar.push('');

  process.stdout.write('\x1b[H\x1b[2J' + satirlar.join('\n'));
}

/* ------------------------------- main --------------------------------- */

function zamanlayiciBaslat() {
  zamanlayiciKur({ maclar, CFG, now, detayGetir, detayiIsle, golKontrol, baskiKontrol, durum, istGecmisEkle,
    dakikaDuzelt, aiDetayTazele, aiDakikaBul });
}

/*
 * HIZLI SKOR (Flashscore): AiScore skoru 1-3 dakika gecikmeli veriyor
 * (90+2 maçı 87' gösteriyor). Flashscore beslemesi daha hızlı; 10 sn'de bir
 * skorları karşılaştırıp önde olanı uygular ve golü anında işler.
 */
let fsSkorSon = 0;
let fsSkorCalisiyor = false;
function hizliSkorTazele() {
  if (fsSkorCalisiyor || now() - fsSkorSon < 10000) return;
  fsSkorCalisiyor = true;
  fsSkorSon = now();
  let k2 = null;
  try { k2 = require('./kaynak2'); } catch (_) { fsSkorCalisiyor = false; return; }
  if (typeof k2.canliListe !== 'function') { fsSkorCalisiyor = false; return; }
  k2.canliListe().then((liste) => {
    if (!Array.isArray(liste) || !liste.length) return;
    for (const m of maclar.values()) {
      if (!m.detay || !m.detay.canli || m.detay.bitti) continue;
      let en = null, sk = 0.8;
      for (const x of liste) {
        const p = Math.min(benzer(m.detay.ev, x.ev || ''), benzer(m.detay.dep, x.dep || ''));
        if (p > sk) { sk = p; en = x; }
      }
      if (!en) continue;
      const yeni = [Number(en.skor?.[0]) || 0, Number(en.skor?.[1]) || 0];
      const eski = m.skor || m.detay.skor || [0, 0];
      if (yeni[0] + yeni[1] <= eski[0] + eski[1]) continue;
      const dk = m.detay.dakika;
      try { golKontrol(m, yeni, dk); } catch (_) {}
      m.skor = yeni;
      m.detay.skor = yeni;
      try { baskiKontrol(m); } catch (_) {}
    }
  }).catch(() => {}).finally(() => { fsSkorCalisiyor = false; });
}

async function main() {
  if (!LOG_ONLY) process.stdout.write('\x1b[H\x1b[2J');
  console.log(`${C.cyan}${C.bold}GolRadar başlatılıyor...${C.reset} ${C.gray}canlı maç verisi alınıyor${C.reset}\n`);

  await tarama();

  // Açılış bildirimi: Telegram hattının çalıştığını doğrular
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    telegramBildir(
      `GolRadar başladı · ${maclar.size} maç takipte · uyarı eşiği %${CFG.uyariYuzde10 ?? 36}`
    );
  }

  // Nabız: sistemin ayakta olduğunu bildirir (nabizDakika: 0 = kapalı)
  if (CFG.nabizDakika > 0 && TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    setInterval(() => {
      const canli = [...maclar.values()].filter((m) => m.detay?.canli).length;
      durum.sonNabiz = saat();
      telegramBildir(`Sistem çalışıyor · ${saat()} · ${canli} maç takipte`);
    }, CFG.nabizDakika * 60 * 1000);
  }

  // Basit HTTP sunucusu (cloud health check + telefon erişimi)
  const http = require('http');
  const sunucu = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mac: maclar.size, zaman: saat(), sonNabiz: durum.sonNabiz || null, telegram: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID), nabizDakika: CFG.nabizDakika || 0, telegramSon: durum.telegramSon || null }));
      return;
    }
    if (req.url === '/maclar') {
      const liste = [...maclar.values()].filter(m => m.detay?.canli).map(m => ({
        mac: `${m.detay.ev} ${m.detay.skor[0]}-${m.detay.skor[1]} ${m.detay.dep}`,
        dk: m.detay.dakika,
        p10: m.baski?.p10 !== null && m.baski?.p10 !== undefined ? +(m.baski.p10 * 100).toFixed(1) : null,
        p5: m.baski?.p5 !== null && m.baski?.p5 !== undefined ? +(m.baski.p5 * 100).toFixed(1) : null,
        yari: CFG.yariKarar === true && m.baski?.yariOlasilik !== null && m.baski?.yariOlasilik !== undefined ? +(m.baski.yariOlasilik * 100).toFixed(1) : null,
        veri: m.detay.atislar?.length || 0,
        son5: (() => {
          const a = anlikBaski(m, m.detay);
          return a ? { sut: a.sut, sot: a.sot, xg: a.xg, tip: a.tip } : null;
        })(),
        istat: m.detay.istat ? { sut: m.detay.istat.sut, sot: m.detay.istat.sot, big: m.detay.istat.big, box: m.detay.istat.box } : null,
        bos: !!m.bos,
        engel: m.sonBlok?.neden || null,
        istatYas: m.istatZaman ? Math.round((Date.now() - m.istatZaman) / 1000) : null,
        kaynak: m.meta.kaynak || 'fotmob',
        ai: (() => {
          const x = aiBul(m.detay.ev, m.detay.dep);
          return x ? { skor: x.skor, dk: x.dakika } : null;
        })()
      })).sort((a, b) => (b.p10 ?? -1) - (a.p10 ?? -1));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(liste));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><meta http-equiv="refresh" content="30"></head><body><pre>' +
      [...maclar.values()].filter(m => m.detay?.canli).map(m => ({ m, b: m.baski || baski(m) }))
        .filter(x => x.b)
        .sort((x, y) => satirDegeri(y.b) - satirDegeri(x.b))
        .map(({ m, b }) =>
          `${m.detay.dakika}' ${m.detay.ev} ${m.detay.skor[0]}-${m.detay.skor[1]} ${m.detay.dep} → %${Math.round(satirDegeri(b))}` +
          (b.p5 !== null && b.p5 !== undefined ? ` (5dk %${Math.round(b.p5 * 100)})` : '')
        ).join('\n') + '</pre></body></html>');
  });
  sunucu.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP sunucusu: http://0.0.0.0:${PORT}`);
  });

  const dongu = setInterval(() => {
    if (now() - sonTarama > CFG.taramaSaniye * 1000) tarama();
    ekranCiz();
  }, 4000);

  // Detay yenileme TEK yerden yapılır: zamanlayici (aşağıda). Buradaki ikinci
  // tur aynı maçları tekrar çekip istek kotasını yiyordu; kota dolunca
  // (429) sistem 60 sn duraklıyor ve veriler geç geliyordu.
  zamanlayiciBaslat();
  setInterval(hizliSkorTazele, 10000);

  // Otokalibrasyon: saatte bir son uyarıların isabetine bak, eşiği gerekiyorsa kaydır
  setInterval(() => {
    try {
      const r = esikOtokalibre();
      if (r) {
        uyariYaz('bilgi', '⚙️ EŞİK GÜNCELLENDİ',
          `p10 eşiği %${r.eski} → %${r.yeni}`,
          `son ${r.n} uyarının isabeti %${Math.round(r.oran * 100)} · otokalibrasyon`);
      }
    } catch (_) {}
  }, 6 * 60 * 60 * 1000);

  if (!LOG_ONLY) {
    setInterval(() => ekranCiz(), 1000);
    process.stdout.write('\x1b[?25l'); // imleci gizle
  } else {
    setInterval(() => ekranCiz(), 2000);
  }

  process.on('SIGINT', () => {
    clearInterval(dongu);
    process.stdout.write('\x1b[?25h\n');
    console.log(`\n${C.cyan}GolRadar kapatıldı.${C.reset} ${C.gray}Toplam ${toplamIstek} istek, ${uyariGecmisi.length} uyarı.${C.reset}`);
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Kritik hata:', e);
    process.exit(1);
  });
} else {
  module.exports = { detayiIsle, istatistikCoz, istGecmisEkle, baskiIstatistik, baskiKontrol, dakikaCoz, dakikaDuzelt, anlikBaski, surjAnaliz, golSonrasiSessiz };
}

