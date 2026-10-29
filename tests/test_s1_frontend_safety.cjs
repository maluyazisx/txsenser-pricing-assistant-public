'use strict';
// Offline behavioral regression checks for the synthetic demo UI.
// These simulated DOM checks do not establish real browser acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const sourcePath = process.env.S1_APP_PATH || path.join(__dirname, '../src/txsenser_pricing/s1_static/app.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const copy = x => JSON.parse(JSON.stringify(x));
const tests = [];
const test = (name, fn) => tests.push({name, fn});

function fixture() {
  const row = {id:'SYN-REG-1', family:'SYN', kind:'组件', configuration:'合成配置', pn:'SYN-ONLY', market:'SYN', application:'SYN', role:'SYN', tier:'SYN', currency:'USD', unit:'件', baseline:'100.00', blocked:null, source:'synthetic', effective:'SYN', approval:'未批准', conditions:'SYN', risk:'模拟'};
  return {marker:'TXSENSER_S1_SYNTHETIC_ONLY_V1', provider:'offline-deterministic-mock', rows:[row], visible_ids:[row.id], matters:[{id:'demo-2026', title:'合成回归', parent:null}], matter:{id:'demo-2026', title:'合成回归', version:0, revision:0, generation:1, mode:'discussion', values:{[row.id]:'100.00'}, selected:[row.id], filters:{}, conversation:[], history:[], requests:{}, proposal:null, seen:[]}};
}
function withPending() {
  const initial = fixture();
  initial.matter.requests.T = {id:'T', status:'pending', generation:1, revision:0, selected:['SYN-REG-1'], filters:{}, edits:[], proposal_edits:[], answer:'合成答复', context:{}, at:'synthetic'};
  return initial;
}
class Element {
  constructor(tag) { this.tagName=tag.toUpperCase(); this.tag=tag; this.children=[]; this.dataset={}; this.value=''; this.checked=false; this.disabled=false; this._text=''; this.className=''; this.attributes={}; this.listeners={}; this.scrollHeight=0; this.failText=null; }
  set textContent(value) { if (this.failText && this.failText(String(value))) { this.failText=null; throw Error('SYNTHETIC_STATUS_DISPLAY_FAILURE'); } this._text=String(value); }
  get textContent() { return this._text; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children=nodes; }
  setAttribute(key,value) { this.attributes[key]=String(value); this[key]=value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(type,fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) { event.target ||= this; event.currentTarget=this; if (typeof this['on'+event.type]==='function') this['on'+event.type](event); for(const fn of this.listeners[event.type]||[]) fn(event); return true; }
  querySelectorAll(selector) { return descendants(this).filter(n=>matches(n,selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function descendants(node) { return node.children.flatMap(n=>n instanceof Element ? [n,...descendants(n)] : []); }
function matches(n,s) { if(s==='input.price'||s==='.price') return n.tag==='input' && n.className.split(/\s+/).includes('price'); if(s==='tr')return n.tag==='tr'; if(s==='input')return n.tag==='input'; return false; }
async function harness(initial=fixture()) {
  const ids=new Map(), calls=[];
  const doc={getElementById(id){if(!ids.has(id))ids.set(id,new Element(id));return ids.get(id);},createElement(tag){return new Element(tag);},querySelectorAll(selector){return [...ids.values()].flatMap(n=>[n,...descendants(n)]).filter(n=>matches(n,selector));}};
  let serial=0;
  const h={doc,ids,calls,server:copy(initial),post:null,get:null,location:{href:'http://synthetic.invalid/?matter=demo-2026'}};
  h.response=(status,data)=>({status,ok:status>=200&&status<300,json:async()=>copy(data)});
  h.confirm=(request,mutate=()=>{})=>{const data=copy(h.server);data.saved=true;data.matter.version++;data.matter.seen.push(request.request_id);mutate(data);h.server=copy(data);return h.response(200,data);};
  const context=vm.createContext({document:doc,location:h.location,URL,crypto:{randomUUID:()=>`SYN-REG-${++serial}`},prompt:()=>null,console,fetch:async(url,options={})=>{
    const method=options.method||'GET', request=options.body?JSON.parse(options.body):null;calls.push({url,method,request});
    if(method==='POST'){assert.equal(url,'/api/action');assert.ok(h.post,'Unexpected synthetic POST');return h.post(request);}
    assert.ok(url.startsWith('/api/state?'),'Unexpected synthetic GET');return h.get?h.get():h.response(200,h.server);
  }});
  h.run=code=>vm.runInContext(code,context);
  h.node=id=>doc.getElementById(id);
  h.status=()=>h.node('saveStatus').textContent;
  h.posts=()=>calls.filter(c=>c.method==='POST');
  h.act=(op,extra={})=>h.run(`act(${JSON.stringify(op)},${JSON.stringify(extra)})`);
  h.price=()=>h.node('rows').querySelector('input.price');
  h.typePrice=value=>{const input=h.price();assert.ok(input,'Expected rendered price input');input.value=value;input.dispatchEvent({type:'input'});return input;};
  vm.runInContext(source,context);
  await new Promise(resolve=>setImmediate(resolve));
  return h;
}
async function remainsBlocked(h) {
  const before=h.posts().length;
  await h.act('view',{selected:[],filters:{}});
  assert.equal(h.posts().length,before,'A second write must remain blocked');
}

test('F1 unsubmitted price survives unrelated view without automatic edit',async()=>{
  const h=await harness();h.typePrice('145.00');h.post=r=>h.confirm(r);
  await h.act('view',{selected:['SYN-REG-1'],filters:{currency:'USD'}});
  assert.equal(h.price().value,'145.00','Unsubmitted typed value must survive redraw');
  assert.equal(h.posts().length,1);assert.equal(h.posts()[0].request.op,'view');assert.equal(h.posts()[0].request.edits,undefined);
  assert.equal(h.server.matter.values['SYN-REG-1'],'100.00','No automatic price write');
});
test('F2 failed final reload status cannot unlock unknown submission',async()=>{
  const h=await harness();h.post=()=>{throw Error('SYNTHETIC_NETWORK_FAILURE');};await h.act('edit',{edits:[]});
  h.node('saveStatus').failText=t=>t.includes('已载入草稿');
  await h.node('reload').onclick();h.post=r=>h.confirm(r);await remainsBlocked(h);
});
test('F3 status failure cannot downgrade known committed result',async()=>{
  const h=await harness();h.post=()=>h.response(503,{saved:null,committed:true,outcome:'committed_unconfirmed'});
  h.node('saveStatus').failText=t=>t.includes('操作已提交');await h.act('edit',{edits:[]});
  await remainsBlocked(h);assert.match(h.status(),/已提交/,'Known commit fact must remain visible on next feedback');
});
test('F4 missing ai_finish token is rejected before POST',async()=>{
  const h=await harness();h.post=r=>h.confirm(r);const result=await h.act('ai_finish');
  assert.equal(h.posts().length,0,'Missing token must never be sent');assert.equal(result,null);
});

test('typed price survives successful reload without POST',async()=>{
  const h=await harness();h.typePrice('145.00');await h.node('reload').onclick();
  assert.equal(h.price().value,'145.00');assert.equal(h.posts().length,0);assert.equal(h.server.matter.values['SYN-REG-1'],'100.00');
});
test('typed price survives hidden row and restored filter',async()=>{
  const h=await harness();h.typePrice('145.00');h.post=r=>h.confirm(r,d=>{d.visible_ids=[];});
  await h.act('view',{selected:['SYN-REG-1'],filters:{currency:'EUR'}});assert.equal(h.price(),null);
  h.post=r=>h.confirm(r,d=>{d.visible_ids=['SYN-REG-1'];});await h.act('view',{selected:['SYN-REG-1'],filters:{}});
  assert.equal(h.price().value,'145.00');assert.ok(h.posts().every(p=>p.request.op==='view' && !p.request.edits));
});
test('deselection preserves typed price even while input is disabled',async()=>{
  const h=await harness();h.typePrice('145.00');h.post=r=>h.confirm(r,d=>{d.matter.selected=[];});
  await h.act('view',{selected:[],filters:{}});assert.equal(h.price().value,'145.00');assert.equal(h.price().disabled,true);
});
test('confirmed explicit edit saves typed value and releases only that buffer',async()=>{
  const h=await harness();h.typePrice('145.00');h.post=r=>h.confirm(r,d=>{d.matter.values['SYN-REG-1']=r.edits[0].new;d.matter.revision++;});
  await h.price().onkeydown({key:'Enter',preventDefault(){}});
  assert.equal(h.posts().length,1);assert.equal(h.posts()[0].request.edits[0].new,'145.00');assert.equal(h.posts()[0].request.edits[0].old,'100.00');
  assert.equal(h.server.matter.values['SYN-REG-1'],'145.00');
  h.server.matter.values['SYN-REG-1']='160.00';h.server.matter.version++;await h.node('reload').onclick();assert.equal(h.price().value,'160.00','Confirmed old buffer must not conceal subsequent server state');
});
test('explicit edit rejection retains typed price and does not retry',async()=>{
  const h=await harness();h.typePrice('145.00');h.post=()=>h.response(409,{saved:false,error:'合成版本冲突'});
  await h.price().onkeydown({key:'Enter',preventDefault(){}});
  assert.equal(h.price().value,'145.00');assert.equal(h.posts().length,1);assert.match(h.status(),/未提交/);
});
test('typing during unrelated POST survives its eventual response',async()=>{
  const h=await harness();let resolve,request;
  h.post=r=>{request=r;return new Promise(done=>{resolve=done;});};
  const pending=h.act('view',{selected:['SYN-REG-1'],filters:{}});h.typePrice('160.00');
  resolve(h.confirm(request));await pending;assert.equal(h.price().value,'160.00');assert.equal(h.posts().length,1);
});
test('typing during explicit edit POST is not erased by earlier confirmed value',async()=>{
  const h=await harness();h.typePrice('145.00');let resolve,request;
  h.post=r=>{request=r;return new Promise(done=>{resolve=done;});};
  const pending=h.price().onkeydown({key:'Enter',preventDefault(){}});h.typePrice('160.00');
  resolve(h.confirm(request,d=>{d.matter.values['SYN-REG-1']='145.00';d.matter.revision++;}));await pending;
  assert.equal(h.price().value,'160.00');assert.equal(h.server.matter.values['SYN-REG-1'],'145.00');assert.equal(h.posts().length,1);
});
test('typing original value during edit POST remains a new unsubmitted intent',async()=>{
  const h=await harness();h.typePrice('145.00');let resolve,request;
  h.post=r=>{request=r;return new Promise(done=>{resolve=done;});};
  const pending=h.price().onkeydown({key:'Enter',preventDefault(){}});h.typePrice('100.00');
  resolve(h.confirm(request,d=>{d.matter.values['SYN-REG-1']='145.00';d.matter.revision++;}));await pending;
  assert.equal(h.price().value,'100.00','A later explicit input must survive even when it equals the old stored value');assert.equal(h.server.matter.values['SYN-REG-1'],'145.00');
});
test('failed initial reload feedback cannot leave a pending write lock permanently busy',async()=>{
  const h=await harness();h.post=()=>{throw Error('SYNTHETIC_NETWORK_FAILURE');};await h.act('edit',{edits:[]});
  h.node('saveStatus').failText=t=>t.includes('已载入草稿');await h.node('reload').onclick();await remainsBlocked(h);
  await h.node('reload').onclick();h.post=r=>h.confirm(r);await h.act('view',{selected:[],filters:{}});assert.equal(h.posts().length,2);
});
test('confirmed save display failure preserves confirmed fact and blocks retry',async()=>{
  const h=await harness();h.post=r=>h.confirm(r,d=>{d.matter.values['SYN-REG-1']='145.00';});
  h.node('saveStatus').failText=t=>t.includes('草稿修改已确认保存');await h.act('edit',{edits:[]});
  await remainsBlocked(h);assert.match(h.status(),/已确认保存/);assert.equal(h.posts().length,1);
});
for(const [name,token,status,id] of [
  ['absent entry','MISSING','pending','T'],['empty token','','pending','T'],['array token',['T'],'pending','T'],['object token',{},'pending','T'],
  ['completed request','T','completed','T'],['stale request','T','stale','T'],['mismatched request id','T','pending','OTHER'],
])test(`ai_finish preflight rejects ${name}`,async()=>{
  const initial=withPending();initial.matter.requests.T.status=status;initial.matter.requests.T.id=id;const h=await harness(initial);h.post=r=>h.confirm(r);
  const result=await h.act('ai_finish',{token});assert.equal(h.posts().length,0);assert.equal(result,null);assert.doesNotMatch(h.status(),/确认保存|回复已记录/);
});
for(const [name,mutate] of [
  ['missing result token',d=>{delete d.matter.requests.T;}],
  ['different result token id',d=>{d.matter.requests.T.id='OTHER';}],
  ['still pending',d=>{d.matter.requests.T.status='pending';}],
  ['unrecognized terminal status',d=>{d.matter.requests.T.status='failed';}],
  ['wrong matter',d=>{d.matter.id='OTHER';}],
  ['missing request acknowledgement',d=>{d.matter.seen=[];}],
  ['non-increasing version',d=>{d.matter.version=0;}],
])test(`ai_finish contradictory saved=true response rejects ${name}`,async()=>{
  const h=await harness(withPending());h.post=r=>h.confirm(r,d=>{d.matter.requests.T.status='completed';mutate(d);});
  const result=await h.act('ai_finish',{token:'T'});assert.equal(result,null);assert.doesNotMatch(h.status(),/回复已记录|指令已修改|记录已保存/);await remainsBlocked(h);
});
test('ai_finish coherent completed reply is accepted once',async()=>{
  const h=await harness(withPending());h.post=r=>h.confirm(r,d=>{d.matter.requests.T.status='completed';d.matter.conversation.push({role:'assistant',request:'T',text:'合成答复',at:'synthetic'});});
  const result=await h.act('ai_finish',{token:'T'});assert.ok(result);assert.match(h.status(),/模拟回复已记录/);assert.equal(h.posts().length,1);
  await h.act('ai_finish',{token:'T'});assert.equal(h.posts().length,1,'Completed token cannot be posted again');
});
test('ai_finish legitimate stale reply remains accepted as blocked stale',async()=>{
  const initial=withPending();initial.matter.revision=1;initial.matter.values['SYN-REG-1']='150.00';
  const h=await harness(initial);h.post=r=>h.confirm(r,d=>{d.matter.requests.T.status='stale';d.matter.conversation.push({role:'system',request:'T',text:'迟到回应已阻断',at:'synthetic'});});
  const result=await h.act('ai_finish',{token:'T'});assert.ok(result);assert.match(h.status(),/迟到回应已阻断/);assert.equal(h.price().value,'150.00');assert.equal(h.posts().length,1);
});
test('single-row confirmation preserves a separate unsent row',async()=>{
  const initial=fixture(),second={...initial.rows[0],id:'SYN-REG-2',baseline:'200.00'};
  initial.rows.push(second);initial.visible_ids.push(second.id);initial.matter.selected.push(second.id);initial.matter.values[second.id]='200.00';
  const h=await harness(initial);const inputs=h.node('rows').querySelectorAll('input.price');
  inputs[0].value='145.00';inputs[0].dispatchEvent({type:'input'});inputs[1].value='250.00';inputs[1].dispatchEvent({type:'input'});
  h.post=r=>h.confirm(r,d=>{d.matter.values['SYN-REG-1']='145.00';d.matter.revision++;});
  await inputs[0].onkeydown({key:'Enter',preventDefault(){}});
  const displayed=h.node('rows').querySelectorAll('input.price');assert.equal(displayed[0].value,'145.00');assert.equal(displayed[1].value,'250.00');assert.equal(h.posts()[0].request.edits.length,1);
  assert.equal(h.server.matter.values['SYN-REG-2'],'200.00');
});
for(const [name,mutate] of [
  ['context matter',d=>{d.matter.requests.T.context.matter='OTHER';}],
  ['explicit edits',d=>{d.matter.requests.T.edits=[{id:'SYN-REG-1',new:'999.00'}];}],
  ['answer',d=>{d.matter.requests.T.answer='contradictory replacement';}],
  ['top-level token',d=>{d.token='OTHER';}],
])test(`ai_finish rejects altered pending request ${name}`,async()=>{
  const initial=withPending();initial.matter.requests.T.context.matter='demo-2026';
  const h=await harness(initial);h.post=r=>h.confirm(r,d=>{d.matter.requests.T.status='completed';mutate(d);});
  const result=await h.act('ai_finish',{token:'T'});assert.equal(result,null);await remainsBlocked(h);assert.doesNotMatch(h.status(),/回复已记录|指令已修改|记录已保存/);
});
test('ai_finish cross-matter pending context never sends POST',async()=>{
  const initial=withPending();initial.matter.requests.T.context.matter='OTHER';const h=await harness(initial);h.post=r=>h.confirm(r);
  assert.equal(await h.act('ai_finish',{token:'T'}),null);assert.equal(h.posts().length,0);
});
test('ai_finish rejects completed when its recorded request is stale',async()=>{
  const initial=withPending();initial.matter.generation=2;const h=await harness(initial);
  h.post=r=>h.confirm(r,d=>{d.matter.requests.T.status='completed';});assert.equal(await h.act('ai_finish',{token:'T'}),null);await remainsBlocked(h);
});
test('ai_finish rejects unexplained stale for an exact current request',async()=>{
  const h=await harness(withPending());h.post=r=>h.confirm(r,d=>{d.matter.requests.T.status='stale';});assert.equal(await h.act('ai_finish',{token:'T'}),null);await remainsBlocked(h);
});
test('persistent broken status cannot unlock after a known committed result',async()=>{
  const h=await harness();h.post=r=>{Object.defineProperty(h.node('saveStatus'),'textContent',{configurable:true,get:()=>'',set(){throw Error('PERSISTENT_SYNTHETIC_STATUS_FAILURE');}});return h.response(503,{saved:null,committed:true,outcome:'committed_unconfirmed'});};
  await h.act('edit',{edits:[]});await h.node('reload').onclick();await remainsBlocked(h);assert.equal(h.posts().length,1);
});
test('persistent broken status before dispatch sends no POST',async()=>{
  const h=await harness();h.post=r=>h.confirm(r);
  Object.defineProperty(h.node('saveStatus'),'textContent',{configurable:true,get:()=>'',set(){throw Error('PERSISTENT_SYNTHETIC_STATUS_FAILURE');}});
  await h.act('view',{selected:[],filters:{}});await h.node('reload').onclick();await h.act('view',{selected:[],filters:{}});assert.equal(h.posts().length,0);
});
test('typing original value during proposal adoption remains unsubmitted',async()=>{
  const initial=fixture();initial.matter.proposal={edits:[{id:'SYN-REG-1',old:'100.00',new:'130.00'}]};
  const h=await harness(initial);h.typePrice('145.00');let resolve,request;
  h.post=r=>{request=r;return new Promise(done=>{resolve=done;});};
  const pending=h.act('mode',{mode:'adjustment'});h.typePrice('100.00');
  resolve(h.confirm(request,d=>{d.matter.values['SYN-REG-1']='130.00';d.matter.mode='adjustment';d.matter.proposal=null;}));await pending;
  assert.equal(h.price().value,'100.00','A new input during proposal adoption must not be replaced by its eventual stored price');assert.equal(h.posts().length,1);assert.equal(h.server.matter.values['SYN-REG-1'],'130.00');
});
for(const confirmed of [false,true])test(`broken price DOM cannot downgrade ${confirmed?'confirmed':'committed'} response`,async()=>{
  const h=await harness();h.post=r=>{
    Object.defineProperty(h.price(),'value',{get(){throw Error('SYNTHETIC_PRICE_DOM_FAILURE');}});
    return confirmed?h.confirm(r,d=>{d.matter.values['SYN-REG-1']='145.00';}):h.response(503,{saved:null,committed:true,outcome:'committed_unconfirmed'});
  };
  await h.act('edit',{edits:[]});await remainsBlocked(h);assert.match(h.status(),confirmed?/已确认保存/:/已提交/);assert.equal(h.posts().length,1);
});
test('ai_finish request identity cannot be replaced by unrelated extra fields',async()=>{
  const h=await harness(withPending());h.post=r=>h.confirm(r,d=>{d.matter.requests.T.status='completed';});
  const result=await h.act('ai_finish',{token:'T',matter:'OTHER',version:999,request_id:'FORGED',op:'edit'});
  assert.ok(result);const sent=h.posts()[0].request;assert.equal(sent.matter,'demo-2026');assert.equal(sent.version,0);assert.notEqual(sent.request_id,'FORGED');assert.equal(sent.op,'ai_finish');
});

(async()=>{
  const selected=process.argv[2]?tests.filter(t=>new RegExp(process.argv[2]).test(t.name)):tests;
  assert.ok(selected.length,'No matching regressions');let failed=0;
  for(const {name,fn} of selected){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+'\n'+e.stack);}}
  console.log(JSON.stringify({scope:'PUBLIC_DEMO_FRONTEND_REGRESSION',source:sourcePath,source_sha256:createHash('sha256').update(source).digest('hex'),source_git_blob:createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex'),passed:selected.length-failed,failed,total:selected.length,defined:tests.length,browser:false,network:false,formalIV:false,formalCI:false}));
  process.exitCode=failed?1:0;
})();

