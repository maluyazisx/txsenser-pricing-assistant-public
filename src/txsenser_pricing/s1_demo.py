"""S1 isolated synthetic-only demo. No C1 price inputs, external providers or publication."""
from __future__ import annotations
import argparse
import copy
from decimal import Decimal, InvalidOperation
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit
import uuid


MARKER = 'TXSENSER_S1_SYNTHETIC_ONLY_V1'
STATIC = Path(__file__).with_name('s1_static')
FIELDS = ('family', 'kind', 'configuration', 'pn', 'market', 'application', 'role', 'tier', 'currency', 'unit')
CATEGORY_FILTERS = ('family', 'kind', 'market', 'application', 'role', 'tier', 'currency', 'unit')
FILTERS = CATEGORY_FILTERS + ('price_min', 'price_max')


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


def blocked(row):
    if row['source_status'] != 'synthetic_available':
        return row['risk'] + '；请补齐该范围的合成来源/档位后再编辑。'
    if any(row[k] is None for k in FIELDS if k != 'pn'):
        return '范围不完整；请明确缺失字段。'
    if sum(identity(r) == identity(row) for r in ROWS) != 1:
        return '身份重复；请明确唯一配置/PN及范围。'
    return None


def validate_filters(filters):
    if not isinstance(filters, dict) or any(k not in FILTERS or not isinstance(v, str) for k,v in filters.items()):
        raise Rejected('筛选无效。')
    result=dict(filters)
    if result.get('price_min') or result.get('price_max'):
        if result.get('currency') not in ('USD','CNY','EUR') or result.get('unit') not in ('台','件'):
            raise Rejected('价格范围需要明确一个币种和单位；不做混合币种比较或换算。')
        for key in ('price_min','price_max'):
            if result.get(key): result[key]=amount(result[key])
        if result.get('price_min') and result.get('price_max') and Decimal(result['price_min'])>Decimal(result['price_max']):
            raise Rejected('价格范围下限不能大于上限；筛选未保存。')
    return result


def visible(row, filters):
    if not all(not filters.get(k) or row[k] == filters[k] for k in CATEGORY_FILTERS): return False
    lower,upper=filters.get('price_min'),filters.get('price_max')
    if lower or upper:
        if row['baseline'] is None: return False
        value=Decimal(row['baseline'])
        if lower and value<Decimal(lower): return False
        if upper and value>Decimal(upper): return False
    return True


def new_matter(mid, title, parent=None):
    return dict(id=mid, title=title, parent=parent, created=now(), status='DRAFT / 合成未批准',
        version=0, revision=0, values={r['id']: r['baseline'] for r in ROWS},
        selected=[], filters={}, conversation=[], history=[], requests={}, seen=[], mode='discussion', proposal=None, generation=0)


class OfflineProvider:
    """Replacement seam. Output never creates authorization; service parses user intent."""
    available = True
    def respond(self, context):
        if not self.available:
            raise Rejected('模拟AI不可用；已保存草稿与原始对话仍可读取。')
        selected = context['selected']
        details = '；'.join(f"{r['id']} {r['configuration']}：{r['draft']} {r['currency']}/{r['unit']}，{r['role']}，{r['tier']}" for r in selected)
        return '模拟分析（非真实语言理解）：' + (details or '请先选入要比较的合成行。') + '。各范围独立比较，不汇总混合币种/单位；不修改草稿。'


class Store:
    def __init__(self, path, provider=None, recover_pending=True):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.exists():
            try:
                with sqlite3.connect(f'file:{self.path.resolve()}?mode=ro',uri=True) as existing:
                    if existing.execute('SELECT marker FROM meta').fetchall() != [(MARKER,)]:
                        raise Rejected('非S1合成存储，拒绝打开。')
            except sqlite3.Error as e:
                raise Rejected('无法验证S1合成存储标记；拒绝修改。') from e
        self.provider = provider or OfflineProvider()
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS meta (marker TEXT NOT NULL)')
            marker = db.execute('SELECT marker FROM meta').fetchall()
            if not marker: db.execute('INSERT INTO meta VALUES (?)', (MARKER,))
            elif marker != [(MARKER,)]: raise Rejected('非S1合成存储，拒绝打开。')
            db.execute('CREATE TABLE IF NOT EXISTS matters (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            if not db.execute('SELECT 1 FROM matters').fetchone():
                self.write(db, new_matter('demo-2026', '合成演示 · 第一轮'))
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

    def state(self, mid):
        with self.connect() as db:
            m = self.read(db, mid)
            summaries = [dict(id=x['id'], title=x['title'], parent=x['parent'], created=x['created']) for x in [json.loads(p) for (p,) in db.execute('SELECT payload FROM matters')]]
        return dict(marker=MARKER, matter=m, matters=summaries,
            rows=[dict(r, blocked=blocked(r)) for r in ROWS], visible_ids=[r['id'] for r in ROWS if visible(r,m['filters'])], provider='offline-deterministic-mock')

    def context(self, m):
        selected = [dict(ROW_BY_ID[rid], draft=m['values'][rid]) for rid in m['selected'] if visible(ROW_BY_ID[rid], m['filters'])]
        return dict(matter=m['id'], revision=m['revision'], selected=selected, filters=m['filters'], recent=m['conversation'][-8:])

    def edits(self, m, edits, actor):
        if not isinstance(edits, list) or not 1 <= len(edits) <= len(ROWS): raise Rejected('需要1–30条精确行编辑。')
        checked = []; ids = set()
        for position, edit in enumerate(edits, 1):
            rid = edit.get('id'); row = ROW_BY_ID.get(rid)
            if not row or rid in ids: raise Rejected('行不存在或批次含重复行；整批未保存。')
            ids.add(rid)
            if rid not in m['selected'] or not visible(row, m['filters']): raise Rejected(f'{rid} 不在当前已选且可见范围；整批未保存。')
            reason = blocked(row)
            if reason: raise Rejected(f'{rid}：{reason} 整批未保存。')
            if edit.get('scope') != {k: row[k] for k in FIELDS}: raise Rejected(f'{rid} 范围不匹配；整批未保存。')
            if edit.get('old') != m['values'][rid]: raise Rejected(f'{rid} 旧值已变化；刷新后重试。')
            try:
                new_value = amount(edit.get('new'))
            except Rejected as e:
                raise Rejected(f'第{position}行（{rid}）：{e} 整批未保存。') from e
            checked.append(dict(id=rid, old=m['values'][rid], new=new_value, scope=edit['scope']))
        for e in checked: m['values'][e['id']] = e['new']
        m['revision'] += 1
        m['history'].append(dict(revision=m['revision'], at=now(), actor=actor, edits=checked, undone=False))

    def action(self, req):
        if not isinstance(req, dict): raise Rejected('请求必须是对象。')
        mid, op, request_id = req.get('matter'), req.get('op'), req.get('request_id')
        if not isinstance(request_id, str) or not re.fullmatch('[a-zA-Z0-9-]{1,80}', request_id): raise Rejected('缺少有效请求标识。')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            m = self.read(db, mid)
            if request_id in m['seen']: raise Rejected('重复请求已阻断；不会再次应用。')
            if req.get('version') != m['version']: raise Rejected('并发版本冲突；未保存。请重新载入最新事项。')
            result = {}
            if op == 'view':
                selected, filters = req.get('selected'), req.get('filters')
                if not isinstance(selected, list) or len(set(selected)) != len(selected) or any(x not in ROW_BY_ID for x in selected): raise Rejected('选择包含未知或重复行。')
                filters=validate_filters(filters)
                # Never silently keep hidden selected rows in the editing scope.
                m['filters'] = filters; m['selected'] = [x for x in selected if visible(ROW_BY_ID[x], filters)]
            elif op == 'edit':
                self.edits(m, req.get('edits'), 'manual')
            elif op == 'undo':
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
                            if blocked(r): raise Rejected(f"{r['id']}：{blocked(r)}")
                            new_value=amount(str(Decimal(r['draft'])+Decimal(value))) if match else amount(value)
                            targets.append(dict(id=r['id'], old=r['draft'], new=new_value, scope={k:r[k] for k in FIELDS}))
                        if match: edits=targets
                        else: proposal_edits=targets
                    answer = self.provider.respond(context)
                    if raw.startswith('检索原文 '):
                        excerpts=self.search(mid,raw[len('检索原文 '):])
                        answer='模拟原文检索（当前与关联上一轮，最多30条）：\n'+'\n'.join(f"{e['at']} [{e['matter']}; {'旧轮次草稿，非当前价' if e['historical'] else '当前事项'}] {e['text']}" for e in excerpts)
                        if not excerpts: answer+='已查范围内未找到；不推断其他事项不存在记录。'
                    if suggestion: answer='仅讨论的合成建议已准备；草稿金额未变。主动点击“开始调整价格”才按当前精确范围采纳。'
                except Rejected as e:
                    edits=[]; proposal_edits=[]; blocked_answer=str(e)
                    answer='模拟回应阻断：'+blocked_answer+' 草稿未变。'
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
            elif op == 'new_round':
                title = req.get('title')
                if not isinstance(title, str) or not title.strip() or len(title)>120: raise Rejected('请输入1–120字事项标题。')
                created = new_matter('demo-'+uuid.uuid4().hex[:12], title, mid)
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
        def send(self, status, body, mime='application/json; charset=utf-8'):
            data = json.dumps(body, ensure_ascii=False).encode() if isinstance(body, (dict,list)) else body
            self.send_response(status); self.send_header('Content-Type',mime)
            self.send_header('Content-Length',str(len(data))); self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
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
                files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}
                if url.path not in files: return self.send(404,{'error':'Not found'})
                ext = files[url.path].split('.')[-1]
                mime={'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8'}[ext]
                self.send(200,(STATIC/files[url.path]).read_bytes(),mime)
            except (Rejected,sqlite3.Error) as e: self.send(400,{'error':str(e)})
        def do_POST(self):
            if not self.allowed(): return self.send(403,{'error':'仅允许本机演示来源。'})
            if self.path != '/api/action' or self.headers.get('Content-Type') != 'application/json': return self.send(400,{'error':'无效请求。'})
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 1 <= length <= 100000: raise Rejected('请求大小超限。')
                result=store.action(json.loads(self.rfile.read(length)))
                self.send(200,result)
            except CommittedUnconfirmed as e:
                self.send(503, {'error': str(e), 'saved': None, 'committed': True,
                    'outcome': 'committed_unconfirmed', 'request_id': e.request_id, **e.result})
            except (Rejected,ValueError,TypeError,KeyError,sqlite3.Error) as e: self.send(409,{'error':str(e),'saved':False})
    return Handler


def main():
    parser=argparse.ArgumentParser(description='S1 synthetic-only local demonstration')
    parser.add_argument('--db',default='.s1-demo/synthetic.sqlite3')
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
    store=Store(args.db,recover_pending=not bool(args.backup))
    if args.backup: store.backup(args.backup); print('Synthetic backup saved.'); return
    if args.restore: print('Synthetic backup restored to new destination.'); return
    server=ThreadingHTTPServer(('127.0.0.1',args.port),handler(store))
    print(f'SYNTHETIC ONLY / MOCK AI: http://127.0.0.1:{server.server_port}',flush=True)
    server.serve_forever()


if __name__=='__main__': main()

