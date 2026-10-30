'use strict';
// Fictional business flow only; uses the existing matter/action Store and guards.
const Workbench = (() => {
 const CATALOG='fictional-role-matrix-v1';
 let view='matrix',initialized=false,formDirty=false,correction=null,quoteEditGeneration=0,pane='prices',editing=false;
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
  if(data.matter.id!==pending.matter)return '另一个报价方案的保存结果待核，请返回原方案核对；勿重复提交。';
  const receipt=data.matter.quote_receipts&&data.matter.quote_receipts[pending.token];
  if(receipt&&receipt.request_id===pending.request_id&&receipt.record&&receipt.record.token===pending.token&&receipt.record.phase==='quoted_demo'){
   resolutionNotice='已核对报价 '+receipt.record.id+' v'+receipt.record.version+' 已保存；不是接受或成交。';keepPending(null);return '';
  }
  return '报价保存结果待核，尚未找到对应确认回执；请重新载入核对，勿重复提交。';
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
   if(!groups.has(key))groups.set(key,{label:[row.market||'市场待确认',row.application||'应用待确认','数量 '+(row.tier==='source_not_specified'?'来源未注明':row.tier||'未注明'),(row.currency||'币种待确认')+'/'+(row.unit||'单位待确认')].join(' · '),products:new Map()});
   const products=groups.get(key).products,pid=JSON.stringify([row.family,row.kind,row.configuration,row.pn]);
   if(!products.has(pid))products.set(pid,{row,cells:new Map(),visible:false});
   const product=products.get(pid);if(!product.cells.has(row.role))product.cells.set(row.role,[]);product.cells.get(row.role).push(row);
   if(data.visible_ids.includes(row.id))product.visible=true;
  }
  return [...groups.values()].map(g=>({...g,products:[...g.products.values()].filter(p=>p.visible)})).filter(g=>g.products.length);
 }
 function priceInput(row,m){
  const input=elem('input');input.className='price';const unsent=inputsFor(m.id).get(row.id);input.value=unsent?unsent.value:roundMoney(m.values[row.id]??row.baseline);input.inputMode='decimal';
  input.disabled=!m.selected.includes(row.id)||!!row.blocked||row.copy_editable===false||!state.visible_ids.includes(row.id);input.dataset.row=row.id;input.setAttribute('aria-label',row.family+' '+typeLabel(row.role)+' 调整后价格');
  const binding={input,matter:m.id,row,old:m.values[row.id],initialDisplay:input.value};renderedPrices.push(binding);
  input.oninput=()=>{rememberPrice(binding,true);syncDraftConfirm();};
  input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();rememberPrice(binding,true);return previewSelected();}};
  return input;
 }
 function typeLabel(role){return state.workbench.price_type_labels&&state.workbench.price_type_labels[role]||({指导:'指导价',直销:'直销底价',经销:'经销底价',代理:'代理底价',OEM:'OEM底价',出厂:'出厂价',大客户权限:'大客户权限价'})[role]||role;}
 function displayName(row){return row.provenance_kind==='private_source_copy'?row.family:row.family.replace(/^虚构 /,'');}
 function showDetails(product){const panel=node('priceDetailsContent');panel.replaceChildren(elem('h3',displayName(product.row)+' · '+product.row.configuration));for(const role of state.workbench.roles){const rows=product.cells.get(role)||[];for(const row of rows)panel.append(elem('p',[typeLabel(role),'参考 '+money(row.baseline)+'；调整后 '+money(state.matter.values[row.id])+' '+row.currency+'/'+row.unit,row.blocked||'',row.source,row.source_anchor||'',row.conditions,row.effective,row.approval].filter(Boolean).join(' · ')));}node('priceDetails').hidden=false;}
 function renderMatrix(data){
  if(!node('roleMatrix'))return false;const active=data.matter.fixture_set===CATALOG&&view==='matrix';node('roleMatrix').hidden=!active;node('detailTable').hidden=active;
  if(!active){node('roleMatrix').replaceChildren();return false;}
  const section=elem('section',undefined,'role-group'),scroll=elem('div',undefined,'role-scroll');scroll.tabIndex=0;scroll.setAttribute('aria-label','产品与价格类型横向总览');
  const table=elem('table',undefined,'role-table'),head=elem('thead'),top=elem('tr'),productHead=elem('th','产品 / 配置 / 适用范围');productHead.scope='col';top.append(productHead);
  for(const role of data.workbench.roles){const th=elem('th',typeLabel(role));th.scope='col';if(role==='出厂')th.title='经济基准，不是成本或普通报价底价';if(role==='大客户权限')th.title='销售总监或CEO按既有授权使用；使用权不等于修改公司标准价的权限';if(role==='指导')th.title='参考标价，不等于净应收价';top.append(th);}head.append(top);const body=elem('tbody');
  for(const group of groupRows(data))for(const product of group.products){
   const tr=elem('tr'),name=elem('th');name.scope='row';const details=elem('button',displayName(product.row),'product-details');details.onclick=()=>showDetails(product);name.append(details,elem('small',product.row.configuration),elem('small',group.label));tr.append(name);
   for(const role of data.workbench.roles){const cell=elem('td'),matches=product.cells.get(role)||[];
    if(matches.length!==1){cell.append(elem('span','—','price-missing'));cell.title=matches.length?'适用范围冲突':'该范围未提供此价格类型';}
    else{const row=matches[0],allowed=data.visible_ids.includes(row.id),check=elem('input'),box=elem('div',undefined,'price-cell');check.type='checkbox';check.checked=data.matter.selected.includes(row.id);check.disabled=!!row.blocked||!allowed;check.dataset.row=row.id;check.setAttribute('aria-label','选择 '+displayName(row)+' '+typeLabel(role));
     const select=()=>act('view',{selected:check.checked?[...data.matter.selected,row.id]:data.matter.selected.filter(id=>id!==row.id),filters:data.matter.filters});check.onchange=select;
     if(row.baseline===null){cell.append(elem('span',/合列|合并/.test(row.blocked||row.risk)?'合列待核':/不适用/.test(row.blocked||row.risk)?'不适用':'待来源','price-missing'));cell.title=row.blocked||row.risk;}
     else{box.append(check);if(editing&&check.checked)box.append(priceInput(row,data.matter));else{const value=elem('button',money(data.matter.values[row.id]),'cell-price');value.disabled=!allowed||!!row.blocked;value.title=(row.blocked||'选择')+typeLabel(role)+'；来源与条件可点产品名称查看';value.onclick=()=>{check.checked=!check.checked;return select();};box.append(value);}cell.append(box);if(data.matter.values[row.id]!==row.baseline){cell.className='changed';cell.append(elem('small',moneyDelta(data.matter.values[row.id],row.baseline),'cell-delta'));}}
    }tr.append(cell);
   }body.append(tr);
  }
  table.append(head,body);scroll.append(table);section.append(scroll);node('roleMatrix').replaceChildren(section);return true;
 }
 async function previewSelected(){
  try{capturePrices();const edits=[];for(const rid of state.matter.selected){const entry=inputsFor(state.matter.id).get(rid);if(!entry)continue;const value=roundMoney(entry.value);if(sameAmount(value,entry.old))continue;inputsFor(state.matter.id).set(rid,{...entry,value});for(const binding of renderedPrices)if(binding.row.id===rid)binding.input.value=value;edits.push({id:rid,old:entry.old,new:value,scope:entry.scope});}
  if(!edits.length){status('请填写调整后价格；小数将四舍五入取整，预览后确认。',true);return null;}return await act('draft_preview',{edits});}catch(error){status(error.message||'请检查调整金额。',true);return null;}
 }
 function showPane(next){pane=next;renderAll();const target=next==='prices'?node('roleMatrix'):node('businessWorkbench');if(target&&typeof target.scrollIntoView==='function')target.scrollIntoView({block:'start',behavior:'smooth'});}
 function fillSelect(id,entries){const s=node(id),prior=s.value;s.replaceChildren(...[['','请选择'],...entries].map(([value,label])=>{const o=elem('option',String(label).replace(/^虚构 /,''));o.value=value;return o;}));if(entries.some(([value])=>value===prior))s.value=prior;}
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
  const enabled=data.matter.fixture_set===CATALOG;node('businessWorkbench').hidden=!enabled||pane==='prices';node('roleViewControls').hidden=!enabled;node('inquirySection').hidden=pane==='history';node('quoteSection').hidden=pane!=='quote';node('historySection').hidden=pane!=='history';
  if(!enabled)return;initialize(data);
  node('discussionHint').textContent='按当前选择提供规则辅助分析；调整建议须预览、确认。';
  const m=data.matter,preview=m.draft_preview;node('draftPreviewPanel').hidden=!preview;
  syncDraftConfirm();
  if(preview){node('draftPreviewRows').replaceChildren(...preview.edits.map(edit=>{const row=data.rows.find(r=>r.id===edit.id);return elem('p',[row.family,row.configuration,edit.scope.market,edit.scope.role,'数量 '+edit.scope.tier,money(edit.old)+' → '+money(edit.new)+'（变化 '+moneyDelta(edit.new,edit.old)+'）',edit.scope.currency+'/'+edit.scope.unit].join(' · '));}));}
  const analysis=m.inquiry;node('wbAnalysis').replaceChildren();for(const id of ['wbCustomer','wbProject','wbProduct','wbMarket','wbApplication','wbRole','wbQuantity','wbCurrency','wbUnit','wbConditions'])node(id).className='';
  if(analysis){
   const labels={NEEDS_INFO:'待补条件',BLOCKED:'暂无可用报价',NEEDS_CONFIRMATION:'条件待确认',AVAILABLE_DEMO:'参考条件匹配'};
   node('wbAnalysis').append(elem('strong',labels[analysis.status]),elem('p',analysis.reason));
   if(analysis.missing.length){node('wbAnalysis').append(elem('p','请补充：'+analysis.missing.join('、')));const ids={客户:'wbCustomer',项目:'wbProject',产品配置:'wbProduct',市场:'wbMarket',应用:'wbApplication',角色:'wbRole',价格类型:'wbRole',数量:'wbQuantity',币种:'wbCurrency',单位:'wbUnit',商业条件:'wbConditions'};for(const label of analysis.missing)if(ids[label])node(ids[label]).className='field-missing';}
   for(const ref of analysis.references)node('wbAnalysis').append(elem('p',money(ref.amount)+' '+ref.currency+'/'+ref.unit+' · '+ref.role+' · 数量 '+ref.tier+' · '+ref.source+' · '+ref.approval));
   for(const old of analysis.history){const d=elem('details');d.append(elem('summary','历史参考 '+old.id+' v'+old.version+' · '+money(old.amount)+' '+old.currency+'/'+old.unit),elem('p',old.reason),elem('p',old.differences.join('；')||'条件一致'));node('wbAnalysis').append(d);}
   if(!analysis.history.length)node('wbAnalysis').append(elem('p','尚无相关报价历史。'));
   if(analysis.references.length&&!node('wbAmount').value)node('wbAmount').value=roundMoney(analysis.references[0].amount);
  }
  const quote=m.quote_preview;node('wbQuotePreview').replaceChildren();node('wbQuoteConfirm').disabled=!quote||formDirty||quote.prepared_version!==m.version;
  if(quote){node('wbQuotePreview').append(elem('h3','核对本次报价'),elem('p',describeTerms(quote.payload.terms)),elem('p','金额 '+money(quote.payload.amount)+'；参考 '+money(quote.payload.reference.amount)+' '+quote.payload.terms.currency+'/'+quote.payload.terms.unit),elem('p',quote.payload.previous_version?'更正 '+quote.payload.id+'，保留原版本；原因：'+quote.payload.reason:'确认后保存。'));}
  const history=data.workbench_history||[],latest=new Map();for(const record of history)latest.set(record.id,Math.max(latest.get(record.id)||0,record.version));
  node('wbHistory').replaceChildren(...[...history].reverse().map(record=>{
   const d=elem('details');d.append(elem('summary',record.id+' v'+record.version+' · '+money(record.amount)+' '+record.terms.currency+'/'+record.terms.unit+(latest.get(record.id)===record.version?' · 当前记录':' · 保留旧版')),elem('p','已报价 · '+record.at),elem('p',describeTerms(record.terms)),elem('p','依据 '+record.reference.id+' · '+record.reference.source),elem('p',record.reason||'首次报价'));
   if(latest.get(record.id)===record.version&&record.matter_id===m.id){const button=elem('button','准备更正（保留旧版）');button.onclick=()=>{quoteEditGeneration++;correction={id:record.id,version:record.version};for(const [key,id] of [['customer_id','wbCustomer'],['project_id','wbProject'],['product_id','wbProduct'],['market','wbMarket'],['application','wbApplication'],['role','wbRole'],['quantity','wbQuantity'],['currency','wbCurrency'],['unit','wbUnit'],['conditions','wbConditions']])node(id).value=record.terms[key];node('wbAmount').value=roundMoney(record.amount);formDirty=true;node('wbQuoteConfirm').disabled=true;node('wbAcknowledged').checked=false;node('wbCorrection').textContent='更正 '+record.id+' v'+record.version+'；请选择原因后重新预览。';showPane('quote');};d.append(button);}
   return d;
  }));
  if(!history.length)node('wbHistory').append(elem('p','暂无已确认报价。'));
 }
 function setup(){
  node('closePriceDetails').onclick=()=>node('priceDetails').hidden=true;node('openInquiry').onclick=()=>showPane('inquiry');node('openQuote').onclick=()=>showPane('quote');node('openHistory').onclick=()=>showPane('history');node('discuss').onclick=()=>{const open=node('discussionPanel').hidden;node('discussionPanel').hidden=!open;node('workspace').className=open?'with-discussion':'';node('discuss').setAttribute('aria-expanded',String(open));};node('adjust').onclick=()=>{if(!current())return act('mode',{mode:'adjustment'});if(state.matter.proposal)return act('mode',{mode:'adjustment'});if(!state.matter.selected.length){status('请先点击要调整的价格。',true);return null;}editing=true;node('editHint').textContent='原值显示取整、来源精度保留；输入小数将四舍五入，预览后确认。';renderAll();};node('previewSelected').onclick=()=>previewSelected();
  node('showRoleMatrix').onclick=()=>{capturePrices();if(!hasUnsubmittedPrices())editing=false;view='matrix';pane='prices';renderAll();};node('showRoleDetails').onclick=()=>{capturePrices();view='detail';pane='prices';renderAll();};
  node('draftConfirm').onclick=()=>{if(!canConfirmDraft()){status('预览后输入或范围已变化；请重新预览再确认。',true);return null;}return act('draft_confirm',{token:state.matter.draft_preview.token});};
  node('draftCancel').onclick=async()=>{const before=state.matter.draft_preview;const result=await act('draft_cancel');if(result&&before){for(const edit of before.edits)inputsFor(state.matter.id).delete(edit.id);renderAll();}};
  node('wbAnalyze').onclick=async()=>{const result=await act('inquiry',{terms:terms()});if(result&&result.analysis&&result.analysis.references.length&&!correction)node('wbAmount').value=roundMoney(result.analysis.references[0].amount);};
  node('wbQuotePrepare').onclick=async()=>{
   try{node('wbAmount').value=roundMoney(node('wbAmount').value);}catch(_){node('wbAmount').className='field-missing';status('请输入本次报价金额。',true);return null;}
   const input=quoteInput(),identity=JSON.stringify(input),generation=quoteEditGeneration,matter=state.matter.id;
   const result=await act('quote_preview',input);
   if(result){formDirty=generation!==quoteEditGeneration||identity!==JSON.stringify(quoteInput())||matter!==state.matter.id;node('wbAcknowledged').checked=false;node('wbQuoteConfirm').disabled=formDirty;if(formDirty)status('预览期间输入已变化；保留新输入，请重新预览再确认。',true);}
  };
  node('wbQuoteCancel').onclick=async()=>{const result=await act('quote_cancel');if(result){correction=null;formDirty=false;node('wbAcknowledged').checked=false;node('wbCorrection').textContent='';}};
  node('wbQuoteConfirm').onclick=async()=>{if(formDirty||!state.matter.quote_preview||state.matter.quote_preview.prepared_version!==state.matter.version)return;const result=await act('quote_confirm',{token:state.matter.quote_preview.token,acknowledged:node('wbAcknowledged').checked});if(result){correction=null;node('wbCorrection').textContent='';node('wbAcknowledged').checked=false;}};
 }
 const renderAll=()=>{if(typeof state!=='undefined'&&state)globalThis.render();};
 return {catalog:CATALOG,groupRows,renderMatrix,render,syncDraftConfirm,previewSelected,sent,finished,resolve,accepted,duplicate,setup,notice:()=>{const text=resolutionNotice;resolutionNotice='';return text;}};
})();
Workbench.setup();
if(typeof state!=='undefined'&&state)render();

