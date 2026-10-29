"""Synthetic SQLite and in-memory HTTP commit-boundary checks."""
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

from txsenser_pricing.s1_demo import FIELDS, ROW_BY_ID, Store, handler


class CommittedRoundDelta(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'synthetic.sqlite3'
        self.store = Store(self.path)
        self.mid = 'demo-2026'
        self.store.action(dict(matter=self.mid, op='view', selected=['SYN-02'],
            filters={}, version=0, request_id=uuid.uuid4().hex))
        self.before = self.store.state(self.mid)['matter']

    def request(self, op, **fields):
        return dict(matter=self.mid, op=op, version=self.before['version'],
            request_id=uuid.uuid4().hex, **fields)

    def post(self, request):
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

    def assert_unconfirmed(self, request, response):
        status, body = response
        self.assertEqual(status, 503)
        self.assertIsNone(body['saved'])
        self.assertIs(body['committed'], True)
        self.assertEqual(body['outcome'], 'committed_unconfirmed')
        self.assertEqual(body['request_id'], request['request_id'])
        self.assertNotIn('未保存', body['error'])
        return body

    def test_edit_postcommit_readback_is_not_reported_unsaved(self):
        request = self.request('edit', edits=[dict(id='SYN-02',
            old=self.before['values']['SYN-02'], new='4321',
            scope={key: ROW_BY_ID['SYN-02'][key] for key in FIELDS})])
        with patch.object(self.store, 'state', side_effect=sqlite3.OperationalError(
                'SYNTHETIC_POSTCOMMIT_DELTA_READBACK_FAILURE')):
            response = self.post(request)
        self.assert_unconfirmed(request, response)
        stored = Store(self.path).state(self.mid)['matter']
        self.assertEqual(stored['values']['SYN-02'], '4321.00')
        self.assertEqual(stored['revision'], self.before['revision'] + 1)
        self.assertEqual(stored['version'], self.before['version'] + 1)
        self.assertEqual(len(stored['history']), len(self.before['history']) + 1)
        self.assertIn(request['request_id'], stored['seen'])

    def test_new_round_postcommit_failure_retains_created_identity(self):
        request = self.request('new_round', title='SYNTHETIC_NEW_ROUND_DELTA')
        with patch.object(self.store, 'state', side_effect=sqlite3.OperationalError(
                'SYNTHETIC_POSTCOMMIT_DELTA_READBACK_FAILURE')):
            response = self.post(request)
        body = self.assert_unconfirmed(request, response)
        fresh = Store(self.path)
        state = fresh.state(self.mid)
        children = [m for m in state['matters'] if m['parent'] == self.mid]
        self.assertEqual(len(children), 1)
        self.assertIn(request['request_id'], state['matter']['seen'])
        self.assertEqual(state['matter']['version'], self.before['version'] + 1)
        # A failed state read cannot discard the identity already known at COMMIT.
        self.assertEqual(body.get('new_matter'), children[0]['id'])
        child = fresh.state(body['new_matter'])['matter']
        self.assertEqual(child['parent'], self.mid)
        self.assertEqual(child['title'], request['title'])
        self.assertEqual(child['revision'], 0)
        self.assertEqual(child['values'], self.before['values'])

    def test_new_round_precommit_failure_keeps_all_matters_unchanged(self):
        before = copy.deepcopy(self.store.state(self.mid))
        request = self.request('new_round', title='SYNTHETIC_ROLLBACK_DELTA',
            simulate_failure=True)
        status, body = self.post(request)
        self.assertEqual(status, 409)
        self.assertIs(body['saved'], False)
        self.assertNotIn('committed', body)
        self.assertNotIn('new_matter', body)
        after = Store(self.path).state(self.mid)
        self.assertEqual(after, before)


if __name__ == '__main__':
    unittest.main()

