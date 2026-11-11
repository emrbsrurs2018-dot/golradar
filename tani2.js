'use strict';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36' };
(async () => {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const test = async (ad, url) => {
    try {
      const r = await fetch(url, { headers: UA });
      const t = await r.text();
      console.log(ad, r.status, 'boyut', t.length, '| on:', t.slice(0, 80).replace(/\n/g, ' '));
    } catch (e) { console.log(ad, 'HATA', e.message); }
  };
  await test('FOTMOB', 'https://www.fotmob.com/api/matches?date=' + d);
  await test('SOFA', 'https://api.sofascore.com/api/v1/sport/football/events/live');
  await test('FLASH', 'https://local-global.flashscore.ninja/2/x/feed/f_1_0_3_tr_1');
  await test('AISCORE', 'https://m.aiscore.com/');
})();
