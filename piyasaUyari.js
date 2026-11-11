'use strict';
const oran = require('./oran');
let index = [];
let indexT = 0;
let calisiyor = false;
const cache = new Map();
function indexTazele() {
  if (calisiyor || Date.now() - indexT < 60000) return;
  calisiyor = true;
  oran.canliOranlar()
    .then((l) => { if (Array.isArray(l) && l.length) index = l; indexT = Date.now(); })
    .catch(() => {})
    .finally(() => { calisiyor = false; });
}

function esles(ev, dep) {
  let en = null, sk = 0.6;
  for (const x of index) {
    const s = Math.min(oran.benzer(ev, x.ev), oran.benzer(dep, x.dep));
    if (s > sk) { sk = s; en = x; }
  }
  return en;
}
