'use strict';

// Canlı baskı paketi: model.ozellikCikar + olasılık + eski puan (yedek)
module.exports = function baski(mac, { KAL, KAL2, KISA, model }) {
  const d = mac.detay;
  if (!d) return null;
  const dk = d.dakika;

  const bosTaraf = {
    olasilik: null, puan: 0, xg: null, isabet: 0, sut: 0,
    mom: null, xg5: null, sot5: 0, buyuk: 0
  };

  if (!d.atislar || !d.atislar.length) {
    return { ev: bosTaraf, dep: { ...bosTaraf }, macOlasilik: null, yariOlasilik: null, p5: null, p10: null };
  }

  const evF = model.ozellikCikar(d, 'h', dk);
  const depF = model.ozellikCikar(d, 'a', dk);
  const macF = model.macOzellikCikar(d, dk);

  const evO = KAL && KAL.hedef === 'takim' ? model.olasilik(evF, KAL) : null;
  const depO = KAL && KAL.hedef === 'takim' ? model.olasilik(depF, KAL) : null;
  const macO = KAL && KAL.hedef === 'mac' ? model.olasilik(macF, KAL) : null;

  let yariO = null;
  if (KAL2) {
    yariO = model.olasilik(model.yariOzellikCikar(d, dk), KAL2);
  }

  let p5 = null, p10 = null;
  if (KISA) {
    p5 = model.olasilik(macF, KISA.m5);
    p10 = model.olasilik(macF, KISA.m10);
  }

  const paket = (f, o) => ({
    olasilik: o,
    puan: Math.round(model.puanHesapla({
      xg: f.xg, sot: f.sot, sut: f.sut, box: null, big: f.buyuk,
      mom: f.mom, dakika: f.dakika
    })),
    xg: Math.round(f.xg * 100) / 100,
    isabet: f.sot,
    sut: f.sut,
    mom: Math.round(f.mom),
    xg5: Math.round(f.xg5 * 100) / 100,
    sot5: f.sot5,
    buyuk: f.buyuk
  });

  return { ev: paket(evF, evO), dep: paket(depF, depO), macOlasilik: macO, yariOlasilik: yariO, p5, p10 };
};
