'use strict';
// Actual page scripts with the existing response double; no browser, listener, DB or network.
const assert=require('node:assert/strict');
const {harness,fixture}=require('./test_s1_workbench_flow.cjs');
const tests=[],test=(name,fn)=>tests.push({name,fn}),rowId='MX-01-2';
const hasRow=(node,id)=>node.dataset?.row===id||node.children?.some(child=>hasRow(child,id));
const marked=(h,id)=>h.all().filter(n=>n.tag==='td'&&hasRow(n,id)).some(n=>n.className.split(/\s+/).includes('changed'));
const cases=[
 ['1000','1000.00',false],['0','0.00',false],[null,null,false],
 [null,'0',true],['0',null,true],['1000','1001',true],
 ['1000.12345678','1000.12345678',false],['1000.10000000','1000.1',false],
 ['1000.00000001','1000.00000002',true],
 ['999999999.99999998','999999999.99999999',true],
];
for(const surface of ['matrix','detail'])test(surface+': exact amount markers preserve null and source precision',async()=>{
 for(const [reference,saved,expected]of cases){
  const d=fixture();if(surface==='detail')d.matter.fixture_set='legacy-detail';
  const row=d.rows.find(r=>r.id===rowId);row.baseline=reference;d.matter.values[rowId]=saved;
  const original=JSON.stringify(d),h=await harness(d);
  assert.equal(marked(h,rowId),expected,JSON.stringify({surface,reference,saved}));
  assert.deepEqual(h.snapshot().matter.values,d.matter.values);
  assert.equal(h.snapshot().rows.find(r=>r.id===rowId).baseline,reference);
  assert.equal(h.snapshot().matter.history.length,0);assert.equal(h.posts().length,0);
  assert.equal(JSON.stringify(d),original,'Display must not normalize supplied data');
  if(reference==='1000'&&saved==='1001')assert.equal(h.run('moneyDelta("1001","1000")'),'+1');
 }
});
test('trial then restore removes marker after confirmed save and reload, retaining both history entries',async()=>{
 const d=fixture();d.rows.find(r=>r.id===rowId).baseline='1000';d.matter.values[rowId]='1000';
 const h=await harness(d);await h.click('adjust');
 await h.all().find(n=>n.className==='cell-price'&&n.dataset.row===rowId).onclick();
 for(const [value,changed]of [['777',true],['1000',false]]){
  const input=h.findPrice(rowId);input.value=value;input.oninput();
  await h.click('previewSelected');await h.click('draftConfirm');await h.click('reload');
  assert.equal(marked(h,rowId),changed);
 }
 const final=h.snapshot();assert.equal(final.matter.values[rowId],'1000.00');
 assert.equal(final.rows.find(r=>r.id===rowId).baseline,'1000');
 assert.equal(final.matter.history.length,2);assert.equal(final.matter.quote_records.length,0);
 assert.equal(final.matter.draft_preview,null);
 assert.deepEqual(final.matter.history.map(x=>x.edits[0].new),['777.00','1000.00']);
});
(async()=>{let failed=0;for(const{name,fn}of tests){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}console.log(JSON.stringify({tests:tests.length,amountCases:cases.length*2,passed:tests.length-failed,failed,actualPageScripts:true,responseDouble:true,browser:false,network:false,database:false}));process.exitCode=failed?1:0;})();
