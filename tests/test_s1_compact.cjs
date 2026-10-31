'use strict';
const assert=require('node:assert/strict');
const {harness,fixture}=require('./test_s1_workbench_flow.cjs');
const tests=[];const test=(name,fn)=>tests.push({name,fn});
function seven(){const data=fixture();data.workbench.roles=['指导','直销','经销','代理','OEM','大客户权限','出厂'];for(const group of [1,2,3])for(const [i,role]of ['代理','出厂','大客户权限'].entries()){const base=data.rows.find(r=>r.id===`MX-0${group}-1`),id=`MX-0${group}-${i+5}`;data.rows.push({...base,id,role,baseline:null,blocked:'待正式来源'});data.visible_ids.push(id);data.matter.values[id]=null;}return data;}
test('default overview has seven single price columns and collapsed ancillary panes',async()=>{
 const h=await harness(seven());assert.equal(h.node('discussionPanel').hidden,true);assert.equal(h.node('businessWorkbench').hidden,true);
 const headings=h.all().filter(n=>n.tag==='th'&&n.scope==='col');assert.equal(headings.length,8);for(const label of ['代理底价','大客户权限价','出厂价'])assert.ok(headings.some(n=>n.textContent===label));
 assert.equal(h.all().filter(n=>n.className==='role-group').length,1);assert.equal(h.all().filter(n=>n.className==='price').length,0);
 await h.click('discuss');assert.equal(h.node('discussionPanel').hidden,false);await h.click('discuss');assert.equal(h.node('discussionPanel').hidden,true);
 await h.click('openInquiry');assert.equal(h.node('businessWorkbench').hidden,false);assert.equal(h.node('inquirySection').hidden,false);assert.equal(h.node('historySection').hidden,true);
 await h.click('openHistory');assert.equal(h.node('historySection').hidden,false);
});
test('integer display and explicit rounding preview never alter untouched source precision',async()=>{
 const data=seven();data.rows.find(r=>r.id==='MX-01-2').baseline='2050.50';data.matter.values['MX-01-2']='2050.50';
 const h=await harness(data);const before=h.posts().length;assert.ok(h.all().some(n=>n.className==='cell-price'&&n.textContent==='2,051'));assert.equal(h.posts().length,before);assert.equal(h.snapshot().matter.values['MX-01-2'],'2050.50');
 const check=h.findCheck('MX-01-2');check.checked=true;await check.onchange();await h.click('adjust');let price=h.findPrice('MX-01-2');assert.equal(price.value,'2051');assert.equal(h.run('hasUnsubmittedPrices()'),false,'Rounding the display is not an edit');
 price.value='2000.50';price.oninput();await h.all().find(n=>n.className==='price-detail-action'&&n.dataset.row==='MX-01-2').onclick();await h.click('showRoleMatrix');assert.equal(h.findPrice('MX-01-2').value,'2000.50');await h.click('previewSelected');
 const request=h.posts().at(-1).request;assert.equal(request.op,'draft_preview');assert.equal(request.edits[0].new,'2001');assert.equal(request.edits[0].old,'2050.50');assert.equal(h.snapshot().matter.values['MX-01-2'],'2050.50');
 await h.click('draftConfirm');assert.equal(h.snapshot().matter.values['MX-01-2'],'2001.00');assert.equal(h.snapshot().rows.find(r=>r.id==='MX-01-2').baseline,'2050.50');assert.equal(h.snapshot().matter.values['MX-01-1'],'2200.00');assert.equal(h.run('hasUnsubmittedPrices()'),false);
  assert.ok(!h.node('showRoleDetails'));assert.equal(h.run('hasUnsubmittedPrices()'),false);await h.click('showRoleMatrix');assert.equal(h.node('businessWorkbench').hidden,true);
});
test('inquiry missing fields are identified and invalid price input does not POST',async()=>{
 const h=await harness(seven());await h.click('openInquiry');await h.click('wbAnalyze');assert.equal(h.node('wbCustomer').className,'field-missing');assert.equal(h.node('wbQuantity').className,'field-missing');
 const check=h.findCheck('MX-01-2');check.checked=true;await check.onchange();await h.click('adjust');const price=h.findPrice('MX-01-2');price.value='=2+2';price.oninput();const count=h.posts().length;await h.click('previewSelected');assert.equal(h.posts().length,count);assert.equal(h.node('saveStatus').className,'error');
});
test('compact quote form preserves WB1 dirty-input protection and saves only a fresh preview',async()=>{
 const h=await harness(seven());await h.click('openQuote');h.fillTerms();h.set('wbAmount','300');
 let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);h.delayQuotePreview={enter,wait};const preparing=h.click('wbQuotePrepare');await entered;
 h.set('wbAmount','999');release();await preparing;assert.equal(h.node('wbAmount').value,'999');assert.equal(h.node('wbQuoteConfirm').disabled,true);const count=h.posts().length;h.node('wbAcknowledged').checked=true;await h.click('wbQuoteConfirm');assert.equal(h.posts().length,count);
 await h.click('wbQuotePrepare');h.node('wbAcknowledged').checked=true;await h.click('wbQuoteConfirm');assert.equal(h.snapshot().matter.quote_records[0].amount,'999.00');await h.click('openHistory');assert.equal(h.node('historySection').hidden,false);
});
(async()=>{let failed=0;for(const{name,fn}of tests){try{await fn();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+'\n'+error.stack);}}console.log(JSON.stringify({tests:tests.length,passed:tests.length-failed,failed,browser:false,responseDouble:true,network:false}));process.exitCode=failed?1:0;})();

