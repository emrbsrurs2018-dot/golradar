'use strict';

// Tüm canlı maçlar için eşzamanlı detay yenileyici.
// radar.js'teki durum nesneleriyle çalışır; ayrı dosyada tutuldu ki
// ana dosya şişmesin.

module.exports = function zamanlayiciKur(ctx) {
  const { maclar, CFG, now, detayGetir, detayiIsle, golKontrol, baskiKontrol, durum, istGecmisEkle,
    dakikaDuzelt, aiDetayTazele, aiDakikaBul } = ctx;

  const ESZAMANLI = CFG.eszamanliIstek || 4;
  let aktif = 0;

  // Sıcak maç (eşiği geçmiş) daha sık güncellenir: "gol yakın" aldıktan sonra
  // baskı sürüyorsa 1-2 dakika içinde tekrar haber verebilmek için.
  const beklemeMs = (m) => {
    const taban = (CFG.detaySaniye || 60) * 1000;
    const p10 = m.baski?.p10 ?? 0;
    const mac = m.baski?.macOlasilik ?? 0;
    const sicak = p10 >= 0.28 || mac >= 0.45 || (m.uyariZamani?.on && now() - m.uyariZamani.on < 10 * 60 * 1000);
    return sicak ? Math.max(5, taban * 0.5) * 1000 : taban;
  };

  setInterval(() => {
    if (aktif >= ESZAMANLI) return;
    if (now() < durum.duraklat) return;

    const aday = [...maclar.values()]
      .filter((m) => m.meta.kaynak !== 'aiscore')
      .filter((m) => now() - m.sonDetay > beklemeMs(m))
      .filter((m) => !(m.bos && now() - (m.bosZaman || 0) < 10 * 60 * 1000 && m.detay?.istat))
      .sort((a, b) => a.sonDetay - b.sonDetay)[0];

    if (!aday) return;

    aday.sonDetay = now();
    aktif++;

    (async () => {
      try {
        const j = await detayGetir(aday.meta.id);
        const d = detayiIsle(j);
        // AiScore'un dakikası daha ileriyse onu kullan (FotMob 1. yarı
        // uzatmasını saymadığı için 56' vs 60' gibi farklar oluyor)
        const aiDk = typeof aiDakikaBul === 'function' ? aiDakikaBul(d.ev, d.dep) : null;
        if (aiDk != null && aiDk > (d.dakika ?? 0)) d.dakika = aiDk;
        // Dakika kaynağı zıplarsa maçın kendi zaman çizgisine oturt
        const duz = typeof dakikaDuzelt === 'function' ? dakikaDuzelt(aday, d.dakika) : null;
        d.dakika = duz != null ? duz : aday.dakikaSon ?? 0;
        // AiScore'dan alınmış istatistik varsa FotMob boş döndürünce silme
        const aiIstat = aday.detay?.istat || null;
        if (!d.istat && aiIstat) d.istat = aiIstat;
        aday.detay = d;
        aday.meta.lig = aday.meta.lig || d.lig;
        if (d.istat) aday.istatZaman = now();

        let golOldu = false;
        try {
          golOldu = golKontrol(aday, d.skor, d.dakika);
        } finally {
          // Uyarı tarafında hata olsa bile skor her zaman güncellensin
          aday.skor = d.skor;
        }

        const veriVar = d.atislar.length > 0;
        aday.bos = !veriVar && !d.istat;
        if (aday.bos) { if (!aday.bosIlkZaman) aday.bosIlkZaman = now(); }
        else aday.bosIlkZaman = 0;

        // FotMob istatistikleri varsa doğrudan modele besle
        if (d.istat) istGecmisEkle(aday, d.dakika, d.istat);

        // FotMob veri vermediyse AiScore'daki şut/isabet ile doldur
        if (aday.bos && typeof aiDetayTazele === 'function') aiDetayTazele(aday);

        if (aday.bos) {
          aday.bosZaman = now();
          // Flashscore'u her turda değil, 60 sn'de bir dene (kota koruması).
          const k2 = now() - (aday.kaynak2Zaman || 0) > 60000;
          if (k2) aday.kaynak2Zaman = now();
          // Ne şut haritası ne FotMob istatistiği var → Flashscore'dan dene.
          // Gelen sayılar hem ekranda hem yedek modelde kullanılır.
          if (k2) require('./kaynak2').bul(aday.meta.ev, aday.meta.dep).then((s) => {
            if (!s) return;
            aday.fs = s;
            if (!s.sut && !s.isabet) return;
            const evS = s.sut?.[0] ?? 0, depS = s.sut?.[1] ?? 0;
            const evI = s.isabet?.[0] ?? 0, depI = s.isabet?.[1] ?? 0;
            const evX = s.xg?.[0] ?? evS * 0.1105;
            const depX = s.xg?.[1] ?? depS * 0.1105;
            aday.bos = false;
            aday.istatZaman = now();
            istGecmisEkle(aday, aday.detay?.dakika ?? 0, {
              sut: [evS, depS],
              sot: [evI, depI],
              box: [null, null],
              big: [null, null],
              korner: s.korner || [null, null],
              xg: [evX, depX]
            });
            baskiKontrol(aday);
          }).catch(() => {});
        }

        if (!golOldu) baskiKontrol(aday);
        durum.sonHata = '';
      } catch (e) {
        durum.sonHata = e.message;
        if (/429|403/.test(e.message)) durum.duraklat = now() + 60000;
      } finally {
        aktif--;
      }
    })();
  }, 150);
};
