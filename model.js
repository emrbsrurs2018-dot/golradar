'use strict';

/*
 * GolRadar çekirdeği: özellik çıkarımı + olasılık modeli.
 * Canlı radar (radar.js), veri toplayıcı (topla.js) ve eğitim (fit.js) aynı
 * fonksiyonları kullanır; böylece ölçülen isabet canlı sistemle birebir aynıdır.
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const PENCERE = 15;   // ana pencere (dk)
const KISA = 5;       // ani tehlike penceresi
const YARI_OMUR = 6;  // üstel sönüm yarı ömrü (dk)
const UFUK = 10;      // hedef ufuk (dk)

/* --------------------------- yardımcılar ------------------------------ */

function golTarafi(m, s) {
  if (s.kendiKalesi) return s.takimId === m.evId ? 'a' : 'h';
  return s.takimId === m.evId ? 'h' : 'a';
}

function skorDk(m, dk) {
  let h = 0, a = 0;
  for (const s of m.atislar) {
    if (!s.gol || s.dk > dk) continue;
    if (golTarafi(m, s) === 'h') h++;
    else a++;
  }
  return [h, a];
}

function kirmiziSay(m, dk, takimId) {
  let n = 0;
  for (const k of m.kartlar || []) {
    if (k.kirmizi && k.dk <= dk && k.takimId === takimId) n++;
  }
  return n;
}

/* --------------------------- özellik çıkarımı ------------------------- */

/**
 * Tek takım için özellikler.
 * @param {object} m maç: {evId, depId, atislar[], momentum[], kartlar[]}
 * @param {'h'|'a'} taraf
 * @param {number} dk dakika
 */
function ozellikCikar(m, taraf, dk) {
  const id = taraf === 'h' ? m.evId : m.depId;
  const rakipId = taraf === 'h' ? m.depId : m.evId;
  const evMi = taraf === 'h';

  const bas = Math.max(0, dk - PENCERE);
  const basK = Math.max(0, dk - KISA);

  const atislar = (m.atislar || []).filter(
    (x) => x.takimId === id && !x.kendiKalesi && x.dk >= bas && x.dk <= dk
  );
  const kisa = atislar.filter((x) => x.dk >= basK);

  const xg = atislar.reduce((t, x) => t + x.xg, 0);
  const sot = atislar.filter((x) => x.isabet).length;
  const buyuk = atislar.filter((x) => x.xg >= 0.2).length;
  const xg5 = kisa.reduce((t, x) => t + x.xg, 0);
  const sot5 = kisa.filter((x) => x.isabet).length;

  // üstel sönüm: eski şutların ağırlığı azalır
  let xgDecay = 0;
  for (const x of atislar) {
    const yas = dk - x.dk;
    xgDecay += x.xg * Math.pow(0.5, yas / YARI_OMUR);
  }

  const momDeger = (m.momentum || [])
    .filter((x) => x.dk >= bas && x.dk <= dk)
    .map((x) => (evMi ? x.deger : -x.deger));
  const mom = momDeger.length ? momDeger.reduce((s, v) => s + v, 0) / momDeger.length : 0;

  const mom3Deger = (m.momentum || [])
    .filter((x) => x.dk >= Math.max(0, dk - 3) && x.dk <= dk)
    .map((x) => (evMi ? x.deger : -x.deger));
  const mom3 = mom3Deger.length ? mom3Deger.reduce((s, v) => s + v, 0) / mom3Deger.length : 0;

  // maç genelinde baskı (90 dakikaya ölçekli kümülatif xG)
  const tumu = (m.atislar || []).filter((x) => x.takimId === id && !x.kendiKalesi && x.dk <= dk);
  const xgMac = (tumu.reduce((t, x) => t + x.xg, 0) / Math.max(dk, 10)) * 90;

  const rakip = (m.atislar || []).filter(
    (x) => x.takimId === rakipId && !x.kendiKalesi && x.dk >= bas && x.dk <= dk
  );
  const rakipXg = rakip.reduce((t, x) => t + x.xg, 0);

  const skor = skorDk(m, dk);
  const skorFark = evMi ? skor[0] - skor[1] : skor[1] - skor[0];

  const kirmiziFark =
    kirmiziSay(m, dk, id) - kirmiziSay(m, dk, rakipId);

  return {
    xg,
    sot,
    sut: atislar.length,
    buyuk,
    xg5,
    sot5,
    xgDecay,
    mom,
    mom3,
    dakika: dk,
    kalan: clamp(92 - dk, 0, UFUK),
    skorFark,
    toplamGol: skor[0] + skor[1],
    kirmiziFark,
    xgMac,
    rakipXg,
    ev: evMi ? 1 : 0
  };
}

/** Maç bazlı özellikler (iki takım birleşik). */
function macOzellikCikar(m, dk) {
  const h = ozellikCikar(m, 'h', dk);
  const a = ozellikCikar(m, 'a', dk);
  const kirmizi =
    kirmiziSay(m, dk, m.evId) + kirmiziSay(m, dk, m.depId);

  return {
    xgTop: h.xg + a.xg,
    sotTop: h.sot + a.sot,
    sutTop: h.sut + a.sut,
    buyukTop: h.buyuk + a.buyuk,
    xg5Top: h.xg5 + a.xg5,
    xgDecayTop: h.xgDecay + a.xgDecay,
    momTop: Math.max(h.mom, a.mom),
    xgMacTop: h.xgMac + a.xgMac,
    dakika: dk,
    kalan: clamp(92 - dk, 0, UFUK),
    skorFarkAbs: Math.abs(h.skorFark),
    toplamGol: h.toplamGol,
    kirmizi
  };
}

/* --------------------------- eski puan modeli ------------------------- */

function puanHesapla(f) {
  const parcalar = [];
  if (f.xg !== null && f.xg !== undefined) parcalar.push([clamp(f.xg / 0.8, 0, 1) * 40, 40]);
  parcalar.push([clamp(f.sot / 2.5, 0, 1) * 22, 22]);
  parcalar.push([clamp(f.sut / 6, 0, 1) * 12, 12]);
  if (f.box !== null && f.box !== undefined) parcalar.push([clamp(f.box / 4, 0, 1) * 8, 8]);
  if (f.big !== null && f.big !== undefined) parcalar.push([clamp(f.big / 1.5, 0, 1) * 6, 6]);
  if (f.mom !== null && f.mom !== undefined) parcalar.push([clamp(f.mom / 70, 0, 1) * 12, 12]);

  const toplamAgirlik = parcalar.reduce((t, p) => t + p[1], 0);
  const puan = toplamAgirlik ? (parcalar.reduce((t, p) => t + p[0], 0) / toplamAgirlik) * 100 : 0;
  const gec = f.dakika >= 75 ? 1.08 : f.dakika >= 60 ? 1.04 : 1;
  return Math.min(100, puan * gec);
}

/* --------------------------- olasılık modeli -------------------------- */

/**
 * Lojistik model ile gol olasılığı (0-1).
 * @param {object} f özellikler
 * @param {object} kal kalibrasyon.json
 */
function olasilik(f, kal) {
  if (!kal || !Array.isArray(kal.katsayilar) || !Array.isArray(kal.ozellikler)) return null;
  let z = kal.katsayilar[0];
  for (let i = 0; i < kal.ozellikler.length; i++) {
    const k = kal.ozellikler[i];
    const ort = kal.ortalama[k];
    const sd = kal.std[k] || 1;
    let v = f[k];
    if (typeof v !== 'number' || isNaN(v)) v = ort;
    z += kal.katsayilar[i + 1] * ((v - ort) / sd);
  }
  return 1 / (1 + Math.exp(-z));
}

module.exports = {
  PENCERE, KISA, YARI_OMUR, UFUK,
  clamp, skorDk, kirmiziSay,
  ozellikCikar, macOzellikCikar,
  puanHesapla, olasilik
};

function yariOzellikCikar(m, dk) {
  const yari = dk <= 45 ? 1 : 2;
  const bas = yari === 1 ? 0 : 45;
  const bit = yari === 1 ? 45 : 90;
  const p15 = Math.max(bas, dk - 15);
  const s = (f) => (m.atislar || []).filter(f);
  const yari15 = s((x) => x.dk >= p15 && x.dk <= dk && !x.kendiKalesi);
  const yariT = s((x) => x.dk > bas && x.dk <= dk && !x.kendiKalesi);
  const t = (a, f) => a.reduce((s2, x) => s2 + f(x), 0);
  const g15 = t(yari15, (x) => x.xg);
  const i15 = yari15.filter((x) => x.isabet).length;
  const s15 = yari15.length;
  const gY = t(yariT, (x) => x.xg);
  const sY = yariT.length;
  const sk = skorDk(m, dk);
  const golY = yariT.filter((x) => x.gol).length;
  const mom = (m.momentum || []).filter((x) => x.dk >= p15 && x.dk <= dk);
  const momT = mom.length ? mom.reduce((a, x) => a + Math.abs(x.deger), 0) / mom.length : 0;
  return {
    yari, gecenYari: dk - bas, kalanYari: bit - dk,
    xg15: g15, isabet15: i15, sut15: s15,
    xgYari: gY, sutYari: sY, golYari: golY,
    macGol: sk[0] + sk[1], skorFarkAbs: Math.abs(sk[0] - sk[1]), momTop: momT
  };
}
module.exports.yariOzellikCikar = yariOzellikCikar;
