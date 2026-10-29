'use strict';
let state, busy=false, pendingToken=null, failNext=false, loading=false, writeBlockReason='';
let writeBlockLevel=0, renderedPrices=[];
// Page-local input only. Never turn an unconfirmed field into an automatic write.
const localPrices=new Map();
const $=id=>document.getElementById(id);
const fields=['family','kind','configuration','pn','market','application','role','tier','currency','unit'];
const filterLabels={family:'系列',kind:'组件 / 整机',market:'市场',application:'应用',role:'角色',tier:'数量档',currency:'币种',unit:'单位'};
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function status(text,error=false){try{$('saveStatus').textContent=text;$('saveStatus').className=error?'error':'';return true;}catch(e){return false;}}
function mid(){return new URL(location.href).searchParams.get('matter')||'demo-workbench-v1';}
function visible(r){return state.visible_ids.includes(r.id);}
function scope(r){return Object.fromEntries(fields.map(k=>[k,r[k]]));}
function error(e){status(writeBlockReason||e.message||String(e),true);}
function validState(data){
 const m=data&&data.matter,record=v=>v&&typeof v==='object'&&!Array.isArray(v);
 return !!(data&&data.marker==='TXSENSER_S1_SYNTHETIC_ONLY_V1'&&m&&typeof m.id==='string'&&
 Number.isInteger(m.version)&&Number.isInteger(m.revision)&&record(m.values)&&record(m.filters)&&record(m.requests)&&
 Array.isArray(m.selected)&&Array.isArray(m.seen)&&Array.isArray(m.conversation)&&Array.isArray(m.history)&&
 Array.isArray(data.rows)&&Array.isArray(data.matters)&&Array.isArray(data.visible_ids));
}
function blockWrites(message,level=1){if(!writeBlockReason||level>=writeBlockLevel){writeBlockReason=message;writeBlockLevel=level;}status(writeBlockReason,true);}
const unknownResult='操作结果暂时无法确认。请重新载入核对，勿重复提交。';
const unconfirmedCommit='操作已提交，但暂时无法确认保存结果。请重新载入核对，勿重复提交。';
function same(a,b){
 if(a===b)return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
}
function inputsFor(matter){if(!localPrices.has(matter))localPrices.set(matter,new Map());return localPrices.get(matter);}
function rememberPrice(binding,typed=false){
 const edits=inputsFor(binding.matter),prior=edits.get(binding.row.id),value=String(binding.input.value);
 if(prior&&prior.value===value&&!typed)return;
 // A real input event during any request is newer intent, even at the old price.
 if(value===String(binding.old??'')&&!(typed&&(busy||loading))){edits.delete(binding.row.id);return;}
 if(prior&&prior.value===value)return;
 const old=prior?prior.old:binding.old;
 edits.set(binding.row.id,{value,old,scope:prior?prior.scope:scope(binding.row)});
}
function capturePrices(){for(const binding of renderedPrices)rememberPrice(binding);}
function hasUnsubmittedPrices(){capturePrices();return !!(state&&inputsFor(state.matter.id).size);}
function sameAmount(a,b){return typeof a==='string'&&typeof b==='string'&&/^\d{1,9}(?:\.\d{1,2})?$/.test(a)&&/^\d{1,9}(?:\.\d{1,2})?$/.test(b)&&Number(a)===Number(b);}
function reconcileInputs(matter,submitted,data){
 const edits=inputsFor(matter);
 for(const item of submitted){
  const current=edits.get(item.edit.id),saved=data.matter.values[item.edit.id];
  if(!current||!item.input||!sameAmount(String(item.edit.new),saved))continue;
  if(current===item.input)edits.delete(item.edit.id);
  else if(current.value===String(saved))edits.delete(item.edit.id);
  else edits.set(item.edit.id,{...current,old:saved});
 }
}
function validPending(matter,token){
 if(typeof token!=='string'||!token.trim()||!Object.hasOwn(matter.requests,token))return false;
 const request=matter.requests[token];
 return !!(request&&request.id===token&&request.status==='pending'&&(!request.context||!Object.hasOwn(request.context,'matter')||request.context.matter===matter.id));
}
function validFinish(before,data,token){
 if(!validPending(before,token)||!data.matter||!data.matter.requests||!Object.hasOwn(data.matter.requests,token))return false;
 const prior=before.requests[token],result=data.matter.requests[token];
 if(!result||result.id!==token||!['completed','stale'].includes(result.status)||(data.token!==undefined&&data.token!==token))return false;
 const {status:previousStatus,...request}=prior,{status:resultStatus,...received}=result;
 if(!same(request,received))return false;
 const keys=['generation','revision','selected','filters'];
 const stale=keys.some(k=>Object.hasOwn(prior,k)&&!same(prior[k],before[k]));
 // The existing backend binds completion to the pending request's exact context.
 if(stale&&result.status!=='stale')return false;
 if(keys.every(k=>Object.hasOwn(prior,k))&&!stale&&result.status==='stale')return false;
 return true;
}
function feedback(op,extra,before,data){
 if(op==='draft_preview')return '请核对范围和新旧值，明确确认后才保存演示草稿。';
 if(op==='draft_confirm')return '演示草稿已确认保存；参考价与其他角色未变，未入报价历史。';
 if(op==='draft_cancel')return '已取消草稿预览；没有保存价格或报价历史。';
 if(op==='inquiry')return '有限模拟询价分析已生成；未保存报价记录。';
 if(op==='quote_preview')return '演示报价待明确确认；尚未进入已报价历史。';
 if(op==='quote_cancel')return '已取消演示报价预览；未进入报价历史。';
 if(op==='quote_confirm')return '演示已报价记录 '+data.record.id+' v'+data.record.version+' 已核对保存；不代表接受或成交。';
 const m=data.matter,changed=[...new Set([...Object.keys(before.values),...Object.keys(m.values)])].some(k=>before.values[k]!==m.values[k]);
 if(op==='view'){
  const filters=JSON.stringify(before.filters)!==JSON.stringify(m.filters),selected=JSON.stringify(before.selected)!==JSON.stringify(m.selected);
  return filters&&selected?'筛选和选择已记录。':filters?'筛选已记录。':selected?'选择已记录。':'筛选与选择已记录（范围未变）。';
 }
 if(op==='mode'){
  if(before.fixture_set==='fictional-role-matrix-v1'&&before.proposal)return '建议修改范围已预览，尚未保存草稿；请明确确认新旧值。';
  if(extra.mode==='adjustment'&&before.proposal)return changed?'已采用建议，草稿已修改并确认保存（未批准）。':'建议已采用并确认保存，草稿金额未变化（未批准）。';
  return m.mode==='adjustment'?'已进入调整模式并记录。':'已回到讨论并记录。';
 }
 if(op==='edit')return changed?'草稿修改已确认保存（未批准）。':'修改操作已记录，草稿金额未变化。';
 if(op==='undo')return changed?'已撤销修改并确认保存（未批准）。':'撤销操作已记录，草稿金额未变化。';
 if(op==='ai_begin')return '对话已记录。';
 if(op==='ai_finish'){
  const request=m.requests[extra.token];
  if(request&&request.status==='stale')return '迟到回应已阻断；没有覆盖新编辑。记录已保存。';
  const pending=before.requests[extra.token],explicit=pending&&Array.isArray(pending.edits)&&pending.edits.length;
  if(explicit)return changed?'演示指令已修改草稿并确认保存（未批准）。':'演示指令已记录，草稿金额未变化。';
  return m.proposal?'模拟回复已记录，建议尚未采用。':'模拟回复已记录。';
 }
 if(op==='new_round')return '新一轮讨论已创建并记录；从演示基准价开始。';
 return '操作已记录并确认保存。';
}
async function load(){
 if(busy||loading)return false;
 loading=true;
 try{
  capturePrices();
  const r=await fetch('/api/state?matter='+encodeURIComponent(mid()));const data=await r.json();
  if(!r.ok||!validState(data)||data.matter.id!==mid())throw Error('草稿读取未完成，请重新载入核对。');
  if(state&&state.matter.id===data.matter.id&&data.matter.version<state.matter.version)throw Error('读取的草稿版本过旧，请重新载入核对。');
  capturePrices();
  state=data;
  try{render();}catch(e){throw Error('草稿已读取，但页面显示异常，请重新载入核对。');}
  const pendingNotice=typeof Workbench!=='undefined'?Workbench.resolve(data):'';
  if(pendingNotice){blockWrites(pendingNotice,2);return false;}
  const resolvedNotice=typeof Workbench!=='undefined'?Workbench.notice():'';
  if(!status(resolvedNotice||'已载入草稿（修订'+state.matter.revision+'）。'))throw Error('草稿已读取，但页面提示异常，请重新载入核对。');
  writeBlockReason='';writeBlockLevel=0;return true;
 }catch(e){blockWrites(e.message||'草稿读取未完成，请重新载入核对。',0);return false;}finally{loading=false;}
}
async function act(op,extra={}){
 if(writeBlockReason){status(writeBlockReason,true);return null;}
 if(busy||loading){status('上一操作尚未确认，请稍后再试。',true);return null;}
 if(!validState(state)||state.matter.id!==mid()){blockWrites(unknownResult);return null;}
 capturePrices();
 if(op==='ai_finish'&&!validPending(state.matter,extra.token)){status('模拟回应标识无效、已结束或不属于当前事项；未提交。',true);return null;}
 if(op==='new_round'&&hasUnsubmittedPrices()){status('仍有未确认的价格输入，请先按 Enter 提交或恢复原值，再开始新一轮。',true);return null;}
 const before=state.matter,requestId=crypto.randomUUID();
 const submittedEdits=op==='edit'?extra.edits:op==='draft_confirm'&&before.draft_preview?before.draft_preview.edits:null;
 const submitted=Array.isArray(submittedEdits)?submittedEdits.map(edit=>{const input=inputsFor(before.id).get(edit.id);return {edit,input:input&&input.value===String(edit.new)&&input.old===edit.old&&same(input.scope,edit.scope)?input:null};}):[];
 busy=true;
 try{
  if(!status('正在处理，尚未确认结果…')){blockWrites('页面提示异常，本次操作尚未发送。请重新载入核对。');return null;}
  const failure=$('failSave').checked;$('failSave').checked=false;
  if(typeof Workbench!=='undefined')Workbench.sent(op,requestId,extra,before.id);
  const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...extra,matter:before.id,version:before.version,request_id:requestId,op,simulate_failure:failure})});
  const data=await r.json();
  if(data&&((data.committed===true&&data.saved!==true)||data.outcome==='committed_unconfirmed')){blockWrites(unconfirmedCommit,2);return null;}
  if(r.ok&&r.status===200&&data&&data.saved===true){
   const resultIdentity=(op!=='new_round'||(typeof data.new_matter==='string'&&Array.isArray(data.matters)&&data.matters.some(m=>m.id===data.new_matter&&m.parent===before.id)))&&
    (op!=='ai_begin'||(validState(data)&&validPending(data.matter,data.token)))&&
    (op!=='ai_finish'||validFinish(before,data,extra.token))&&
    (typeof Workbench==='undefined'||validState(data)&&Workbench.accepted(op,extra,before,data,requestId));
   const duplicate=typeof Workbench!=='undefined'&&validState(data)&&Workbench.duplicate(op,extra,data);
   if(data.committed===false||!validState(data)||data.matter.id!==before.id||(!duplicate&&data.matter.version<=before.version)||(!duplicate&&!data.matter.seen.includes(requestId))||!resultIdentity){
    blockWrites('服务返回已保存，但结果数据暂时无法核对。请重新载入核对，勿重复提交。',2);return null;
   }
   state=data;
   if(typeof Workbench!=='undefined')Workbench.finished(op);
   try{capturePrices();reconcileInputs(before.id,submitted,data);const message=feedback(op,extra,before,data);render();if(!status(message))throw Error('反馈显示异常');}catch(e){
    blockWrites('操作已确认保存，但页面显示异常。请重新载入核对，勿重复提交。',3);return null;
   }
   return data;
  }
  if(!r.ok&&r.status===409&&data&&data.saved===false&&!data.matter&&!data.new_matter&&!data.token){
   if(typeof Workbench!=='undefined')Workbench.finished(op);
   status('本次操作未提交：'+(data.error||'请求被拒绝。'),true);return null;
  }
  blockWrites(data&&data.saved===true?'服务返回已保存，但结果暂时无法核对。请重新载入核对，勿重复提交。':unknownResult,data&&data.saved===true?2:1);return null;
 }catch(e){blockWrites(unknownResult);return null;}finally{busy=false;}
}
function render(){
 const m=state.matter;document.title=m.title+' · 合成演示';
 renderedPrices=[];
 $('matter').replaceChildren(...state.matters.map(x=>{const o=el('option',x.title);o.value=x.id;o.selected=x.id===m.id;return o;}));
 $('summary').textContent=`${state.rows.length} 条合成配置行 · ${state.rows.filter(visible).length} 条可见 · ${m.mode==='adjustment'?'价格调整':'市场讨论'} · 草稿修订 ${m.revision}`;
 $('selection').textContent=`已选 ${m.selected.length} 行（仅可见行进入编辑范围）`;
 $('filters').replaceChildren(...Object.entries(filterLabels).map(([key,label])=>{const l=el('label',label),s=el('select');s.id='filter-'+key;s.setAttribute('aria-label',label);let options=['',...new Set(state.rows.map(r=>r[key]).filter(x=>x!==null))];s.replaceChildren(...options.map(v=>{const o=el('option',v||'全部');o.value=v;o.selected=(m.filters[key]||'')===v;return o;}));s.onchange=()=>{const next={...m.filters,[key]:s.value};if(key==='currency'||key==='unit'){next.price_min='';next.price_max='';}return act('view',{selected:m.selected,filters:next});};l.append(s);return l;}));
 $('priceMin').value=m.filters.price_min||'';$('priceMax').value=m.filters.price_max||'';
 if(!(typeof Workbench!=='undefined'&&Workbench.renderMatrix(state))){
 $('rows').replaceChildren(...state.rows.filter(visible).map(r=>{
 const tr=el('tr');tr.dataset.row=r.id;if(m.selected.includes(r.id))tr.className='selected';
 let td=el('td'),check=el('input');check.type='checkbox';check.checked=m.selected.includes(r.id);check.setAttribute('aria-label','选中 '+r.id);check.onchange=()=>act('view',{selected:check.checked?[...m.selected,r.id]:m.selected.filter(x=>x!==r.id),filters:m.filters});td.append(check);tr.append(td);
 td=el('td',r.family);td.append(el('small',r.configuration),el('small',r.id+' · '+(r.pn||'无PN · 配置身份明确')));tr.append(td);
 for(const text of [r.kind,r.market+' / '+r.application,r.role,r.tier||'未知',r.currency+' / '+r.unit])tr.append(el('td',text));
 tr.append(el('td',r.baseline??'缺失 / 不可用','number'));
 td=el('td');if(m.values[r.id]!==r.baseline)td.className='changed';const input=el('input'),unsent=inputsFor(m.id).get(r.id);input.className='price';input.value=unsent?unsent.value:(m.values[r.id]??'');input.inputMode='decimal';input.disabled=!m.selected.includes(r.id)||!!r.blocked;input.setAttribute('aria-label',r.id+' 拟调整价');
 const binding={input,matter:m.id,row:r,old:m.values[r.id]};renderedPrices.push(binding);input.oninput=()=>{rememberPrice(binding,true);if(m.fixture_set==='fictional-role-matrix-v1'&&typeof Workbench!=='undefined')Workbench.syncDraftConfirm();};
 input.onkeydown=async e=>{if(e.key==='Enter'){e.preventDefault();rememberPrice(binding);const draft=inputsFor(m.id).get(r.id);await act(m.fixture_set==='fictional-role-matrix-v1'?'draft_preview':'edit',{edits:[{id:r.id,old:draft?draft.old:m.values[r.id],new:input.value,scope:draft?draft.scope:scope(r)}]});}};
 td.append(input);if(unsent)td.append(el('small','未确认输入；按 Enter 提交。'));if(m.values[r.id]!==r.baseline)td.append(el('small',r.baseline+' → '+m.values[r.id]));tr.append(td);
 const delta=r.baseline!==null&&m.values[r.id]!==null?(Number(m.values[r.id])-Number(r.baseline)).toFixed(2):'不可比';tr.append(el('td',delta,'number'));
 td=el('td');const d=el('details');d.append(el('summary',r.blocked?'阻断 · 查看原因':'合成来源 / 条件'));for(const text of [r.source,r.effective,r.approval,r.conditions,r.blocked||r.risk])d.append(el('p',text));if(r.blocked)td.className='blocked';td.append(d);tr.append(td);return tr;
 }));
 }else $('rows').replaceChildren();
 if(typeof Workbench!=='undefined')Workbench.render(state);
 $('adjust').textContent=m.proposal?(m.fixture_set==='fictional-role-matrix-v1'?'预览建议修改范围':'采用建议并修改草稿'):'开始调整价格';
 $('context').textContent='模拟AI本轮范围：'+(m.selected.join('、')||'未选行')+'。输入最多30行及最近8条对话；不回灌全量历史。';
 $('conversation').replaceChildren(...m.conversation.map(x=>{const d=el('div',undefined,'message '+x.role);d.append(el('small',x.role+' · '+x.at),el('div',x.text));return d;}));$('conversation').scrollTop=$('conversation').scrollHeight;
 $('historyCount').textContent=`（${m.history.length} 条）`;$('history').replaceChildren(...[...m.history].reverse().map(h=>el('div',`修订 ${h.revision} · ${h.at} · ${h.actor}${h.undone?' · 已撤销':''}\n`+h.edits.map(e=>e.id+': '+e.old+' → '+e.new+' '+e.scope.currency+'/'+e.scope.unit).join('\n'),'history-entry')));
 const pending=Object.values(m.requests).filter(r=>r&&validPending(m,r.id));pendingToken=pending.length?pending[pending.length-1].id:null;
 $('finish').disabled=!pending.length;$('undo').disabled=m.fixture_set==='fictional-role-matrix-v1'||!m.history.some(h=>!h.undone&&h.actor!=='undo');
}
async function send(text){const sent=await act('ai_begin',{text});if(!sent)return;pendingToken=sent.token;$('message').value='';if(!$('delay').checked)await finish();}
async function finish(){const token=pendingToken;if(!token)return;const result=await act('ai_finish',{token});if(result&&result.matter.requests[token].status==='stale')status('迟到回应已阻断；没有覆盖新编辑。记录已保存。',true);}
$('reload').onclick=load;
$('matter').onchange=()=>{if(busy||loading||writeBlockReason||hasUnsubmittedPrices()){$('matter').value=state?state.matter.id:mid();status(writeBlockReason||'仍有未完成的操作或价格输入，请先确认后再切换事项。',true);return;}pendingToken=null;location.href='/?matter='+encodeURIComponent($('matter').value);};
$('newRound').onclick=async()=>{const title=prompt('新一轮合成事项标题（从合成基线开始，旧草稿不会变成当前依据）','合成演示 · 新决策轮');if(title){const r=await act('new_round',{title});if(r)location.href='/?matter='+encodeURIComponent(r.new_matter);}};
$('applyPriceRange').onclick=()=>act('view',{selected:state.matter.selected,filters:{...state.matter.filters,price_min:$('priceMin').value,price_max:$('priceMax').value}});
$('clearPriceRange').onclick=()=>act('view',{selected:state.matter.selected,filters:{...state.matter.filters,price_min:'',price_max:''}});
$('selectVisible').onclick=()=>act('view',{selected:state.rows.filter(visible).map(r=>r.id),filters:state.matter.filters});
$('clearSelection').onclick=()=>act('view',{selected:[],filters:state.matter.filters});
$('undo').onclick=()=>act('undo');$('adjust').onclick=()=>act('mode',{mode:'adjustment'});$('discuss').onclick=()=>act('mode',{mode:'discussion'});
$('applyBatch').onclick=async()=>{try{const edits=$('batch').value.trim().split('\n').map(line=>{const p=line.trim().split(/\s+/);if(p.length!==2)throw Error('每行需包含精确行号与金额。');const r=state.rows.find(r=>r.id===p[0]);if(!r)throw Error('未知行号 '+p[0]);return {id:r.id,old:state.matter.values[r.id],new:p[1],scope:scope(r)};});const result=await act(state.matter.fixture_set==='fictional-role-matrix-v1'?'draft_preview':'edit',{edits});if(result)$('batch').value='';}catch(e){error(e);}};
$('send').onclick=()=>send($('message').value);$('compare').onclick=()=>send('比较选中产品');$('finish').onclick=finish;$('duplicate').onclick=finish;
$('search').onclick=async()=>{try{const r=await fetch('/api/search?matter='+encodeURIComponent(state.matter.id)+'&q='+encodeURIComponent($('query').value));const results=await r.json();if(!r.ok)throw Error(results.error);$('searchResults').replaceChildren(...results.map(x=>{const d=el('div',undefined,'search-result');d.append(el('small',x.title+' · '+x.at+' · '+(x.historical?'旧轮次草稿，非当前价格':'当前事项')),el('div',x.text));return d;}));if(!results.length)$('searchResults').textContent='当前和关联上一轮已查范围内未找到。';}catch(e){error(e);}};
load();

