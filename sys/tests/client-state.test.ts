import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from '@playwright/test';

const executablePath = process.env.CORAL_BROWSER_EXECUTABLE
  ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : chromium.executablePath());
const available = existsSync(executablePath);
let browser: Browser;
let bundle: string;
before(async () => {
  if (!available) return;
  browser = await chromium.launch({ executablePath, headless: true });
  const built = await build({ stdin: {
    contents: 'export { mountReading } from "./reading.ts"; export { mountEditor } from "./editor.ts";',
    resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'ts',
  }, bundle: true, write: false, format: 'iife', globalName: 'CoralClients', platform: 'browser' });
  bundle = built.outputFiles[0].text;
});
after(async () => { await browser?.close(); });

const fixture = (editing: boolean, isNew = false) => `<!doctype html><html><head><meta charset="utf-8"><meta name="editor-style-nonce" content="test-nonce"><style>[hidden]{display:none!important}.cm-editor{height:250px}.topbar{height:40px}</style></head><body>
  <header class="topbar"></header>${editing ? `<button type="submit" form="editor-form">保存</button><form id="editor-form" action="/${isNew ? 'new' : 'edit'}" method="post">
  ${isNew ? '<input name="title" value=""><input name="directory" value="">' : '<input name="uri" value="coral://vault/default/note.md"><input name="version" value="v1"><input id="preview-uri" value="coral://vault/default/note.md">'}
  <input id="preview-vault" value="default"><section class="writing-surface"><div class="draft-notice" hidden><button type="button" data-restore-draft>恢复草稿</button><button type="button" data-discard-draft>丢弃草稿</button></div><textarea id="editor" name="content">${isNew ? '' : '# Original\n\nOriginal body'}</textarea><div id="markdown-editor"></div><div id="preview"></div><button type="button" data-focus-editor>专注模式</button><div id="save-status"></div><div id="word-count"></div><div id="save-error" hidden></div><div id="conflict-actions" hidden><a data-latest-document href="/document?uri=coral%3A%2F%2Fvault%2Fdefault%2Fnote.md" target="_blank">打开最新版本</a><button type="button" data-download-draft>下载当前草稿</button></div></section></form>`
    : '<div data-document-update-error hidden></div><article data-reading-document="coral://vault/default/note.md" data-reading-directory="coral://vault/default/" data-reading-version="v1"><h2 id="first">First</h2><div style="height:1800px">Body</div><h2 id="second">Second</h2><div style="height:1800px">End</div></article>'}</body></html>`;

async function mount(page: Page, editing: boolean) {
  await page.addScriptTag({ content: bundle });
  await page.evaluate(edit => {
    const clients = (window as unknown as { CoralClients: { mountEditor(): void; mountReading(): void } }).CoralClients;
    if (edit) clients.mountEditor(); else clients.mountReading();
  }, editing);
}

test('new notes have independent persistent draft IDs and migrate an old draft only after restoration', { skip: !available, timeout: 30000 }, async () => {
  const context = await browser.newContext();
  try {
    await context.route('http://coral.test/**', route => route.fulfill({ contentType: route.request().url().includes('/api/') ? 'application/json' : 'text/html',
      body: route.request().url().includes('/api/') ? '{"html":"Preview"}' : fixture(true, true) }));
    const first = await context.newPage(), second = await context.newPage();
    await first.goto('http://coral.test/new?vault=default');
    await first.evaluate(() => localStorage.setItem('coral:draft:new:default', JSON.stringify({ content: 'Legacy draft', title: 'Legacy title', directory: 'old', version: '', updated: 1 })));
    await mount(first, true);
    assert.equal(await first.locator('.draft-notice').isVisible(), true);
    const firstId = new URL(first.url()).searchParams.get('draft');
    assert.ok(firstId);
    await second.goto('http://coral.test/new?vault=default');
    await mount(second, true);
    const secondId = new URL(second.url()).searchParams.get('draft');
    assert.ok(secondId && secondId !== firstId);
    await first.locator('[data-restore-draft]').click();
    assert.equal(await first.locator('.cm-content').textContent(), 'Legacy draft');
    assert.equal(await first.evaluate(() => localStorage.getItem('coral:draft:new:default')), null);
    await second.locator('[name="title"]').fill('Second title');
    await second.locator('.cm-content').fill('Independent second draft');
    await second.waitForFunction(() => document.querySelector('#save-status')?.textContent === '草稿已存于本机');
    first.on('dialog', dialog => dialog.accept());
    await first.reload();
    await mount(first, true);
    assert.equal(new URL(first.url()).searchParams.get('draft'), firstId);
    await first.locator('[data-restore-draft]').click();
    assert.equal(await first.locator('.cm-content').textContent(), 'Legacy draft');
    assert.equal(await second.locator('.cm-content').textContent(), 'Independent second draft');
  } finally { await context.close(); }
});

test('edits made during saving remain a local draft and conflicts retain the old version with a complete download', { skip: !available, timeout: 30000 }, async () => {
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let requestStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    let saves = 0;
    await context.route('http://coral.test/**', async route => {
      const request = route.request();
      if (request.url().includes('/api/preview')) { await route.fulfill({ json: { html: 'Preview' } }); return; }
      if (request.method() === 'POST') {
        saves++;
        if (saves === 1) { requestStarted(); await held; await route.fulfill({ json: { version: 'v2', url: '/document' } }); }
        else await route.fulfill({ status: 409, json: { error: '文档已被修改，请重新打开后再保存' } });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: fixture(true) });
    });
    const page = await context.newPage();
    await page.goto('http://coral.test/edit');
    await mount(page, true);
    await page.locator('.cm-content').fill('Submitted version');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await started;
    await page.locator('.cm-content').fill('---\ntitle: Current draft\n---\nComplete current body');
    release();
    await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === '草稿已存于本机');
    assert.equal(await page.locator('[name="version"]').inputValue(), 'v2');
    const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('coral:draft:coral://vault/default/note.md')!));
    assert.equal(draft.content, '---\ntitle: Current draft\n---\nComplete current body');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === '保存失败');
    assert.equal(await page.locator('#conflict-actions').isVisible(), true);
    assert.equal(await page.locator('[name="version"]').inputValue(), 'v2');
    const downloadEvent = page.waitForEvent('download');
    await page.locator('[data-download-draft]').click();
    const download = await downloadEvent;
    const stream = await download.createReadStream();
    let downloaded = '';
    for await (const chunk of stream) downloaded += chunk;
    assert.equal(downloaded, draft.content);
  } finally { await context.close(); }
});

test('reading restores an anchor-relative position, honors explicit navigation and reports update failures', { skip: !available, timeout: 30000 }, async () => {
  const context = await browser.newContext();
  try {
    let version = 'v1', fail = false;
    await context.route('http://coral.test/**', route => {
      if (route.request().url().includes('/api/document')) return route.fulfill({ status: fail ? 404 : 200, json: fail ? { error: '文档不存在' } : { version } });
      let html = fixture(false).replace('data-reading-version="v1"', `data-reading-version="${version}"`);
      if (version === 'v2') html = html.replace('<h2 id="second">', '<div style="height:400px">New material</div><h2 id="second">');
      return route.fulfill({ contentType: 'text/html', body: html });
    });
    const page = await context.newPage();
    await page.goto('http://coral.test/document');
    await mount(page, false);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => window.scrollTo(0, 2200));
    await page.waitForFunction(() => localStorage.getItem('coral:reading-position:coral://vault/default/note.md') !== null);
    const y = await page.evaluate(() => window.scrollY);
    await page.reload();
    await mount(page, false);
    await page.waitForFunction(expected => Math.abs(window.scrollY - expected) < 3, y);
    fail = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('[data-document-update-error]')!.hidden);
    assert.equal(await page.locator('[data-document-update-error]').textContent(), '文档不存在');
    fail = false; version = 'v2';
    const reload = page.waitForEvent('domcontentloaded');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await reload;
    await mount(page, false);
    await page.waitForFunction(expected => Math.abs(window.scrollY - expected) < 3, y + 400);
    await page.goto('http://coral.test/document?reading=start#first');
    await mount(page, false);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(new URL(page.url()).searchParams.has('reading'), false);
    assert.equal(new URL(page.url()).hash, '#first');
    assert.ok(await page.evaluate(() => window.scrollY < 100));
  } finally { await context.close(); }
});
