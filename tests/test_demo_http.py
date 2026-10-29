"""Two synthetic end-to-end HTTP checks for the public demo on loopback."""
import http.client
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import tempfile
import unittest
import uuid


class DemoHttp(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.process = subprocess.Popen(
            [sys.executable, "-u", "-m", "txsenser_pricing.s1_demo",
             "--db", str(Path(self.temp.name) / "synthetic.sqlite3"), "--port", "0"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=os.environ.copy())
        self.addCleanup(self.stop)
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(10), "Demo did not report a listening port")
            line = self.process.stdout.readline()
        match = re.search(r"http://127\.0\.0\.1:(\d+)", line)
        self.assertIsNotNone(match, "Demo did not start on loopback")
        self.port = int(match.group(1))

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process.stdout.close()

    def request(self, method, path, payload=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            body = None if payload is None else json.dumps(payload)
            headers = {"Origin": f"http://127.0.0.1:{self.port}"}
            if payload is not None:
                headers["Content-Type"] = "application/json"
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def state(self):
        status, body = self.request("GET", "/api/state?matter=demo-2026")
        self.assertEqual(status, 200)
        return json.loads(body)

    def act(self, state, op, **extra):
        request = dict(matter="demo-2026", version=state["matter"]["version"],
                       request_id=uuid.uuid4().hex, op=op, **extra)
        status, body = self.request("POST", "/api/action", request)
        return status, json.loads(body)

    def select(self):
        status, state = self.act(self.state(), "view",
                                 selected=["SYN-02", "SYN-03"], filters={})
        self.assertEqual(status, 200)
        self.assertIs(state["saved"], True)
        return state

    def edit(self, state, row_id, value):
        fields = ("family", "kind", "configuration", "pn", "market",
                  "application", "role", "tier", "currency", "unit")
        row = next(row for row in state["rows"] if row["id"] == row_id)
        return dict(id=row_id, old=state["matter"]["values"][row_id], new=value,
                    scope={key: row[key] for key in fields})

    def test_select_edit_and_reload_confirm_saved_draft(self):
        status, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("虚构价格演示".encode(), body)
        before = self.select()
        status, result = self.act(before, "edit",
                                  edits=[self.edit(before, "SYN-02", "1500")])
        self.assertEqual(status, 200)
        self.assertIs(result["saved"], True)
        fresh = self.state()
        self.assertEqual(fresh["matter"]["values"]["SYN-02"], "1500.00")
        self.assertEqual(fresh["matter"]["revision"], before["matter"]["revision"] + 1)
        self.assertEqual(len(fresh["matter"]["history"]), 1)

    def test_invalid_batch_returns_error_without_partial_save(self):
        before = self.select()
        status, result = self.act(before, "edit", edits=[
            self.edit(before, "SYN-02", "1500"),
            self.edit(before, "SYN-03", "oops")])
        self.assertEqual(status, 409)
        self.assertIs(result["saved"], False)
        self.assertIn("第2行", result["error"])
        self.assertEqual(self.state()["matter"], before["matter"])


if __name__ == "__main__":
    unittest.main()

