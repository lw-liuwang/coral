import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

// A repeatable workload, isolated from the configured vaults and running server.
const args = process.argv.slice(2);
const fence = String.fromCharCode(96).repeat(3);
if (args.includes('--output') && !args[args.indexOf('--output') + 1]) throw new Error('--output requires a filename');
const output = args.includes('--output') ? resolve(args[args.indexOf('--output') + 1]) : undefined;
const directory = await mkdtemp(join(tmpdir(), 'coral-performance-'));
let child, browser;
try {
  const vault = join(directory, 'obsdian/bench');
  await mkdir(vault, { recursive: true });
  await writeFile(join(vault, '.coral-vault.json'), JSON.stringify({ id: 'bench' }));
  for (let group = 0; group < 10; group++) {
    const folder = join(vault, `group-${String(group).padStart(2, '0')}`);
    await mkdir(join(folder, 'assets'), { recursive: true });
    for (let i = 0; i < 50; i++) {
      const id = `00000000-0000-0000-0000-${String(group * 50 + i + 1).padStart(12, '0')}`;
      const body = `# Note ${group}-${i}\n\n` + Array.from({ length: 15 }, (_, j) =>
        `## Section ${j}\n\n  KV bandwidth cache measurements. ${'A paragraph with **important** content and [link](00.md). '.repeat(4)}\n\n[[00]]\n\n${fence}go\nfunc sample${j}() string { return "example" }\n${fence}\n\n`).join('');
      const metadata = `---\ntitle: Note ${group}-${i}\ncoral_note_id: ${id}\ncoral_language: zh\ncoral_primary: true\n---\n`;
      const name = String(i).padStart(2, '0');
      await writeFile(join(folder, name + '.md'), metadata + body);
      if (i % 10 === 0) await writeFile(join(folder, name + '.en.md'), metadata.replace('language: zh', 'language: en').replace('primary: true', 'primary: false') + body);
    }
    await writeFile(join(folder, 'assets/image.bin'), Buffer.alloc(1024 * 1024, 'x'));
  }
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ data_dir: directory }));
  child = spawn(resolve('dist', process.platform === 'win32' ? 'coral.exe' : 'coral'), ['--config', config, '--listen', '127.0.0.1:0'],
    { windowsHide: true, env: { ...process.env, CORAL_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const base = await new Promise((resolve, reject) => {
    let log = '';
    const timeout = setTimeout(() => reject(new Error('Server startup timed out: ' + log)), 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stderr.on('data', data => { log += data; });
    child.stdout.on('data', data => {
      log += data;
      const match = /coral: (http:\/\/[^\s]+)/.exec(log);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const uri = 'coral://vault/bench/group-00/00.md';
  const paths = {
    catalog: '/', directory: '/?vault=bench&directory=group-00',
    document: '/document?' + new URLSearchParams({ uri }),
    version_check: '/api/document?' + new URLSearchParams({ uri, max_chars: '1' }),
    search: '/api/search?vault=bench&q=KV%20bandwidth',
  };
  const request = async path => {
    const start = performance.now();
    const response = await fetch(base + path);
    const bytes = (await response.arrayBuffer()).byteLength;
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return { ms: Math.round((performance.now() - start) * 10) / 10, bytes };
  };
  const results = { fixture: { notes: 500, translations: 50, attachment_bytes: 10 * 1024 * 1024 }, requests: {} };
  for (const [name, path] of Object.entries(paths)) {
    const first = await request(path);
    const warm = [];
    for (let i = 0; i < 5; i++) warm.push((await request(path)).ms);
    warm.sort((a, b) => a - b);
    results.requests[name] = { first_ms: first.ms, warm_median_ms: warm[2], warm_max_ms: warm[4], response_bytes: first.bytes };
  }
  results.concurrent_document_version_search_ms = await Promise.all([paths.document, paths.version_check, paths.search].map(async path => (await request(path)).ms));
  if (args.includes('--browser')) {
    const { chromium } = await import('@playwright/test');
    const ui = join(directory, 'obsdian/ui');
    await mkdir(ui); await writeFile(join(ui, '.coral-vault.json'), '{"id":"ui"}');
    const plain = Array.from({ length: 150 }, (_, i) => `## Section ${i}\n\n  A long article for measuring scrolling. ${'A paragraph of readable content. '.repeat(20)}\n\n`).join('');
    const math = Array.from({ length: 150 }, (_, i) => `## Section ${i}\n\n  Inline $x_i = y_i + z_i$ and a displayed equation:\n\n$$\n\\operatorname{softmax}(x)_i = \\frac{e^{x_i}}{\\sum_j e^{x_j}}\n$$\n\n`).join('');
    browser = await chromium.launch({ headless: true, ...(process.env.CORAL_BROWSER_EXECUTABLE ? { executablePath: process.env.CORAL_BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.addInitScript(() => {
      window.__longTasks = [];
      document.addEventListener('coral:math-ready', () => { window.__mathReady = performance.now(); });
      new PerformanceObserver(list => { for (const task of list.getEntries()) window.__longTasks.push({ start: Math.round(task.startTime), ms: Math.round(task.duration) }); }).observe({ type: 'longtask', buffered: true });
    });
    results.browser = {};
    for (const [name, body] of [['plain', plain], ['math', math]]) {
      await writeFile(join(ui, name + '.md'), `---\ntitle: ${name}\n---\n# ${name}\n\n` + body);
      await page.goto(base + '/document?' + new URLSearchParams({ uri: `coral://vault/ui/${name}.md` }), { waitUntil: 'networkidle' });
      if (name === 'math') await page.waitForFunction(() => document.querySelectorAll('[data-math-rendered]').length === 300);
      results.browser[name] = await page.evaluate(async () => {
        const navigation = performance.getEntriesByType('navigation')[0];
        const frames = []; let last = performance.now();
        for (let n = 0; n < 90; n++) {
          await new Promise(requestAnimationFrame);
          const now = performance.now(); frames.push(now - last); last = now; window.scrollBy(0, 80);
        }
        return { response_ms: Math.round(navigation.responseStart), dom_ready_ms: Math.round(navigation.domContentLoadedEventEnd),
          math_ready_ms: window.__mathReady === undefined ? null : Math.round(window.__mathReady),
          long_tasks: window.__longTasks, max_frame_ms: Math.round(Math.max(...frames)), frames_over_33ms: frames.filter(ms => ms > 33).length,
          client: performance.getEntriesByType('resource').filter(r => r.name.endsWith('/client.js')).map(r => ({ transfer: r.transferSize, body: r.encodedBodySize })),
          editor_loaded: performance.getEntriesByType('resource').some(r => /\/editor-/.test(r.name)) };
      });
      if (output) { await mkdir(dirname(output), { recursive: true }); await page.screenshot({ path: join(dirname(output), name + '.png') }); }
    }
  }
  console.log(JSON.stringify(results, null, 2));
  if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(results, null, 2) + '\n'); }
  await browser?.close(); browser = undefined;
  child.kill(); await exited; child = undefined;
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  if (dirname(directory) !== resolve(tmpdir()) || !directory.startsWith(join(tmpdir(), 'coral-performance-'))) throw new Error('Unexpected benchmark directory');
  await rm(directory, { recursive: true, force: true });
}
