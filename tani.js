'use strict';
const ai = require('./aiscore');
(async () => {
  const t0 = Date.now();
  const l = await ai.canliMaclar(true);
  const s = ai.saglik();
  console.log('AISCORE:', l.length, 'mac | kod', s.kod, '| hata', s.hata || '-', '| ms', Date.now() - t0);
  if (l.length) {
    console.log('ornek:', l.slice(0, 3).map((m) => `${m.dakika}' ${m.ev} ${m.skor.join('-')} ${m.dep}`).join(' | '));
  }
  try {
    const k = require('./kaynak2');
    const f = await k.canliListe();
    console.log('FLASHSCORE:', f.length, 'mac');
  } catch (e) {
    console.log('FLASHSCORE hata:', e.message);
  }
  const fs = require('fs');
  const c = JSON.parse(fs.readFileSync('aiscore.json', 'utf8'));
  console.log('cerez yasi dk:', Math.round((Date.now() - c.ts) / 60000));
})();
