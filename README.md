# TxSenser Pricing Demo

A small offline demonstration of a pricing workbench. All 30 price rows are invented examples. The assistant is a deterministic simulation, not a connected AI service. This snapshot does not read company pricing, customer records or mail.

## Run the interactive demo

Python 3.11 or newer is sufficient; no runtime packages are required.

```sh
PYTHONPATH=src python3 -m txsenser_pricing.s1_demo --db .s1-demo/synthetic.sqlite3 --port 8765
```

Open http://127.0.0.1:8765/ in the same computer's browser. The application deliberately binds only to loopback and checks the request host and origin. No public application server, tunnel, authentication service or real-data connection is configured.

Try filtering by currency, selecting a synthetic row, changing its draft amount and pressing Enter. Compare selected rows using the simulated assistant. Draft history and conversations are kept in the separate local synthetic database. Do not enter private business data in this demonstration.

## Focused checks

The standard GitHub-hosted Ubuntu workflow runs 18 save/batch checks, four simulated UI boundary checks and two real loopback HTTP checks, followed by one real-browser scenario. It needs no project secrets or external rate service and does not repeat a broader historical test suite.

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_s1_batch_error.py' -v
PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_s1_postcommit_ack.py' -v
PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_s1_committed_round_delta.py' -v
node tests/test_s1_frontend_safety.cjs '^F[1-4] '
PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_demo_http.py' -v
```

The four focused UI checks use a simulated document and in-memory responses. The separate browser scenario starts the existing Python application on loopback, opens the page in the hosted runner's Chrome with its sandbox enabled, changes one invented draft amount, then reloads and confirms it remains saved. The workflow installs only the pinned Playwright 1.55.1 driver and retains one synthetic screenshot for seven days. It does not expose the application as a hosted service.

A successful browser run establishes only that scenario for the checked snapshot. It does not establish business or production acceptance. No browser success is claimed until the workflow has actually completed.

## Public snapshot scope

This repository contains only the selected demo code and applicable synthetic tests. It has no original repository history, governance records, real pricing files or historical execution logs. External reference rates and commercial conversion assumptions are excluded from this offline snapshot.

The interactive page requires the Python/SQLite API; copying its static assets to GitHub Pages does not provide a working interactive demo. No static-only product rewrite is included.

Public visibility does not by itself grant a software license.

