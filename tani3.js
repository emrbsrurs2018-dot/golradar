'use strict';
const k = require('./kaynak2');
(async () => {
  const l = await k.canliListe();
  console.log('FLASH LISTE:', l.length, 'mac');
  if (l.length) console.log('ornek:', l.slice(0, 3).map((x) => `${x.ev} ${x.skor.join('-')} ${x.dep}`).join(' | '));
  if (l.length) {
    const s = await k.bul(l[0].ev, l[0].dep);
    console.log('DETAY:', JSON.stringify(s));
  }
})();
