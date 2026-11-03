'use strict';
// A2 only. Synthetic C1 envelope -> real adapter/Store -> real cloud Chrome UI.
// Run --fixture-only for local non-browser preparation; never opens a listener.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const fixture=`import copy,json,socket,sys
from pathlib import Path
from types import SimpleNamespace
from http.server import ThreadingHTTPServer
from txsenser_pricing.s1_demo import Store,handler
from txsenser_pricing.s1_workbench import MATRIX_ROWS
from txsenser_pricing.s1_inquiry_read import C1HistoryReadAdapter
from txsenser_pricing.product_pricing_contracts import ReadEnvelope
def no_outbound(*args,**kwargs): raise RuntimeError('Synthetic history fixture forbids outbound connections')
socket.create_connection=no_outbound
row=copy.deepcopy(MATRIX_ROWS[1])
row.update(id='SYNTH-HISTORY-ROW',product_id='SYNTH-LOCAL-PRODUCT',family='合成产品',kind='合成类型',configuration='合成配置',pn='SYNTH-PN',market='国内',application='合成应用',role='直销',price_type='direct',currency='CNY',unit='台',conditions='合成商务条件（仅供检查）',tier='source_not_specified',min_quantity=None,max_quantity=None,baseline='1000.1234',source='SYNTHETIC-SOURCE',source_anchor='SYNTHETIC-ANCHOR',approval='SYNTHETIC-APPROVAL',effective='SYNTHETIC-CURRENTNESS',source_status='synthetic_available',provenance_kind='private_source_copy',quote_eligible=False,copy_editable=True,risk='')
class Reader:
 def historical_pricing_lookup(self,q):
  mode=Path(sys.argv[2]).read_text().strip()
  record=dict(record_kind='pricing_evidence',record_id='PE-SYNTH',revision_id='R-NEW' if mode=='changed' else 'R-1',revision_digest='digest-new' if mode=='changed' else 'digest-1',price_nature='historical_pricing_evidence',temporal_status='historical',allowed_uses=['internal_history'],customer_link={'customer_id':'AC-SYNTH','validation_state':'confirmed'},opportunity_link={},product_links=[{'product_id':'P-SYNTH','configuration_id':'CFG-SYNTH'}],commercial_classification=['customer_specific'],stage_facts=[dict(stage_fact_id='F-SYNTH',stage_kind='payment_received',amount='120.3456',amount_nature='total_received',coverage='partial',occurred_at=None)],comparison_limitations=['仅供内部参考，部分收款不能作单价。'],source_refs=['synthetic:history'])
  empty=mode=='empty'
  return ReadEnvelope(query_id='SYNTHETIC-QUERY',as_of=q.as_of,knowledge_as_of='2026-10-01T00:00:00Z',brain_publication_id='PUB-SYNTH',brain_publication_digest='pub-digest',freshness='snapshot',match_status='not_found' if empty else 'exact',matched_scope={},missing_inputs=(),reconciliation_refs=(),purpose='internal_history',external_use='restricted',historical=() if empty else (record,),unknown=({'reasons':['retracted']},) if empty else (),publication_status='candidate',execution_allowed=False)
adapter=C1HistoryReadAdapter(Reader(),scopes={('AC-SYNTH','','SYNTH-LOCAL-PRODUCT'):('P-SYNTH','CFG-SYNTH')},publication_id='PUB-SYNTH',publication_digest='pub-digest',coverage_confirmed=True,shared_history=SimpleNamespace(account_ids={'AC-SYNTH'},opportunity_accounts=()))
experience=dict(persona='ceo',copy_sha256='f'*64,rows=[row])
store=Store(sys.argv[1],experience=experience,history_reader=adapter,recover_pending=False)
mid='experience-'+'f'*16
terms=dict(customer_id='AC-SYNTH',project_id='',product_id=row['product_id'],market=row['market'],application=row['application'],role=row['role'],quantity='5',currency=row['currency'],unit=row['unit'],conditions=row['conditions'])
store.action(dict(matter=mid,op='inquiry',request_id='SYNTHETIC-INQUIRY',version=0,terms=terms))
if sys.argv[3]=='fixture-only':
 print(json.dumps(store.state(mid),ensure_ascii=False));sys.exit(0)
server=ThreadingHTTPServer(('127.0.0.1',0),handler(store))
print(f'SYNTHETIC HISTORY: http://127.0.0.1:{server.server_port}/?matter={mid}',flush=True)
server.serve_forever()
`;
(async()=>{
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-history-reference-')),db=path.join(temp,'synthetic.sqlite'),mode=path.join(temp,'synthetic-provider-mode.txt');
 fs.writeFileSync(mode,'ready');const env={...process.env,PYTHONPATH:path.join(root,'src'),PYTHONDONTWRITEBYTECODE:'1'};let server,browser;
 try{
  if(process.argv.includes('--fixture-only')){
   const d=JSON.parse(execFileSync('python3',['-B','-c',fixture,db,mode,'fixture-only'],{cwd:root,env,encoding:'utf8'}));
   assert.equal(d.history_connection.status,'ready_records');assert.equal(d.history_reference.options.length,1);assert.equal(d.history_reference.options[0].reference.record_id,'PE-SYNTH');
   assert.equal(d.matter.history.length,0);assert.equal(d.matter.quote_records.length,0);assert.ok(d.rows.every(r=>r.quote_eligible===false));assert.deepEqual(d.workbench.customers,{});assert.deepEqual(d.workbench.projects,{});
   console.log(JSON.stringify({status:'HISTORY_REFERENCE_FIXTURE_PREPARED',syntheticEnvelope:true,realAdapterAndStore:true,browser:false,listener:false,realProvider:false}));return;
  }
  assert.notEqual(typeof process.getuid==='function'?process.getuid():-1,0,'Normal Chrome sandbox requires non-root');
  const {chromium}=require('playwright'),out=path.join(root,'test-results/history-reference');fs.mkdirSync(out,{recursive:true});
  server=spawn('python3',['-B','-u','-c',fixture,db,mode,'serve'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  const url=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Synthetic startup timed out')),10000);server.stdout.on('data',b=>{text=(text+b).slice(-4096);const m=text.match(/http:\/\/127\.0\.0\.1:\d+\/\?matter=experience-f+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error('Synthetic fixture exited'));});});
  const origin=new URL(url).origin;browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',chromiumSandbox:true,headless:true});
  const page=await browser.newPage({viewport:{width:1512,height:828}}),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{if(new URL(r.request().url()).origin===origin)return r.continue();external.push(r.request().url());return r.abort();});
  const idle=()=>page.waitForFunction(()=>typeof state!=='undefined'&&state&&!busy&&!loading);
  const read=()=>page.evaluate(()=>({matter:state.matter,check:state.history_reference}));
  const clickAction=async(selector,op)=>{const wait=page.waitForResponse(r=>r.url()===origin+'/api/action'&&r.request().method()==='POST'&&r.request().postDataJSON().op===op);await page.locator(selector).first().click();const response=await wait;assert.equal(response.status(),200);await idle();return response.json();};
  const history=async()=>{await page.locator('#openHistory').click();await page.locator('#wbHistory').scrollIntoViewIfNeeded();};
  const shot=async name=>{await page.locator('#wbHistory').scrollIntoViewIfNeeded();await page.waitForFunction(()=>{const n=document.getElementById('wbHistory'),r=n.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight;});await page.screenshot({path:path.join(out,name+'.png')});};
  await page.goto(url,{waitUntil:'domcontentloaded'});await idle();const initial=(await read()).matter;await history();
  assert.equal(await page.locator('#wbCustomerField').isVisible(),false);assert.match(await page.locator('#wbHistory').innerText(),/已收款/);
  await clickAction('[data-history-reference="select"]','history_reference_select');const saved=(await read()).matter.history_reference;
  assert.equal(saved.reference.record_id,'PE-SYNTH');assert.equal(JSON.stringify(saved).includes('120.3456'),false);
  await page.reload({waitUntil:'domcontentloaded'});await idle();await history();assert.equal((await read()).check.status,'valid');assert.deepEqual((await read()).matter.history_reference,saved);
  assert.match(await page.locator('#wbHistory').innerText(),/原引用时点/);assert.match(await page.locator('#wbHistory').innerText(),/本次复核时点/);await shot('history-1-saved-reopened');
  fs.writeFileSync(mode,'changed');await page.reload({waitUntil:'domcontentloaded'});await idle();await history();assert.equal((await read()).check.status,'changed');assert.deepEqual((await read()).matter.history_reference,saved);await shot('history-2-version-changed');
  fs.writeFileSync(mode,'empty');await page.reload({waitUntil:'domcontentloaded'});await idle();await history();assert.equal((await read()).check.status,'unavailable');assert.match(await page.locator('#wbHistory').innerText(),/不能据此判断已撤回/);await shot('history-3-empty-not-withdrawn');
  fs.writeFileSync(mode,'ready');await page.reload({waitUntil:'domcontentloaded'});await idle();await history();
  await clickAction('[data-history-reference="remove"]','history_reference_remove');assert.equal((await read()).matter.history_reference,null);assert.deepEqual((await read()).matter.previous_history_references,[saved]);
  let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  const delay=async route=>{const r=route.request();if(new URL(r.url()).origin!==origin){external.push(r.url());return route.abort();}if(r.method()==='POST'&&r.postDataJSON().op==='history_reference_select'){enter();await gate;}await route.continue();};await page.route('**/api/action',delay);
  const pending=clickAction('[data-history-reference="select"]','history_reference_select');await entered;await page.locator('#openInquiry').click();await page.locator('#wbQuantity').fill('9');release();await pending;await page.unroute('**/api/action',delay);
  assert.equal(await page.locator('#wbQuantity').inputValue(),'9');assert.equal((await read()).matter.history_reference.context.inquiry_request.terms.quantity,'5');assert.match(await page.locator('#saveStatus').innerText(),/新输入保留/);
  await page.locator('#inquirySection').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'history-4-late-input-retained.png')});
  await clickAction('#wbAnalyze','inquiry');await history();const final=await read();assert.equal(final.check.status,'context_changed');assert.equal(final.matter.inquiry_request.terms.quantity,'9');assert.equal(final.matter.history_reference.context.inquiry_request.terms.quantity,'5');await shot('history-5-context-changed');
  for(const key of ['values','private_rows','history','quote_records'])assert.deepEqual(final.matter[key],initial[key]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  const result={status:'HISTORY_REFERENCE_GUI_PASS',screenshots:5,viewport:'1512x828',realAdapterAndStore:true,syntheticEnvelope:true,realProvider:false,exactReferenceSavedAndReopened:true,originalAndCurrentTimeLabels:true,versionChangeNotSubstituted:true,emptyNotWithdrawal:true,removedTraceRetained:true,lateInputRetained:true,changedInquiryDoesNotInheritReference:true,sourceAndSavedPricesUnchanged:true,adjustmentHistory:0,quoteRecords:0,sandbox:true,externalRequests:0,layoutAndExportsNotRun:true};
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{if(browser)await browser.close();if(server){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),new Promise(r=>setTimeout(r,1000))]);}fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
