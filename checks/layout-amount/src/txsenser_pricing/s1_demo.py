"""S1 isolated synthetic-only demo. No C1 price inputs, external providers or publication."""
from __future__ import annotations
import argparse
import copy
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit
import uuid

from .s1_inquiry_read import (InquiryRejected, analyze_reference, normalize_terms, history_state,
                            select_history_reference, history_reference_state)
from .s1_workbench import (CATALOG_ID, DEMO_MATTER, MATRIX_ROWS, LEGACY_MATRIX_ROWS, CUSTOMERS, PROJECTS, ROLES, PRICE_TYPE_ORDER, PRICE_TYPE_LABELS, CONDITIONS, OPS,
    WorkbenchRejected, analyze, prepare_quote, confirm_quote, replay_quote)

MARKER = 'TXSENSER_S1_SYNTHETIC_ONLY_V1'
PRIVATE_COPY_MARKER = 'TXSENSER_PRICING_PRIVATE_EXPERIENCE_V1'
STATIC = Path(__file__).with_name('s1_static')
FIELDS = ('family', 'kind', 'configuration', 'pn', 'market', 'application', 'role', 'tier', 'currency', 'unit')
CATEGORY_FILTERS = ('family', 'kind', 'market', 'application', 'role', 'tier', 'currency', 'unit')
FILTERS = CATEGORY_FILTERS + ('price_min', 'price_max', 'price_types')


class Rejected(Exception):
    pass


class CommittedUnconfirmed(Rejected):
    """COMMIT succeeded, but the independent readback could not confirm state."""
    def __init__(self, request_id, result):
        super().__init__('变更已提交，但保存结果尚未核对；请重新载入核对，不要重复提交。')
        self.request_id = request_id
        self.result = dict(result)


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def amount(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{1,9}(?:\.\d{1,2})?', value):
        raise Rejected('请输入非负金额，最多两位小数；不接受公式、指数或缺失值。')
    try:
        return f'{Decimal(value):.2f}'
    except InvalidOperation as e:
        raise Rejected('金额无效。') from e


def fixtures():
    """Invented values only, unrelated to company prices or pricing rules."""
    rows = []
    for i in range(24):
        family = ('合成 Aurora', '合成 Boreal', '合成 Cirrus')[i // 8]
        rows.append(dict(id=f'SYN-{i+1:02}', family=family,
            kind='组件参考' if i % 4 == 3 else '整机',
            configuration=f'演示配置 {i // 2 + 1} / '+('有线' if i % 2 == 0 else '无线'),
            pn=None if i % 5 == 0 else f'DEMO-PN-{i+1:02}',
            market='国际' if i % 3 else '国内', application='矿业' if i % 4 == 2 else '通用工业',
            role=('经销', '终端', 'OEM')[i % 3], tier='1–9' if i % 2 == 0 else '10–49',
            currency='CNY' if i % 3 == 0 else ('EUR' if i % 7 == 0 else 'USD'),
            unit='件' if i % 4 == 3 else '台', baseline=f'{1000 + i*37}.00',
            source='合成固定样本 S1-v1', source_status='synthetic_available',
            effective='演示轮次 2026；非正式有效期', approval='未批准／不可报价',
            conditions='税、运费、选配：未知；无自动换算', risk='仅合成演示；组件不替代整机价' if i % 4 == 3 else '仅合成演示'))
    for status, label in [('unavailable','来源不可读取'), ('missing','真正缺价'), ('conflict','同范围来源冲突'), ('unknown_tier','数量档未知')]:
        r = copy.deepcopy(rows[0]); r.update(id=f'SYN-{len(rows)+1:02}', configuration=label, pn=None,
            source_status=status, risk=label, baseline=None if status != 'unknown_tier' else '1400.00')
        if status == 'unknown_tier': r['tier'] = None
        rows.append(r)
    for n in range(2):
        r = copy.deepcopy(rows[1]); r.update(id=f'SYN-{len(rows)+1:02}', configuration='重复身份演示', pn='DEMO-DUPLICATE', risk='重复身份，禁止写入')
        rows.append(r)
    return rows


ROWS = fixtures()
ROW_BY_ID = {r['id']: r for r in ROWS}


def identity(row):
    return tuple(row[k] for k in FIELDS)


def blocked(row, rows=None):
    rows = ROWS if rows is None else rows
    if row['source_status'] != 'synthetic_available':
        if row.get('provenance_kind') == 'private_source_copy':
            return (row.get('risk') or '适用条件待确认') + '；暂不能调整价格。'
        return row['risk'] + '；请补齐该范围的合成来源/档位后再编辑。'
    if any(row[k] is None for k in FIELDS if k != 'pn'):
        return '范围不完整；请明确缺失字段。'
    if sum(identity(r) == identity(row) for r in rows) != 1:
        return '身份重复；请明确唯一配置/PN及范围。'
    return None


def private_draft_blocked(row, rows, matter):
    reason = blocked(row, rows)
    if matter.get('data_kind') != 'private_experience': return reason
    if row.get('copy_editable') is not True or matter.get('persona') != 'ceo':
        return '当前权限仅可查看此价格，不能调整体验草稿。'
    if reason is None: return None
    if row.get('provenance_kind') != 'private_source_copy' or row.get('baseline') is None:
        return reason
    if not all(row.get(key) for key in ('id', 'product_id', 'family', 'kind', 'configuration')):
        return reason
    if sum(identity(other) == identity(row) for other in rows) != 1: return reason
    return None  # Only the explicitly confirmed, isolated CEO draft path may use this.


def validate_filters(filters):
    if not isinstance(filters, dict) or any(k not in FILTERS or (k != 'price_types' and not isinstance(v, str)) for k,v in filters.items()):
        raise Rejected('筛选无效。')
    result=dict(filters)
    if 'price_types' in result:
        roles=result['price_types']
        if not isinstance(roles,list) or any(not isinstance(x,str) or x not in PRICE_TYPE_ORDER for x in roles) or len(set(roles))!=len(roles):
            raise Rejected('请选择有效且不重复的价格列。')
        result['price_types']=[x for x in PRICE_TYPE_ORDER if x in roles]
    if result.get('price_min') or result.get('price_max'):
        if result.get('currency') not in ('USD','CNY','EUR') or result.get('unit') not in ('台','件'):
            raise Rejected('价格范围需要明确一个币种和单位；不做混合币种比较或换算。')
        for key in ('price_min','price_max'):
            if result.get(key): result[key]=amount(result[key])
        if result.get('price_min') and result.get('price_max') and Decimal(result['price_min'])>Decimal(result['price_max']):
            raise Rejected('价格范围下限不能大于上限；筛选未保存。')
    return result


def visible(row, filters):
    if 'price_types' in filters and row['role'] not in filters['price_types']: return False
    if not all(not filters.get(k) or row[k] == filters[k] for k in CATEGORY_FILTERS): return False
    lower,upper=filters.get('price_min'),filters.get('price_max')
    if lower or upper:
        if row['baseline'] is None: return False
        value=Decimal(row['baseline'])
        if lower and value<Decimal(lower): return False
        if upper and value>Decimal(upper): return False
    return True


def new_matter(mid, title, parent=None, fixture_set=None):
    rows = MATRIX_ROWS if fixture_set == CATALOG_ID else ROWS
    matter = dict(id=mid, title=title, parent=parent, created=now(), status='DRAFT / 合成未批准',
        version=0, revision=0, values={r['id']: r['baseline'] for r in rows},
        selected=[], filters={}, conversation=[], history=[], requests={}, seen=[], mode='discussion', proposal=None, generation=0)
    if fixture_set == CATALOG_ID:
        matter.update(fixture_set=CATALOG_ID, catalog_revision=2, quote_records=[], quote_receipts={}, quote_preview=None, draft_preview=None, inquiry=None)
    return matter


def catalog(matter):
    if matter.get('private_rows') is not None: return matter['private_rows']
    if matter.get('fixture_set') != CATALOG_ID: return ROWS
    return MATRIX_ROWS if matter.get('catalog_revision') == 2 else LEGACY_MATRIX_ROWS


class OfflineProvider:
    """Replacement seam. Output never creates authorization; service parses user intent."""
    available = True
    def respond(self, context):
        if not self.available:
            raise Rejected('模拟AI不可用；已保存草稿与原始对话仍可读取。')
        selected = context['selected']
        details = '；'.join(f"{r['id']} {r['configuration']}：{r['draft']} {r['currency']}/{r['unit']}，{r['role']}，{r['tier']}" for r in selected)
        return '模拟分析（非真实语言理解）：' + (details or '请先选入要比较的合成行。') + '。各范围独立比较，不汇总混合币种/单位；不修改草稿。'


def private_rule_reply(context):
    rows = context['selected']
    if not rows:
        return '规则辅助：请先选择具体价格，再点“比较选中价格”。不会自动修改价格。'
    lines = ['规则辅助：以下按当前选中价格逐项列出，不自动改价。']
    def shown(raw):
        return '待确认' if raw is None else format(Decimal(raw).quantize(Decimal('1'), rounding=ROUND_HALF_UP), ',f')
    for row in rows:
        role = PRICE_TYPE_LABELS.get(row['role'], row['role'])
        lines.append(f"{row['family']} · {row['configuration']} · {role}：本方案已保存价 {shown(row.get('draft'))}；来源参考 {shown(row.get('baseline'))} {row.get('currency') or '币种待确认'}/{row.get('unit') or '单位待确认'}。")
    lines.append('币种、单位和适用条件分别核对；批量采购请与公司另议，不自动套用数量折扣。')
    return '\n'.join(lines)


class Store:
    def __init__(self, path, provider=None, recover_pending=True, matrix_demo=False, experience=None, history_reader=None):
        self.marker = PRIVATE_COPY_MARKER if experience is not None else MARKER
        if experience is not None and experience.get('persona') not in ('ceo','sales_director','sales_admin','sales'):
            raise Rejected('查看身份未识别；未打开或修改体验库。')
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.exists():
            try:
                with sqlite3.connect(f'file:{self.path.resolve()}?mode=ro',uri=True) as existing:
                    if existing.execute('SELECT marker FROM meta').fetchall() != [(self.marker,)]:
                        raise Rejected('非S1合成存储，拒绝打开。')
                    if experience is not None:
                        copy_id = 'experience-' + experience['copy_sha256'][:16]
                        payload = existing.execute('SELECT payload FROM matters WHERE id=?', (copy_id,)).fetchone()
                        previous = json.loads(payload[0]) if payload else None
                        if not isinstance(previous, dict) or previous.get('data_kind') != 'private_experience' or previous.get('copy_sha256') != experience['copy_sha256'] or previous.get('persona') != experience['persona'] or previous.get('private_rows') != experience['rows']:
                            raise Rejected('本次副本或查看身份与已有体验库不匹配；原库已保留，请使用对应独立库。')
            except (sqlite3.Error, json.JSONDecodeError) as e:
                raise Rejected('无法验证S1合成存储标记；拒绝修改。') from e
        self.provider = provider or OfflineProvider()
        self.history_reader = history_reader  # Explicit read-only injection; no default real binding.
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS meta (marker TEXT NOT NULL)')
            marker = db.execute('SELECT marker FROM meta').fetchall()
            if not marker: db.execute('INSERT INTO meta VALUES (?)', (self.marker,))
            elif marker != [(self.marker,)]: raise Rejected('存储身份不匹配，拒绝打开。')
            db.execute('CREATE TABLE IF NOT EXISTS matters (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            if not db.execute('SELECT 1 FROM matters').fetchone():
                self.write(db, new_matter('demo-2026', '合成演示 · 第一轮'))
            if matrix_demo:
                if not db.execute('SELECT 1 FROM matters WHERE id=?', (DEMO_MATTER,)).fetchone():
                    self.write(db, new_matter(DEMO_MATTER, '价格总览', fixture_set=CATALOG_ID))
                elif self.read(db, DEMO_MATTER).get('fixture_set') != CATALOG_ID:
                    raise Rejected('演示事项身份不匹配，拒绝覆盖。')
            if experience is not None:
                copy_id = 'experience-' + experience['copy_sha256'][:16]
                if not db.execute('SELECT 1 FROM matters WHERE id=?', (copy_id,)).fetchone():
                    m = new_matter(copy_id, '价格体验副本', fixture_set=CATALOG_ID)
                    m.update(private_rows=copy.deepcopy(experience['rows']), values={r['id']:r['baseline'] for r in experience['rows']},
                             data_kind='private_experience', copy_sha256=experience['copy_sha256'], persona=experience['persona'])
                    self.write(db, m)
            # A process restart never resumes a pending model response silently.
            for (payload,) in db.execute('SELECT payload FROM matters').fetchall():
                m = json.loads(payload); changed = False
                for req in m['requests'].values():
                    if recover_pending and req['status'] == 'pending':
                        req['status'] = 'interrupted'; changed = True
                        m['conversation'].append(dict(at=now(), role='system', text='上次模拟生成已中断；未应用任何新草稿修改。', request=req['id']))
                if changed: m['version'] += 1; self.write(db, m)
        self.path.chmod(0o600)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute('PRAGMA synchronous=FULL')
        db.execute('PRAGMA foreign_keys=ON')
        return db

    @staticmethod
    def write(db, matter):
        db.execute('INSERT OR REPLACE INTO matters VALUES (?,?)', (matter['id'], json.dumps(matter, ensure_ascii=False)))

    @staticmethod
    def read(db, mid):
        result = db.execute('SELECT payload FROM matters WHERE id=?', (mid,)).fetchone()
        if not result: raise Rejected('事项不存在，拒绝跨事项操作。')
        return json.loads(result[0])

    @staticmethod
    def workbench_history(db):
        history = []
        for (payload,) in db.execute('SELECT payload FROM matters'):
            matter = json.loads(payload)
            if matter.get('fixture_set') == CATALOG_ID:
                history.extend(dict(copy.deepcopy(record), matter_id=matter['id']) for record in matter.get('quote_records', []))
        return history

    def state(self, mid):
        with self.connect() as db:
            m = self.read(db, mid)
            if m.get('data_kind') == 'private_experience' and m.get('persona') != 'ceo':
                # Defense in depth for the new fields: do not expose CEO history
                # identities/context through a non-CEO read projection.
                m.pop('history_reference', None)
                m.pop('previous_history_references', None)
            summaries = [dict(id=x['id'], title=x['title'], parent=x['parent'], created=x['created']) for x in [json.loads(p) for (p,) in db.execute('SELECT payload FROM matters')]]
            history = self.workbench_history(db) if m.get('fixture_set') == CATALOG_ID and m.get('data_kind') != 'private_experience' else []
        rows = catalog(m)
        result = dict(marker=self.marker, matter=m, matters=summaries,
            rows=[dict(r, blocked=private_draft_blocked(r, rows, m), quote_blocked=blocked(r, rows),
                experience_draft_only=m.get('data_kind')=='private_experience' and blocked(r, rows) is not None and private_draft_blocked(r, rows, m) is None) for r in rows], visible_ids=[r['id'] for r in rows if visible(r,m['filters'])], provider='offline-deterministic-mock')
        if m.get('fixture_set') == CATALOG_ID:
            products = {r['product_id']: dict(id=r['product_id'], label=r['family']+' / '+r['configuration']) for r in rows}
            private = m.get('data_kind') == 'private_experience'
            result.update(workbench_history=history, workbench=dict(customers={} if private else CUSTOMERS, projects={} if private else PROJECTS,
                products=list(products.values()), roles=[role for role in PRICE_TYPE_ORDER if any(r['role']==role for r in rows)],
                price_type_labels=PRICE_TYPE_LABELS, conditions=sorted({r['conditions'] for r in rows if isinstance(r.get('conditions'),str) and r['conditions']}) if m.get('data_kind')=='private_experience' else CONDITIONS))
            if private:
                request = m.get('inquiry_request')
                reader = self.history_reader if m.get('persona') == 'ceo' else None
                checked_as_of = now()  # Recheck now; the saved inquiry's original time is retained.
                result['inquiry_read'] = (analyze_reference(request['terms'], rows,
                    as_of=checked_as_of, history_reader=reader) if request else None)
                result['history_connection'] = (result['inquiry_read']['history'] if result['inquiry_read'] else
                    history_state('not_connected' if reader is None else 'identity_unresolved'))
                result['history_reference'] = history_reference_state(request,
                    m.get('history_reference'), result['history_connection'], checked_as_of)
        return result

    def context(self, m):
        by_id = {r['id']: r for r in catalog(m)}
        selected = [dict(by_id[rid], draft=m['values'][rid]) for rid in m['selected'] if visible(by_id[rid], m['filters'])]
        return dict(matter=m['id'], revision=m['revision'], selected=selected, filters=m['filters'], recent=m['conversation'][-8:])

    def checked_edits(self, m, edits, private_draft=False):
        rows = catalog(m); by_id = {r['id']: r for r in rows}
        if not isinstance(edits, list) or not 1 <= len(edits) <= len(rows): raise Rejected(f'需要1–{len(rows)}条精确行编辑。')
        checked = []; ids = set()
        for position, edit in enumerate(edits, 1):
            rid = edit.get('id'); row = by_id.get(rid)
            if not row or rid in ids: raise Rejected('行不存在或批次含重复行；整批未保存。')
            ids.add(rid)
            if rid not in m['selected'] or not visible(row, m['filters']): raise Rejected(f'{rid} 不在当前已选且可见范围；整批未保存。')
            reason = private_draft_blocked(row, rows, m) if private_draft else blocked(row, rows)
            if row.get('copy_editable') is False: raise Rejected('此权限只能查看价格，不能调整标准价格。')
            if reason: raise Rejected(f'{rid}：{reason} 整批未保存。')
            if edit.get('scope') != {k: row[k] for k in FIELDS}: raise Rejected(f'{rid} 范围不匹配；整批未保存。')
            if edit.get('old') != m['values'][rid]: raise Rejected(f'{rid} 旧值已变化；刷新后重试。')
            try:
                new_value = amount(edit.get('new'))
            except Rejected as e:
                raise Rejected(f'第{position}行（{rid}）：{e} 整批未保存。') from e
            checked.append(dict(id=rid, old=m['values'][rid], new=new_value, scope=edit['scope']))
        return checked

    def edits(self, m, edits, actor, private_draft=False):
        checked = self.checked_edits(m, edits, private_draft=private_draft)
        for e in checked: m['values'][e['id']] = e['new']
        m['revision'] += 1
        m['history'].append(dict(revision=m['revision'], at=now(), actor=actor, edits=checked, undone=False))

    def preview_draft(self, m, edits):
        checked = self.checked_edits(m, edits, private_draft=True)
        m['draft_preview'] = dict(token=uuid.uuid4().hex, prepared_version=m['version'] + 1,
            revision=m['revision'], selected=m['selected'][:], filters=copy.deepcopy(m['filters']),
            generation=m['generation'], edits=checked)
        return copy.deepcopy(m['draft_preview'])

    def action(self, req):
        if not isinstance(req, dict): raise Rejected('请求必须是对象。')
        mid, op, request_id = req.get('matter'), req.get('op'), req.get('request_id')
        if not isinstance(request_id, str) or not re.fullmatch('[a-zA-Z0-9-]{1,80}', request_id): raise Rejected('缺少有效请求标识。')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            m = self.read(db, mid)
            rows = catalog(m); by_id = {r['id']: r for r in rows}
            if m.get('data_kind') == 'private_experience' and op in ('quote_preview', 'quote_confirm'):
                raise Rejected('私有询价仅作来源参考，不能在体验库保存已报价记录。')
            if m.get('fixture_set') == CATALOG_ID:
                try:
                    replay = replay_quote(m, req)
                except WorkbenchRejected as e:
                    raise Rejected(str(e)) from e
                if replay:
                    db.rollback()
                    try:
                        return dict(self.state(mid), saved=True, request_id=request_id, **replay)
                    except Exception as e:
                        raise CommittedUnconfirmed(request_id, replay) from e
            if request_id in m['seen']: raise Rejected('重复请求已阻断；不会再次应用。')
            if req.get('version') != m['version']: raise Rejected('并发版本冲突；未保存。请重新载入最新事项。')
            result = {}
            if op == 'view':
                selected, filters = req.get('selected'), req.get('filters')
                if not isinstance(selected, list) or len(set(selected)) != len(selected) or any(x not in by_id for x in selected): raise Rejected('选择包含未知或重复行。')
                filters=validate_filters(filters)
                # Never silently keep hidden selected rows in the editing scope.
                m['filters'] = filters; m['selected'] = [x for x in selected if visible(by_id[x], filters)]
            elif op == 'edit':
                if m.get('fixture_set') == CATALOG_ID: raise Rejected('横向工作台需先预览范围，再明确确认草稿。')
                self.edits(m, req.get('edits'), 'manual')
            elif op == 'undo':
                if m.get('fixture_set') == CATALOG_ID: raise Rejected('请通过预览修改恢复草稿金额，不能跳过确认。')
                h = next((x for x in reversed(m['history']) if not x['undone'] and x['actor'] != 'undo'), None)
                if h is None: raise Rejected('没有可撤销的修改。')
                if any(m['values'][e['id']] != e['new'] for e in h['edits']): raise Rejected('当前值与历史不一致，拒绝撤销。')
                reverse = [dict(e, old=e['new'], new=e['old']) for e in h['edits']]
                for e in reverse: m['values'][e['id']] = e['new']
                h['undone'] = True; m['revision'] += 1
                m['history'].append(dict(revision=m['revision'], at=now(), actor='undo', edits=reverse, undone=False))
            elif op == 'mode':
                if req.get('mode') not in ('discussion','adjustment'): raise Rejected('模式无效。')
                if req['mode'] == 'adjustment' and m.get('proposal'):
                    proposal=m['proposal']
                    if proposal.get('generation') != m.get('generation',0) or proposal['revision'] != m['revision'] or proposal['selected'] != m['selected'] or proposal['filters'] != m['filters']:
                        raise Rejected('建议已过期；请按最新草稿和范围重新讨论。')
                    if m.get('fixture_set') == CATALOG_ID:
                        result['draft_preview'] = self.preview_draft(m, proposal['edits'])
                    else:
                        self.edits(m, proposal['edits'], 'explicit_start_adjustment')
                    m['proposal']=None
                m['mode'] = req['mode']
            elif op == 'ai_begin':
                raw = req.get('text')
                if not isinstance(raw, str) or not raw.strip() or len(raw) > 4000: raise Rejected('对话需为1–4000字。')
                context = self.context(m)
                # Exact anchored grammar is disclosed in the UI; external model text cannot authorize.
                match = re.fullmatch(r'仅将选中行拟调价增加 ([0-9]{1,9}(?:\.[0-9]{1,2})?) (USD|CNY|EUR)/(台|件)', raw)
                suggestion = re.fullmatch(r'讨论建议：将选中行拟调价设为 ([0-9]{1,9}(?:\.[0-9]{1,2})?) (USD|CNY|EUR)/(台|件)', raw)
                edits = []; proposal_edits = []; blocked_answer = None
                try:
                    if raw.startswith('仅将选中行拟调价') and not match:
                        raise Rejected('明确编辑缺少准确金额/币种/单位或格式不匹配；请使用屏幕上的完整句式。')
                    if match or suggestion:
                        value, currency, unit = (match or suggestion).groups()
                        if not context['selected']: raise Rejected('请先选择精确行。')
                        if any(r['currency'] != currency or r['unit'] != unit for r in context['selected']): raise Rejected('币种/单位不一致；请筛选同一币种与单位。未换算，整批未保存。')
                        targets=[]
                        for r in context['selected']:
                            if blocked(r, rows): raise Rejected(f"{r['id']}：{blocked(r, rows)}")
                            new_value=amount(str(Decimal(r['draft'])+Decimal(value))) if match else amount(value)
                            targets.append(dict(id=r['id'], old=r['draft'], new=new_value, scope={k:r[k] for k in FIELDS}))
                        if match and m.get('fixture_set') != CATALOG_ID: edits=targets
                        else: proposal_edits=targets
                    answer = self.provider.respond(context)
                    if m.get('data_kind') == 'private_experience': answer = private_rule_reply(context)
                    if raw.startswith('检索原文 '):
                        excerpts=self.search(mid,raw[len('检索原文 '):])
                        answer='模拟原文检索（当前与关联上一轮，最多30条）：\n'+'\n'.join(f"{e['at']} [{e['matter']}; {'旧轮次草稿，非当前价' if e['historical'] else '当前事项'}] {e['text']}" for e in excerpts)
                        if not excerpts: answer+='已查范围内未找到；不推断其他事项不存在记录。'
                    if m.get('fixture_set') == CATALOG_ID and (match or suggestion): answer='调整建议已准备，价格尚未改变；请预览范围并确认后保存。'
                    elif suggestion: answer='仅讨论的合成建议已准备；草稿金额未变。主动点击“开始调整价格”才按当前精确范围采纳。'
                except Rejected as e:
                    edits=[]; proposal_edits=[]; blocked_answer=str(e)
                    answer=('本次未执行：' if m.get('data_kind')=='private_experience' else '模拟回应阻断：')+blocked_answer+' 价格未改变。'
                m['generation']=m.get('generation',0)+1
                m['proposal']=None  # A newer interaction invalidates an older unadopted proposal.
                token = uuid.uuid4().hex
                m['conversation'].append(dict(at=now(), role='user', text=raw, request=token))
                m['requests'][token] = dict(id=token, status='pending', generation=m['generation'], revision=m['revision'], selected=m['selected'][:], filters=copy.deepcopy(m['filters']), edits=edits, proposal_edits=proposal_edits, answer=answer, context=context, at=now())
                result['token'] = token
            elif op == 'ai_finish':
                token = req.get('token'); pending = m['requests'].get(token)
                if not pending or pending['status'] != 'pending': raise Rejected('重复、跨事项或中断的模拟回应已阻断。')
                if pending.get('generation') != m.get('generation',0) or pending['revision'] != m['revision'] or pending['selected'] != m['selected'] or pending['filters'] != m['filters']:
                    pending['status'] = 'stale'
                    m['conversation'].append(dict(at=now(), role='system', text='迟到回应已阻断：已有更新对话轮次、草稿或选择/筛选变化，未覆盖新建议或编辑。', request=token))
                else:
                    if pending['edits']: self.edits(m, pending['edits'], 'mock_ai_explicit_command')
                    if pending.get('proposal_edits'):
                        m['proposal']=dict(edits=pending['proposal_edits'],generation=m['generation'],revision=m['revision'],selected=m['selected'][:],filters=copy.deepcopy(m['filters']))
                    pending['status'] = 'completed'
                    m['conversation'].append(dict(at=now(), role='assistant', text='模拟AI明确命令已写入同一合成草稿；未批准、未发布。' if pending['edits'] else pending['answer'], request=token))
            elif op in ('history_reference_select', 'history_reference_remove'):
                if m.get('data_kind') != 'private_experience' or m.get('persona') != 'ceo':
                    raise Rejected('当前身份不能保存历史依据引用。')
                request = m.get('inquiry_request')
                if not request or req.get('inquiry_request') != request:
                    raise Rejected('询价条件已变化或尚未保存，请先重新核对。')
                old = m.get('history_reference')
                if op == 'history_reference_select':
                    history = analyze_reference(request['terms'], rows, as_of=now(),
                        history_reader=self.history_reader)['history']
                    if req.get('queried_scope') != history.get('queried_scope') or not history.get('queried_scope'):
                        raise Rejected('历史读取范围已变化，请重新读取后选择；未保存。')
                    try: selected = select_history_reference(request, history, req.get('reference'))
                    except (InquiryRejected, KeyError) as e:
                        raise Rejected('这条依据未通过本次授权查询核对，未保存。') from e
                    if old and old['reference'] == selected['reference'] and old['context'] == selected['context']:
                        selected = old
                else:
                    if not old or req.get('reference') != old['reference']:
                        raise Rejected('待移除的引用已变化，请重新读取。')
                    selected = None
                if old and old != selected:
                    # Preserve only the original citation/context, never historical facts.
                    m.setdefault('previous_history_references', []).append(copy.deepcopy(old))
                m['history_reference'] = selected
            elif op in OPS:
                if m.get('fixture_set') != CATALOG_ID:
                    raise Rejected('此操作仅用于新的虚构工作台事项。')
                try:
                    if op == 'draft_preview':
                        result['draft_preview'] = self.preview_draft(m, req.get('edits'))
                    elif op == 'draft_cancel':
                        m['draft_preview'] = None
                    elif op == 'draft_confirm':
                        preview = m.get('draft_preview')
                        if not preview or req.get('token') != preview['token'] or preview['prepared_version'] != m['version']:
                            raise Rejected('草稿预览已失效；请重新预览范围与新旧值。')
                        if any(preview[key] != m[key] for key in ('revision', 'selected', 'filters', 'generation')):
                            raise Rejected('预览范围或草稿已变化；请重新确认。')
                        self.edits(m, preview['edits'], 'manual_preview_confirmed', private_draft=True)
                        result['confirmed_token'] = preview['token']
                        m['draft_preview'] = None
                    elif op == 'inquiry':
                        if m.get('data_kind') == 'private_experience':
                            try: terms = normalize_terms(req.get('terms'))
                            except InquiryRejected as e: raise WorkbenchRejected(str(e)) from e
                            # Persist only the inquiry inputs, never copy shared history into this Store.
                            if m.get('inquiry_request', {}).get('terms') != terms:
                                m['inquiry_request'] = dict(schema='private-inquiry-request.v1', terms=terms,
                                    as_of=now(), context_id=uuid.uuid4().hex)
                        else:
                            m['inquiry'] = analyze(req.get('terms'), rows, self.workbench_history(db))
                            result['analysis'] = copy.deepcopy(m['inquiry'])
                    elif op == 'quote_preview':
                        result.update(prepare_quote(m, req, self.workbench_history(db), amount, rows))
                    elif op == 'quote_cancel':
                        m['quote_preview'] = None
                    elif op == 'quote_confirm':
                        result.update(confirm_quote(m, req, now()))
                except WorkbenchRejected as e:
                    raise Rejected(str(e)) from e
            elif op == 'new_round':
                title = req.get('title')
                if not isinstance(title, str) or not title.strip() or len(title)>120: raise Rejected('请输入1–120字事项标题。')
                created = new_matter('demo-'+uuid.uuid4().hex[:12], title, mid, m.get('fixture_set'))
                if m.get('private_rows') is not None:
                    created.update(private_rows=copy.deepcopy(m['private_rows']), values={r['id']:r['baseline'] for r in m['private_rows']},
                                   data_kind='private_experience', copy_sha256=m['copy_sha256'], persona=m['persona'])
                elif m.get('fixture_set') == CATALOG_ID and m.get('catalog_revision') != 2:
                    created.pop('catalog_revision', None);created['values']={r['id']:r['baseline'] for r in LEGACY_MATRIX_ROWS}
                self.write(db, created); result['new_matter'] = created['id']
            else: raise Rejected('未知操作。')
            m['version'] += 1; m['seen'].append(request_id)
            self.write(db, m)
            if req.get('simulate_failure') is True:
                raise Rejected('模拟落盘失败：事务已回滚，未保存。输入仍保留，请重试。')
            db.commit()
        # Only acknowledge after COMMIT plus independent readback.
        try:
            stored = self.state(mid)
            if stored['matter']['version'] < m['version']:
                raise Rejected('无法确认已提交版本。')
        except (Rejected, sqlite3.Error, ValueError, TypeError, KeyError) as e:
            raise CommittedUnconfirmed(request_id, result) from e
        return dict(**stored, **result, saved=True)

    def search(self, mid, query):
        if len(query) > 200: raise Rejected('检索词过长。')
        with self.connect() as db:
            current = self.read(db, mid); ids = [mid]
            if current['parent']: ids.append(current['parent'])
            results = []
            for ident in ids:
                m = self.read(db, ident)
                for msg in m['conversation']:
                    if query.casefold() in msg['text'].casefold():
                        results.append(dict(matter=ident, title=m['title'], historical=ident!=mid, status=m['status'], **msg))
            return results[-30:]

    def backup(self, target):
        target = Path(target)
        if target.exists(): raise Rejected('备份目标已存在；请使用新路径。')
        with self.connect() as source, sqlite3.connect(target) as dest: source.backup(dest)
        target.chmod(0o600)


def handler(store):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass  # Do not duplicate raw conversation in HTTP logs.
        def send(self, status, body, mime='application/json; charset=utf-8', filename=None):
            data = json.dumps(body, ensure_ascii=False).encode() if isinstance(body, (dict,list)) else body
            self.send_response(status); self.send_header('Content-Type',mime)
            self.send_header('Content-Length',str(len(data))); self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            if filename: self.send_header('Content-Disposition','attachment; filename="'+filename+'"')
            self.send_header('Content-Security-Policy',"default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'")
            self.end_headers(); self.wfile.write(data)
        def allowed(self):
            host = self.headers.get('Host','')
            expected = f'127.0.0.1:{self.server.server_port}'
            if host != expected: return False
            origin = self.headers.get('Origin')
            return origin is None or origin == 'http://'+expected
        def do_GET(self):
            if not self.allowed(): return self.send(403, {'error':'仅允许本机演示来源。'})
            url = urlsplit(self.path); query = parse_qs(url.query)
            try:
                if url.path == '/api/state': return self.send(200, store.state(query.get('matter',['demo-2026'])[0]))
                if url.path == '/api/search': return self.send(200, store.search(query.get('matter',['demo-2026'])[0],query.get('q',[''])[0]))
                files={'/':'index.html','/app.js':'app.js','/fx.js':'fx.js','/workbench.js':'workbench.js','/style.css':'style.css'}
                if url.path not in files: return self.send(404,{'error':'Not found'})
                ext = files[url.path].split('.')[-1]
                mime={'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8'}[ext]
                self.send(200,(STATIC/files[url.path]).read_bytes(),mime)
            except (Rejected,sqlite3.Error) as e: self.send(400,{'error':str(e)})
        def do_POST(self):
            if not self.allowed(): return self.send(403,{'error':'仅允许本机演示来源。'})
            if self.path not in ('/api/action','/api/price-export') or self.headers.get('Content-Type') != 'application/json': return self.send(400,{'error':'无效请求。'})
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 1 <= length <= 100000: raise Rejected('请求大小超限。')
                request=json.loads(self.rfile.read(length))
                if self.path == '/api/price-export':
                    from .s1_price_export import export_request, ExportRejected
                    try: raw,mime,filename=export_request(store,request)
                    except ExportRejected as e: raise Rejected(str(e)) from e
                    return self.send(200,raw,mime,filename)
                result=store.action(request)
                self.send(200,result)
            except CommittedUnconfirmed as e:
                self.send(503, {'error': str(e), 'saved': None, 'committed': True,
                    'outcome': 'committed_unconfirmed', 'request_id': e.request_id, **e.result})
            except (Rejected,ValueError,TypeError,KeyError,sqlite3.Error) as e: self.send(409,{'error':str(e),'saved':False})
    return Handler


def main():
    parser=argparse.ArgumentParser(description='S1 synthetic-only local demonstration')
    parser.add_argument('--db',default='.s1-demo/experience-v2.sqlite3')
    parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--backup'); parser.add_argument('--restore')
    args=parser.parse_args()
    if args.restore:
        if Path(args.db).exists(): raise SystemExit('Restore requires a new destination, never overwrite an existing draft.')
        # Validate marker before writing restored bytes.
        source=sqlite3.connect(f'file:{Path(args.restore).resolve()}?mode=ro',uri=True)
        if source.execute('SELECT marker FROM meta').fetchall()!=[(MARKER,)]: raise SystemExit('Not an S1 synthetic backup')
        Path(args.db).parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        with sqlite3.connect(args.db) as dest: source.backup(dest)
        source.close()
    experience=None
    if Path(args.db).exists() and not (args.backup or args.restore):
        try:
            with sqlite3.connect(Path(args.db).resolve().as_uri()+'?mode=ro',uri=True) as previous:
                expected_marker=PRIVATE_COPY_MARKER if experience is not None else MARKER
                if previous.execute('SELECT marker FROM meta').fetchall()!=[(expected_marker,)]: raise ValueError()
                target='experience-'+experience['copy_sha256'][:16] if experience is not None else DEMO_MATTER
                record=previous.execute('SELECT payload FROM matters WHERE id=?',(target,)).fetchone()
                stored=json.loads(record[0]) if record else None
                if experience is not None:
                    if not stored or stored.get('copy_sha256')!=experience['copy_sha256'] or stored.get('private_rows')!=experience['rows'] or stored.get('persona')!=experience['persona']: raise ValueError()
                elif stored and stored.get('catalog_revision')!=2: raise ValueError()
        except Exception: raise SystemExit('已有数据库不属于本次体验版本；请使用新路径，旧方案保持原样。') from None
    store=Store(args.db,recover_pending=not bool(args.backup), matrix_demo=not bool(args.backup or args.restore),experience=experience)
    if args.backup: store.backup(args.backup); print('Synthetic backup saved.'); return
    if args.restore: print('Synthetic backup restored to new destination.'); return
    server=ThreadingHTTPServer(('127.0.0.1',args.port),handler(store))
    target='experience-'+experience['copy_sha256'][:16] if experience is not None else DEMO_MATTER
    print(f'PRICE EXPERIENCE COPY: http://127.0.0.1:{server.server_port}/?matter={target}',flush=True)
    server.serve_forever()


if __name__=='__main__': main()

