'use strict';
const https = require('https');
const H = { 'User-Agent': 'Mozilla/5.0', 'x-fsign': 'SW9D1eZo', Referer: 'https://www.flashscore.com.tr/', Accept: '*/*' };
const t = (u) => new Promise((r) => {
  https.get(u, { headers: H, timeout: 20000 }, (s) => {
    let d = ''; s.setEncoding('utf8');
    s.on('data', (c) => (d += c));
    s.on('end', () => r(d));
  }).on('error', () => r(''));
});
const kv = (x) => {
  const o = {};
  x.split('\u00ac').forEach((p) => { const i = p.indexOf('\u00f7'); if (i > 0) o[p.slice(0, i)] = p.slice(i + 1); });
  return o;
};
(async () => {
  const d = await t('https://local-global.flashscore.ninja/2/x/feed/f_1_0_3_tr_1');
  const rows = d.split('~').filter((x) => x.startsWith('AA\u00f7')).map(kv);
  console.log('liste', rows.length);
  let var_ = 0;
  for (const m of rows.slice(0, 12)) {
    const st = await t(`https://local-global.flashscore.ninja/2/x/feed/df_st_1_${m.AA}`);
    const alanlar = {};
    for (const r of st.split('~')) { const o = kv(r); if (o.SG) alanlar[o.SG] = 1; }
    const ad = Object.keys(alanlar);
    if (alanlar['Total shots']) var_++;
    console.log(`${m.AE}-${m.AF} | alan ${ad.length} | sut ${alanlar['Total shots'] ? 'VAR' : 'yok'} | ${ad.slice(0, 6).join(',')}`);
  }
  console.log('sutlu mac', var_, '/12');
})();
