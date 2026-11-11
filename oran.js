'use strict';
const https=require('https');
const H={'X-API-Key':'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R','Accept':'application/json','User-Agent':'Mozilla/5.0'};
const g=u=>new Promise(r=>{https.get(u,{headers:H,timeout:15000},s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d))}catch(e){r(null)}});}).on('error',()=>r(null));});
const norm=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();

const benzer=(a,b)=>{a=norm(a);b=norm(b);if(a===b)return 1;
  const A=new Set(a.split(' ')),B=new Set(b.split(' '));let o=0;
  A.forEach(x=>{if(B.has(x))o++;});if(!o)return 0;return o/Math.min(A.size,B.size);};
async function canliOranlar(){
  const m=await g('https://guest.api.arcadia.pinnacle.com/0.1/sports/29/matchups');
  if(!Array.isArray(m))return [];
  return m.filter(x=>x.status==='started'&&x.isLive&&x.type==='matchup').filter(x=>!/corners/i.test((x.participants[0]?.name||'')+(x.participants[1]?.name||''))).map(x=>({
    id:x.id,ev:x.participants[0]?.name,dep:x.participants[1]?.name,lig:x.league?.name,
    skor:[x.participants[0]?.state?.score||0,x.participants[1]?.state?.score||0]}));
}
module.exports={canliOranlar,benzer,g};

const ondalik=p=>p>0?1+p/100:1+100/Math.abs(p);
async function macOran(id,toplamGol){
  const mk=await g(`https://guest.api.arcadia.pinnacle.com/0.1/matchups/${id}/markets/related/straight`);
  if(!Array.isArray(mk))return null;
  const t=mk.filter(x=>x.type==='total'&&x.period===0&&x.prices&&x.prices.length===2);
  const h=t.find(x=>x.prices.some(p=>p.points===toplamGol+0.5));
  if(!h)return null;
  const o=h.prices.find(p=>p.designation==='over'),u=h.prices.find(p=>p.designation==='under');
  const po=1/ondalik(o.price),pu=1/ondalik(u.price);
  return {cizgi:toplamGol+0.5,gol:po/(po+pu),oran:ondalik(o.price)};
}
module.exports.macOran=macOran;

/* ---- Piyasadan "kalan gol beklentisi" (lambda) ---- */
const poissonCdf=(k,l)=>{let s=0,t=1;for(let i=0;i<=k;i++){if(i>0)t*=l/i;s+=t;}return s*Math.exp(-l);};
const poissonUst=(k,l)=>1-poissonCdf(k-1,l); // P(X >= k)

async function macLambda(id,toplamGol){
  const mk=await g(`https://guest.api.arcadia.pinnacle.com/0.1/matchups/${id}/markets/related/straight`);
  if(!Array.isArray(mk))return null;
  const satirlar=[];
  for(const m of mk){
    if(m.type!=='total'||m.period!==0||!m.prices||m.prices.length!==2)continue;
    const o=m.prices.find(p=>p.designation==='over');
    const u=m.prices.find(p=>p.designation==='under');
    if(!o||!u||typeof o.points!=='number')continue;
    const puan=o.points;
    if(Math.abs(puan*4-Math.round(puan*4))>1e-9)continue; // çeyrek çizgileri atla
    const k=Math.floor(puan)+1;
    const po=1/ondalik(o.price),pu=1/ondalik(u.price);
    satirlar.push({k,p:po/(po+pu)});
  }
  if(!satirlar.length)return null;
  // lambda'yı ızgara + hassaslaştırma ile çöz
  let en=null;
  for(let l=0.05;l<=8;l+=0.05){
    let e=0;for(const s of satirlar)e+=(poissonUst(s.k,l)-s.p)**2;
    if(!en||e<en.e)en={l,e};
  }
  for(let l=Math.max(0.02,en.l-0.05);l<=en.l+0.05;l+=0.002){
    let e=0;for(const s of satirlar)e+=(poissonUst(s.k,l)-s.p)**2;
    if(e<en.e)en={l,e};
  }
  return {lambdaToplam:en.l,kalan:Math.max(0,en.l-toplamGol),satir:satirlar.length};
}
module.exports.macLambda=macLambda;
