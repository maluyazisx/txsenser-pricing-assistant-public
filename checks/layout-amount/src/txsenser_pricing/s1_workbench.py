"""Fictional workbench scenarios; data lives only in the existing S1 matter JSON.

Not a real customer/quote authority. No network, business source or AI calls.
"""
import copy
from decimal import Decimal
import hashlib
import json
import re
import uuid

CATALOG_ID = 'fictional-role-matrix-v1'
DEMO_MATTER = 'demo-workbench-v1'
CUSTOMERS = {'DEMO-C-A': '虚构客户 A', 'DEMO-C-B': '虚构客户 B'}
PROJECTS = {'DEMO-P-A': '虚构项目 Alpha', 'DEMO-P-B': '虚构项目 Beta'}
LEGACY_ROLES = ('指导', '直销', '经销', 'OEM')
ROLES = LEGACY_ROLES + ('代理', '出厂', '大客户权限')
PRICE_TYPE_ORDER = ('指导', '直销', '经销', '代理', 'OEM', '大客户权限', '出厂')
PRICE_TYPE_LABELS = {'指导':'指导价', '直销':'直销底价', '经销':'经销底价', '代理':'代理底价',
                     'OEM':'OEM底价', '大客户权限':'大客户权限价', '出厂':'出厂价'}
CONDITIONS = ('标准演示条件', '附加条件待确认')
CORRECTION_REASONS = ('更正录入金额', '更正数量', '更正演示条件')
TERM_FIELDS = ('customer_id', 'project_id', 'product_id', 'market', 'application', 'role',
               'quantity', 'currency', 'unit', 'conditions')
TERM_LABELS = dict(zip(TERM_FIELDS, ('客户', '项目', '产品配置', '市场', '应用', '价格类型', '数量', '币种', '单位', '商业条件')))
OPS = ('inquiry', 'quote_preview', 'quote_cancel', 'quote_confirm', 'draft_preview', 'draft_cancel', 'draft_confirm')


class WorkbenchRejected(ValueError):
    pass


def matrix_fixtures():
    rows = []
    # Explicit invented scenarios, not a pricing formula or company price system.
    scenarios = [
        ('DEMO-LUMEN', '虚构 Lumen', '标准配置 / 有线', '整机', '国内', 'CNY', '台', '1–9', 1, 9, ('2200', '2050', '1900', None)),
        ('DEMO-VEGA', '虚构 Vega', '标准配置 / 无线', '整机', '国内', 'CNY', '台', '1–9', 1, 9, ('2600', '2500', None, '2100')),
        ('DEMO-LUMEN', '虚构 Lumen', '标准配置 / 有线', '整机', '国际', 'USD', '台', '1–9', 1, 9, ('350', '330', '300', '280')),
        ('DEMO-LUMEN', '虚构 Lumen', '标准配置 / 有线', '整机', '国际', 'USD', '台', '10–49', 10, 49, (None, '310', '280', '260')),
        ('DEMO-VEGA', '虚构 Vega', '标准配置 / 无线', '整机', '国际', 'EUR', '台', '1–9', 1, 9, ('400', '380', '355', '330')),
        ('DEMO-CORE', '虚构 Core', '组件配置 / 标准', '组件参考', '国内', 'CNY', '件', '1–9', 1, 9, ('800', '750', '700', None)),
    ]
    for group, (pid, family, config, kind, market, currency, unit, tier, lower, upper, prices) in enumerate(scenarios, 1):
        for position, role in enumerate(ROLES, 1):
            value = prices[LEGACY_ROLES.index(role)] if role in LEGACY_ROLES else None
            unavailable = value is None
            reason = ('本虚构场景不适用经销角色' if pid == 'DEMO-VEGA' and role == '经销'
                      else '待正式来源提供该价格类型') if unavailable else ''
            rows.append(dict(id=f'MX-{group:02}-{position}', product_id=pid, family=family,
                kind=kind, configuration=config, pn=pid, market=market, application='通用工业',
                role=role, tier=tier, min_quantity=lower, max_quantity=upper, currency=currency,
                unit=unit, baseline=f'{Decimal(value):.2f}' if value is not None else None,
                source='原创虚构角色样本 v1', source_status='missing' if unavailable else 'synthetic_available',
                effective='虚构场景；非正式有效期', approval='未批准／不可用于真实报价',
                conditions='标准演示条件；税、运输与成本未建模', risk=reason,
                quote_eligible=role not in ('指导', '出厂')))
    return rows


MATRIX_ROWS = matrix_fixtures()
LEGACY_MATRIX_ROWS = [row for row in MATRIX_ROWS if row['role'] in LEGACY_ROLES]


def latest_records(history):
    current = {}
    for record in history:
        if record.get('phase') == 'quoted_demo':
            old = current.get(record['id'])
            if old is None or record['version'] > old['version']:
                current[record['id']] = record
    return list(current.values())


def analyze(terms, rows, history):
    if not isinstance(terms, dict) or any(key not in TERM_FIELDS for key in terms):
        raise WorkbenchRejected('询价条件格式无效。')
    clean = {key: terms.get(key, '') for key in TERM_FIELDS}
    if any(not isinstance(value, str) or len(value) > (1000 if key=='conditions' else 100) for key,value in clean.items()):
        raise WorkbenchRejected('仅接受屏幕列出的虚构条件。')
    missing = [TERM_LABELS[key] for key, value in clean.items() if not value]
    result = dict(terms=clean, status='NEEDS_INFO', missing=missing, references=[], history=[],
                  reason='请补齐标出的条件。', simulated=True)
    private_copy = any(row.get('provenance_kind')=='private_source_copy' for row in rows)
    allowed = {'customer_id': CUSTOMERS, 'project_id': PROJECTS, 'conditions': {r['conditions'] for r in rows if isinstance(r.get('conditions'),str)} if private_copy else CONDITIONS,
               'product_id': {row['product_id'] for row in rows}, 'role': ROLES,
               'market': {row['market'] for row in rows}, 'application': {row['application'] for row in rows},
               'currency': {row['currency'] for row in rows}, 'unit': {row['unit'] for row in rows}}
    if any(clean[key] and clean[key] not in values for key, values in allowed.items()):
        raise WorkbenchRejected('条件不属于本次虚构演示范围；不接收真实客户或项目。')
    if clean['quantity'] and not re.fullmatch(r'[1-9]\d{0,4}', clean['quantity']):
        raise WorkbenchRejected('请输入1–99999的整数数量。')
    if missing:
        return result
    quantity = int(clean['quantity'])
    candidates = [row for row in rows if type(row.get('min_quantity')) is int and type(row.get('max_quantity')) is int and all(row[key] == clean[key] for key in
        ('product_id', 'market', 'application', 'role', 'currency', 'unit')) and
        row['min_quantity'] <= quantity <= row['max_quantity']]
    relevant = [r for r in latest_records(history) if r['terms']['product_id'] == clean['product_id']]
    relevant.sort(key=lambda r: (r['terms']['customer_id'] == clean['customer_id'],
                               r['terms']['project_id'] == clean['project_id'], r['at']), reverse=True)
    for record in relevant[:3]:
        differences = [f"{TERM_LABELS[k]}：历史 {record['terms'][k]} → 本次 {clean[k]}" for k in TERM_FIELDS if record['terms'][k] != clean[k]]
        result['history'].append(dict(id=record['id'], version=record['version'], at=record['at'],
            amount=record['amount'], currency=record['terms']['currency'], unit=record['terms']['unit'],
            differences=differences, reason='条件一致，可参考该次报价。' if not differences else '条件不同，仅作参考，不自动沿用金额。',
            warning='已报价不等于接受或成交；历史不是正式价。'))
    if len(candidates) != 1 or candidates[0]['baseline'] is None or candidates[0]['source_status'] != 'synthetic_available':
        result.update(status='BLOCKED', reason=candidates[0]['risk'] if len(candidates) == 1 else '暂无唯一匹配价格，请核对产品、市场、数量档和币种。')
        return result
    row = candidates[0]
    result['references'] = [dict(id=row['id'], product_id=row['product_id'], configuration=row['configuration'],
        amount=row['baseline'], role=row['role'], tier=row['tier'], currency=row['currency'], unit=row['unit'],
        source=row['source'], approval=row['approval'], conditions=row['conditions'])]
    if row.get('quote_eligible') is False:
        result.update(status='NEEDS_CONFIRMATION', reason='此价格类型仅作参考，不能直接用于报价。')
        return result
    conditions_match = clean['conditions']==row['conditions'] if private_copy else clean['conditions']=='标准演示条件'
    result.update(status='AVAILABLE_DEMO' if conditions_match else 'NEEDS_CONFIRMATION',
        reason='已有适用参考，可核对后准备报价。' if conditions_match
               else '附加商业条件尚未确认；不能把参考价当作适用报价。')
    return result


def prepare_quote(matter, request, history, normalize, rows=None):
    analysis = analyze(request.get('terms'), MATRIX_ROWS if rows is None else rows, history)
    if analysis['status'] != 'AVAILABLE_DEMO':
        raise WorkbenchRejected(analysis['reason'])
    value = normalize(request.get('amount'))
    quote_id = request.get('quote_id')
    old_version = 0
    reason = request.get('reason', '')
    if quote_id:
        old = next((r for r in latest_records(matter.get('quote_records', [])) if r['id'] == quote_id), None)
        if old is None or request.get('expected_version') != old['version']:
            raise WorkbenchRejected('待更正记录不存在或版本已变化；请重新载入。')
        if reason not in CORRECTION_REASONS:
            raise WorkbenchRejected('请选择更正原因。')
        old_version = old['version']
    else:
        quote_id = 'DEMO-Q-' + uuid.uuid4().hex[:12]
        reason = ''
    payload = dict(id=quote_id, previous_version=old_version, terms=copy.deepcopy(analysis['terms']),
        amount=value, reference=copy.deepcopy(analysis['references'][0]), reason=reason,
        historical_references=copy.deepcopy(analysis['history']), phase='quoted_demo')
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    matter['quote_preview'] = dict(token=uuid.uuid4().hex, prepared_version=matter['version'] + 1,
        digest=digest, payload=payload)
    return dict(quote_preview=copy.deepcopy(matter['quote_preview']))


def replay_quote(matter, request):
    if request.get('op') != 'quote_confirm':
        return None
    receipt = matter.get('quote_receipts', {}).get(request.get('token'))
    if not receipt:
        return None
    if request.get('acknowledged') is not True:
        raise WorkbenchRejected('请先明确确认这是虚构的已报出报价。')
    if request['request_id'] in matter['seen'] and request['request_id'] != receipt['request_id']:
        raise WorkbenchRejected('请求标识已用于不同操作。')
    return dict(record=copy.deepcopy(receipt['record']), duplicate=True, original_request_id=receipt['request_id'])


def confirm_quote(matter, request, timestamp):
    preview = matter.get('quote_preview')
    if request.get('acknowledged') is not True or not preview or request.get('token') != preview['token']:
        raise WorkbenchRejected('报价预览无效；需明确确认，不能自动入历史。')
    if preview['prepared_version'] != matter['version']:
        raise WorkbenchRejected('确认前状态已变化；请重新预览。')
    payload = copy.deepcopy(preview['payload'])
    latest = next((r for r in latest_records(matter.get('quote_records', [])) if r['id'] == payload['id']), None)
    version = latest['version'] if latest else 0
    if version != payload['previous_version']:
        raise WorkbenchRejected('报价版本已变化；请重新预览。')
    record = dict(payload, version=version + 1, at=timestamp, request_id=request['request_id'], token=preview['token'])
    matter.setdefault('quote_records', []).append(record)
    matter.setdefault('quote_receipts', {})[preview['token']] = dict(request_id=request['request_id'], record=copy.deepcopy(record))
    matter['quote_preview'] = None
    return dict(record=copy.deepcopy(record))

