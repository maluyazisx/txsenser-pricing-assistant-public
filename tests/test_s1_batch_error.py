"""A2 focused synthetic batch error localization; no browser or CI claims."""
import copy
from pathlib import Path
import tempfile
import unittest
import uuid
from txsenser_pricing.s1_demo import Store, ROW_BY_ID, FIELDS, Rejected


class BatchErrorLocalization(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / 'synthetic.sqlite')
        self.mid = 'demo-2026'
        self.act('view', selected=['SYN-02', 'SYN-03', 'SYN-06'], filters={})

    def tearDown(self):
        self.tmp.cleanup()

    def matter(self):
        return self.store.state(self.mid)['matter']

    def act(self, op, **kwargs):
        return self.store.action(dict(matter=self.mid, version=self.matter()['version'], request_id=uuid.uuid4().hex, op=op, **kwargs))

    def edit(self, rid, value):
        return dict(id=rid, new=value, old=self.matter()['values'][rid], scope={k: ROW_BY_ID[rid][k] for k in FIELDS})

    def check_invalid(self, ids, position, invalid='oops'):
        before = copy.deepcopy(self.matter())
        edits = [self.edit(rid, invalid if n == position else '2000') for n, rid in enumerate(ids, 1)]
        with self.assertRaises(Rejected) as caught:
            self.act('edit', edits=edits)
        self.assertIn(f'第{position}行（{ids[position - 1]}）', str(caught.exception))
        self.assertIn('请输入非负金额，最多两位小数；不接受公式、指数或缺失值。', str(caught.exception))
        self.assertIn('整批未保存', str(caught.exception))
        self.assertEqual(self.matter(), before)

    def test_first_row_identified(self):
        self.check_invalid(['SYN-02', 'SYN-03'], 1)

    def test_second_row_identified_and_whole_state_rolled_back(self):
        self.check_invalid(['SYN-02', 'SYN-03'], 2)

    def test_submitted_order_not_matrix_order(self):
        self.check_invalid(['SYN-06', 'SYN-03', 'SYN-02'], 3)

    def test_amount_variants_remain_rejected(self):
        for invalid in ['-1', '1e3', '1.001', '=2+2', '', None]:
            with self.subTest(invalid=invalid):
                self.check_invalid(['SYN-02', 'SYN-03'], 2, invalid)

    def test_single_row_is_located(self):
        self.check_invalid(['SYN-03'], 1)

    def test_other_errors_keep_existing_message_and_rollback(self):
        before = copy.deepcopy(self.matter())
        bad = self.edit('SYN-03', '2000')
        bad['old'] = 'wrong'
        with self.assertRaises(Rejected) as caught:
            self.act('edit', edits=[self.edit('SYN-02', '2000'), bad])
        self.assertEqual(str(caught.exception), 'SYN-03 旧值已变化；刷新后重试。')
        self.assertEqual(self.matter(), before)

    def test_valid_batch_still_commits_once(self):
        before = self.matter()
        self.act('edit', edits=[self.edit('SYN-03', '2000'), self.edit('SYN-02', '2100')])
        after = self.matter()
        self.assertEqual(after['revision'], before['revision'] + 1)
        self.assertEqual([e['id'] for e in after['history'][-1]['edits']], ['SYN-03', 'SYN-02'])
        self.assertEqual(after['values']['SYN-03'], '2000.00')
        self.assertEqual(after['values']['SYN-02'], '2100.00')


if __name__ == '__main__':
    unittest.main()

