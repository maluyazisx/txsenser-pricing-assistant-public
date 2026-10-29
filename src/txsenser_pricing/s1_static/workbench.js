'use strict';
// Fictional business flow only; uses the existing matter/action Store and guards.
const Workbench = (() => {
 const CATALOG='fictional-role-matrix-v1';
 let view='matrix',initialized=false,formDirty=false,correction=null,quoteEditGeneration=0;
 let pending=null,resolutionNotice='';
 try{const raw=typeof sessionStorage!=='undefined'&&sessionStorage.getItem('s1-workbench-pending');if(raw){const p=JSON.parse(raw);if(p&&p.op==='quote_confirm'&&typeof p.matter==='string'&&typeof p.request_id==='string'&&typeof p.token==='string')pending=p;}}catch(_){}
 const node=id=>document.getElementById(id);
 const elem=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const current=()=>typeof state!=='undefined'&&state&&state.matter.fixture_set===CATALOG;
 function keepPending(value){pending=value;try{if(typeof sessionStorage!=='undefined'){if(value)sessionStorage.setItem('s1-workbench-pending',JSON.stringify(value));else sessionStorage.removeItem('s1-workbench-pending');}}catch(_){} }
 function sent(op,id,extra,matter){if(op==='quote_confirm')keepPending({op,matter,request_id:id,token:extra.token});}
 function finished(op){if(op==='quote_confirm')keepPending(null);}
 function resolve(data){
  if(!pending)return '';
  if(data.matter.id!==pending.matter)return '另一个演示方案的报价保存结果待核，请返回原方案核对；勿重复提交。';
  const receipt=data.matter.quote_receipts&&data.matter.quote_receipts[pending.token];
  if(receipt&&receipt.request_id===pending.request_id&&receipt.record&&receipt.record.token===pending.token&&receipt.record.phase==='quoted_demo'){
   resolutionNotice='已核对演示报价 '+receipt.record.id+' v'+receipt.record.version+' 已保存；不是接受或成交。';keepPending(null);return '';
  }
  return '演示报价保存结果待核，尚未找到对应确认回执；请重新载入核对，勿重复提交。';
 }
 function accepted(op,extra,before,data,requestId){
  if(op==='quote_confirm'){
   const record=data.record,receipt=data.matter.quote_receipts&&data.matter.quote_receipts[extra.token];
   return !!(record&&receipt&&receipt.record&&Array.isArray(data.matter.quote_records)&&record.token===extra.token&&record.phase==='quoted_demo'&&record.id===receipt.record.id&&record.version===receipt.record.version&&
    data.matter.quote_records.some(r=>same(r,record))&&same(record,receipt.record)&&
    (receipt.request_id===requestId||data.duplicate===true&&data.original_request_id===receipt.request_id));
  }
  if(op==='draft_confirm')return !!(before.draft_preview&&Array.isArray(before.draft_preview.edits)&&data.confirmed_token===before.draft_preview.token&&data.matter.revision===before.revision+1&&before.draft_preview.edits.every(e=>data.matter.values[e.id]===e.new));
  if(op==='quote_preview')return !!(data.quote_preview&&data.matter.quote_preview&&data.quote_preview.token===data.matter.quote_preview.token);
  if(op==='draft_preview')return !!(data.draft_preview&&data.matter.draft_preview&&data.draft_preview.token===data.matter.draft_preview.token);
  return true;
 }
 function duplicate(op,extra,data){return op==='quote_confirm'&&data.duplicate===true&&data.matter.seen.includes(data.original_request_id)&&data.record&&data.record.token===extra.token;}
 function canConfirmDraft(){
  if(!current())return false;const m=state.matter,p=m.draft_preview;
  return !!(p&&p.prepared_version===m.version&&Array.isArray(p.edits)&&p.edits.every(edit=>{const input=inputsFor(m.id).get(edit.id);return !input||sameAmount(input.value,edit.new)&&input.old===edit.old&&same(input.scope,edit.scope);}));
 }
 function syncDraftConfirm(){node('draftConfirm').disabled=!canConfirmDraft();}
 function groupRows(data){
  const groups=new Map();
  for(const row of data.rows){
   const key=JSON.stringify([row.market,row.application,row.tier,row.currency,row.unit]);
   if(!groups.has(key))groups.set(key,{label:[row.market,row.application,'数量 '+(row.tier||'未知'),row.currency+'/'+row.unit].join(' · '),products:new Map()});
   const products=groups.get(key).products,pid=JSON.stringify([row.family,row.kind,row.configuration,row.pn]);
   if(!products.has(pid))products.set(pid,{row,cells:new Map(),visible:false});
   const product=products.get(pid);if(!product.cells.has(row.role))product.cells.set(row.role,[]);product.cells.get(row.role).push(row);
   if(data.visible_ids.includes(row.id))product.visible=true;
  }
  return [...groups.values()].map(g=>({...g,products:[...g.products.values()].filter(p=>p.visible)})).filter(g=>g.products.length);
 }
 function priceInput(row,m){
  const input=elem('input');input.className='price';const unsent=inputsFor(m.id).get(row.id);input.value=unsent?unsent.value:(m.values[row.id]??'');input.inputMode='decimal';
  input.disabled=!m.selected.includes(row.id)||!!row.blocked||!state.visible_ids.includes(row.id);input.dataset.row=row.id;input.setAttribute('aria-label',[row.family,row.configuration,row.market,row.tier,row.currency+'/'+row.unit,row.role,'拟调草稿'].join(' '));
  const binding={input,matter:m.id,row,old:m.values[row.id]};renderedPrices.push(binding);
  input.oninput=()=>{rememberPrice(binding,true);syncDraftConfirm();};
  input.onkeydown=async event=>{if(event.key==='Enter'){event.preventDefault();rememberPrice(binding);const item=inputsFor(m.id).get(row.id);await act('draft_preview',{edits:[{id:row.id,old:item?item.old:m.values[row.id],new:input.value,scope:item?item.scope:scope(row)}]});}};
  return input;
 }
 function renderMatrix(data){
  if(!node('roleMatrix'))return false;
  const active=data.matter.fixture_set===CATALOG&&view==='matrix';node('roleMatrix').hidden=!active;node('detailTable').hidden=active;
  if(!active){node('roleMatrix').replaceChildren();return false;}
  const groups=groupRows(data),sections=[];
  for(const group of groups){
   const section=elem('section',undefined,'role-group');section.append(elem('h3',group.label));
   const scroll=elem('div',undefined,'role-scroll');scroll.tabIndex=0;scroll.setAttribute('aria-label',group.label+' 横向角色价格表');
   const table=elem('table',undefined,'role-table'),head=elem('thead'),top=elem('tr'),bottom=elem('tr'),productHead=elem('th','产品 / 明确配置');productHead.rowSpan=2;productHead.scope='col';top.append(productHead);
   for(const role of data.workbench.roles){const th=elem('th',role);th.colSpan=2;th.scope='colgroup';top.append(th);for(const label of ['参考价（虚构）','拟调草稿']){const sub=elem('th',label);sub.scope='col';bottom.append(sub);}}
   head.append(top,bottom);const body=elem('tbody');
   for(const product of group.products){
    const tr=elem('tr'),name=elem('th',product.row.family);name.scope='row';name.append(elem('small',product.row.configuration),elem('small',product.row.pn||'配置身份明确'));tr.append(name);
    for(const role of data.workbench.roles){
     const matches=product.cells.get(role)||[],ref=elem('td'),draft=elem('td');
     if(matches.length!==1){ref.textContent=matches.length?'范围冲突，需核对':'本范围未提供此角色';draft.textContent='不可调整';}
     else{
      const row=matches[0],allowed=data.visible_ids.includes(row.id),check=elem('input');check.type='checkbox';check.checked=data.matter.selected.includes(row.id);check.disabled=!!row.blocked||!allowed;check.dataset.row=row.id;check.setAttribute('aria-label',['选入',row.family,row.configuration,row.market,row.tier,row.currency+'/'+row.unit,role].join(' '));
      check.onchange=()=>act('view',{selected:check.checked?[...data.matter.selected,row.id]:data.matter.selected.filter(id=>id!==row.id),filters:data.matter.filters});
      ref.append(elem('strong',row.baseline??'缺价'),elem('small',row.blocked||'虚构参考，非正式价'));
      const details=elem('details');details.append(elem('summary','来源与条件'),elem('p',row.source),elem('p',row.conditions),elem('p',row.approval),elem('small',row.id));ref.append(details);
      draft.append(check,priceInput(row,data.matter));if(!allowed)draft.append(elem('small','当前筛选范围外，仅读取'));if(inputsFor(data.matter.id).has(row.id))draft.append(elem('small','未确认输入；Enter 先预览'));if(row.blocked)draft.append(elem('small',row.blocked));
     }
     tr.append(ref,draft);
    }
    body.append(tr);
   }
   table.append(head,body);scroll.append(table);section.append(scroll);sections.push(section);
  }
  if(!sections.length)sections.push(elem('p','本筛选范围没有虚构产品；不补价。'));
  node('roleMatrix').replaceChildren(...sections);return true;
 }
 function fillSelect(id,entries){const s=node(id),prior=s.value;s.replaceChildren(...[['','请选择'],...entries].map(([value,label])=>{const o=elem('option',label);o.value=value;return o;}));if(entries.some(([value])=>value===prior))s.value=prior;}
 function initialize(data){
  if(initialized)return;initialized=true;
  fillSelect('wbCustomer',Object.entries(data.workbench.customers));fillSelect('wbProject',Object.entries(data.workbench.projects));fillSelect('wbProduct',data.workbench.products.map(p=>[p.id,p.label]));
  for(const [id,key] of [['wbMarket','market'],['wbApplication','application'],['wbRole','role'],['wbCurrency','currency'],['wbUnit','unit']])fillSelect(id,[...new Set(data.rows.map(r=>r[key]))].map(v=>[v,v]));
  fillSelect('wbConditions',data.workbench.conditions.map(v=>[v,v]));
  for(const id of ['wbCustomer','wbProject','wbProduct','wbMarket','wbApplication','wbRole','wbCurrency','wbUnit','wbConditions','wbQuantity','wbAmount','wbReason'])node(id).oninput=node(id).onchange=()=>{quoteEditGeneration++;formDirty=true;node('wbQuoteConfirm').disabled=true;node('wbAcknowledged').checked=false;};
 }
 function terms(){return Object.fromEntries([['customer_id','wbCustomer'],['project_id','wbProject'],['product_id','wbProduct'],['market','wbMarket'],['application','wbApplication'],['role','wbRole'],['quantity','wbQuantity'],['currency','wbCurrency'],['unit','wbUnit'],['conditions','wbConditions']].map(([key,id])=>[key,node(id).value]));}
 function quoteInput(){return {terms:terms(),amount:node('wbAmount').value,...(correction?{quote_id:correction.id,expected_version:correction.version,reason:node('wbReason').value}:{})};}
 function describeTerms(t){const options=state.workbench;const product=options.products.find(p=>p.id===t.product_id);return [options.customers[t.customer_id],options.projects[t.project_id],product?product.label:t.product_id,t.market,t.application,t.role,'数量 '+t.quantity,t.currency+'/'+t.unit,t.conditions].join(' · ');}
 function render(data){
  const enabled=data.matter.fixture_set===CATALOG;node('businessWorkbench').hidden=!enabled;node('roleViewControls').hidden=!enabled;
  if(!enabled)return;initialize(data);
  node('discussionHint').textContent='有限模拟，不支持自由聊天。普通讨论不改价。例句保持：仅将选中行拟调价增加 80 USD/台；讨论建议：将选中行拟调价设为 1500 USD/台。两者均先形成建议，点击“预览建议修改范围”，再明确确认才保存草稿。输入“检索原文 关键词”查找本轮与关联上一轮原文。恢复草稿金额也请按预览、确认流程操作。';
  const m=data.matter,preview=m.draft_preview;node('draftPreviewPanel').hidden=!preview;
  syncDraftConfirm();
  if(preview){node('draftPreviewRows').replaceChildren(...preview.edits.map(edit=>{const row=data.rows.find(r=>r.id===edit.id);return elem('p',[row.family,row.configuration,edit.scope.market,edit.scope.role,'数量 '+edit.scope.tier,edit.old+' → '+edit.new,edit.scope.currency+'/'+edit.scope.unit].join(' · '));}));}
  const analysis=m.inquiry;node('wbAnalysis').replaceChildren();
  if(analysis){
   const labels={NEEDS_INFO:'待补条件',BLOCKED:'无法给出演示报价',NEEDS_CONFIRMATION:'条件待确认',AVAILABLE_DEMO:'演示范围内可用'};
   node('wbAnalysis').append(elem('strong',labels[analysis.status]),elem('p',analysis.reason));
   if(analysis.missing.length)node('wbAnalysis').append(elem('p','缺少：'+analysis.missing.join('、')));
   for(const ref of analysis.references)node('wbAnalysis').append(elem('p',ref.amount+' '+ref.currency+'/'+ref.unit+' · '+ref.role+' · 数量 '+ref.tier+' · '+ref.source+' · '+ref.approval));
   for(const old of analysis.history){const d=elem('details');d.append(elem('summary','历史参考 '+old.id+' v'+old.version+' · '+old.amount+' '+old.currency+'/'+old.unit),elem('p',old.reason),elem('p',old.differences.join('；')||'条件一致'),elem('p',old.warning));node('wbAnalysis').append(d);}
   if(!analysis.history.length)node('wbAnalysis').append(elem('p','没有可引用的虚构已报价历史。'));
   if(analysis.references.length&&!node('wbAmount').value)node('wbAmount').value=analysis.references[0].amount;
  }
  const quote=m.quote_preview;node('wbQuotePreview').replaceChildren();node('wbQuoteConfirm').disabled=!quote||formDirty||quote.prepared_version!==m.version;
  if(quote){node('wbQuotePreview').append(elem('h3','确认以下已报出的虚构报价'),elem('p',describeTerms(quote.payload.terms)),elem('p','金额 '+quote.payload.amount+'；参考 '+quote.payload.reference.amount+' '+quote.payload.terms.currency+'/'+quote.payload.terms.unit),elem('p',quote.payload.previous_version?'更正 '+quote.payload.id+'，保留原版本；原因：'+quote.payload.reason:'尚未保存到报价历史。'));}
  const history=data.workbench_history||[],latest=new Map();for(const record of history)latest.set(record.id,Math.max(latest.get(record.id)||0,record.version));
  node('wbHistory').replaceChildren(...[...history].reverse().map(record=>{
   const d=elem('details');d.append(elem('summary',record.id+' v'+record.version+' · '+record.amount+' '+record.terms.currency+'/'+record.terms.unit+(latest.get(record.id)===record.version?' · 当前记录':' · 保留旧版')),elem('p','虚构已报价 · '+record.at+'；接受/合同/成交：未知，未记录'),elem('p',describeTerms(record.terms)),elem('p','依据 '+record.reference.id+' · '+record.reference.source),elem('p',record.reason||'初次演示报价'));
   if(latest.get(record.id)===record.version&&record.matter_id===m.id){const button=elem('button','准备更正（保留旧版）');button.onclick=()=>{correction={id:record.id,version:record.version};for(const [key,id] of [['customer_id','wbCustomer'],['project_id','wbProject'],['product_id','wbProduct'],['market','wbMarket'],['application','wbApplication'],['role','wbRole'],['quantity','wbQuantity'],['currency','wbCurrency'],['unit','wbUnit'],['conditions','wbConditions']])node(id).value=record.terms[key];node('wbAmount').value=record.amount;formDirty=true;node('wbQuoteConfirm').disabled=true;node('wbAcknowledged').checked=false;node('wbCorrection').textContent='更正 '+record.id+' v'+record.version+'；请选择原因后重新预览。';};d.append(button);}
   return d;
  }));
  if(!history.length)node('wbHistory').append(elem('p','尚无已确认的演示报价。草稿与取消操作不会进入此处。'));
 }
 function setup(){
  node('showRoleMatrix').onclick=()=>{capturePrices();view='matrix';renderAll();};node('showRoleDetails').onclick=()=>{capturePrices();view='detail';renderAll();};
  node('draftConfirm').onclick=()=>{if(!canConfirmDraft()){status('预览后输入或范围已变化；请重新预览再确认。',true);return null;}return act('draft_confirm',{token:state.matter.draft_preview.token});};
  node('draftCancel').onclick=async()=>{const before=state.matter.draft_preview;const result=await act('draft_cancel');if(result&&before){for(const edit of before.edits)inputsFor(state.matter.id).delete(edit.id);renderAll();}};
  node('wbAnalyze').onclick=async()=>{const result=await act('inquiry',{terms:terms()});if(result&&result.analysis&&result.analysis.references.length&&!correction)node('wbAmount').value=result.analysis.references[0].amount;};
  node('wbQuotePrepare').onclick=async()=>{
   const input=quoteInput(),identity=JSON.stringify(input),generation=quoteEditGeneration,matter=state.matter.id;
   const result=await act('quote_preview',input);
   if(result){formDirty=generation!==quoteEditGeneration||identity!==JSON.stringify(quoteInput())||matter!==state.matter.id;node('wbAcknowledged').checked=false;node('wbQuoteConfirm').disabled=formDirty;if(formDirty)status('预览期间输入已变化；保留新输入，请重新预览再确认。',true);}
  };
  node('wbQuoteCancel').onclick=async()=>{const result=await act('quote_cancel');if(result){correction=null;formDirty=false;node('wbAcknowledged').checked=false;node('wbCorrection').textContent='';}};
  node('wbQuoteConfirm').onclick=async()=>{if(formDirty||!state.matter.quote_preview||state.matter.quote_preview.prepared_version!==state.matter.version)return;const result=await act('quote_confirm',{token:state.matter.quote_preview.token,acknowledged:node('wbAcknowledged').checked});if(result){correction=null;node('wbCorrection').textContent='';node('wbAcknowledged').checked=false;}};
 }
 const renderAll=()=>{if(typeof state!=='undefined'&&state)globalThis.render();};
 return {catalog:CATALOG,groupRows,renderMatrix,render,syncDraftConfirm,sent,finished,resolve,accepted,duplicate,setup,notice:()=>{const text=resolutionNotice;resolutionNotice='';return text;}};
})();
Workbench.setup();
if(typeof state!=='undefined'&&state)render();

