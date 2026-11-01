'use strict';
// Opt-in private acceptance script. This file is prepared, not dispatched by the Builder.
// Twelve invented product scopes, temporary Store, normal Chromium sandbox, no external requests.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
(async()=>{
 assert.notEqual(typeof process.getuid==='function'?process.getuid():-1,0,'Use the normal browser user and sandbox');
 const layoutAndAmount=process.argv.includes('--layout-and-amount');assert.ok(!(layoutAndAmount&&process.argv.includes('--layout-only')),'Choose one narrow entry point');
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'invented-export-gui-')),db=path.join(temp,'invented.sqlite'),out=path.join(root,'test-results/price-table');fs.mkdirSync(out,{recursive:true});
 const env={...process.env,PYTHONPATH:path.join(root,'src'),PYTHONDONTWRITEBYTECODE:'1'};
 execFileSync('python3',['-B','-c',`import copy,sys
from txsenser_pricing.s1_demo import Store
from txsenser_pricing.s1_workbench import DEMO_MATTER,MATRIX_ROWS
s=Store(sys.argv[1],matrix_demo=True,recover_pending=False);rows=[]
for n in range(2):
 for original in MATRIX_ROWS:
  r=copy.deepcopy(original);r.update(id=f'EXAMPLE-{n}-'+r['id'],product_id=f'EXAMPLE-{n}-'+r['product_id'],family=f'虚构样本{n+1} '+r['family'],configuration=f'样本{n+1} '+r['configuration']+'；虚构长配置检验完整换行与价格边界。'*3+' MODEL'+('A'*80));rows.append(r)
with s.connect() as c:
 if sys.argv[2]=='layout-and-amount':
  next(r for r in rows if r['id']=='EXAMPLE-0-MX-01-2')['baseline']='1000'
 m=s.read(c,DEMO_MATTER);m.update(private_rows=rows,values={r['id']:r['baseline'] for r in rows})
 if sys.argv[2]=='layout-and-amount':m['values']['EXAMPLE-0-MX-01-2']='1000.00'
 s.write(c,m)
`,db,layoutAndAmount?'layout-and-amount':'default'],{cwd:root,env});
 const server=spawn('python3',['-B','-u','-m','txsenser_pricing.s1_demo','--db',db,'--port','0'],{cwd:root,env,stdio:['ignore','pipe','pipe']});let browser;
 try{
  const origin=await new Promise((resolve,reject)=>{let text='';const timeout=setTimeout(()=>reject(Error('Startup timed out')),10000);server.stdout.on('data',b=>{text=(text+b).slice(-4096);const m=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timeout);resolve(m[0]);}});server.stderr.on('data',()=>{});server.once('exit',()=>reject(Error('Fixture process exited')));});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',chromiumSandbox:true,headless:true});const page=await browser.newPage({viewport:{width:1440,height:828},acceptDownloads:true}),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
  await page.goto(origin+'/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('价格已载入'));
  const perform=async(op,action)=>{const wait=page.waitForResponse(r=>r.url()===origin+'/api/action'&&r.request().method()==='POST'&&r.request().postDataJSON().op===op);await action();const r=await wait;assert.equal(r.status(),200);const data=await r.json();await page.waitForFunction(()=>!busy&&!loading);return data;};
  const choose=async roles=>{await perform('view',()=>page.locator('#clearPriceColumns').click());for(const role of roles)await perform('view',()=>page.locator('#priceColumnOptions input[data-price-type="'+role+'"]').check());};
  const all=['指导','直销','经销','代理','OEM','大客户权限','出厂'];
  for(const width of [1512,1280]){await page.setViewportSize({width,height:828});for(const roles of [['直销'],['直销','经销'],all]){
   await choose(roles);assert.equal(await page.locator('.role-table tbody tr').count(),12);assert.equal(await page.locator('.role-table thead th').count(),roles.length+1);
   const layout=await page.locator('.role-table').evaluate(table=>{const rect=table.getBoundingClientRect(),container=table.parentElement.getBoundingClientRect(),headers=[...table.querySelectorAll('thead th')],product=table.querySelector('tbody th'),cell=product.getBoundingClientRect();return {tableWidth:rect.width,containerWidth:container.width,productWidth:cell.width,priceWidths:headers.slice(1).map(h=>h.getBoundingClientRect().width),centered:headers.slice(1).every(h=>getComputedStyle(h).textAlign==='center'),wrapped:getComputedStyle(product).whiteSpace==='normal',overflow:[...table.querySelectorAll('tbody th small,tbody th button')].some(text=>{const bounds=text.closest('th').getBoundingClientRect(),range=document.createRange();range.selectNodeContents(text);return [...range.getClientRects()].some(r=>r.right>bounds.right+1||r.left<bounds.left-1);})};});
   assert.ok(layout.centered&&layout.wrapped&&!layout.overflow,JSON.stringify(layout));assert.ok(layout.priceWidths.every(w=>Math.abs(w-120)<=1));assert.ok(layout.tableWidth<=layout.containerWidth+1);
   if(roles.length===7){assert.ok(Math.abs(layout.tableWidth-layout.containerWidth)<=2);assert.ok(layout.productWidth>280);}
   else{assert.ok(Math.abs(layout.tableWidth-(420+120*roles.length))<=2);assert.ok(Math.abs(layout.productWidth-420)<=2);}
   await page.screenshot({path:path.join(out,'layout-'+width+'-'+roles.length+'-columns.png')});
  }}
  if(layoutAndAmount){
   const rowId='EXAMPLE-0-MX-01-2';await page.setViewportSize({width:1512,height:828});await choose(['直销']);
   const readAmountState=()=>page.evaluate(id=>({referenceRows:state.matter.private_rows,values:state.matter.values,history:state.matter.history,quotes:state.matter.quote_records,preview:state.matter.draft_preview,baseline:state.rows.find(r=>r.id===id).baseline}),rowId);
   const initial=await readAmountState();assert.equal(initial.baseline,'1000');assert.equal(initial.values[rowId],'1000.00');assert.equal(initial.history.length,0);assert.equal(initial.quotes.length,0);
   const assertAmountStage=async(value,count,changed)=>{
    const data=await readAmountState();assert.equal(data.values[rowId],value);assert.equal(data.baseline,'1000');assert.deepEqual(data.referenceRows,initial.referenceRows,'Source rows must remain byte-for-byte equivalent');assert.equal(data.history.length,count);assert.equal(data.quotes.length,0);assert.equal(data.preview,null);
    for(const [id,amount]of Object.entries(initial.values))if(id!==rowId)assert.equal(data.values[id],amount,'Unselected saved price changed: '+id);
    const marker=await page.locator('.cell-price[data-row="'+rowId+'"]').evaluate(button=>{const cell=button.closest('td');return {changed:cell.classList.contains('changed'),deltas:[...cell.querySelectorAll('.cell-delta')].map(n=>n.textContent)};});
    assert.equal(marker.changed,changed);assert.deepEqual(marker.deltas,changed?['+1']:[],'Restored equality must have neither a yellow marker nor a zero delta');return data;
   };
   await assertAmountStage('1000.00',0,false);await page.screenshot({path:path.join(out,'amount-1-equivalent-initial.png')});
   const saveThroughUI=async(value,count)=>{
    await page.locator('#adjust').click();const input=page.locator('input.price[data-row="'+rowId+'"]');
    if(await input.count()===0)await perform('view',()=>page.locator('.cell-price[data-row="'+rowId+'"]').click());
    assert.equal(await input.count(),1);await input.fill(value);
    const preview=await perform('draft_preview',()=>page.locator('#previewSelected').click());assert.equal(preview.matter.draft_preview.edits.length,1);assert.equal(preview.matter.draft_preview.edits[0].id,rowId);assert.equal(preview.matter.draft_preview.edits[0].new,value+'.00');
    const saved=await perform('draft_confirm',()=>page.locator('#draftConfirm').click());assert.equal(saved.matter.history.length,count);assert.equal(saved.matter.quote_records.length,0);
    await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('价格已载入')&&!busy&&!loading);
   };
   await saveThroughUI('1001',1);await assertAmountStage('1001.00',1,true);await page.screenshot({path:path.join(out,'amount-2-nonzero-saved-reloaded.png')});
   await saveThroughUI('1000',2);const restored=await assertAmountStage('1000.00',2,false);assert.deepEqual(restored.values,initial.values);
   assert.ok(restored.history.every(h=>h.edits.length===1&&h.edits[0].id===rowId));assert.deepEqual(restored.history.map(h=>[h.edits[0].old,h.edits[0].new]),[['1000.00','1001.00'],['1001.00','1000.00']]);
   await page.screenshot({path:path.join(out,'amount-3-restored-reloaded.png')});assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
   console.log(JSON.stringify({status:'PRICE_LAYOUT_AND_AMOUNT_GUI_PASS',widths:[1512,1280],columns:[1,2,7],layoutCases:6,amountStages:3,amountScreenshots:3,longChineseAndUnbrokenToken:true,initialEquivalentUnmarked:true,nonzeroDelta:'+1',restoredUnmarked:true,sourceUnchanged:true,history:2,quotes:0,actualUISaveAndReload:true,exportsRun:false,sandbox:true,externalRequests:0,limit:'invented fixture only; no real data or deployment acceptance'}));return;
  }
  if(process.argv.includes('--layout-only')){assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log(JSON.stringify({status:'PRICE_LAYOUT_GUI_PASS',widths:[1512,1280],columns:[1,2,7],cases:6,longChineseAndUnbrokenToken:true,sandbox:true,externalRequests:0,limit:'invented fixture; no real data or deployment acceptance'}));return;}
  await page.setViewportSize({width:1440,height:828});
  await choose(['直销']);assert.equal(await page.locator('#showRoleMatrix').count(),0);assert.equal(await page.locator('#editToolbar').isVisible(),false);
  await page.locator('#adjust').click();await perform('view',()=>page.locator('.cell-price[data-row="EXAMPLE-0-MX-01-2"]').click());const input=page.locator('input.price[data-row="EXAMPLE-0-MX-01-2"]');await input.fill('1999');
  await page.locator('.price-detail-action[data-row="EXAMPLE-0-MX-01-2"]').click();
  const inViewport=async selector=>{const b=await page.locator(selector).boundingBox();assert.ok(b&&b.y>=0&&b.y+b.height<=828&&b.x>=0&&b.x+b.width<=1440,selector+' must be in viewport');};
  await inViewport('#priceDetails');await inViewport('#closePriceDetails');assert.equal(await page.locator('#priceDetails .source-card').count(),1);assert.ok(await page.locator('#priceDetails').evaluate(el=>el.contains(document.activeElement)));await page.screenshot({path:path.join(out,'details-12-products-828.png')});await page.keyboard.press('Escape');assert.equal(await input.inputValue(),'1999');
  await perform('draft_preview',()=>page.locator('#previewSelected').click());await inViewport('#draftPreviewPanel');await inViewport('#draftConfirm');await inViewport('#draftCancel');assert.ok(await page.locator('#draftPreviewPanel').evaluate(el=>el.contains(document.activeElement)));await page.screenshot({path:path.join(out,'preview-12-products-828.png')});
  await page.locator('#draftConfirm').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'draftBack');await page.locator('#draftBack').click();assert.equal(await input.inputValue(),'1999');
  await perform('draft_preview',()=>page.locator('#previewSelected').click());const saved=await perform('draft_confirm',()=>page.locator('#draftConfirm').click());assert.equal(saved.matter.values['EXAMPLE-0-MX-01-2'],'1999.00');assert.equal(saved.matter.history.length,1);
  await page.locator('#enterBatch').click();await perform('view',()=>page.locator('#selectVisible').click());const selected=await page.evaluate(()=>state.matter.selected.slice());assert.ok(selected.length>1);await perform('view',()=>page.locator('#clearSelection').click());await perform('view',()=>page.locator('#restoreSelection').click());assert.deepEqual(await page.evaluate(()=>state.matter.selected),selected);await page.locator('#exitAdjustment').click();
  await page.locator('#priceExport summary').click();
  for(const [id,extension]of [['exportXlsx','xlsx'],['exportPdf','pdf']]){const wait=page.waitForEvent('download');await page.locator('#'+id).click();const download=await wait;const file=path.join(out,'invented-12-products.'+extension);await download.saveAs(file);const b=fs.readFileSync(file);assert.ok(extension==='xlsx'?b.subarray(0,2).equals(Buffer.from('PK')):b.subarray(0,5).equals(Buffer.from('%PDF-')));}
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(await page.evaluate(()=>state.matter.values['EXAMPLE-0-MX-01-2']),'1999.00');
  console.log(JSON.stringify({status:'PRICE_TABLE_GUI_PASS',viewport:'1440x828',productScopes:12,columns:[1,2,7],detailsAndConfirmInViewport:true,focusAndTabTrap:true,realDownloads:['xlsx','pdf'],sandbox:true,externalRequests:0,limit:'invented fixture only; not real source or official publication acceptance'}));
 }finally{if(browser)await browser.close();if(server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>{const timeout=setTimeout(()=>{server.kill('SIGKILL');r();},5000);server.once('exit',()=>{clearTimeout(timeout);r();});});}fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
