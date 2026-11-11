'use strict';
/*
 * patlama.js — "önümüzdeki 10 dakikada gol" olasılığı (v4).
 *
 * TARİHÇE (neden 4 sürüm):
 * v1 xG'ye bakıyordu; AiScore xG vermediği için canlıda taban orana sıkıştı.
 * v2 lojistik modelin şut/isabet katsayıları NEGATİF çıktı (az şut = yüksek
 *    olasılık). 87' 2-0 maçta 2 şut / 0 isabet olan maça %42 OYNA verdi.
 * v3 kural tabanlıydı: son 5 dk isabet sayısı. Testte %39 isabet.
 * v4 (bu sürüm): anlikVeri'den zaman bazlı ayrımla eğitilen lojistik model
 *    + "son 5 dk en az 1 isabet" kapısı.
 *
 * v4 TEST (9-11 Kas, 12.595 an, taban %27,3):
 *    AUC 0,597 · p≥34 + 1+ isabet → 187 uyarı · %43,9 isabet
 *    (maç bazlı, 10 dk soğumalı). Uyarı hacmi ~60/gün.
 *
 * Özellikler: son 3/5/10 dk isabet, son 5/10 dk şut, son 5 dk tehlikeli atak,
 * atak, korner, dakika, toplam gol, skor farkı, tempo (şut/90).
 *
 * Not: %44 "kesin gol" değil. 100 uyarının ~44'ünde 10 dk içinde gol gelir.
 */
const MODEL = require('./patlamaModel4.json');

const topla = (x) => (Array.isArray(x) ? (Number(x[0]) || 0) + (Number(x[1]) || 0) : 0);

function gecmisBul(gecmis, hedef) {
  let en = null;
  for (const x of gecmis) {
    if (x.dk <= hedef) en = x;
    else break;
  }
  return en;
}

// Kümülatif istatistikten son 5/10 dk farkları
function istatdan(mac, d) {
  const ist = d.istat || {};
  if (!Array.isArray(ist.sut)) return null;
  const sut = topla(ist.sut), sotHam = topla(ist.sot), korner = topla(ist.korner);
  // Baskı göstergesi: tehlikeli atak + atak (AiScore'da var, xG yok)
  const teh = Array.isArray(ist.tehlikeli) ? topla(ist.tehlikeli) : null;
  const atk = Array.isArray(ist.atak) ? topla(ist.atak) : null;
  // İsabet > şut olamaz (AiScore sayacı bozulunca model %76'ya fırlıyordu)
  const sot = Math.min(sotHam, sut);
  const gecmis = (mac.istGecmis || []).filter((x) => x.ist && x.dk <= d.dakika);
  // YARI SINIRI: 2. yarı başında "son 5 dk" penceresi 1. yarıya taşmamalı.
  // 48'de hedef 43 olunca 1. yarı şutları sayılıyordu (48'de 5 şut gibi).
  const yariBas = d.dakika > 45 ? 45 : 0;
  const a3 = gecmisBul(gecmis, Math.max(yariBas, d.dakika - 3));
  const a5 = gecmisBul(gecmis, Math.max(yariBas, d.dakika - 5));
  const a10 = gecmisBul(gecmis, Math.max(yariBas, d.dakika - 10));
  const dk = Math.max(d.dakika, 10);
  const olcek = (deger, hedef) => Math.round((deger * Math.min(hedef, dk)) / dk);
  const fark = (toplam, eski, hedef) =>
    toplam === null ? null
      : eski && Array.isArray(eski) ? Math.max(0, toplam - topla(eski))
        : olcek(toplam, hedef);
  return {
    sut, sot, korner,
    d5sut: a5 ? Math.max(0, sut - topla(a5.ist.sut)) : olcek(sut, 5),
    d5sot: Math.min(
      a5 ? Math.max(0, sot - topla(a5.ist.sot)) : olcek(sot, 5),
      a5 ? Math.max(0, sut - topla(a5.ist.sut)) : olcek(sut, 5)
    ),
    d5korner: a5 ? Math.max(0, korner - topla(a5.ist.korner)) : olcek(korner, 5),
    d10sut: a10 ? Math.max(0, sut - topla(a10.ist.sut)) : olcek(sut, 10),
    d10sot: a10 ? Math.min(Math.max(0, sot - topla(a10.ist.sot)), Math.max(0, sut - topla(a10.ist.sut))) : olcek(sot, 10),
    d3sot: a3 ? Math.min(Math.max(0, sot - topla(a3.ist.sot)), Math.max(0, sut - topla(a3.ist.sut))) : olcek(sot, 3),
    d5teh: fark(teh, a5 && a5.ist.tehlikeli, 5),
    d5atk: fark(atk, a5 && a5.ist.atak, 5)
  };
}

// Şut haritasından aynı özellikler (korner yok → 0)
function atisdan(d) {
  const a = (d.atislar || []).filter((x) => !x.kendiKalesi && x.dk <= d.dakika);
  if (!a.length) return null;
  const son = (n) => a.filter((x) => x.dk > d.dakika - n);
  const o5 = son(5), o10 = son(10);
  return {
    sut: a.length,
    sot: a.filter((x) => x.isabet).length,
    korner: 0,
    d5sut: o5.length,
    d5sot: o5.filter((x) => x.isabet).length,
    d5korner: 0,
    d10sut: o10.length
  };
}

function ozellikCikar(mac, d) {
  const temel = istatdan(mac, d) || atisdan(d);
  if (!temel) return null;
  const dk = Math.max(d.dakika, 10);
  const sonGolDk = mac.sonGolDk != null && mac.sonGolDk <= d.dakika ? mac.sonGolDk : null;
  const sonGolDkRaw = sonGolDk == null ? 99 : Math.max(0, d.dakika - sonGolDk);
  const sut = temel.sut, sot = temel.sot;
  const isabetOran = sut > 0 ? sot / sut : 0.3;
  const d5sut = temel.d5sut, d5sot = temel.d5sot;
  const gec = d.dakika >= 60 ? 1 : 0;
  return {
    dk: d.dakika,
    dk2: (d.dakika / 90) ** 2 * 10,
    topGol: d.skor[0] + d.skor[1],
    skorFarkAbs: Math.abs(d.skor[0] - d.skor[1]),
    fark: Math.abs(d.skor[0] - d.skor[1]),
    sut, sot, korner: temel.korner,
    d5sut, d5sot, d5korner: temel.d5korner,
    d10sut: temel.d10sut,
    // v4 modelinin beklediği adlar
    isabet5: d5sot,
    sut5: d5sut,
    isabet3: typeof temel.d3sot === 'number' ? temel.d3sot : d5sot,
    isabet10: typeof temel.d10sot === 'number' ? temel.d10sot : d5sot,
    sut10: temel.d10sut,
    teh5: temel.d5teh === undefined ? null : temel.d5teh,
    atk5: temel.d5atk === undefined ? null : temel.d5atk,
    sonGolDk: Math.min(sonGolDkRaw, 60),
    golSon10: sonGolDkRaw <= 10 ? 1 : 0,
    sutHiz: (sut / dk) * 90,
    isabetOran,
    dkX5sut: d.dakika * d5sut / 100,
    dkXtopGol: d.dakika * (d.skor[0] + d.skor[1]) / 100,
    hizXisabet: ((sut / dk) * 90 * isabetOran) / 10,
    gecX5sot: gec * d5sot,
    gec
  };
}

/**
 * v4: anlikVeri ile eğitilen lojistik model (zaman bazlı test AUC 0,597).
 * Test: p≥34 + son 5 dk 1+ isabet → 187 uyarı, %43,9 isabet (taban %27,3).
 * İsabet kapısı şart: model tek başına isabetsiz anlarda da yüksek p üretiyor.
 * @returns {number} 0-1
 */
function olasilik(f) {
  let z = MODEL.katsayilar[0];
  for (let i = 0; i < MODEL.ozellikler.length; i++) {
    const k = MODEL.ozellikler[i];
    const ort = MODEL.ortalama[k];
    const sd = MODEL.std[k] || 1;
    let v = f[k];
    if (typeof v !== 'number' || isNaN(v)) v = ort;
    z += MODEL.katsayilar[i + 1] * Math.max(-3, Math.min(3, (v - ort) / sd));
  }
  const p = 1 / (1 + Math.exp(-z));
  // KAPI: son 5 dakikada isabet yoksa OYNA yok. Sadece TAKİP bandına düşer.
  if ((f.d5sot || 0) < 1) return Math.min(p, 0.29);
  return p;
}

/**
 * @returns {{p:number, patlama:boolean, ozellik:object}|null}
 * Veri yoksa null (model hesaplanamaz, eski davranış korunur).
 */
function hesapla(mac, d) {
  if (!d || !Array.isArray(d.skor)) return null;
  const f = ozellikCikar(mac, d);
  if (!f) return null;
  const p = olasilik(f);
  // Uyarı şartı: son 5 dakikada en az 1 isabetli şut. "İsabet yok" = maç kapalı.
  const patlama = (f.d5sot || 0) >= 1;
  return { p, patlama, ozellik: f };
}

module.exports = { hesapla, olasilik, ozellikCikar, modelo: MODEL, esik: 34 };
