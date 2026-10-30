"""PR36 business batch: synthetic Store only, no listener/network/real history."""
import copy
from io import BytesIO
from email.message import Message
from types import SimpleNamespace
from pathlib import Path
import sqlite3
import json
import tempfile
import unittest
import uuid
from unittest.mock import patch
from txsenser_pricing.s1_demo import Store, Rejected, CommittedUnconfirmed, FIELDS, ROWS, handler
from txsenser_pricing.s1_workbench import DEMO_MATTER, MATRIX_ROWS, CATALOG_ID, latest_records


def terms(**overrides):
    return dict(customer_id='DEMO-C-A', project_id='DEMO-P-A', product_id='DEMO-LUMEN',
        market='国际', application='通用工业', role='经销', quantity='5', currency='USD', unit='台',
        conditions='标准演示条件', **{}) | overrides


class BusinessBatch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'fictional.sqlite'
        self.store = Store(self.path, matrix_demo=True)
        self.mid = DEMO_MATTER
    def tearDown(self): self.tmp.cleanup()
    def state(self): return self.store.state(self.mid)
    def act(self, op, **extra):
        request = dict(matter=self.mid, version=self.state()['matter']['version'], request_id=uuid.uuid4().hex, op=op, **extra)
        return self.store.action(request)
    def prepare(self, **extra):
        return self.act('quote_preview', terms=terms(), amount='300', **extra)['quote_preview']
    def confirm(self, preview, **extra):
        return self.act('quote_confirm', token=preview['token'], acknowledged=True, **extra)
    def edit(self, rid='MX-01-2', new='2000'):
        row=next(r for r in MATRIX_ROWS if r['id']==rid)
        return dict(id=rid, old=self.state()['matter']['values'][rid], new=new, scope={k:row[k] for k in FIELDS})

    def test_new_catalog_keeps_legacy_and_one_database(self):
        self.assertEqual(len(self.state()['rows']),42)
        self.assertEqual(len(self.store.state('demo-2026')['rows']),30)
        self.assertEqual(self.store.state('demo-2026')['matter']['version'],0)
        product=[r for r in MATRIX_ROWS if r['product_id']=='DEMO-LUMEN' and r['market']=='国内']
        self.assertEqual({r['role'] for r in product},{'指导','直销','经销','OEM','代理','出厂','大客户权限'})
        self.assertEqual(len({(r['configuration'],r['pn'],r['tier'],r['currency'],r['unit']) for r in product}),1)
        with self.store.connect() as db:
            self.assertEqual({r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")},{'meta','matters'})
        self.assertEqual([r['baseline'] for r in ROWS][:2],['1000.00','1037.00'])

    def test_enabling_workbench_does_not_rewrite_existing_legacy_history(self):
        original=self.store.state('demo-2026')['matter']
        Store(self.path,matrix_demo=True)
        self.assertEqual(self.store.state('demo-2026')['matter'],original)

    def test_draft_preview_confirm_changes_one_role_only(self):
        self.act('view',selected=['MX-01-2'],filters={})
        before=copy.deepcopy(self.state()['matter']);reference=copy.deepcopy(MATRIX_ROWS)
        preview=self.act('draft_preview',edits=[self.edit()])['draft_preview']
        pending=self.state()['matter']
        self.assertEqual(pending['values'],before['values']);self.assertEqual(pending['history'],before['history'])
        self.assertEqual(pending['quote_records'],[])
        after=self.act('draft_confirm',token=preview['token'])['matter']
        self.assertEqual(after['values']['MX-01-2'],'2000.00')
        self.assertEqual({k:v for k,v in after['values'].items() if k!='MX-01-2'},{k:v for k,v in before['values'].items() if k!='MX-01-2'})
        self.assertEqual(after['revision'],before['revision']+1);self.assertEqual(after['quote_records'],[])
        self.assertEqual(MATRIX_ROWS,reference)

    def test_draft_cancel_and_stale_scope_cannot_write_prices(self):
        self.act('view',selected=['MX-01-2'],filters={})
        preview=self.act('draft_preview',edits=[self.edit()])['draft_preview']
        before=self.state()['matter']['values']
        self.act('draft_cancel');self.assertEqual(self.state()['matter']['values'],before)
        self.assertEqual(self.state()['matter']['history'],[])
        preview=self.act('draft_preview',edits=[self.edit()])['draft_preview']
        self.act('view',selected=[],filters={})
        with self.assertRaises(Rejected):self.act('draft_confirm',token=preview['token'])
        self.assertEqual(self.state()['matter']['values'],before)

    def test_legacy_direct_edit_and_context_remain_compatible(self):
        path=Path(self.tmp.name)/'legacy.sqlite'
        store=Store(path)
        self.assertEqual(len(store.state('demo-2026')['matters']),1)
        def action(op,**args):
            return store.action(dict(matter='demo-2026',version=store.state('demo-2026')['matter']['version'],request_id=uuid.uuid4().hex,op=op,**args))
        action('view',selected=['SYN-02'],filters={})
        row=next(r for r in ROWS if r['id']=='SYN-02')
        action('edit',edits=[dict(id='SYN-02',old=row['baseline'],new='1500',scope={k:row[k] for k in FIELDS})])
        state=store.state('demo-2026')
        self.assertEqual(state['matter']['values']['SYN-02'],'1500.00')
        self.assertEqual(store.context(state['matter'])['selected'][0]['draft'],'1500.00')

    def test_new_matrix_direct_edit_and_undo_cannot_skip_preview(self):
        self.act('view',selected=['MX-01-2'],filters={})
        before=self.state()['matter']
        for op,args in [('edit',dict(edits=[self.edit()])),('undo',{})]:
            with self.assertRaises(Rejected):self.act(op,**args)
            self.assertEqual(self.state()['matter'],before)

    def test_exact_simulated_command_only_previews_until_confirmation(self):
        self.act('view',selected=['MX-03-3'],filters={})
        started=self.act('ai_begin',text='仅将选中行拟调价增加 80 USD/台')
        self.act('ai_finish',token=started['token'])
        self.assertEqual(self.state()['matter']['values']['MX-03-3'],'300.00')
        self.assertIsNotNone(self.state()['matter']['proposal'])
        preview=self.act('mode',mode='adjustment')['draft_preview']
        self.assertEqual(self.state()['matter']['values']['MX-03-3'],'300.00')
        self.act('draft_confirm',token=preview['token'])
        self.assertEqual(self.state()['matter']['values']['MX-03-3'],'380.00')
        self.assertEqual(self.state()['matter']['quote_records'],[])

    def test_missing_and_out_of_demo_customer_never_guessed(self):
        result=self.act('inquiry',terms=terms(quantity=''))['analysis']
        self.assertEqual(result['status'],'NEEDS_INFO');self.assertEqual(result['references'],[])
        before=self.state()['matter']
        with self.assertRaises(Rejected):self.act('inquiry',terms=terms(customer_id='OUTSIDE-DEMO',project_id=''))
        self.assertEqual(self.state()['matter'],before)

    def test_exact_market_tier_currency_and_missing_role_boundaries(self):
        analysis=self.act('inquiry',terms=terms(quantity='10'))['analysis']
        self.assertEqual(analysis['references'][0]['amount'],'280.00')
        for case in [terms(quantity='50'),terms(currency='EUR'),terms(market='国内',currency='CNY',role='OEM')]:
            self.assertEqual(self.act('inquiry',terms=case)['analysis']['status'],'BLOCKED')
        pending=terms(conditions='附加条件待确认')
        self.assertEqual(self.act('inquiry',terms=pending)['analysis']['status'],'NEEDS_CONFIRMATION')
        with self.assertRaises(Rejected):self.act('quote_preview',terms=pending,amount='300')

    def test_one_complete_business_flow_and_reuse_after_reopen(self):
        analysis=self.act('inquiry',terms=terms())['analysis'];self.assertEqual(analysis['status'],'AVAILABLE_DEMO')
        self.prepare();self.assertEqual(self.state()['matter']['quote_records'],[])
        self.act('quote_cancel');self.assertEqual(self.state()['matter']['quote_records'],[])
        preview=self.prepare();response=self.confirm(preview);record=response['record']
        self.assertEqual(record['phase'],'quoted_demo');self.assertEqual(record['terms'],terms())
        self.assertRegex(record['at'],r'^\d{4}-\d{2}-\d{2}T');self.assertTrue(record['id'].startswith('DEMO-Q-'))
        saved=copy.deepcopy(self.state()['matter'])
        replay=self.store.action(dict(matter=self.mid,op='quote_confirm',token=preview['token'],acknowledged=True,
            request_id=record['request_id'],version=0))
        self.assertTrue(replay['duplicate']);self.assertEqual(replay['record'],record)
        self.assertTrue(self.confirm(preview)['duplicate']);self.assertEqual(self.state()['matter'],saved)
        self.store=Store(self.path)
        analysis=self.act('inquiry',terms=terms(quantity='10'))['analysis']
        self.assertEqual(analysis['references'][0]['amount'],'280.00')
        self.assertEqual(analysis['history'][0]['id'],record['id'])
        self.assertTrue(any('数量' in item for item in analysis['history'][0]['differences']))
        self.assertEqual(self.state()['matter']['values']['MX-04-3'],'280.00')

    def test_correction_appends_version_and_never_mutates_v1(self):
        first=self.confirm(self.prepare())['record'];old=copy.deepcopy(first)
        preview=self.act('quote_preview',terms=terms(quantity='10'),amount='290',quote_id=first['id'],expected_version=1,reason='更正数量')['quote_preview']
        second=self.confirm(preview)['record'];records=self.state()['matter']['quote_records']
        self.assertEqual(records[0],old);self.assertEqual(second['id'],first['id']);self.assertEqual(second['version'],2)
        self.assertEqual(second['previous_version'],1);self.assertEqual(len(records),2)
        self.assertEqual(latest_records(records),[second])
        analysis=self.act('inquiry',terms=terms(quantity='10'))['analysis']
        self.assertEqual(analysis['history'][0]['version'],2)
        with self.assertRaises(Rejected):self.act('quote_preview',terms=terms(),amount='300',quote_id=first['id'],expected_version=1,reason='更正数量')

    def test_confirmation_requires_explicit_ack_and_current_preview(self):
        preview=self.prepare();before=self.state()['matter']
        with self.assertRaises(Rejected):self.act('quote_confirm',token=preview['token'],acknowledged=False)
        self.assertEqual(self.state()['matter'],before)
        self.act('inquiry',terms=terms(quantity='10'))
        with self.assertRaises(Rejected):self.confirm(preview)
        self.assertEqual(self.state()['matter']['quote_records'],[])

    def test_failed_save_rolls_back_all_quote_facts_and_receipts(self):
        preview=self.prepare();before=self.state()['matter']
        with self.assertRaises(Rejected):self.confirm(preview,simulate_failure=True)
        self.assertEqual(self.state()['matter'],before)
        self.assertEqual(len(self.confirm(preview)['matter']['quote_records']),1)

    def test_postcommit_read_failure_is_unknown_and_exact_receipt_recovers(self):
        preview=self.prepare();request=dict(matter=self.mid,version=self.state()['matter']['version'],request_id=uuid.uuid4().hex,
            op='quote_confirm',token=preview['token'],acknowledged=True)
        with patch.object(self.store,'state',side_effect=sqlite3.OperationalError('synthetic readback')):
            with self.assertRaises(CommittedUnconfirmed) as caught:self.store.action(request)
        self.assertEqual(caught.exception.request_id,request['request_id'])
        state=self.state();self.assertEqual(len(state['matter']['quote_records']),1)
        self.assertEqual(state['matter']['quote_receipts'][preview['token']]['request_id'],request['request_id'])
        self.assertTrue(self.confirm(preview)['duplicate']);self.assertEqual(len(self.state()['matter']['quote_records']),1)

    def test_http_asset_and_business_confirm_contract(self):
        def call(method,path,body=None,origin='http://127.0.0.1:8765'):
            cls=handler(self.store);request=cls.__new__(cls)
            request.server=SimpleNamespace(server_port=8765)
            request.path=path;request.command=method;request.request_version='HTTP/1.1';request.requestline=method+' '+path+' HTTP/1.1'
            request.headers=Message();request.headers['Host']='127.0.0.1:8765';request.headers['Origin']=origin
            raw=json.dumps(body,ensure_ascii=False).encode() if body is not None else b''
            request.headers['Content-Type']='application/json';request.headers['Content-Length']=str(len(raw))
            request.rfile=BytesIO(raw);request.wfile=BytesIO()
            getattr(request,'do_'+method)()
            head,data=request.wfile.getvalue().split(b'\r\n\r\n',1)
            return int(head.split(b' ')[1]),data
        status,data=call('GET','/workbench.js')
        self.assertEqual(status,200);self.assertIn(b'Workbench',data)
        self.assertEqual(call('GET','/workbench.js',origin='https://untrusted.invalid')[0],403)
        preview=self.prepare()
        request=dict(matter=self.mid,version=self.state()['matter']['version'],request_id=uuid.uuid4().hex,
            op='quote_confirm',token=preview['token'],acknowledged=True)
        status,data=call('POST','/api/action',request)
        result=json.loads(data);self.assertEqual(status,200);self.assertTrue(result['saved'])
        self.assertEqual(result['record']['phase'],'quoted_demo')
        self.assertEqual(len(result['matter']['quote_records']),1)

    def test_request_identity_and_matter_boundaries(self):
        preview=self.prepare();record=self.confirm(preview)['record']
        used=self.act('inquiry',terms=terms())['matter']['seen'][-1]
        with self.assertRaises(Rejected):self.store.action(dict(matter=self.mid,op='quote_confirm',version=0,request_id=used,token=preview['token'],acknowledged=True))
        other=self.act('new_round',title='虚构下一轮')['new_matter']
        request=dict(matter=other,version=0,request_id=uuid.uuid4().hex,op='quote_confirm',token=preview['token'],acknowledged=True)
        with self.assertRaises(Rejected):self.store.action(request)
        analysis=self.store.action(dict(matter=other,version=0,request_id=uuid.uuid4().hex,op='inquiry',terms=terms()))['analysis']
        self.assertEqual(analysis['history'][0]['id'],record['id'])


if __name__=='__main__':unittest.main()

