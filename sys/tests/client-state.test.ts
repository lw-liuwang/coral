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
  <input id="preview-vault" value="default"><section class="writing-surface"><div class="draft-notice" hidden><span data-draft-message>有未保存的本地草稿</span><button type="button" data-restore-draft>恢复草稿</button><button type="button" data-discard-draft>丢弃草稿</button></div><textarea id="editor" name="content">${isNew ? '' : '# Original\n\nOriginal body'}</textarea><div id="markdown-editor"></div><div id="preview"></div><button type="button" data-focus-editor>专注模式</button><div id="save-status"></div><div id="word-count"></div><div id="save-error" hidden></div><div id="conflict-actions" hidden><a data-latest-document href="/document?uri=coral%3A%2F%2Fvault%2Fdefault%2Fnote.md" target="_blank">打开最新版本</a><button type="button" data-download-draft>下载当前草稿</button></div></section></form>`
    : '<div data-document-update-error hidden></div><div data-reading-update hidden style="position:fixed;bottom:12px;right:12px"><span>笔记已更新</span><button type="button" data-load-update>加载更新</button></div><article data-reading-document="coral://vault/default/note.md" data-reading-directory="coral://vault/default/" data-reading-version="v1"><h2 id="first">First</h2><div style="height:1800px">Body</div><h2 id="second">Second</h2><div style="height:1800px">End</div></article>'}</body></html>`;

async function mount(page: Page, editing: boolean) {
  await page.addScriptTag({ content: bundle });
  await page.evaluate(edit => {
    const clients = (window as unknown as { CoralClients: { mountEditor(): void; mountReading(): void } }).CoralClients;
    if (edit) clients.mountEditor(); else clients.mountReading();
  }, editing);
}

test('new notes keep independent editor IDs and auto-recover a migrated draft while preserving its legacy copy', { skip: !available, timeout: 30000 }, async () => {
  const context = await browser.newContext();
  try {
    await context.route('http://coral.test/**', route => route.fulfill({ contentType: route.request().url().includes('/api/') ? 'application/json' : 'text/html',
      body: route.request().url().includes('/api/') ? '{"html":"Preview"}' : fixture(true, true) }));
    const first = await context.newPage(), second = await context.newPage();
    await first.goto('http://coral.test/new?vault=default');
    await first.evaluate(() => localStorage.setItem('coral:draft:new:default', JSON.stringify({ content: 'Legacy draft', title: 'Legacy title', directory: 'old', version: '', updated: 1 })));
    await mount(first, true);
    assert.equal(await first.locator('.draft-notice').isVisible(), true);
    assert.equal(await first.locator('[data-draft-message]').textContent(), '已恢复本地草稿');
    assert.equal(await first.locator('[data-restore-draft]').isHidden(), true);
    const firstId = new URL(first.url()).searchParams.get('draft');
    assert.ok(firstId);
    await second.goto('http://coral.test/new?vault=default');
    await mount(second, true);
    const secondId = new URL(second.url()).searchParams.get('draft');
    assert.ok(secondId && secondId !== firstId);
    assert.equal(await second.locator('[name="title"]').inputValue(), '');
    assert.equal(await first.locator('.cm-content').textContent(), 'Legacy draft');
    const legacy = await first.evaluate(() => localStorage.getItem('coral:draft:new:default'));
    assert.equal(JSON.parse(legacy!).content, 'Legacy draft');
    assert.equal(await first.evaluate(() => localStorage.getItem('coral:migrated-draft:coral:draft:new:default')), legacy);
    await second.locator('[name="title"]').fill('Second title');
    await second.locator('.cm-content').fill('Independent second draft');
    await second.waitForFunction(() => document.querySelector('#save-status')?.textContent === '草稿已存于本机');
    first.on('dialog', dialog => dialog.accept());
    await first.reload();
    await mount(first, true);
    assert.equal(new URL(first.url()).searchParams.get('draft'), firstId);
    assert.equal(await first.locator('[data-restore-draft]').isHidden(), true);
    assert.equal(await first.locator('.cm-content').textContent(), 'Legacy draft');
    assert.equal(await first.locator('[name="title"]').inputValue(), 'Legacy title');
    assert.equal(await first.locator('[name="directory"]').inputValue(), 'old');
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
    const drafts = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('coral:draft:v2:'))
      .map(key => JSON.parse(localStorage.getItem(key)!)).filter(record => record.resource === 'coral://vault/default/note.md' && record.state === 'active'));
    assert.equal(drafts.length, 1);
    const draft = drafts[0];
    assert.equal(draft.content, '---\ntitle: Current draft\n---\nComplete current body');
    assert.equal(draft.version, 'v2');
    assert.equal(draft.editor, new URL(page.url()).searchParams.get('draft'));
    assert.equal(typeof draft.writer, 'string');
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

test('reading preserves position and selection until an explicit update, honors navigation and reports failures', { skip: !available, timeout: 30000 }, async () => {
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
    let navigations = 0;
    page.on('framenavigated', () => navigations++);
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector('#second')!);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('[data-reading-update]')!.hidden);
    assert.equal(navigations, 0);
    assert.equal(await page.locator('article').getAttribute('data-reading-version'), 'v1');
    assert.equal(await page.evaluate(() => getSelection()!.toString()), 'Second');
    assert.equal(await page.evaluate(() => scrollY), y);
    assert.equal(await page.locator('[data-document-update-error]').isHidden(), true);
    const reload = page.waitForEvent('domcontentloaded');
    await page.locator('[data-load-update]').click();
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

const tocFixture = () => `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0}.topbar{height:40px;position:sticky;top:0;background:white}
  details{position:fixed;top:50px;left:0;width:210px}.article-toc-scroll{height:120px;overflow:auto}
  nav a{display:block;height:28px}article{margin-left:230px;padding-top:40px}h2{margin:0;height:40px;scroll-margin-top:56px}
  section{height:300px}section:last-child{height:100px}
  </style></head><body><header class="topbar"></header><details open><summary>文章目录</summary>
  <nav class="article-toc-scroll" data-article-toc>${Array.from({ length: 24 }, (_, i) => `<a href="#${encodeURIComponent('章节-' + i)}">章节 ${i}</a>`).join('')}<a href="#%ZZ">无效目标</a></nav></details>
  <article data-reading-document="coral://vault/default/toc.md" data-reading-directory="coral://vault/default/">${Array.from({ length: 24 }, (_, i) => `<section><h2 id="章节-${i}">章节 ${i}</h2>正文 ${i}</section>`).join('')}</article></body></html>`;

test('article TOC follows restored reading positions and scrolls its own container without moving the article', { skip: !available, timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    await context.route('http://coral.test/**', route => route.fulfill({ contentType: 'text/html', body: tocFixture() }));
    const page = await context.newPage();
    await page.goto('http://coral.test/document?return_to=%2Fsearch%3Fq%3Dtoc');
    await page.evaluate(() => localStorage.setItem('coral:reading-position:coral://vault/default/toc.md', JSON.stringify({ heading: '章节-16', offset: 0, y: 0 })));
    await mount(page, false);
    const active = page.locator('[data-article-toc] [aria-current="location"]');
    await page.waitForFunction(() => document.querySelector('[data-article-toc] [aria-current]')?.textContent === '章节 16');
    const restoredY = await page.evaluate(() => scrollY);
    assert.ok(restoredY > 4000);
    assert.equal(await active.count(), 1);
    assert.equal(await active.evaluate(link => {
      const viewport = link.parentElement!.getBoundingClientRect(), item = link.getBoundingClientRect();
      return item.top >= viewport.top && item.bottom <= viewport.bottom;
    }), true);
    assert.equal(await page.evaluate(() => scrollY), restoredY);
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForFunction(() => document.querySelector('[data-article-toc] [aria-current]')?.textContent === '章节 0');
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForFunction(() => document.querySelector('[data-article-toc] [aria-current]')?.textContent === '章节 23');
    const bottomY = await page.evaluate(() => scrollY);
    assert.ok(await page.locator('[data-article-toc]').evaluate(nav => nav.scrollTop > 0));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await page.evaluate(() => scrollY), bottomY);

    const chapter = (number: number) => page.getByRole('link', { name: '章节 ' + number, exact: true });
    for (const number of [8, 18]) {
      await chapter(number).focus();
      await chapter(number).press('Enter');
      await page.waitForFunction(number => document.querySelector('[data-article-toc] [aria-current]')?.textContent === '章节 ' + number, number);
      assert.equal(decodeURIComponent(new URL(page.url()).hash), '#章节-' + number);
      assert.equal(new URL(page.url()).searchParams.get('return_to'), '/search?q=toc');
    }
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('[data-article-toc] [aria-current]')?.textContent === '章节 8');
    await page.goForward();
    await page.waitForFunction(() => document.querySelector('[data-article-toc] [aria-current]')?.textContent === '章节 18');
    await page.setViewportSize({ width: 1280, height: 600 });
    assert.equal(await active.textContent(), '章节 18');
  } finally { await context.close(); }
});

test('article TOC honors explicit hashes and works when reading storage is unavailable', { skip: !available, timeout: 30000 }, async () => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage disabled'); } }));
    await context.route('http://coral.test/**', route => route.fulfill({ contentType: 'text/html', body: tocFixture() }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://coral.test/document?reading=start#' + encodeURIComponent('章节-12'));
    await mount(page, false);
    await page.waitForFunction(() => document.querySelector('[data-article-toc] [aria-current]')?.textContent === '章节 12');
    assert.equal(new URL(page.url()).searchParams.has('reading'), false);
    assert.equal(decodeURIComponent(new URL(page.url()).hash), '#章节-12');
    await page.getByRole('link', { name: '章节 3', exact: true }).focus();
    await page.getByRole('link', { name: '章节 3', exact: true }).press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-article-toc] [aria-current]')?.textContent === '章节 3');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
