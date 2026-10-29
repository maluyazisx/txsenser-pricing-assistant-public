'use strict';
// One real-browser scenario against the existing synthetic loopback application.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

function startServer(root, directory) {
  const server = spawn('python3', ['-u', '-m', 'txsenser_pricing.s1_demo',
    '--db', path.join(directory, 'synthetic.sqlite3'), '--port', '0'], {
    cwd: root, env: {...process.env, PYTHONPATH: path.join(root, 'src')},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(Error('Synthetic server startup timed out')), 10000);
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(Error(`Synthetic server exited before startup: ${code ?? signal}`));
    });
    server.stdout.on('data', chunk => {
      output = (output + chunk.toString()).slice(-4096);
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    // Drain stderr without creating an archive of application messages.
    server.stderr.on('data', () => {});
  });
  return {server, ready};
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise(resolve => {
    const timeout = setTimeout(() => server.kill('SIGKILL'), 5000);
    server.once('exit', () => { clearTimeout(timeout); resolve(); });
    server.kill('SIGTERM');
  });
}

(async () => {
  assert.notEqual(typeof process.getuid === 'function' ? process.getuid() : -1, 0,
    'Run the browser under the normal hosted runner user with its sandbox enabled');
  const root = path.resolve(__dirname, '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-synthetic-browser-'));
  const output = path.join(root, 'test-results');
  fs.mkdirSync(output, {recursive: true});
  assert.ok(!fs.readFileSync(path.join(root,'src/txsenser_pricing/s1_static/index.html'),'utf8').includes('fx-panel'),'Only run against the reviewed sanitized no-FX public export');
  const {server, ready} = startServer(root, directory);
  let browser;
  try {
    const origin = await ready;
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
      chromiumSandbox: true,
      headless: true
    });
    const page = await browser.newPage({viewport: {width: 1440, height: 960}});
    const errors = [], externalRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.goto(origin + '/', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('saveStatus').textContent.includes('已载入草稿'));
    const perform = async (op, action) => {
      const waiting=page.waitForResponse(response=>response.url()===origin+'/api/action'&&response.request().method()==='POST'&&response.request().postDataJSON().op===op);
      await action();const response=await waiting;assert.equal(response.status(),200);const data=await response.json();assert.equal(data.saved,true);
      await page.waitForFunction(()=>typeof busy==='boolean'&&!busy&&!loading);return data;
    };
    assert.equal(await page.locator('#roleMatrix .role-group').count(),5);
    assert.equal(await page.locator('#roleMatrix tbody tr').count(),6);
    await perform('view',()=>page.locator('#roleMatrix input[type="checkbox"][data-row="MX-01-2"]').check());
    const price=page.locator('#roleMatrix input.price[data-row="MX-01-2"]');await price.fill('2000.00');
    const preview=await perform('draft_preview',()=>price.press('Enter'));
    assert.equal(preview.matter.values['MX-01-2'],'2050.00');assert.equal(preview.matter.quote_records.length,0);
    const adjusted=await perform('draft_confirm',()=>page.locator('#draftConfirm').click());
    assert.equal(adjusted.matter.values['MX-01-2'],'2000.00');assert.equal(adjusted.matter.values['MX-01-1'],'2200.00');
    assert.equal(adjusted.rows.find(r=>r.id==='MX-01-2').baseline,'2050.00');
    const fillInquiry=async quantity=>{
      for(const [id,value] of Object.entries({wbCustomer:'DEMO-C-A',wbProject:'DEMO-P-A',wbProduct:'DEMO-LUMEN',wbMarket:'国际',wbApplication:'通用工业',wbRole:'经销',wbCurrency:'USD',wbUnit:'台',wbConditions:'标准演示条件'}))await page.locator('#'+id).selectOption(value);
      await page.locator('#wbQuantity').fill(quantity);
    };
    const missing=await perform('inquiry',()=>page.locator('#wbAnalyze').click());assert.equal(missing.analysis.status,'NEEDS_INFO');
    await fillInquiry('5');const analysis=await perform('inquiry',()=>page.locator('#wbAnalyze').click());assert.equal(analysis.analysis.references[0].amount,'300.00');
    const unsaved=await perform('quote_preview',()=>page.locator('#wbQuotePrepare').click());assert.equal(unsaved.matter.quote_records.length,0);
    const canceled=await perform('quote_cancel',()=>page.locator('#wbQuoteCancel').click());assert.equal(canceled.matter.quote_records.length,0);
    await perform('quote_preview',()=>page.locator('#wbQuotePrepare').click());await page.locator('#wbAcknowledged').check();
    const confirmed=await perform('quote_confirm',()=>page.locator('#wbQuoteConfirm').click());const first=confirmed.record;assert.equal(first.phase,'quoted_demo');
    await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('已载入草稿'));
    assert.ok((await page.locator('#wbHistory').innerText()).includes(first.id));
    await fillInquiry('10');const repeated=await perform('inquiry',()=>page.locator('#wbAnalyze').click());
    assert.equal(repeated.analysis.history[0].id,first.id);assert.ok(repeated.analysis.history[0].differences.some(v=>v.includes('数量')));assert.equal(repeated.analysis.references[0].amount,'280.00');
    await page.locator('#wbHistory details').first().locator('summary').click();await page.getByRole('button',{name:'准备更正（保留旧版）',exact:true}).click();
    await page.locator('#wbQuantity').fill('10');await page.locator('#wbAmount').fill('290.00');await page.locator('#wbReason').selectOption('更正数量');
    await perform('quote_preview',()=>page.locator('#wbQuotePrepare').click());await page.locator('#wbAcknowledged').check();
    const corrected=await perform('quote_confirm',()=>page.locator('#wbQuoteConfirm').click());
    assert.equal(corrected.record.id,first.id);assert.equal(corrected.record.version,2);assert.equal(corrected.matter.quote_records.length,2);assert.deepEqual(corrected.matter.quote_records[0],first);
    assert.equal(corrected.matter.values['MX-04-3'],'280.00');
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    await price.scrollIntoViewIfNeeded();
    await page.screenshot({path: path.join(output, 'pricing-synthetic.png'),fullPage:true});
    console.log(JSON.stringify({status: 'SYNTHETIC_BROWSER_PASS',
      candidate: process.env.GITHUB_SHA || null, chromiumSandbox: true,
      browser: browser.version(), matrixRows:24,
      scenario: 'matrix_preview_confirm_inquiry_quote_cancel_confirm_reload_reuse_append_correction', screenshot: 'test-results/pricing-synthetic.png',
      limit: 'Synthetic demonstration only; not business or production acceptance'}));
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      await stopServer(server);
      fs.rmSync(directory, {recursive: true, force: true});
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
