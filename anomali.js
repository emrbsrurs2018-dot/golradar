'use strict';
module.exports = function anomali(b, d, taban) {
  const out = [];
  const p95 = (taban && taban.xg && taban.xg.p95) || 0.93;
  const sut = b.ev.sut + b.dep.sut;
  const xg = (b.ev.xg || 0) + (b.dep.xg || 0);
  const gol = d.skor[0] + d.skor[1];
  if (d.dakika >= 45 && sut === 0) out.push('45+ dk, toplam 0 şut');
  if (xg >= p95 * 2 && gol === 0) out.push('xG yüksek ama gol yok');
  for (const [f, ad] of [[b.ev, d.ev], [b.dep, d.dep]]) {
    if ((f.xg || 0) >= p95 && f.isabet === 0) out.push(ad + ': xG var, isabet 0');
  }
  return out;
};
