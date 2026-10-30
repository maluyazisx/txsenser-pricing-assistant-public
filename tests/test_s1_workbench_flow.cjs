'use strict';
// Actual page scripts with a response double; no child process, listener/browser/network.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),staticDir=path.join(root,'src/txsenser_pricing/s1_static');
const app=fs.readFileSync(path.join(staticDir,'app.js'),'utf8'),workbench=fs.readFileSync(path.join(staticDir,'workbench.js'),'utf8'),html=fs.readFileSync(path.join(staticDir,'index.html'),'utf8');
// Response double only. Actual SQLite/atomicity/reopen checks are in test_s1_workbench_batch.py.
function fixture(){
 const rows=[];
 for(const [group,pid,family,market,currency,prices] of [[1,'DEMO-LUMEN','虚构 Lumen','国内','CNY',[2200,2050,1900,null]],[2,'DEMO-VEGA','虚构 Vega','国内','CNY',[2600,2500,null,2100]],[3,'DEMO-LUMEN','虚构 Lumen','国际','USD',[350,330,300,280]]]){
  for(const [n,role] of ['指导','直销','经销','OEM'].entries())rows.push({id:`MX-${String(group).padStart(2,'0')}-${n+1}`,product_id:pid,family,kind:'整机',configuration:'标准配置',pn:pid,market,application:'通用工业',role,tier:'1–9',currency,unit:'台',baseline:prices[n]===null?null:prices[n].toFixed(2),blocked:prices[n]===null?'本虚构范围缺价':null,source:'虚构页面夹具',conditions:'标准演示条件',approval:'非正式价格'});
 }
 return {marker:'TXSENSER_S1_SYNTHETIC_ONLY_V1',rows,visible_ids:rows.map(r=>r.id),matters:[{id:'demo-workbench-v1',title:'虚构工作台'}],workbench:{customers:{'DEMO-C-A':'虚构客户 A','DEMO-C-B':'虚构客户 B'},projects:{'DEMO-P-A':'虚构项目 Alpha','DEMO-P-B':'虚构项目 Beta'},products:[{id:'DEMO-LUMEN',label:'虚构 Lumen / 标准配置'},{id:'DEMO-VEGA',label:'虚构 Vega / 标准配置'}],roles:['指导','直销','经销','OEM'],conditions:['标准演示条件','附加条件待确认']},workbench_history:[],matter:{id:'demo-workbench-v1',fixture_set:'fictional-role-matrix-v1',title:'虚构工作台',parent:null,version:0,revision:0,generation:0,mode:'discussion',values:Object.fromEntries(rows.map(r=>[r.id,r.baseline])),selected:[],filters:{},conversation:[],history:[],requests:{},seen:[],proposal:null,draft_preview:null,quote_preview:null,quote_records:[],quote_receipts:{},inquiry:null}};
}
const clone=x=>JSON.parse(JSON.stringify(x));
function analysis(terms,m){
 const labels={customer_id:'客户',project_id:'项目',product_id:'产品配置',market:'市场',application:'应用',role:'价格类型',quantity:'数量',currency:'币种',unit:'单位',conditions:'商业条件'};
 const missing=Object.entries(terms).filter(([,v])=>!v).map(([k])=>labels[k]),quantity=Number(terms.quantity),value=quantity>=10?'280.00':'300.00';
 return {terms:clone(terms),status:missing.length?'NEEDS_INFO':'AVAILABLE_DEMO',missing,reason:missing.length?'请补齐条件':'虚构参考可用于页面流程',references:missing.length?[]:[{id:quantity>=10?'MX-04-3':'MX-03-3',amount:value,currency:'USD',unit:'台',role:'经销',tier:quantity>=10?'10–49':'1–9',source:'虚构页面夹具',approval:'未批准'}],history:m.quote_records.length?[{id:m.quote_records[0].id,version:1,amount:'300.00',currency:'USD',unit:'台',differences:quantity===5?[]:['数量：历史 5 → 本次 '+quantity],reason:'条件不同不自动沿用',warning:'已报价非成交'}]:[]};
}
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.className='';this.textContent='';this.attributes={};this.scrollHeight=0;}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=items;}
 setAttribute(key,value){this.attributes[key]=String(value);}
 addEventListener(key,fn){this['on'+key]=fn;}
}
const descend=n=>[n,...n.children.filter(x=>x instanceof Element).flatMap(descend)];
async function harness(initial=fixture()){
 const ids=new Map();let server=clone(initial);
 for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*?)\bid="([^"]+)"([^>]*)>/gi)){const element=new Element(match[1]);element.hidden=/\bhidden\b/.test(match[2]+match[4]);element.disabled=/\bdisabled\b/.test(match[2]+match[4]);ids.set(match[3],element);}
 const document={getElementById:id=>ids.get(id)||[...ids.values()].flatMap(descend).find(n=>n.id===id)||null,createElement:tag=>new Element(tag)};
 const calls=[],storage=new Map();let serial=0;
 const h={document,calls,failQuoteReadback:false};
 h.backend=payload=>{
  if(payload.kind==='state')return {status:200,body:clone(server)};
  const request=payload.request,data=clone(server),m=data.matter;let result={};
  if(request.op==='view'){m.selected=request.selected;m.filters=request.filters;}
  else if(request.op==='draft_preview'){m.draft_preview={token:'DRAFT-TOKEN',prepared_version:m.version+1,edits:request.edits.map(e=>({...e,new:Number(e.new).toFixed(2)}))};result.draft_preview=m.draft_preview;}
  else if(request.op==='draft_confirm'){const preview=m.draft_preview;for(const e of preview.edits)m.values[e.id]=e.new;m.revision++;m.history.push({revision:m.revision,at:'synthetic',actor:'manual_preview_confirmed',edits:clone(preview.edits)});result.confirmed_token=preview.token;m.draft_preview=null;}
  else if(request.op==='draft_cancel')m.draft_preview=null;
  else if(request.op==='inquiry'){m.inquiry=analysis(request.terms,m);result.analysis=m.inquiry;}
  else if(request.op==='quote_preview'){const a=analysis(request.terms,m);m.quote_preview={token:'QUOTE-'+(m.version+1),prepared_version:m.version+1,payload:{id:request.quote_id||'DEMO-Q-UI',previous_version:request.expected_version||0,terms:clone(request.terms),amount:Number(request.amount).toFixed(2),reference:clone(a.references[0]),reason:request.reason||'',historical_references:a.history,phase:'quoted_demo'}};result.quote_preview=m.quote_preview;}
  else if(request.op==='quote_cancel')m.quote_preview=null;
  else if(request.op==='quote_confirm'){const p=m.quote_preview;const record={...p.payload,version:p.payload.previous_version+1,token:p.token,at:'2026-10-29T00:00:00Z',request_id:request.request_id};m.quote_records.push(record);m.quote_receipts[p.token]={request_id:request.request_id,record:clone(record)};m.quote_preview=null;result.record=record;}
  else throw Error('Unexpected double operation '+request.op);
  m.version++;m.seen.push(request.request_id);data.workbench_history=m.quote_records.map(record=>({...clone(record),matter_id:m.id}));server=clone(data);
  if(payload.fail_readback)return {status:503,body:{saved:null,committed:true,outcome:'committed_unconfirmed',request_id:request.request_id,...result}};
  return {status:200,body:{...data,saved:true,...result}};
 };
 const context=vm.createContext({document,location:{href:'http://synthetic.invalid/?matter=demo-workbench-v1'},URL,console,crypto:{randomUUID:()=>`BIZ-${++serial}`},prompt:()=>null,sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},fetch:async(url,options={})=>{
  const method=options.method||'GET';calls.push({url,method,request:options.body?JSON.parse(options.body):null});
  let result;
  if(method==='GET'){assert.ok(url.startsWith('/api/state?'));result=h.backend({kind:'state',matter:new URL(url,'http://synthetic.invalid').searchParams.get('matter')});}
  else {assert.equal(url,'/api/action');const request=JSON.parse(options.body),fail_readback=h.failQuoteReadback&&request.op==='quote_confirm';if(fail_readback)h.failQuoteReadback=false;result=h.backend({kind:'action',request,fail_readback});}
  return {ok:result.status===200,status:result.status,json:async()=>{
   if(options.body&&JSON.parse(options.body).op==='quote_preview'&&h.delayQuotePreview){const gate=h.delayQuotePreview;h.delayQuotePreview=null;gate.enter();await gate.wait;}
   return result.body;
  }};
 }});
 h.run=code=>vm.runInContext(code,context);h.node=id=>document.getElementById(id);h.click=id=>h.node(id).onclick();
 h.snapshot=()=>JSON.parse(h.run('JSON.stringify(state)'));h.all=()=>[...ids.values()].flatMap(descend);
 h.findPrice=id=>h.all().find(n=>n.className==='price'&&n.dataset.row===id);
 h.findCheck=id=>h.all().find(n=>n.type==='checkbox'&&n.dataset.row===id);
 h.set=(id,value)=>{h.node(id).value=value;if(h.node(id).onchange)h.node(id).onchange();};
 h.fillTerms=(quantity='5')=>{for(const [id,value] of Object.entries({wbCustomer:'DEMO-C-A',wbProject:'DEMO-P-A',wbProduct:'DEMO-LUMEN',wbMarket:'国际',wbApplication:'通用工业',wbRole:'经销',wbQuantity:quantity,wbCurrency:'USD',wbUnit:'台',wbConditions:'标准演示条件'}))h.set(id,value);};
 h.posts=()=>calls.filter(c=>c.method==='POST');h.cleanup=()=>{};
 vm.runInContext(app,context);vm.runInContext(workbench,context);await new Promise(r=>setImmediate(r));
 assert.equal(h.snapshot().matter.id,'demo-workbench-v1');assert.equal(h.node('saveStatus').className,'',h.node('saveStatus').textContent);
 return h;
}
const tests=[];const test=(name,fn)=>tests.push({name,fn});
test('one actionable matrix-inquiry-quote-history-correction flow',async()=>{
 const h=await harness();try{
  const groups=h.run('Workbench.groupRows(state)');assert.equal(groups.length,2);assert.equal(groups[0].products.length,2);assert.equal(groups[0].products[0].cells.size,4);
  assert.equal(h.snapshot().rows.length,12);const before=h.snapshot().matter.values;
  const check=h.findCheck('MX-01-2');assert.ok(check);check.checked=true;await check.onchange();
  let price=h.findPrice('MX-01-2');assert.equal(price.disabled,false);price.value='2000';price.oninput();await price.onkeydown({key:'Enter',preventDefault(){}});
  assert.equal(h.snapshot().matter.values['MX-01-2'],'2050.00');assert.ok(h.snapshot().matter.draft_preview);assert.equal(h.snapshot().matter.quote_records.length,0);
  price=h.findPrice('MX-01-2');price.value='2001';price.oninput();assert.equal(h.node('draftConfirm').disabled,true);const previewPosts=h.posts().length;await h.click('draftConfirm');assert.equal(h.posts().length,previewPosts);price.value='2000';price.oninput();assert.equal(h.node('draftConfirm').disabled,false);
  await h.click('draftConfirm');assert.equal(h.snapshot().matter.values['MX-01-2'],'2000.00');assert.equal(h.snapshot().matter.values['MX-01-1'],before['MX-01-1']);assert.equal(h.snapshot().matter.quote_records.length,0);
  await h.click('wbAnalyze');assert.equal(h.snapshot().matter.inquiry.status,'NEEDS_INFO');
  h.fillTerms();await h.click('wbAnalyze');assert.equal(h.snapshot().matter.inquiry.status,'AVAILABLE_DEMO');assert.equal(h.node('wbAmount').value,'300.00');
  await h.click('wbQuotePrepare');assert.ok(h.snapshot().matter.quote_preview);assert.equal(h.snapshot().matter.quote_records.length,0);
  await h.click('wbQuoteCancel');assert.equal(h.snapshot().matter.quote_records.length,0);
  await h.click('wbQuotePrepare');h.node('wbAcknowledged').checked=true;await h.click('wbQuoteConfirm');
  const first=h.snapshot().matter.quote_records[0];assert.ok(first);assert.match(h.node('saveStatus').textContent,/已核对保存/);
  const count=h.posts().length;await h.click('wbQuoteConfirm');assert.equal(h.posts().length,count,'No repeat confirmation POST');
  await h.click('reload');assert.equal(h.snapshot().matter.quote_records[0].id,first.id);
  h.fillTerms('10');await h.click('wbAnalyze');assert.equal(h.snapshot().matter.inquiry.references[0].amount,'280.00');assert.equal(h.snapshot().matter.inquiry.history[0].id,first.id);assert.ok(h.snapshot().matter.inquiry.history[0].differences.some(s=>s.includes('数量')));
  const correctionButton=h.all().find(n=>n.tag==='button'&&n.textContent==='准备更正（保留旧版）');assert.ok(correctionButton);correctionButton.onclick();
  h.set('wbQuantity','10');h.set('wbAmount','290');h.set('wbReason','更正数量');await h.click('wbQuotePrepare');h.node('wbAcknowledged').checked=true;await h.click('wbQuoteConfirm');
  const records=h.snapshot().matter.quote_records;assert.equal(records.length,2);assert.equal(records[0].amount,'300.00');assert.equal(records[1].amount,'290.00');assert.equal(records[1].id,first.id);assert.equal(records[1].version,2);
  assert.equal(h.snapshot().matter.values['MX-03-3'],'300.00');assert.ok(records.every(r=>r.phase==='quoted_demo'));
 }finally{h.cleanup();}
});
test('unknown quote commit is checked by exact receipt with no automatic resubmission',async()=>{
 const h=await harness();try{
  h.fillTerms();await h.click('wbAnalyze');await h.click('wbQuotePrepare');h.node('wbAcknowledged').checked=true;h.failQuoteReadback=true;
  await h.click('wbQuoteConfirm');assert.match(h.node('saveStatus').textContent,/已提交/);assert.ok(h.run('writeBlockReason'));
  const posts=h.posts().length;await h.click('wbQuoteConfirm');assert.equal(h.posts().length,posts);
  await h.click('reload');assert.equal(h.posts().length,posts);assert.equal(h.snapshot().matter.quote_records.length,1);assert.equal(h.run('writeBlockReason'),'');assert.match(h.node('saveStatus').textContent,/已核对演示报价/);
 }finally{h.cleanup();}
});
test('unconfirmed price input survives matrix/detail switches without writes',async()=>{
 const h=await harness();try{
  let check=h.findCheck('MX-01-2');check.checked=true;await check.onchange();
  let price=h.findPrice('MX-01-2');price.value='1999';price.oninput();const before=h.posts().length;
  await h.click('showRoleDetails');assert.equal(h.node('detailTable').hidden,false);
  await h.click('showRoleMatrix');assert.equal(h.findPrice('MX-01-2').value,'1999');assert.equal(h.posts().length,before);assert.equal(h.snapshot().matter.values['MX-01-2'],'2050.00');
 }finally{h.cleanup();}
});
test('WB1 edits during quote preview keep the new input dirty until a fresh preview',async()=>{
 const h=await harness();try{
  h.fillTerms();h.set('wbAmount','300');
  let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);
  h.delayQuotePreview={enter,wait};const preparing=h.click('wbQuotePrepare');await entered;
  h.set('wbAmount','999');assert.equal(h.node('wbQuoteConfirm').disabled,true);
  release();await preparing;
  assert.equal(h.node('wbAmount').value,'999','Keep the newer input');
  assert.equal(h.snapshot().matter.quote_preview.payload.amount,'300.00','Delayed response is the old preview');
  assert.equal(h.node('wbQuoteConfirm').disabled,true,'Old response must not unlock confirmation');
  const posts=h.posts().length;h.node('wbAcknowledged').checked=true;await h.click('wbQuoteConfirm');
  assert.equal(h.posts().length,posts,'Dirty input must also block the confirm handler');
  assert.equal(h.snapshot().matter.quote_records.length,0);
  h.run('render()');assert.equal(h.node('wbQuoteConfirm').disabled,true,'Dirty guard survives redraw');
  await h.click('wbQuotePrepare');assert.equal(h.node('wbQuoteConfirm').disabled,false);
  assert.equal(h.snapshot().matter.quote_preview.payload.amount,'999.00');
  h.node('wbAcknowledged').checked=true;await h.click('wbQuoteConfirm');
  assert.equal(h.snapshot().matter.quote_records.length,1);assert.equal(h.snapshot().matter.quote_records[0].amount,'999.00');
 }finally{h.cleanup();}
});
module.exports={harness,fixture};
if(require.main===module)(async()=>{const selected=tests.filter(({name})=>!process.argv.includes('--wb1-only')||name.startsWith('WB1 '));let failed=0;for(const {name,fn} of selected){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}console.log(JSON.stringify({tests:selected.length,passed:selected.length-failed,failed,actualStore:false,responseDouble:true,listener:false,browser:false,externalNetwork:false}));process.exitCode=failed?1:0;})();

