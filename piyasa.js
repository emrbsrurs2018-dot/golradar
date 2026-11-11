'use strict';
const oran=require('./oran');
let index=[],sonIndex=0;const cache=new Map();
async function indeks(){
  try{index=await oran.canliOranlar();sonIndex=Date.now();}catch(e){}
}
async function tazele(m,ev,dep,tg){
  const k=m.id;
  try{const v=await oran.macOran(m.id,tg);if(v)cache.set(k,{v,t:Date.now()});}catch(e){}
}

function esles(ev,dep){
  let en=null,sk=0.6;
  for(const x of index){
    const s=Math.min(oran.benzer(ev,x.ev),oran.benzer(dep,x.dep));
    if(s>sk){sk=s;en=x;}
  }
  return en;
}
function getir(ev,dep,tg){
  if(Date.now()-sonIndex>60000){sonIndex=Date.now();indeks();}
  const m=esles(ev,dep);
  if(!m)return null;
  const c=cache.get(m.id);
  if(!c||Date.now()-c.t>120000)tazele(m,ev,dep,tg);
  return c?c.v:null;
}
module.exports={getir};

/* ---- Piyasa tabanlı 10 dakikalık gol olasılığı ---- */
const cache10=new Map();
async function getir10(ev,dep,toplamGol,dakika){
  if(!index.length||Date.now()-sonIndex>60000)await indeks();
  const m=esles(ev,dep);
  if(!m)return null;
  let c=cache10.get(m.id);
  if(!c||!c.v||Date.now()-c.t>120000){
    const r=await oran.macLambda(m.id,toplamGol).catch(()=>null);
    if(!r)return null;
    c={t:Date.now(),v:r};
    cache10.set(m.id,c);
  }
  const kalanDk=Math.max(1,92-dakika);
  const oranDk=c.v.kalan/kalanDk;
  return {p10:1-Math.exp(-oranDk*10), kalan:c.v.kalan, lambda:c.v.lambdaToplam};
}
module.exports.getir10=getir10;
