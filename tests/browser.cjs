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
    assert.equal(await page.locator('#rows tr').count(), 30);
    await page.getByRole('checkbox', {name: '选中 SYN-02', exact: true}).check();
    await page.waitForFunction(() => document.getElementById('saveStatus').textContent.includes('选择已记录'));
    const price = page.getByRole('textbox', {name: 'SYN-02 拟调整价', exact: true});
    await price.fill('1500.00');
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + '/api/action' && response.request().method() === 'POST'),
      price.press('Enter')
    ]);
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).saved, true);
    await page.waitForFunction(() => document.getElementById('saveStatus').textContent.includes('草稿修改已确认保存'));
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('saveStatus').textContent.includes('已载入草稿'));
    assert.equal(await price.inputValue(), '1500.00');
    assert.match(await page.locator('#historyCount').innerText(), /1/);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    await price.scrollIntoViewIfNeeded();
    await page.screenshot({path: path.join(output, 'pricing-synthetic.png')});
    console.log(JSON.stringify({status: 'SYNTHETIC_BROWSER_PASS',
      candidate: process.env.GITHUB_SHA || null, chromiumSandbox: true,
      browser: browser.version(), rows: 30,
      scenario: 'load_select_edit_save_reload', screenshot: 'test-results/pricing-synthetic.png',
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
