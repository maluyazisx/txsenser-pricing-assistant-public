'use strict';
// Existing demo flow and private reference inquiries; no shared-history writes.
const Workbench = (() => {
 const CATALOG='fictional-role-matrix-v1';
 let initialized=false,formDirty=false,correction=null,quoteEditGeneration=0,pane='prices',editing=false,detailRowId=null;
 let pending=null,resolutionNotice='',batchMode=false,previousSelection=[],draftEditGeneration=0,invalidDraftToken=null,exportBusy=false,activePanel=null,returnFocus=null,shownPreviewKey=null;
 let exportScopeGeneration=0;
 let inquiryDirty=false,inquiryGeneration=0,historyReferenceControls=[];
 function scopeIntent(){exportScopeGeneration++;}
 try{const raw=typeof sessionStorage!=='undefined'&&sessionStorage.getItem('s1-workbench-pending');if(raw){const p=JSON.parse(raw);if(p&&p.op==='quote_confirm'&&typeof p.matter==='string'&&typeof p.request_id==='string'&&typeof p.token==='string')pending=p;}}catch(_){}
 const node=id=>document.getElementById(id);
 const elem=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const current=()=>typeof state!=='undefined'&&state&&state.matter.fixture_set===CATALOG;
 const privateInquiry=()=>current()&&state.matter.data_kind==='private_experience';
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
  if(op==='history_reference_select'||op==='history_reference_remove'){
   if(!['values','private_rows','history','quote_records'].every(key=>same(before[key],data.matter[key])))return false;
   const saved=data.matter.history_reference;
   const old=before.history_reference,archived=before.previous_history_references||[],retired=old&&(op==='history_reference_remove'||!saved||!same(old.reference,saved.reference)||!same(old.context,saved.context));
   if(!same(data.matter.previous_history_references||[],retired?[...archived,old]:archived))return false;
   if(op==='history_reference_remove')return saved===null;
   return !!(saved&&saved.schema==='private-history-reference.v1'&&same(saved.reference,extra.reference)&&same(saved.context.inquiry_request,extra.inquiry_request)&&same(saved.context.queried_scope,extra.queried_scope));
  }
  if(op==='inquiry'&&before.data_kind==='private_experience')return !!(data.matter.inquiry_request&&data.matter.inquiry_request.schema==='private-inquiry-request.v1'&&same(data.matter.inquiry_request.terms,extra.terms)&&data.inquiry_read&&data.inquiry_read.kind==='private_reference_inquiry'&&same(data.inquiry_read.terms,extra.terms)&&data.inquiry_read.execution_allowed===false);
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
  if(!current()||busy||loading||writeBlockReason)return false;const m=state.matter,p=m.draft_preview;
  return !!(p&&p.token!==invalidDraftToken&&p.prepared_version===m.version&&Array.isArray(p.edits)&&p.edits.every(edit=>{const input=inputsFor(m.id).get(edit.id);return !input||sameAmount(input.value,edit.new)&&input.old===edit.old&&same(input.scope,edit.scope);}));
 }
 function syncDraftConfirm(){node('draftConfirm').disabled=!canConfirmDraft();for(const button of historyReferenceControls)button.disabled=busy||loading||!!writeBlockReason||inquiryDirty;if(current()){syncEditing();syncExportSummary(state);}}
 function visibleRoles(data){const filters=data.matter.filters,roles=data.workbench.roles;if(Array.isArray(filters.price_types))return roles.filter(r=>filters.price_types.includes(r));return filters.role?roles.filter(r=>r===filters.role):roles;}
 function selectable(row){return row.baseline!==null&&!row.blocked&&row.copy_editable!==false&&state.visible_ids.includes(row.id);}
 function selectionReason(row){return row.copy_editable===false?'当前权限仅可查看此价格。':row.blocked||row.risk||'该范围尚无可调整的参考价格。';}
 function quantityText(row){return row.tier==='source_not_specified'?(row.provenance_kind==='private_source_copy'&&row.source_status==='synthetic_available'&&row.conditions?'未设固定数量分档，见适用条件':'数量范围待确认'):(row.tier||'数量范围待确认');}
 function groupRows(data){
  const groups=new Map();
  for(const row of data.rows){
   const key=JSON.stringify([row.market,row.application,row.tier,row.currency,row.unit,row.conditions]);
   if(!groups.has(key))groups.set(key,{label:[row.market||'市场待确认',row.application||'应用待确认',quantityText(row),(row.currency||'币种待确认')+'/'+(row.unit||'单位待确认')].join(' · '),products:new Map()});
   const products=groups.get(key).products,pid=JSON.stringify([row.family,row.kind,row.configuration,row.pn]);
   if(!products.has(pid))products.set(pid,{row,cells:new Map(),visible:false});
   const product=products.get(pid);if(!product.cells.has(row.role))product.cells.set(row.role,[]);product.cells.get(row.role).push(row);
   if(data.visible_ids.includes(row.id)&&visibleRoles(data).includes(row.role))product.visible=true;
  }
  return [...groups.values()].map(g=>({...g,products:[...g.products.values()].filter(p=>p.visible)})).filter(g=>g.products.length);
 }
 function priceInput(row,m){
  const input=elem('input');input.className='price';const unsent=inputsFor(m.id).get(row.id);input.value=unsent?unsent.value:roundMoney(m.values[row.id]??row.baseline);input.inputMode='decimal';
  input.disabled=!m.selected.includes(row.id)||!!row.blocked||row.copy_editable===false||!state.visible_ids.includes(row.id);input.dataset.row=row.id;input.setAttribute('aria-label',row.family+' '+typeLabel(row.role)+' 调整后价格');
  const binding={input,matter:m.id,row,old:m.values[row.id],initialDisplay:input.value};renderedPrices.push(binding);
  input.oninput=()=>{draftEditGeneration++;rememberPrice(binding,true);syncDraftConfirm();};
  input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();rememberPrice(binding,true);return previewSelected();}};
  return input;
 }
 function typeLabel(role){return state.workbench.price_type_labels&&state.workbench.price_type_labels[role]||({指导:'指导价',直销:'直销底价',经销:'经销底价',代理:'代理底价',OEM:'OEM底价',出厂:'出厂价',大客户权限:'大客户权限价'})[role]||role;}
 function displayName(row){return row.provenance_kind==='private_source_copy'?row.family:row.family.replace(/^虚构 /,'');}
 function openPanel(id,focusId){
  if(activePanel!==id){returnFocus=document.activeElement;activePanel=id;}
  node('panelBackdrop').hidden=false;for(const other of ['priceDetails','draftPreviewPanel'])node(other).hidden=other!==id;
  const target=node(focusId);if(typeof target.focus==='function')target.focus({preventScroll:true});
 }
 function closePanel(){
  if(!activePanel)return;node(activePanel).hidden=true;node('panelBackdrop').hidden=true;activePanel=null;
  const target=returnFocus&&returnFocus.isConnected&&!returnFocus.disabled&&returnFocus.getClientRects().length?returnFocus:node('adjust');if(target&&typeof target.focus==='function')target.focus({preventScroll:true});
 }
 function panelKey(event){
  if(!activePanel)return;
  if(event.key==='Escape'){event.preventDefault();if(activePanel==='priceDetails')detailRowId=null;closePanel();return;}
  if(event.key!=='Tab')return;const panel=node(activePanel);if(typeof panel.querySelectorAll!=='function')return;
  const items=[...panel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),summary,[tabindex="0"]')].filter(x=>x.getClientRects().length);
  if(!items.length)return;const first=items[0],last=items.at(-1),outside=!items.includes(document.activeElement);if(event.shiftKey&&(outside||document.activeElement===first)){event.preventDefault();last.focus();}else if(!event.shiftKey&&(outside||document.activeElement===last)){event.preventDefault();first.focus();}
 }
 function showDetails(product,row){
  if(!row)return;detailRowId=row.id;
  const panel=node('priceDetailsContent');panel.replaceChildren(elem('h3',displayName(product.row)+' · '+product.row.configuration));
  {
   const card=elem('section',undefined,'source-card'),privateCopy=row.provenance_kind==='private_source_copy';
   card.append(elem('h4',typeLabel(row.role)),elem('p','参考 '+money(row.baseline)+'；调整后 '+money(state.matter.values[row.id])+' · '+scopeUnitLabel(row)),
    elem('p','来源：'+(privateCopy?'私有来源体验副本':row.source||'示例资料')+(row.source_anchor?' · 单元格 '+row.source_anchor:'')),
    elem('p','适用条件：'+(row.conditions||'待确认')+' · 数量范围：'+quantityText(row)));
   if(row.experience_draft_only)card.append(elem('p','适用条件待确认；仅可调整本体验草稿，不能据此报价。'));
   else if(row.quote_blocked||row.blocked)card.append(elem('p',row.quote_blocked||row.blocked));
   const trace=elem('details');trace.append(elem('summary','追溯信息'));
   for(const [label,value]of [['来源标识',row.source],['来源位置',row.source_anchor],['版本或日期依据',row.effective],['批准依据',row.approval]])if(value)trace.append(elem('p',label+'：'+value));
   card.append(trace);panel.append(card);
  }
  openPanel('priceDetails','priceDetailsContent');
 }
 function renderMatrix(data){
  if(!node('roleMatrix'))return false;const active=data.matter.fixture_set===CATALOG;node('roleMatrix').hidden=!active;node('detailTable').hidden=active;
  if(!active){node('roleMatrix').replaceChildren();return false;}
  renderColumns(data);
  const section=elem('section',undefined,'role-group'),scroll=elem('div',undefined,'role-scroll');scroll.tabIndex=0;scroll.setAttribute('aria-label','产品与价格类型横向总览');
  const table=elem('table',undefined,'role-table'),head=elem('thead'),top=elem('tr'),productHead=elem('th','产品 / 配置 / 适用范围');productHead.scope='col';top.append(productHead);
  const roles=visibleRoles(data),groups=groupRows(data);let focusedRow=null;table.className='role-table price-cols-'+roles.length;
  node('roleMatrix').className=editing?'selecting-prices':'';
  if(!roles.length){node('roleMatrix').replaceChildren(elem('p','未选择价格列，请在上方选择后查看或导出。','empty-prices'));node('summary').textContent='0 个产品范围 · 0 项参考价';detailRowId=null;if(activePanel==='priceDetails')closePanel();else node('priceDetails').hidden=true;syncExportSummary(data);return true;}
  for(const role of roles){const th=elem('th',typeLabel(role));th.scope='col';if(role==='出厂')th.title='经济基准，不是成本或普通报价底价';if(role==='大客户权限')th.title='销售总监或CEO按既有授权使用；使用权不等于修改公司标准价的权限';if(role==='指导')th.title='参考标价，不等于净应收价';top.append(th);}head.append(top);const body=elem('tbody');
  for(const group of groups)for(const product of group.products){
   const tr=elem('tr'),name=elem('th');name.scope='row';const details=elem('button',displayName(product.row),'product-details');details.onclick=()=>{if(focusedRow)focusedRow.className='';focusedRow=tr;tr.className='row-focused';const rows=roles.flatMap(role=>product.cells.get(role)||[]);status(rows.some(selectable)?'已定位此产品；点击本行具体价格查看，点“调整价格”后可选择修改。':rows.length?selectionReason(rows[0]):'此筛选范围暂无价格。',!rows.some(selectable));};name.onclick=details.onclick;name.append(details,elem('small',product.row.configuration),elem('small',group.label));tr.append(name);
   for(const role of roles){const cell=elem('td'),allMatches=product.cells.get(role)||[],matches=allMatches.filter(row=>data.visible_ids.includes(row.id));
    if(matches.length!==1){cell.append(elem('span','—','price-missing'));cell.title=matches.length?'适用范围冲突':allMatches.length?'不在当前筛选范围':'该范围未提供此价格类型';}
    else{const row=matches[0],canSelect=selectable(row),check=elem('input'),box=elem('div',undefined,'price-cell');check.type='checkbox';check.checked=data.matter.selected.includes(row.id);check.disabled=!canSelect;check.dataset.row=row.id;check.setAttribute('aria-label','选择 '+displayName(row)+' '+typeLabel(role));
     const select=()=>{if(!canSelect){status(selectionReason(row),true);return null;}return act('view',{selected:check.checked?[...new Set([...data.matter.selected,row.id])]:data.matter.selected.filter(id=>id!==row.id),filters:data.matter.filters});};check.onchange=async()=>{const result=await select();syncDraftConfirm();return result;};
     check.hidden=!editing||!batchMode;box.append(check);
     if(editing&&check.checked&&canSelect){box.append(priceInput(row,data.matter));const info=elem('button','详情','price-detail-action');info.dataset.row=row.id;info.onclick=event=>{if(event&&event.stopPropagation)event.stopPropagation();showDetails(product,row);};box.append(info);}
     else{const value=elem('button',row.baseline===null?(/合列|合并/.test(row.blocked||row.risk)?'合列待核':'待来源'):money(data.matter.values[row.id]),'cell-price');value.dataset.row=row.id;value.setAttribute('aria-pressed',check.checked);value.title=canSelect?(editing?'点击选择此价格并输入调整金额':'点击查看此价格；调整请点“调整价格”'):selectionReason(row);value.onclick=async()=>{if(!editing||!canSelect)showDetails(product,row);if(!canSelect){status(selectionReason(row),true);return;}if(!editing){status('已显示此价格详情；调整请点“调整价格”。');return;}check.checked=!check.checked;const result=await act('view',{selected:batchMode?(check.checked?[...new Set([...data.matter.selected,row.id])]:data.matter.selected.filter(id=>id!==row.id)):[row.id],filters:data.matter.filters});syncDraftConfirm();if(result)status(check.checked?'已选中'+typeLabel(role)+'；输入金额后点“预览调整”。':'已取消此价格选择。');};box.append(value);}
     cell.className=check.checked?'selected-price':'';cell.append(box);if(!sameMoneyValue(data.matter.values[row.id],row.baseline)){cell.className+=' changed';cell.append(elem('small',moneyDelta(data.matter.values[row.id],row.baseline),'cell-delta'));}
    }tr.append(cell);
   }body.append(tr);
  }
  table.append(head,body);scroll.append(table);section.append(scroll);node('roleMatrix').replaceChildren(section);
  const count=data.rows.filter(row=>data.visible_ids.includes(row.id)&&roles.includes(row.role)&&row.baseline!==null).length;node('summary').textContent=groups.reduce((sum,g)=>sum+g.products.length,0)+' 个产品范围 · '+count+' 项参考价';
  if(detailRowId){const product=groups.flatMap(g=>g.products).find(p=>[...p.cells.values()].flat().some(r=>r.id===detailRowId&&roles.includes(r.role)&&data.visible_ids.includes(r.id)));if(product)showDetails(product,[...product.cells.values()].flat().find(r=>r.id===detailRowId));else{detailRowId=null;if(activePanel==='priceDetails')closePanel();else node('priceDetails').hidden=true;}}
  syncExportSummary(data);return true;
 }
 function previewChanges(){
  const m=state.matter,ids=m.selected.filter(id=>state.rows.some(row=>row.id===id&&selectable(row)));
  if(!ids.length)return {edits:[],reason:'请先点击可调整的价格。'};
  const edits=[];
  for(const id of ids){const entry=inputsFor(m.id).get(id);if(!entry)continue;let value;try{value=roundMoney(entry.value);if(!/^\d{1,9}$/.test(value))throw Error('amount range');}catch(_){return {edits:[],reason:'请检查 '+id+' 的金额：输入0至999999999的数字，预览时取整。'};}if(entry.old!==m.values[id])return {edits:[],reason:'原价格已变化，请重新载入核对；输入仍保留。'};if(!sameAmount(value,entry.old))edits.push({id,old:entry.old,new:value,scope:entry.scope});}
  return {edits,reason:edits.length?'':'尚无金额修改；填写后可预览。'};
 }
 function syncEditing(){
  node('editToolbar').hidden=!editing;node('batchActions').hidden=!editing||!batchMode;node('batchInputPanel').hidden=!editing||!batchMode;node('enterBatch').textContent=batchMode?'切换单项调整':'批量调整';
  const eligible=state.rows.filter(selectable).length;node('selectVisible').textContent='选择当前筛选内 '+eligible+' 项可调整价格';node('restoreSelection').disabled=!previousSelection.length;
  const check=previewChanges(),waiting=busy||loading||!!writeBlockReason;node('previewSelected').disabled=waiting||!check.edits.length;
  node('previewHint').textContent=waiting?(writeBlockReason||'正在处理，请稍候。'):check.reason||('可预览 '+check.edits.length+' 项修改；保存前会显示对照。');
  if(state.matter.draft_preview&&state.matter.draft_preview.token===invalidDraftToken)node('previewHint').textContent='预览期间输入已变化；新输入已保留，请重新预览。';
  node('draftPanelHint').textContent=canConfirmDraft()?'核对范围与前后金额后确认；原参考价不变。':node('previewHint').textContent;
 }
 async function previewSelected(){
  if(!current()||busy||loading||writeBlockReason){syncEditing();return null;}
  capturePrices();const checked=previewChanges();if(!checked.edits.length){syncEditing();status(checked.reason,true);return null;}
  for(const edit of checked.edits){const prior=inputsFor(state.matter.id).get(edit.id);inputsFor(state.matter.id).set(edit.id,{...prior,value:edit.new});for(const binding of renderedPrices)if(binding.row.id===edit.id)binding.input.value=edit.new;}
  const m=state.matter,generation=draftEditGeneration,identity=JSON.stringify([m.id,m.selected,m.filters,checked.edits]);
  const result=await act('draft_preview',{edits:checked.edits});
  if(result){capturePrices();const now=previewChanges();invalidDraftToken=generation!==draftEditGeneration||identity!==JSON.stringify([state.matter.id,state.matter.selected,state.matter.filters,now.edits])?result.matter.draft_preview.token:null;}
  syncDraftConfirm();if(invalidDraftToken)status('预览期间输入已变化；新输入已保留，请重新预览。',true);return result;
 }
 async function setPriceColumns(roles){
  capturePrices();if(busy||loading||writeBlockReason){scopeIntent();status(writeBlockReason||'请等待上一操作完成。',true);return null;}
  return act('view',{selected:state.matter.selected,filters:{...state.matter.filters,role:'',price_types:roles}});
 }
 function renderColumns(data){
  const roles=visibleRoles(data);node('priceColumnOptions').replaceChildren(...data.workbench.roles.map(role=>{const label=elem('label'),check=elem('input');check.type='checkbox';check.checked=roles.includes(role);check.dataset.priceType=role;check.setAttribute('aria-label','显示 '+typeLabel(role));check.onchange=()=>setPriceColumns(data.workbench.roles.filter(r=>r===role?check.checked:roles.includes(r)));label.append(check,elem('span',typeLabel(role)));return label;}));
 }
 function syncExportSummary(data){
  const roles=visibleRoles(data),groups=groupRows(data),products=groups.reduce((n,g)=>n+g.products.length,0);if(!node('exportBasis').value)node('exportBasis').value='reference';if(!node('exportAudience').value)node('exportAudience').value=data.matter.persona||'ceo';
  node('exportScope').textContent='当前筛选：'+products+' 个产品范围；价格列：'+(roles.map(typeLabel).join('、')||'未选择')+'；对象：'+(({ceo:'CEO',sales_director:'销售总监',sales_admin:'销售管理部门',sales:'普通销售'})[node('exportAudience').value]||'权限待明确')+'；依据：'+(node('exportBasis').value==='saved'?'已保存调整价格':'来源参考价格')+'。';
  for(const id of ['exportXlsx','exportPdf'])node(id).disabled=exportBusy||!roles.length||!products||busy||loading||!!writeBlockReason||!['ceo','sales_director','sales_admin','sales'].includes(node('exportAudience').value);
 }
 async function downloadPrices(format){
  const roles=visibleRoles(state);if(exportBusy||!roles.length)return;exportBusy=true;syncExportSummary(state);node('exportStatus').textContent='正在生成当前范围的价格表…';
  const generation=exportScopeGeneration,basis=node('exportBasis').value,audience=node('exportAudience').value,identity=JSON.stringify([state.matter.id,state.matter.version,roles,basis,audience]);
  try{const response=await fetch('/api/price-export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({matter:state.matter.id,version:state.matter.version,roles,basis,format,audience})});if(!response.ok){const error=await response.json();throw Error(error.error||'导出未完成。');}
   const blob=await response.blob();if(generation!==exportScopeGeneration||busy||loading||writeBlockReason||identity!==JSON.stringify([state.matter.id,state.matter.version,visibleRoles(state),node('exportBasis').value,node('exportAudience').value]))throw Error('导出期间范围已变化或范围请求仍在处理中，请完成操作后重新导出；未下载旧范围。');
   const expected=format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/pdf';if(blob.type!==expected)throw Error('文件格式未核对，未下载。');
   const url=URL.createObjectURL(blob),link=elem('a');try{link.href=url;link.download='price-table-'+basis+'.'+format;document.body.append(link);link.click();}finally{if(typeof link.remove==='function')link.remove();URL.revokeObjectURL(url);}node('exportStatus').textContent='已生成'+(basis==='saved'?'已保存调整价格':'来源参考价格')+'文件；未发送或正式发布。';
  }catch(error){node('exportStatus').textContent=error.message||'导出未完成，请核对范围。';}finally{exportBusy=false;syncExportSummary(state);}
 }
 function showPane(next){if(privateInquiry()&&next==='quote')next='inquiry';pane=next;renderAll();const target=next==='prices'?node('roleMatrix'):node('businessWorkbench');if(target&&typeof target.scrollIntoView==='function')target.scrollIntoView({block:'start',behavior:'smooth'});}
 function fillSelect(id,entries){const s=node(id),prior=s.value;s.replaceChildren(...[['','请选择'],...entries].map(([value,label])=>{const o=elem('option',String(label).replace(/^虚构 /,''));o.value=value;return o;}));if(entries.some(([value])=>value===prior))s.value=prior;}
 function initialize(data){
  if(initialized)return;initialized=true;node('exportAudience').value=data.matter.persona||'ceo';
  fillSelect('wbCustomer',Object.entries(data.workbench.customers));fillSelect('wbProject',Object.entries(data.workbench.projects));fillSelect('wbProduct',data.workbench.products.map(p=>[p.id,p.label]));
  for(const [id,key] of [['wbMarket','market'],['wbApplication','application'],['wbRole','role'],['wbCurrency','currency'],['wbUnit','unit']])fillSelect(id,[...new Set(data.rows.map(r=>r[key]))].map(v=>[v,v]));
  fillSelect('wbConditions',data.workbench.conditions.map(v=>[v,v]));
  if(data.matter.data_kind==='private_experience'){
   for(const id of ['wbCustomer','wbProject']){node(id).replaceChildren();node(id).value='';node(id).disabled=true;}
   const saved=data.matter.inquiry_request&&data.matter.inquiry_request.terms;
   if(saved)for(const [key,id]of [['product_id','wbProduct'],['market','wbMarket'],['application','wbApplication'],['role','wbRole'],['quantity','wbQuantity'],['currency','wbCurrency'],['unit','wbUnit'],['conditions','wbConditions']]){
    if(key==='conditions'&&saved[key]&&!data.workbench.conditions.includes(saved[key])){const option=elem('option',saved[key]);option.value=saved[key];node(id).append(option);}
    node(id).value=saved[key]||'';
   }
   else for(const [key,id]of [['market','wbMarket'],['application','wbApplication'],['currency','wbCurrency'],['unit','wbUnit'],['conditions','wbConditions']]){const values=[...new Set(data.rows.map(r=>r[key]).filter(v=>typeof v==='string'&&v))];if(values.length===1)node(id).value=values[0];}
  }
  for(const id of ['wbCustomer','wbProject','wbProduct','wbMarket','wbApplication','wbRole','wbCurrency','wbUnit','wbConditions','wbQuantity','wbAmount','wbReason'])node(id).oninput=node(id).onchange=()=>{quoteEditGeneration++;formDirty=true;node('wbQuoteConfirm').disabled=true;node('wbAcknowledged').checked=false;if(privateInquiry()){inquiryGeneration++;inquiryDirty=true;for(const host of ['wbAnalysis','wbHistory'])node(host).replaceChildren(elem('p','询价条件已变化，请重新核对并保存；旧结果不代表当前输入。'));}};
 }
 function terms(){return Object.fromEntries([['customer_id','wbCustomer'],['project_id','wbProject'],['product_id','wbProduct'],['market','wbMarket'],['application','wbApplication'],['role','wbRole'],['quantity','wbQuantity'],['currency','wbCurrency'],['unit','wbUnit'],['conditions','wbConditions']].map(([key,id])=>[key,node(id).value]));}
 function quoteInput(){return {terms:terms(),amount:node('wbAmount').value,...(correction?{quote_id:correction.id,expected_version:correction.version,reason:node('wbReason').value}:{})};}
 function describeTerms(t){const options=state.workbench;const product=options.products.find(p=>p.id===t.product_id);return [options.customers[t.customer_id],options.projects[t.project_id],product?product.label:t.product_id,t.market,t.application,t.role,'数量 '+t.quantity,t.currency+'/'+t.unit,t.conditions].join(' · ');}
 function renderDiscussion(data){
  const m=data.matter,by=new Map(data.rows.map(r=>[r.id,r]));
  node('chooseDiscussionPrices').textContent=m.selected.length?'更换比较价格':'选择比较价格';node('clearDiscussionPrices').disabled=!m.selected.length;
  node('discussionSelected').replaceChildren(...m.selected.map(id=>{const row=by.get(id),item=elem('div',undefined,'discussion-price');item.append(elem('span',priceLabel(row)+(data.visible_ids.includes(id)?'':' · 当前筛选外')));const remove=elem('button','移除');remove.dataset.removeSelection=id;remove.onclick=()=>act('view',{selected:m.selected.filter(x=>x!==id),filters:m.filters});item.append(remove);return item;}));
  if(!m.selected.length)node('discussionSelected').append(elem('p','尚未选择具体价格。'));
  node('discussionChoices').replaceChildren(...data.rows.filter(r=>data.visible_ids.includes(r.id)&&r.baseline!==null).map(row=>{const label=elem('label',undefined,'discussion-price'),check=elem('input');check.type='checkbox';check.dataset.discussionRow=row.id;check.checked=m.selected.includes(row.id);check.onchange=async()=>{const result=await act('view',{selected:check.checked?[...new Set([...m.selected,row.id])]:m.selected.filter(id=>id!==row.id),filters:m.filters});if(!result)check.checked=state.matter.selected.includes(row.id);return result;};label.append(check,elem('span',priceLabel(row)+' · '+money(m.values[row.id])));return label;}));
 }
 function hasUnsubmittedInquiry(){return privateInquiry()?inquiryDirty:formDirty;}
 function renderReadHistory(host,history){
  const labels={not_connected:'报价历史尚未接通。',identity_unresolved:'尚未确认客户、项目或产品的对应关系，暂时无法查找报价。',unavailable:'报价记录暂时无法读取，请稍后重试。',ready_empty:'没有找到符合本次条件的历史记录。',ready_records:'已找到相关历史记录，请核对产品、数量及交易条件后参考。'};
  const h=history||{status:'not_connected'};host.append(elem('p',labels[h.status]||labels.unavailable));
  if(h.status==='ready_records'||h.status==='ready_empty'){
   host.append(elem('p','查询时间：'+(h.as_of||'待核对')+'；知识截至：'+(h.knowledge_as_of||'待核对')));
   if(h.detail){const details=elem('details');details.append(elem('summary','查看历史依据与适用限制'),elem('div',h.detail,'history-entry'));host.append(details);}
  }
 }
 function referenceInputsMatch(request){return !!(request&&Object.entries(terms()).every(([key,value])=>['customer_id','project_id'].includes(key)||request.terms[key]===value));}
 async function changeHistoryReference(op,reference,request,matter,queriedScope){
  if(inquiryDirty||!referenceInputsMatch(request)||state.matter.id!==matter||!same(state.matter.inquiry_request,request)){status('询价条件已变化，请先核对并保存；原引用未改。',true);return null;}
  const generation=inquiryGeneration;
  const result=await act(op,{reference,inquiry_request:request,queried_scope:queriedScope});
  if(result){inquiryDirty=inquiryDirty||generation!==inquiryGeneration||!referenceInputsMatch(request)||state.matter.id!==matter;renderAll();status(inquiryDirty?'原条件的引用操作已保存；新输入保留，请重新核对。':op==='history_reference_remove'?'已移除本次引用，原引用记录保留。':'历史引用已保存；请以页面复核结果判断能否继续参考。',inquiryDirty);}
  return result;
 }
 function renderHistoryReference(host,data){
  historyReferenceControls=[];
  const check=data.history_reference;if(!check)return;
  const saved=check.saved,previous=data.matter.previous_history_references||[];
  if(saved){
   host.append(elem('strong','已保存的历史依据'),elem('p',check.label||'原记录摘要目前无法重新取得；原询价条件仍可查看。'),elem('p',check.message));
   host.append(elem('p','原引用时点：'+saved.selected_as_of+'；本次复核时点：'+check.checked_as_of));
  }
  if(saved||previous.length){
   const details=elem('details');details.append(elem('summary','查看原引用与询价条件'));
   for(const item of [...previous,...(saved?[saved]:[])]){const t=item.context.inquiry_request.terms,product=data.workbench.products.find(p=>p.id===t.product_id);details.append(elem('p',[product?product.label:'原产品配置',t.market,t.application,typeLabel(t.role),t.quantity?'数量 '+t.quantity:'数量未填写',t.currency+'/'+t.unit,t.conditions].join(' · ')),elem('p','原询价时点：'+item.context.inquiry_request.as_of+'；引用时点：'+item.selected_as_of));}
   host.append(details);
  }
  if(data.matter.persona!=='ceo'||data.history_connection.status!=='ready_records'||!check.options.length||!data.matter.inquiry_request)return;
  const request=JSON.parse(JSON.stringify(data.matter.inquiry_request)),matter=data.matter.id,queriedScope=JSON.parse(JSON.stringify(data.history_connection.queried_scope));
  const controls=elem('div');controls.dataset.historyReferences='true';controls.append(elem('p','选择一条已核对的历史依据，仅保存引用，不套用金额。'));
  check.options.forEach((item,index)=>{const button=elem('button','引用：'+item.label);button.type='button';button.dataset.historyReference='select';button.disabled=busy||loading||!!writeBlockReason||inquiryDirty;button.onclick=()=>changeHistoryReference('history_reference_select',item.reference,request,matter,queriedScope);controls.append(button);historyReferenceControls.push(button);});
  if(saved){const remove=elem('button','移除本次引用');remove.type='button';remove.dataset.historyReference='remove';remove.disabled=busy||loading||!!writeBlockReason||inquiryDirty;remove.onclick=()=>changeHistoryReference('history_reference_remove',saved.reference,request,matter,queriedScope);controls.append(remove);historyReferenceControls.push(remove);}
  host.append(controls);
 }
 function renderPrivateInquiry(data){
  node('wbAnalyze').textContent='核对价格并保存';node('wbQuotePrepare').disabled=true;node('wbQuoteConfirm').disabled=true;
  const analysis=data.inquiry_read;node('wbAnalysis').replaceChildren();node('wbHistory').replaceChildren();
  if(inquiryDirty){for(const host of ['wbAnalysis','wbHistory'])node(host).append(elem('p','询价条件已变化，请重新核对并保存；旧结果不代表当前输入。'));return;}
  if(analysis){
   node('wbAnalysis').append(elem('strong',analysis.status==='REFERENCE_ONLY'?'价格核对结果':analysis.status==='NEEDS_INFO'?'请补充条件':'暂未找到匹配价格'));
   if(analysis.missing.length)node('wbAnalysis').append(elem('p','请补充：'+analysis.missing.join('、')));
   for(const ref of analysis.references){node('wbAnalysis').append(elem('p','参考单价：'+money(ref.baseline)+' '+ref.currency+'/'+ref.unit+' · '+typeLabel(ref.role),'inquiry-price'),elem('p','适用条件：'+(ref.conditions||'待确认')));const trace=elem('details');trace.append(elem('summary','查看价格依据'),elem('p','参考已导入的价格资料，不采用本方案的试调金额。'),elem('p','体验范围确认不代表正式价格审批。'));for(const [label,value]of [['资料标识',ref.source],['资料位置',ref.source_anchor],['适用依据记录',ref.effective],['体验确认记录',ref.approval]])if(value)trace.append(elem('p',label+'：'+value));node('wbAnalysis').append(trace);}
   for(const difference of analysis.differences)node('wbAnalysis').append(elem('p',difference.includes('未设固定数量分档')?'批量采购请与公司另议；不会自动套用数量折扣。':difference));
   node('wbAnalysis').append(elem('p','本次询价已保存，仅供价格核对，不是正式报价。'));
   renderReadHistory(node('wbAnalysis'),analysis.history);
  }else node('wbAnalysis').append(elem('p','选择产品和销售方式后，核对本次询价。'));
  renderReadHistory(node('wbHistory'),data.history_connection);
  renderHistoryReference(node('wbHistory'),data);
 }
 function render(data){
  const enabled=data.matter.fixture_set===CATALOG;node('openPrices').hidden=pane==='prices';node('businessWorkbench').hidden=!enabled||pane==='prices';node('roleViewControls').hidden=!enabled;node('inquirySection').hidden=pane==='history';node('quoteSection').hidden=pane!=='quote';node('historySection').hidden=pane!=='history';
  if(!enabled)return;initialize(data);
  const isPrivate=data.matter.data_kind==='private_experience';node('openQuote').hidden=isPrivate;node('quoteSection').hidden=isPrivate||pane!=='quote';node('wbCustomerField').hidden=isPrivate;node('wbProjectField').hidden=isPrivate;node('wbPrivateHint').hidden=!isPrivate||pane==='history';
  node('wbPrivateHint').textContent='选择产品和销售方式，核对价格并保存本次询价。';node('wbQuantityLabel').textContent=isPrivate?'本次询价数量（可留空）':'数量';node('wbHistoryTitle').textContent='报价历史';node('openHistory').textContent=isPrivate&&data.history_connection&&data.history_connection.status==='not_connected'?'报价历史 · 未接通':'报价历史';
  node('discussionHint').textContent='规则辅助：按所选价格逐项比较；不具备自由问答能力，也不会自动改价。';
  const m=data.matter,preview=m.draft_preview;if(!editing||!preview){node('draftPreviewPanel').hidden=true;if(activePanel==='draftPreviewPanel')closePanel();}
  syncDraftConfirm();
  if(preview){node('draftPreviewRows').replaceChildren(...preview.edits.map(edit=>{const row=data.rows.find(r=>r.id===edit.id);return elem('p',[row.family,row.configuration,edit.scope.market||'市场待确认',typeLabel(edit.scope.role),quantityText(row),money(edit.old)+' → '+money(edit.new)+'（变化 '+moneyDelta(edit.new,edit.old)+'）',scopeUnitLabel(edit.scope)].join(' · '));}));}
  if(preview&&editing){const key=m.id+'|'+preview.token+'|'+preview.prepared_version;if(shownPreviewKey!==key){shownPreviewKey=key;openPanel('draftPreviewPanel','draftPreviewTitle');}}
  if(isPrivate){renderPrivateInquiry(data);return;}
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
  node('chooseDiscussionPrices').onclick=()=>{node('discussionChooser').hidden=false;renderDiscussion(state);};node('finishDiscussionSelection').onclick=()=>{node('discussionChooser').hidden=true;};node('clearDiscussionPrices').onclick=()=>act('view',{selected:[],filters:state.matter.filters});
  node('closePriceDetails').onclick=()=>{detailRowId=null;closePanel();};node('draftBack').onclick=()=>closePanel();if(typeof document.addEventListener==='function')document.addEventListener('keydown',panelKey);node('openInquiry').onclick=()=>showPane('inquiry');node('openQuote').onclick=()=>showPane('quote');node('openHistory').onclick=()=>showPane('history');node('discuss').onclick=()=>{const open=node('discussionPanel').hidden;node('discussionPanel').hidden=!open;node('workspace').className=open?'with-discussion':'';node('discuss').setAttribute('aria-expanded',String(open));};node('adjust').onclick=()=>{if(busy||loading||writeBlockReason){status(writeBlockReason||'上一操作尚未确认。',true);return null;}if(!current())return act('mode',{mode:'adjustment'});if(state.matter.proposal)return act('mode',{mode:'adjustment'});editing=true;batchMode=false;pane='prices';const rows=state.rows.filter(r=>state.visible_ids.includes(r.id)),eligible=rows.filter(selectable);node('editHint').textContent=eligible.length?'点击带边框的价格单元格选择并输入；预览后确认。':'当前范围暂无可调整价格。';renderAll();status(eligible.length?'已进入调整：点击具体价格单元格选择。':rows.length?selectionReason(rows[0]):'当前筛选范围暂无价格。',!eligible.length);};node('previewSelected').onclick=()=>previewSelected();
  node('openPrices').onclick=()=>showPane('prices');
  node('allPriceColumns').onclick=()=>setPriceColumns(state.workbench.roles.slice());node('clearPriceColumns').onclick=()=>setPriceColumns([]);
  node('exportBasis').oninput=node('exportBasis').onchange=node('exportAudience').oninput=node('exportAudience').onchange=()=>{scopeIntent();syncExportSummary(state);};node('exportXlsx').onclick=()=>downloadPrices('xlsx');node('exportPdf').onclick=()=>downloadPrices('pdf');
  node('enterBatch').onclick=()=>{capturePrices();batchMode=!batchMode;renderAll();};
  node('exitAdjustment').onclick=()=>{capturePrices();editing=false;batchMode=false;renderAll();status('已返回看价；未确认输入保留，尚未保存。');};
  node('selectVisible').onclick=async()=>{if(!editing||!batchMode)return;previousSelection=state.matter.selected.slice();await act('view',{selected:state.rows.filter(selectable).map(r=>r.id),filters:state.matter.filters});syncDraftConfirm();};
  node('clearSelection').onclick=async()=>{previousSelection=state.matter.selected.slice();await act('view',{selected:[],filters:state.matter.filters});syncDraftConfirm();};
  node('restoreSelection').onclick=async()=>{const prior=previousSelection;previousSelection=state.matter.selected.slice();await act('view',{selected:prior.filter(id=>state.rows.some(r=>r.id===id&&selectable(r))),filters:state.matter.filters});syncDraftConfirm();};
  node('draftConfirm').onclick=async()=>{if(!canConfirmDraft()){status('预览后输入或范围已变化；请重新预览再确认。',true);return null;}const result=await act('draft_confirm',{token:state.matter.draft_preview.token});if(result)closePanel();return result;};
  node('draftCancel').onclick=async()=>{const before=state.matter.draft_preview;const result=await act('draft_cancel');if(result&&before){for(const edit of before.edits)inputsFor(state.matter.id).delete(edit.id);closePanel();renderAll();}};
  node('wbAnalyze').onclick=async()=>{
   const input=terms(),generation=inquiryGeneration,matter=state.matter.id,isPrivate=privateInquiry();
   const result=await act('inquiry',{terms:input});
   if(isPrivate&&result){inquiryDirty=generation!==inquiryGeneration||JSON.stringify(input)!==JSON.stringify(terms())||matter!==state.matter.id;renderAll();status(inquiryDirty?'已保存提交时的询价条件；新输入保留，请重新核对并保存。':'本次询价已保存，可继续核对或下次打开。',inquiryDirty);}
   else if(result&&result.analysis&&result.analysis.references.length&&!correction)node('wbAmount').value=roundMoney(result.analysis.references[0].amount);
  };
  node('wbQuotePrepare').onclick=async()=>{
   if(privateInquiry()){status('私有询价只保存条件，不生成已报价记录。',true);return null;}
   try{node('wbAmount').value=roundMoney(node('wbAmount').value);}catch(_){node('wbAmount').className='field-missing';status('请输入本次报价金额。',true);return null;}
   const input=quoteInput(),identity=JSON.stringify(input),generation=quoteEditGeneration,matter=state.matter.id;
   const result=await act('quote_preview',input);
   if(result){formDirty=generation!==quoteEditGeneration||identity!==JSON.stringify(quoteInput())||matter!==state.matter.id;node('wbAcknowledged').checked=false;node('wbQuoteConfirm').disabled=formDirty;if(formDirty)status('预览期间输入已变化；保留新输入，请重新预览再确认。',true);}
  };
  node('wbQuoteCancel').onclick=async()=>{const result=await act('quote_cancel');if(result){correction=null;formDirty=false;node('wbAcknowledged').checked=false;node('wbCorrection').textContent='';}};
  node('wbQuoteConfirm').onclick=async()=>{if(privateInquiry()||formDirty||!state.matter.quote_preview||state.matter.quote_preview.prepared_version!==state.matter.version)return;const result=await act('quote_confirm',{token:state.matter.quote_preview.token,acknowledged:node('wbAcknowledged').checked});if(result){correction=null;node('wbCorrection').textContent='';node('wbAcknowledged').checked=false;}};
 }
 const renderAll=()=>{if(typeof state!=='undefined'&&state)globalThis.render();};
 return {catalog:CATALOG,renderDiscussion,hasUnsubmittedInquiry,groupRows,renderMatrix,render,syncDraftConfirm,previewSelected,sent,finished,resolve,accepted,duplicate,setup,scopeIntent,notice:()=>{const text=resolutionNotice;resolutionNotice='';return text;}};
})();
Workbench.setup();
if(typeof state!=='undefined'&&state)render();

