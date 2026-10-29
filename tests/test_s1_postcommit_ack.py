"""Synthetic commit/readback boundary checks. No listener or browser is used."""
import copy
import io
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from txsenser_pricing.s1_demo import FIELDS, ROW_BY_ID, Rejected, Store, handler


class PostCommitAcknowledgment(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name) / 'synthetic.sqlite3')
        self.mid = 'demo-2026'
        matter = self.matter()
        self.store.action(dict(matter=self.mid, op='view', selected=['SYN-02', 'SYN-03'],
            filters={}, version=matter['version'], request_id=uuid.uuid4().hex))
        self.before = self.matter()
        self.request = dict(matter=self.mid, op='edit', version=self.before['version'],
            request_id=uuid.uuid4().hex, edits=[dict(id=rid, old=self.before['values'][rid],
                new=value, scope={key: ROW_BY_ID[rid][key] for key in FIELDS})
                for rid, value in [('SYN-02', '1500'), ('SYN-03', '1600')]])

    def matter(self):
        return self.store.state(self.mid)['matter']

    def post(self, request):
        # Invoke the real HTTP request method against memory streams, without binding a socket.
        target = object.__new__(handler(self.store))
        payload = json.dumps(request).encode()
        target.server = SimpleNamespace(server_port=8765)
        target.headers = {'Host': '127.0.0.1:8765', 'Origin': 'http://127.0.0.1:8765',
            'Content-Type': 'application/json', 'Content-Length': str(len(payload))}
        target.path = '/api/action'
        target.rfile = io.BytesIO(payload)
        replies = []
        target.send = lambda status, body: replies.append((status, body))
        target.do_POST()
        self.assertEqual(len(replies), 1)
        return replies[0]

    def assert_committed_once(self):
        matter = self.matter()
        self.assertEqual(matter['values']['SYN-02'], '1500.00')
        self.assertEqual(matter['values']['SYN-03'], '1600.00')
        self.assertEqual(matter['revision'], self.before['revision'] + 1)
        self.assertEqual(len(matter['history']), len(self.before['history']) + 1)
        self.assertEqual([edit['id'] for edit in matter['history'][-1]['edits']], ['SYN-02', 'SYN-03'])
        self.assertIn(self.request['request_id'], matter['seen'])
        self.assertEqual(matter['conversation'], self.before['conversation'])

    def check_readback_failure(self, error):
        with patch.object(self.store, 'state', side_effect=error):
            status, body = self.post(self.request)
        self.assertEqual(status, 503)
        self.assertIsNone(body['saved'])
        self.assertIs(body['committed'], True)
        self.assertEqual(body['outcome'], 'committed_unconfirmed')
        self.assertEqual(body['request_id'], self.request['request_id'])
        self.assertIn('重新载入核对', body['error'])
        self.assertIn('不要重复提交', body['error'])
        self.assertNotIn('未保存', body['error'])
        self.assert_committed_once()

    def test_sqlite_readback_failure_does_not_claim_rollback(self):
        self.check_readback_failure(sqlite3.OperationalError('SYNTHETIC_POSTCOMMIT_READBACK_FAILURE'))

    def test_rejected_readback_does_not_claim_rollback(self):
        self.check_readback_failure(Rejected('SYNTHETIC_READBACK_REJECTED'))

    def test_invalid_payload_readback_does_not_claim_rollback(self):
        self.check_readback_failure(ValueError('SYNTHETIC_READBACK_INVALID'))

    def test_unconfirmed_version_does_not_claim_rollback(self):
        with patch.object(self.store, 'state', return_value={'matter': copy.deepcopy(self.before)}):
            status, body = self.post(self.request)
        self.assertEqual(status, 503)
        self.assertIsNone(body['saved'])
        self.assertIs(body['committed'], True)
        self.assert_committed_once()

    def test_same_request_cannot_apply_twice_after_unconfirmed_commit(self):
        self.check_readback_failure(sqlite3.OperationalError('SYNTHETIC_POSTCOMMIT_READBACK_FAILURE'))
        before_retry = self.matter()
        retry = copy.deepcopy(self.request)
        retry['version'] = before_retry['version']
        status, body = self.post(retry)
        self.assertEqual(status, 409)
        self.assertIs(body['saved'], False)
        self.assertIn('重复请求', body['error'])
        self.assertEqual(self.matter(), before_retry)

    def test_precommit_failure_remains_unsaved_and_atomic(self):
        status, body = self.post(dict(self.request, simulate_failure=True))
        self.assertEqual(status, 409)
        self.assertIs(body['saved'], False)
        self.assertNotIn('committed', body)
        self.assertEqual(self.matter(), self.before)

    def test_scope_rejection_keeps_whole_batch_and_history_unchanged(self):
        request = copy.deepcopy(self.request)
        request['edits'][1]['scope']['currency'] = 'CNY'
        status, body = self.post(request)
        self.assertEqual(status, 409)
        self.assertIs(body['saved'], False)
        self.assertEqual(self.matter(), self.before)

    def test_normal_success_still_requires_confirmed_readback(self):
        status, body = self.post(self.request)
        self.assertEqual(status, 200)
        self.assertIs(body['saved'], True)
        self.assert_committed_once()


if __name__ == '__main__':
    unittest.main()

