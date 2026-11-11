'use strict';
const https=require('https');
const H={'User-Agent':'Mozilla/5.0','x-fsign':'SW9D1eZo','Referer':'https://www.flashscore.com.tr/','Accept':'*/*'};
const t=u=>new Promise(r=>{https.get(u,{headers:H,timeout:20000},s=>{let d='';s.setEncoding('utf8');s.on('data',c=>d+=c);s.on('end',()=>r(d));}).on('error',()=>r(''));});
const kv=x=>{const o={};x.split('¬').forEach(p=>{const i=p.indexOf('÷');if(i>0)o[p.slice(0,i)]=p.slice(i+1);});return o;};

async function canliListe(){
  const d=await t('https://local-global.flashscore.ninja/2/x/feed/f_1_0_3_tr_1');
  const out=[];
  for(const r of d.split('~').filter(x=>x.startsWith('AA÷'))){
    const o=kv(r);
    if(!['12','13','11','4','38','42','43','54'].includes(o.AC))continue;
    out.push({id:o.AA,ev:o.AE,dep:o.AF,skor:[o.AG||0,o.AH||0]});
  }
  return out;
}

async function istatistik(id){
  const d=await t(`https://local-global.flashscore.ninja/2/x/feed/df_st_1_${id}`);
  if(!d)return null;
  const o={};
  for(const r of d.split('~')){
    const m=kv(r);
    if(!m.SG)continue;
    if(!(m.SG in o))o[m.SG]={e:m.SH,d:m.SI};
  }
  return o;
}

const {benzer}=require('./oran');
let liste=[],son=0;
async function bul(ev,dep){
  if(Date.now()-son>15000){son=Date.now();try{liste=await canliListe();}catch(e){}}
  let en=null,sk=0.6;
  for(const x of liste){const p=Math.min(benzer(ev,x.ev),benzer(dep,x.dep));if(p>sk){sk=p;en=x;}}
  if(!en)return null;
  const st=await istatistik(en.id);
  if(!st)return null;
  const al=k=>{const v=st[k];if(!v)return null;const n=s=>{const q=parseFloat(String(s).replace(/[^\d.]/g,''));return isNaN(q)?null:q;};const a=n(v.e),b=n(v.d);return a===null||b===null?null:[a,b];};
  const sut=al('Total shots');if(!sut)return null;
  return {sut,isabet:al('Shots on target'),korner:al('Corner kicks'),xg:al('Expected goals (xG)'),
    big:al('Big chances'),box:al('Shots inside the box'),kaynak:'flashscore',id:en.id};
}
module.exports.bul=bul;
module.exports.canliListe=canliListe;
