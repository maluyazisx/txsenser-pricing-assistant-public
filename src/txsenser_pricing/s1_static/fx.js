'use strict';
// Verified dated public reference snapshot only. No network or price/history writes.
(() => {
 const node=id=>document.getElementById(id),codes=['CNY','USD','EUR'];
 const amounts=Object.fromEntries(codes.map(code=>[code,node('fxAmount'+code)]));
 if(codes.some(code=>!amounts[code]))return;
 let rates=null,date=null,source='',last='CNY',sourceAmount=amounts.CNY.value.trim();
 const status=node('fxStatus');
 function decimal(raw){if(typeof raw!=='string'||!/^\d{1,12}(?:\.\d{1,12})?$/.test(raw))throw Error('INVALID_AMOUNT');const [whole,fraction='']=raw.split('.');return {n:BigInt(whole+fraction),d:10n**BigInt(fraction.length)};}
 const round=(n,d)=>(2n*n+d)/(2n*d);
 function dateAge(raw){if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw))throw Error();const d=new Date(raw+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==raw)throw Error();const today=new Date();const age=Math.floor((Date.UTC(today.getFullYear(),today.getMonth(),today.getDate())-d.getTime())/86400000);if(age<0||age>7)throw Error();return age;}
 function fixed2(rate){const n=round(rate.n*100n,rate.d).toString().padStart(3,'0');return n.slice(0,-2)+'.'+n.slice(-2);}
 function clearOthers(){for(const code of codes)if(code!==last)amounts[code].value='';}
 function convert(){
  if(!rates){clearOthers();return;}
  try{dateAge(date);}catch(_){rates=null;clearOthers();node('fxUsd').textContent='';node('fxEur').textContent='';status.textContent='参考日期已过期，暂不能换算';return;}
  let amount;try{amount=decimal(sourceAmount);if(amount.n>1000000000n*amount.d)throw Error();}catch(_){clearOthers();return;}
  for(const code of codes)if(code!==last){const from=rates[last],to=rates[code];amounts[code].value=round(amount.n*from.n*to.d,amount.d*from.d*to.n).toString();}
 }
 for(const code of codes){amounts[code].addEventListener('input',()=>{last=code;sourceAmount=amounts[code].value.trim();convert();});amounts[code].addEventListener('change',()=>{if(code!==last)return;try{const raw=decimal(sourceAmount);amounts[code].value=round(raw.n,raw.d).toString();}catch(_){}convert();});}
 function applyReference(){
  try{const ref=JSON.parse(node('fxReferenceData').textContent);if(ref.schema!=='verified-reference-v1'||ref.unit!=='CNY_PER_100_FOREIGN'||ref.source_url!=='https://www.safe.gov.cn/safe/rmbhlzjj/'||ref.data_url!=='https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do')throw Error();
   const usd=decimal(ref.per100.USD),eur=decimal(ref.per100.EUR),asOf=ref.as_of,label=ref.source_label;dateAge(asOf);if(usd.n<=0n||eur.n<=0n||typeof label!=='string'||!label||label.length>100)throw Error();usd.d*=100n;eur.d*=100n;
   rates={CNY:{n:1n,d:1n},USD:usd,EUR:eur};date=asOf;source=label;
   node('fxUsd').textContent='1 USD = '+fixed2(usd)+' CNY';node('fxEur').textContent='1 EUR = '+fixed2(eur)+' CNY';status.textContent=date+' · '+source+' · 日度中间价，非实时';
   convert();
  }catch(_){rates=null;clearOthers();node('fxUsd').textContent='';node('fxEur').textContent='';status.textContent='暂无经核验的近期参考汇率，暂不能换算。';}
 }
 applyReference();
})();

