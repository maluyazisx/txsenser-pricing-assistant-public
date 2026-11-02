'use strict';
// A1 only: invented private Store, real browser UI, no source file/provider/export.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');

const fixture = `import copy,json,socket,sys
from http.server import ThreadingHTTPServer
from txsenser_pricing.s1_demo import Store,handler
from txsenser_pricing.s1_workbench import MATRIX_ROWS
def no_outbound(*args,**kwargs):
 raise RuntimeError('Synthetic inquiry fixture forbids outbound connections')
socket.create_connection=no_outbound
rows=[]
for n in range(2):
 r=copy.deepcopy(MATRIX_ROWS[1])
 r.update(id=f'SYNTH-INQUIRY-{n}',product_id=f'SYNTH-PRODUCT-{n}',
  family=f'合成产品{n+1}',kind='合成类型',configuration=f'合成配置{n+1}',pn=f'SYNTH-PN-{n}',
  market='国内',application='合成应用',role='直销',price_type='direct',
  currency='CNY',unit='台',conditions=f'合成条件{n+1}（仅供检查）',
  tier='source_not_specified',min_quantity=None,max_quantity=None,
  baseline='1000.1234' if n==0 else '1100.5678',source='SYNTHETIC-REFERENCE',
  source_anchor=f'SYNTH-ANCHOR-{n}',approval='SYNTHETIC-APPROVAL',effective='SYNTHETIC-CURRENTNESS',
  source_status='synthetic_available',provenance_kind='private_source_copy',
  quote_eligible=False,copy_editable=True,risk='')
 rows.append(r)
experience=dict(persona='ceo',copy_sha256='d'*64,rows=rows)
store=Store(sys.argv[1],experience=experience,recover_pending=False)
mid='experience-'+'d'*16
with store.connect() as db:
 matter=store.read(db,mid);matter['values']['SYNTH-INQUIRY-0']='777.00';matter['selected']=['SYNTH-INQUIRY-0'];store.write(db,matter)
if sys.argv[2]=='fixture-only':
 print(json.dumps(store.state(mid),ensure_ascii=False));sys.exit(0)
server=ThreadingHTTPServer(('127.0.0.1',0),handler(store))
print(f'SYNTHETIC INQUIRY: http://127.0.0.1:{server.server_port}/?matter={mid}',flush=True)
server.serve_forever()
`;

(async () => {
  const root=path.resolve(__dirname,'..'), temp=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-private-inquiry-'));
  const db=path.join(temp,'synthetic.sqlite'), env={...process.env,PYTHONPATH:path.join(root,'src'),PYTHONDONTWRITEBYTECODE:'1'};
  const fixtureOnly=process.argv.includes('--fixture-only');
  let server, browser;
  try {
    if (fixtureOnly) {
      const data=JSON.parse(execFileSync('python3',['-B','-c',fixture,db,'fixture-only'],{cwd:root,env,encoding:'utf8'}));
      assert.equal(data.matter.data_kind,'private_experience');assert.equal(data.matter.values['SYNTH-INQUIRY-0'],'777.00');
      assert.equal(data.rows[0].baseline,'1000.1234');assert.ok(data.rows.every(r=>r.quote_eligible===false));
      assert.deepEqual(data.workbench.customers,{});assert.deepEqual(data.workbench.projects,{});
      assert.equal(data.history_connection.status,'not_connected');assert.equal(data.matter.history.length,0);assert.equal(data.matter.quote_records.length,0);
      console.log(JSON.stringify({status:'PRIVATE_INQUIRY_FIXTURE_PREPARED',syntheticOnly:true,browser:false,listener:false,sharedProvider:false}));
      return;
    }
    assert.notEqual(typeof process.getuid==='function'?process.getuid():-1,0,'Use normal Chrome sandbox as a non-root user');
    const {chromium}=require('playwright');
    const out=path.join(root,'test-results/private-inquiry');fs.mkdirSync(out,{recursive:true});
    server=spawn('python3',['-B','-u','-c',fixture,db,'serve'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    const url=await new Promise((resolve,reject)=>{
      let text='';const timer=setTimeout(()=>reject(Error('Synthetic fixture startup timed out')),10000);
      server.stdout.on('data',b=>{text=(text+b).slice(-4096);const match=text.match(/http:\/\/127\.0\.0\.1:\d+\/\?matter=experience-d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
      server.stderr.on('data',()=>{});server.once('exit',()=>{clearTimeout(timer);reject(Error('Synthetic fixture exited before startup'));});
    });
    const origin=new URL(url).origin;
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',chromiumSandbox:true,headless:true});
    const page=await browser.newPage({viewport:{width:1512,height:828}}), errors=[], external=[], requests=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).pathname));
    await page.route('**/*',route=>{
      if(new URL(route.request().url()).origin===origin)return route.continue();
      external.push(route.request().url());return route.abort();
    });
    const loaded=()=>page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('价格已载入')&&!busy&&!loading);
    const perform=async (action,op='inquiry')=>{
      const wait=page.waitForResponse(r=>r.url()===origin+'/api/action'&&r.request().method()==='POST'&&r.request().postDataJSON().op===op);
      await action();const response=await wait;assert.equal(response.status(),200);const data=await response.json();await page.waitForFunction(()=>!busy&&!loading);return data;
    };
    const inViewport=async selectors=>{
      for(const selector of selectors){
        assert.equal(await page.locator(selector).isVisible(),true,selector+' is visible');
        await page.waitForFunction(s=>{const r=document.querySelector(s).getBoundingClientRect();return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;},selector);
        const box=await page.locator(selector).boundingBox();assert.ok(box&&box.x>=0&&box.y>=0&&box.x+box.width<=1512&&box.y+box.height<=828,selector+' is fully inside viewport');
      }
    };
    const inquiryView=async()=>{
      await page.locator('#openInquiry').click();await page.locator('#inquirySection').scrollIntoViewIfNeeded();
      await inViewport(['#wbProduct','#wbRole','#wbQuantity','#wbConditions','#wbAnalyze','#wbAnalysis']);
    };
    const snapshot=()=>page.evaluate(()=>({rows:state.matter.private_rows,values:state.matter.values,history:state.matter.history,quotes:state.matter.quote_records,request:state.matter.inquiry_request||null}));
    await page.goto(url,{waitUntil:'domcontentloaded'});await loaded();const initial=await snapshot();
    assert.equal(await page.evaluate(()=>state.matter.data_kind),'private_experience');assert.equal(initial.values['SYNTH-INQUIRY-0'],'777.00');
    for(const id of ['wbCustomerField','wbProjectField','openQuote','quoteSection'])assert.equal(await page.locator('#'+id).isVisible(),false);
    for(const id of ['wbCustomer','wbProject']){assert.equal(await page.locator('#'+id+' option').count(),0);assert.equal(await page.locator('#'+id).isDisabled(),true);}
    await page.locator('#discuss').click();assert.equal(await page.locator('#diagnosticTools').isVisible(),false);
    assert.match(await page.locator('#discussionSelected').innerText(),/合成产品1.*合成配置1.*直销底价/);
    assert.deepEqual(await page.evaluate(()=>state.matter.selected),['SYNTH-INQUIRY-0']);
    await page.locator('#chooseDiscussionPrices').click();
    await perform(()=>page.locator('input[data-discussion-row="SYNTH-INQUIRY-1"]').check(),'view');
    await page.locator('#finishDiscussionSelection').click();assert.equal(await page.locator('#editToolbar').isVisible(),false);assert.equal(await page.locator('input.price').count(),0);
    await perform(()=>page.locator('button[data-remove-selection="SYNTH-INQUIRY-0"]').click(),'view');
    await perform(()=>page.locator('#clearDiscussionPrices').click(),'view');assert.deepEqual(await page.evaluate(()=>state.matter.selected),[]);
    await page.locator('#chooseDiscussionPrices').click();await perform(()=>page.locator('input[data-discussion-row="SYNTH-INQUIRY-0"]').check(),'view');await page.locator('#finishDiscussionSelection').click();
    await perform(()=>page.locator('#compare').click(),'ai_finish');
    const reply=await page.evaluate(()=>state.matter.conversation.at(-1).text);assert.match(reply,/规则辅助/);assert.match(reply,/合成产品1.*合成配置1.*直销底价/);assert.match(reply,/本方案已保存价 777.*来源参考 1,000/);assert.doesNotMatch(reply,/SYNTH-INQUIRY|source_not_specified|777\\.00/);
    await page.locator('#discussionSelected').scrollIntoViewIfNeeded();await inViewport(['#chooseDiscussionPrices','#discussionSelected','#conversation']);
    await page.screenshot({path:path.join(out,'usability-1-selected-rule-reply.png')});
    const readSaved=async()=>{if(!await page.locator('#reload').isVisible())await page.locator('.more-actions > summary').click();const wait=page.waitForResponse(r=>r.url().startsWith(origin+'/api/state?'));await page.locator('#reload').click();assert.equal((await wait).status(),200);await page.waitForFunction(()=>!busy&&!loading);};
    await page.locator('#message').fill('合成待发问题');await readSaved();assert.equal(await page.locator('#message').inputValue(),'合成待发问题');assert.match(await page.locator('#saveStatus').innerText(),/输入仍保留/);await page.locator('#message').fill('');await page.locator('#discuss').click();
    await inquiryView();
    const expected={wbProduct:'SYNTH-PRODUCT-0',wbMarket:'国内',wbApplication:'合成应用',wbRole:'直销',wbCurrency:'CNY',wbUnit:'台',wbConditions:'合成条件1（仅供检查）'};
    for(const [id,value]of Object.entries(expected))await page.locator('#'+id).selectOption(value);
    await page.locator('#wbQuantity').fill('5');
    const saved=await perform(()=>page.locator('#wbAnalyze').click());
    assert.equal(saved.inquiry_read.references[0].baseline,'1000.1234');assert.equal(saved.inquiry_read.execution_allowed,false);
    assert.equal(saved.matter.values['SYNTH-INQUIRY-0'],'777.00');assert.equal(saved.history_connection.status,'not_connected');
    const analysis=await page.locator('#wbAnalysis').innerText();assert.match(analysis,/参考单价：1,000/);assert.doesNotMatch(analysis,/参考单价：777/);assert.match(analysis,/尚未接通/);
    await inquiryView();await page.screenshot({path:path.join(out,'inquiry-1-saved-reference.png')});
    await page.reload({waitUntil:'domcontentloaded'});await loaded();await inquiryView();
    for(const [id,value]of Object.entries(expected))assert.equal(await page.locator('#'+id).inputValue(),value);
    assert.equal(await page.locator('#wbQuantity').inputValue(),'5');assert.match(await page.locator('#wbAnalysis').innerText(),/参考单价：1,000/);
    await page.screenshot({path:path.join(out,'inquiry-2-reopened.png')});
    assert.equal(await page.locator('#wbAnalyze').innerText(),'核对价格并保存');assert.match(await page.locator('#wbAnalysis').innerText(),/价格核对结果/);
    assert.equal(await page.getByText('查看价格依据',{exact:true}).count(),1);
    await page.locator('#wbQuantity').fill('7');await readSaved();assert.equal(await page.locator('#wbQuantity').inputValue(),'7');assert.equal(await page.evaluate(()=>state.matter.inquiry_request.terms.quantity),'5');
    assert.match(await page.locator('#wbAnalysis').innerText(),/旧结果不代表当前输入/);await inquiryView();
    await page.screenshot({path:path.join(out,'usability-2-unsubmitted-inquiry-retained.png')});

    // Delay the actual successful server response; never fabricate the saved body.
    let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);let delayed=false;
    const delay=async route=>{
      if(!delayed&&route.request().method()==='POST'&&route.request().postDataJSON().op==='inquiry'){
        delayed=true;const response=await route.fetch();assert.equal(response.status(),200);enter();await gate;return route.fulfill({response});
      }
      return route.continue();
    };
    await page.route(origin+'/api/action',delay);await page.locator('#wbQuantity').fill('6');
    const pending=perform(()=>page.locator('#wbAnalyze').click());
    await Promise.race([entered,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Delayed inquiry never reached the server')),15000);entered.then(()=>clearTimeout(timer));})]);
    await page.locator('#wbQuantity').fill('9');release();const older=await pending;await page.unroute(origin+'/api/action',delay);
    assert.equal(older.matter.inquiry_request.terms.quantity,'6');assert.equal(await page.locator('#wbQuantity').inputValue(),'9');
    assert.match(await page.locator('#wbAnalysis').innerText(),/旧结果不代表当前输入/);assert.match(await page.locator('#saveStatus').innerText(),/新输入保留/);
    await inquiryView();await page.screenshot({path:path.join(out,'inquiry-3-new-input-preserved.png')});
    const latest=await perform(()=>page.locator('#wbAnalyze').click());assert.equal(latest.matter.inquiry_request.terms.quantity,'9');
    await page.reload({waitUntil:'domcontentloaded'});await loaded();await inquiryView();assert.equal(await page.locator('#wbQuantity').inputValue(),'9');

    // The UI has no private quote action. Check the unchanged server boundary too.
    const rejected=await page.evaluate(async()=>{
      const before=JSON.parse(JSON.stringify(state.matter)),results=[];
      for(const op of ['quote_preview','quote_confirm']){
        const response=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({matter:before.id,op,request_id:'SYNTH-BLOCK-'+op.replaceAll('_','-'),version:before.version,terms:before.inquiry_request.terms,amount:'999',token:'synthetic',acknowledged:true})});
        results.push({status:response.status,body:await response.json()});
      }
      const after=await(await fetch('/api/state?matter='+encodeURIComponent(before.id))).json();return {before,after:after.matter,results};
    });
    assert.deepEqual(rejected.after,rejected.before);assert.ok(rejected.results.every(x=>x.status===409&&x.body.saved===false&&/私有询价仅作来源参考/.test(x.body.error)));
    assert.equal(await page.locator('#openQuote').isVisible(),false);assert.equal(await page.locator('#quoteSection').isVisible(),false);
    await page.locator('#openHistory').click();await page.locator('#historySection').scrollIntoViewIfNeeded();await inViewport(['#wbHistoryTitle','#wbHistory']);
    const history=await page.locator('#wbHistory').innerText();assert.match(history,/尚未接通/);assert.doesNotMatch(history,/暂无已确认报价|尚无相关报价历史|未返回可参考历史/);
    await page.screenshot({path:path.join(out,'inquiry-4-history-not-connected.png')});
    const final=await snapshot();assert.deepEqual(final.rows,initial.rows);assert.deepEqual(final.values,initial.values);
    assert.deepEqual(final.history,[]);assert.deepEqual(final.quotes,[]);assert.equal(final.request.terms.quantity,'9');
    assert.ok(final.rows.every(r=>r.quote_eligible===false&&r.min_quantity===null&&r.max_quantity===null));
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.ok(!requests.includes('/api/price-export')&&!requests.includes('/api/fx'));
    const result={status:'PRIVATE_USABILITY_GUI_PASS',viewport:'1512x828',screenshots:6,discussionSelectionUsesViewOnly:true,reloadPreservesUnsavedInquiryAndMessage:true,privateDiagnosticsHidden:true,naturalRuleReply:true,actualUISaveAndReload:true,visibleConditionsAndResult:true,fictionalIdentityControlsAbsent:true,sourceReferenceNotSavedDraft:true,lateInputPreserved:true,historyState:'not_connected',privateQuoteUIClosed:true,privateQuoteAPIRejected:2,sourceAndSavedPricesUnchanged:true,adjustmentHistory:0,quoteRecords:0,sandbox:true,externalRequests:0,providerBound:false,exportsRun:false,layoutMatrixRerun:false,limit:'invented private fixture only; no real data, provider, deployment or publication acceptance'};
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
  } finally {
    if(browser)await browser.close();
    if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{server.kill('SIGKILL');resolve();},5000);server.once('exit',()=>{clearTimeout(timer);resolve();});});}
    fs.rmSync(temp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
