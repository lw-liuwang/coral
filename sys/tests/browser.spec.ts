import { test as base, expect, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfig } from '../src/config.js';
import { createApp } from '../src/web.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const test = base.extend<{ applicationDirectory: string; applicationUrl: string }>({
  applicationDirectory: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-browser-'));
    try { await use(directory); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  },
  applicationUrl: async ({ applicationDirectory: directory }, use) => {
    const application = createApp(createConfig({ data_dir: directory }));
    application.registry.create('default', '项目设计', '# 数据模型\n\nMarkdown 是知识库的唯一内容真源。\n\n## 查询接口\n\n参见 [[开发记录]]。\n\n```typescript\nconst uri = "coral://vault/project/docs/design.md";\n```');
    application.registry.create('default', '开发记录', '# 迭代记录\n\n完成知识库查询与文件下载。');
    mkdirSync(join(directory, 'obsdian/default/assets'));
    writeFileSync(join(directory, 'obsdian/default/assets/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=', 'base64'));
    const server = application.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    try { await use(`http://127.0.0.1:${address.port}`); }
    finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      application.close();
    }
  },
});

async function openActions(page: Page, label: string) {
  const summary = page.getByLabel(label, { exact: true });
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
}

async function expectSimpleWorkspace(page: Page, scopedSearch = false) {
  const sidebar = page.getByRole('complementary', { name: '知识库导航' });
  const search = page.getByRole('search');
  await expect(page.getByRole('complementary')).toHaveCount(1);
  await expect(search).toHaveCount(1);
  await expect(sidebar.getByRole('search')).toHaveCount(1);
  await expect(search.getByRole('searchbox', { name: '搜索知识库' })).toBeVisible();
  await expect(search.getByRole('button', { name: '搜索', exact: true })).toBeVisible();
  await expect(search.locator('input[name="vault"]')).toHaveCount(0);
  await expect(search.getByRole('combobox', { name: '搜索范围' })).toHaveCount(scopedSearch ? 1 : 0);
  await expect(page.locator('dialog')).toHaveCount(0);
}

test('workspace navigation switches Vaults and uses one global search form', async ({ page, applicationUrl }, testInfo) => {
  const created = await page.request.post(applicationUrl + '/vaults/new', { form: { name: 'research' }, maxRedirects: 0 });
  expect(created.status()).toBe(303);
  for (const [vault, title] of [['default', '默认库记录'], ['research', '研究记录']]) {
    await page.request.post(applicationUrl + '/new', { form: { vault, title, content: '跨知识库检索样例' } });
  }
  await page.goto(applicationUrl + '/?vault=default');
  await expectSimpleWorkspace(page);
  const sidebar = page.getByRole('complementary', { name: '知识库导航' });
  await openActions(page, '切换知识库');
  const selected = sidebar.getByRole('link', { name: '打开知识库：default', exact: true });
  await expect(selected).toHaveAttribute('aria-current', 'true');
  const sidebarBox = (await sidebar.boundingBox())!;
  const contentBox = (await page.locator('.file-list').boundingBox())!;
  expect(contentBox.x).toBeGreaterThan(sidebarBox.x + sidebarBox.width);
  expect(contentBox.y).toBeLessThan(130);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('workspace-directory.png'), fullPage: true });
  await sidebar.getByRole('link', { name: '打开知识库：research', exact: true }).click();
  await expect(page.getByRole('link', { name: '研究记录', exact: true })).toBeVisible();
  await openActions(page, '切换知识库');
  await expect(sidebar.getByRole('link', { name: '打开知识库：research', exact: true })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('searchbox', { name: '搜索知识库' }).fill('跨知识库检索样例');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expectSimpleWorkspace(page, true);
  await expect(page.getByRole('combobox', { name: '搜索范围' })).toHaveValue('');
  await expect(page.locator('.result-item')).toHaveCount(2);
  await page.getByRole('combobox', { name: '搜索范围' }).selectOption('research');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.result-item')).toHaveCount(1);
  await page.locator('.result-item').getByRole('link', { name: '研究记录', exact: true }).click();
  await expectSimpleWorkspace(page);
  await expect(page.getByRole('link', { name: '编辑', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: '回收站', exact: true })).toHaveAttribute('href', '/trash?vault=research');
  await page.screenshot({ path: testInfo.outputPath('workspace-document.png'), fullPage: true });
});

test('find notes across Vaults, distinguish duplicate titles and open their directory', async ({ page, applicationUrl, applicationDirectory }) => {
  const root = join(applicationDirectory, 'obsdian/default');
  for (const folder of ['课程/基础', '课程/进阶']) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, '10.md'), '---\ntitle: 注意力机制\n---\n# 注意力机制\n\n目录定位样例');
  }
  await page.request.post(applicationUrl + '/vaults/new', { form: { name: 'research' } });
  await page.request.post(applicationUrl + '/new', { form: { vault: 'research', title: '注意力机制', content: '目录定位样例' } });
  await page.goto(applicationUrl);
  await expectSimpleWorkspace(page);
  await page.getByRole('searchbox', { name: '搜索知识库' }).fill('目录定位样例');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.result-item')).toHaveCount(3);
  await expectSimpleWorkspace(page, true);
  await expect(page.getByRole('combobox', { name: '搜索范围' })).toHaveValue('');
  const advanced = page.locator('.result-item').filter({ hasText: '课程/进阶/10.md' });
  await expect(advanced.locator('.result-location')).toHaveText('default / 课程/进阶/10.md');
  await page.getByRole('combobox', { name: '搜索范围' }).selectOption('research');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.result-item')).toHaveCount(1);
  await expect(page.locator('.result-location')).toContainText('research /');
  await page.getByRole('combobox', { name: '搜索范围' }).selectOption('');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await advanced.locator('.result-location').click();
  expect(new URL(page.url()).searchParams.get('directory')).toBe('课程/进阶');
  await expect(page.locator('.file-list li:target .page-link')).toHaveText('注意力机制');
  await page.goto(applicationUrl + '/search');
  await expect(page.getByText('没有找到匹配的内容。', { exact: true })).toHaveCount(0);
});

test('navigate a dense directory and return from editing without losing the current note', async ({ page, applicationUrl, applicationDirectory }, testInfo) => {
  const folder = '学习资料/长课程';
  const root = join(applicationDirectory, 'obsdian/default', folder);
  mkdirSync(join(root, '空文件夹'), { recursive: true });
  writeFileSync(join(root, 'index.md'), '---\ntitle: 课程目录\n---\n# 课程目录\n\n开始阅读。');
  for (let i = 1; i <= 36; i++) {
    const title = i === 31 || i === 32 ? '重复标题' : `第 ${i} 节 · 长标题中的目录导航与笔记定位`;
    writeFileSync(join(root, `${i}.md`), `---\ntitle: ${title}\n---\n# ${title}\n\n课程内容。\n\n## 机制\n\n${'解释原理与示例。\n\n'.repeat(8)}`);
  }
  const uri = `coral://vault/default/${folder.split('/').map(encodeURIComponent).join('/')}/35.md`;
  await page.goto(applicationUrl + '/document?' + new URLSearchParams({ uri }));
  await expectSimpleWorkspace(page);
  const nav = page.getByRole('navigation', { name: '文末阅读导航', exact: true });
  await expect(nav.locator('[rel="prev"] .reading-title')).toHaveText('第 34 节 · 长标题中的目录导航与笔记定位');
  await expect(nav.locator('[rel="next"] .reading-title')).toHaveText('第 36 节 · 长标题中的目录导航与笔记定位');
  await nav.locator('[rel="prev"]').click();
  await expect(page.locator('.page-head h1')).toHaveText('第 34 节 · 长标题中的目录导航与笔记定位');
  await nav.locator('[rel="next"]').click();
  await expect(page.locator('.page-head h1')).toHaveText('第 35 节 · 长标题中的目录导航与笔记定位');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('dense-directory-reading.png') });
  await page.getByRole('link', { name: '所在目录', exact: true }).click();
  await expect(page.locator('.file-list li:target .page-link')).toHaveText('第 35 节 · 长标题中的目录导航与笔记定位');
  for (const filename of ['31.md', '32.md']) {
    const row = page.locator(`.file-list li[data-document-uri$="/${filename}"]`);
    await expect(row.getByRole('link', { name: '重复标题', exact: true })).toBeVisible();
    await expect(row).toContainText(filename);
  }
  await page.locator('.file-list li[data-document-uri$="/10.md"] .page-link').click();
  await expect(page.locator('.page-head h1')).toHaveText('第 10 节 · 长标题中的目录导航与笔记定位');
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await expectSimpleWorkspace(page);
  await expect(page.getByRole('navigation', { name: '目录树', exact: true }).locator('[aria-current="page"]')).toHaveAttribute('href', /directory=/);
  await page.locator('.cm-content').fill('---\ntitle: 第 10 节 · 长标题中的目录导航与笔记定位\n---\n# 更新后的正文\n\n已修改并保存。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.getByRole('link', { name: '返回阅读', exact: true }).click();
  await expect(page.locator('article')).toContainText('已修改并保存。');
  const tree = page.getByRole('navigation', { name: '目录树', exact: true });
  await tree.getByRole('link', { name: '打开文件夹：学习资料/长课程/空文件夹', exact: true }).click();
  await expect(page.getByText('此目录暂无文档。', { exact: true })).toBeVisible();
  await tree.getByRole('link', { name: '打开文件夹：学习资料/长课程', exact: true }).click();
  await expect(page.locator('.file-list li .page-link').first()).toHaveText('课程目录');
  await expect(tree.getByRole('link', { name: /^打开笔记/ })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('dense-directory-list.png') });
});

test('workspace uses one sidebar and a reading area at desktop widths', async ({ page, applicationUrl, applicationDirectory }, testInfo) => {
  const folder = '推理系统/注意力机制';
  const root = join(applicationDirectory, 'obsdian/default');
  for (const directory of [folder, '推理系统/模型执行', '推理系统/并行计算']) mkdirSync(join(root, directory), { recursive: true });
  const titles = ['从一次请求看推理链路', 'Prefill 和 Decode', '注意力计算中的数据流', '为什么要缓存 K 和 V', '连续批处理如何工作', '分页管理 KV Cache', 'KV Cache 的容量与带宽', '一次 Decode 的访存过程', '多请求如何共享显存', '量化缓存的收益与代价', '前缀缓存的复用边界', '如何定位性能瓶颈'];
  const body = '# KV Cache 的容量与带宽\n\n一次解码只生成一个新 token，却要读取前面所有 token 的 K 和 V。上下文越长，需要读回的数据越多。\n\n## 先看一次 Decode\n\n模型为新 token 计算 Query，再把它与已有的 Key 做注意力计算。Value 按注意力权重汇总，结果继续进入下一层。缓存省去了旧 token 的重复计算，也带来了持续的内存读取。\n\n## 两个不同的限制\n\n| 限制 | 影响 |\n| --- | --- |\n| 容量 | 同时能容纳多少请求和上下文 |\n| 带宽 | 每一步解码要花多久读回缓存 |\n\n扩大批次能摊薄权重读取成本，同时也会增加缓存占用。因此，评估吞吐量时需要同时观察请求长度、批次大小和实际带宽。';
  titles.forEach((title, index) => writeFileSync(join(root, folder, `${index + 1}.md`), `---\ntitle: ${title}\n---\n${index === 6 ? body : `# ${title}\n\n${['从具体请求出发，追踪计算和数据流。', '理解机制，再比较适用条件。', '把计算、存储和调度放在一起看。'][index % 3]}`}`));
  await page.goto(applicationUrl + '/document?' + new URLSearchParams({ uri: 'coral://vault/default/' + folder.split('/').map(encodeURIComponent).join('/') + '/7.md' }));
  for (const width of [1280, 1600]) {
    await page.setViewportSize({ width, height: 960 });
    const tree = page.getByRole('navigation', { name: '目录树', exact: true });
    await expect(tree.locator('[aria-current="page"]')).toContainText('注意力机制');
    await expectSimpleWorkspace(page);
    await expect(page.locator('article')).toContainText('两个不同的限制');
    const sidebar = (await page.getByRole('complementary').boundingBox())!;
    const article = (await page.locator('article').boundingBox())!;
    expect(article.x).toBeGreaterThan(sidebar.x + sidebar.width);
    expect(article.width).toBeGreaterThan(680);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`workspace-reading-${width}.png`) });
  }
});

test('secondary actions stay discoverable and menus support keyboard dismissal', async ({ page, applicationUrl }, testInfo) => {
  await page.goto(applicationUrl + '/?vault=default');
  const first = page.getByLabel('文档操作：开发记录', { exact: true });
  const second = page.getByLabel('文档操作：项目设计', { exact: true });
  const rename = page.getByRole('link', { name: '重命名文档：开发记录', exact: true });
  await expect(first).toBeVisible();
  await expect(rename).toBeHidden();
  await expect(page.getByLabel('Markdown 文档')).toBeHidden();
  await expect(page.locator('[data-document-uri] .file-entry > .muted')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('clean-directory.png'), fullPage: true });
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(rename).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '复制文档 URI：开发记录', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(rename).toBeHidden();
  await expect(first).toBeFocused();
  await first.click();
  await second.focus();
  await page.keyboard.press('Enter');
  await expect(rename).toBeHidden();
  await expect(page.locator('.tools-menu[open]')).toHaveCount(1);
  await page.getByRole('heading', { level: 1 }).click();
  await expect(page.locator('.tools-menu[open]')).toHaveCount(0);
  await page.getByRole('link', { name: '项目设计', exact: true }).click();
  await expect(page.getByRole('link', { name: '编辑', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '移动', exact: true })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('clean-document.png'), fullPage: true });
});

test('native action and import menus work without JavaScript', async ({ browser, applicationUrl }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(applicationUrl + '/?vault=default');
    await openActions(page, '文档操作：项目设计');
    await page.getByRole('link', { name: '重命名文档：项目设计', exact: true }).click();
    await page.getByRole('textbox', { name: '文件名称（含扩展名）', exact: true }).fill('renamed.md');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(page.locator('.file-entry').filter({ has: page.getByRole('link', { name: '项目设计', exact: true }) })).toContainText('renamed.md');
    await openActions(page, '导入文档');
    await page.getByLabel('Markdown 文档').setInputFiles({ name: 'native.md', mimeType: 'text/markdown', buffer: Buffer.from('# Native import') });
    await page.getByRole('button', { name: '上传 Markdown', exact: true }).click();
    await expect(page.getByRole('link', { name: 'native', exact: true })).toBeVisible();
    await page.getByRole('searchbox', { name: '搜索知识库' }).fill('Native import');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(page.locator('.result-item')).toHaveCount(1);
  } finally { await context.close(); }
});

test('continuous reading remembers each directory and locates the last document on return', async ({ page, applicationUrl, applicationDirectory }, testInfo) => {
  const root = join(applicationDirectory, 'obsdian/default/课程 #1');
  mkdirSync(join(root, '其他目录'), { recursive: true });
  for (const number of [9, 10, 11, 100]) writeFileSync(join(root, number + '.md'), '---\ntitle: 第 ' + number + ' 篇\n---\n# 第 ' + number + ' 篇\n\n' + '课程正文。\n\n'.repeat(30));
  writeFileSync(join(root, '其他目录/note.md'), '---\ntitle: 其他课程\n---\n# 其他课程');
  const directory = applicationUrl + '/?' + new URLSearchParams({ vault: 'default', directory: '课程 #1' });
  await page.goto(directory);
  await expect(page.getByRole('region', { name: '阅读进度' })).toBeHidden();
  await page.getByRole('link', { name: '第 10 篇', exact: true }).click();
  const nav = page.getByRole('navigation', { name: '文末阅读导航', exact: true });
  await expect(nav).toContainText('第 2 / 4 篇');
  await expect(nav.locator('[rel="prev"] .reading-title')).toHaveText('第 9 篇');
  await expect(nav.locator('[rel="next"] .reading-title')).toHaveText('第 11 篇');
  await page.getByRole('navigation', { name: '文末阅读导航', exact: true }).locator('[rel="next"]').click();
  await expect(page.locator('.page-head h1')).toHaveText('第 11 篇');
  await page.getByRole('link', { name: '所在目录', exact: true }).click();
  await expect(page).toHaveURL(/#doc-[a-f0-9]+$/);
  const current = page.locator('.file-list .is-last-read');
  await expect(current.locator('.page-link')).toHaveText('第 11 篇');
  await expect(current.locator('.reading-marker')).toBeVisible();
  await expect(current).toBeInViewport();
  const resume = page.getByRole('region', { name: '阅读进度' });
  await expect(resume.locator('[data-resume-title]')).toHaveText('第 11 篇');
  await page.reload();
  await expect(current.locator('.page-link')).toHaveText('第 11 篇');
  await page.screenshot({ path: testInfo.outputPath('directory-reading-progress.png'), fullPage: true });
  await resume.getByRole('link', { name: '下一篇', exact: true }).click();
  await expect(page.locator('.page-head h1')).toHaveText('第 100 篇');
  await expect(nav.locator('[rel="next"]')).toHaveCount(0);
  await expect(nav).toContainText('已是本目录最后一篇');
  await page.screenshot({ path: testInfo.outputPath('continuous-reading.png') });
  await page.goBack();
  await expect(current.locator('.page-link')).toHaveText('第 100 篇');
  await expect(resume.getByRole('link', { name: '下一篇', exact: true })).toBeHidden();
  await page.goto(directory);
  await page.getByRole('link', { name: '其他目录', exact: true }).click();
  await expect(resume).toBeHidden();
  await page.getByRole('link', { name: '其他课程', exact: true }).click();
  await expect(nav).toContainText('第 1 / 1 篇');
  await expect(nav.locator('[rel]')).toHaveCount(0);
  await page.goto(directory);
  await expect(current.locator('.page-link')).toHaveText('第 100 篇');
  rmSync(join(root, '100.md'));
  await page.reload();
  await expect(resume).toBeHidden();
  await expect(current).toHaveCount(0);
});

test('reading navigation works when browser storage is disabled', async ({ page, applicationUrl, applicationDirectory }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException('Storage disabled', 'SecurityError'); };
    Storage.prototype.setItem = () => { throw new DOMException('Storage disabled', 'SecurityError'); };
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const root = join(applicationDirectory, 'obsdian/default');
  writeFileSync(join(root, '10.md'), '---\ntitle: Storage first\n---\n# Storage first');
  writeFileSync(join(root, '11.md'), '---\ntitle: Storage next\n---\n# Storage next');
  await page.goto(applicationUrl + '/document?' + new URLSearchParams({ uri: 'coral://vault/default/10.md' }));
  await page.getByRole('navigation', { name: '文末阅读导航', exact: true }).locator('[rel="next"]').click();
  await expect(page.locator('.page-head h1')).toHaveText('Storage next');
  await page.getByRole('link', { name: '所在目录', exact: true }).click();
  await expect(page.locator('.file-list li:target .page-link')).toHaveText('Storage next');
  await expect(page.getByRole('region', { name: '阅读进度' })).toBeHidden();
  expect(errors).toEqual([]);
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`refresh catalog after manual Vault changes at ${viewport.width}px`, async ({ page, applicationUrl, applicationDirectory }, testInfo) => {
    await page.setViewportSize(viewport);
    const created = await page.request.post(applicationUrl + '/vaults/new', { form: { name: 'manual' }, maxRedirects: 0 });
    expect(created.status()).toBe(303);
    await page.goto(applicationUrl);
    const refresh = page.getByRole('link', { name: '刷新知识库', exact: true });
    await expect(refresh.locator('svg.lucide-refresh-cw')).toBeVisible();
    await expect(page.getByRole('link', { name: 'default', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'manual', exact: true })).toBeVisible();

    rmSync(join(applicationDirectory, 'obsdian', 'default'), { recursive: true });
    rmSync(join(applicationDirectory, 'obsdian', 'manual'), { recursive: true });
    await refresh.click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('0 个');
    await expect(page.locator('.vault-list li')).toHaveCount(0);
    await expect(page.getByText('暂不可用', { exact: true })).toHaveCount(0);

    const restored = join(applicationDirectory, 'obsdian', 'restored');
    mkdirSync(restored);
    writeFileSync(join(restored, 'note.md'), '# Restored');
    await refresh.click();
    await expect(page.getByRole('link', { name: 'restored', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('1 个');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('refreshed-catalog.png'), fullPage: true });
  });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`copy folder URIs, rename entries and navigate full paths at ${viewport.width}px`, async ({ page, applicationUrl }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: applicationUrl });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.request.post(applicationUrl + '/new', { form: {
      vault: 'default', title: '深层文档', content: '# 深层文档\n\nOriginal content', directory: '团队资料/推理 系统',
    } });
    await page.goto(applicationUrl + '/?vault=default');
    const folderUri = 'coral://vault/default/' + encodeURIComponent('团队资料');
    await openActions(page, '文件夹操作：团队资料');
    const folderCopy = page.getByRole('button', { name: '复制文件夹 URI：团队资料', exact: true });
    await expect(folderCopy).toHaveAttribute('data-copy', folderUri);
    await folderCopy.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(folderUri);
    await page.getByRole('link', { name: '重命名文件夹：团队资料', exact: true }).click();
    const folderName = page.getByRole('textbox', { name: '文件夹名称', exact: true });
    await folderName.fill('assets');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('同名');
    await expect(folderName).toHaveValue('assets');
    await folderName.fill('团队资料-改名');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await page.getByRole('link', { name: '团队资料-改名', exact: true }).click();
    await page.getByRole('link', { name: '推理 系统', exact: true }).click();
    const crumbs = page.getByRole('navigation', { name: '当前位置', exact: true });
    await expect(crumbs).toContainText('团队资料-改名');
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('推理 系统');
    const currentUri = 'coral://vault/default/' + ['团队资料-改名', '推理 系统'].map(encodeURIComponent).join('/');
    await expect(page.locator('.document-uri')).toHaveCount(0);
    await expect(page.locator('.page-head [data-copy]')).toHaveAttribute('data-copy', currentUri);
    await expect(page.locator('.file-list .row-actions .icon-btn')).toHaveCount(0);
    await openActions(page, '文档操作：深层文档');
    const entryActions = page.locator('.file-list .row-actions').first().locator('.menu-content');
    await expect(entryActions.locator('.btn')).toHaveCount(4);
    await expect(entryActions).toContainText('复制链接');
    await expect(entryActions).toContainText('重命名');
    await expect(entryActions).toContainText('删除');
    await page.getByRole('link', { name: '深层文档', exact: true }).click();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('深层文档.md');
    await expect(crumbs.getByRole('link')).toHaveText(['全部知识库', 'default', '团队资料-改名', '推理 系统']);
    await page.getByRole('link', { name: '编辑', exact: true }).click();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('深层文档.md');
    await page.getByRole('link', { name: '返回阅读', exact: true }).click();
    await openActions(page, '文档操作');
    await page.getByRole('link', { name: '重命名', exact: true }).click();
    await page.getByRole('textbox', { name: '文件名称（含扩展名）', exact: true }).fill('新文件 #100%.md');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('新文件 #100%.md');
    await expect(page.locator('article')).toContainText('Original content');
    const documentUri = currentUri + '/' + encodeURIComponent('新文件 #100%.md');
    await expect(page.locator('.document-uri')).toHaveCount(0);
    const actions = page.locator('.page-head .btns');
    await openActions(page, '文档操作');
    const documentCopy = actions.getByRole('button', { name: '复制 Coral 链接', exact: true });
    await expect(documentCopy).toHaveAttribute('class', 'btn');
    await expect(actions.getByRole('link', { name: '重命名', exact: true })).toHaveAttribute('class', 'btn');
    await expect(documentCopy).toHaveAttribute('data-copy', documentUri);
    await documentCopy.click();
    await expect(documentCopy).toHaveText('复制链接');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(documentUri);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('full-document-path.png'), fullPage: true });
    await crumbs.getByRole('link', { name: '推理 系统', exact: true }).click();
    await openActions(page, '知识库工具');
    await page.getByRole('link', { name: '重命名当前文件夹', exact: true }).click();
    await page.getByRole('textbox', { name: '文件夹名称', exact: true }).fill('推理 新目录');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('推理 新目录');
    await expect(page.locator('.file-entry')).toContainText('新文件 #100%.md');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('full-folder-path.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`render Mermaid in documents and live previews at ${viewport.width}px`, async ({ page, applicationUrl }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    const blockedStyles: string[] = [];
    const blockedRendererStyles: string[] = [];
    const externalRequests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (!/Content Security Policy|violates.*directive/i.test(message.text())) return;
      blockedStyles.push(message.text());
      if (message.location().url.includes('/static/mermaid')) blockedRendererStyles.push(message.text());
    });
    page.on('request', request => { if (!request.url().startsWith(applicationUrl)) externalRequests.push(request.url()); });
    const source = '```mermaid\nflowchart LR\nA["开始"] --> B["完成"]\n```\n\n```mermaid\nsequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Done\n```\n\n```mermaid\nflowchart TD\nA -->\n```\n\n```javascript\nconsole.log("Still code");\n```';
    const created = await page.request.post(applicationUrl + '/new', { form: { vault: 'default', title: 'Mermaid diagrams', content: source }, headers: { Accept: 'application/json' } });
    expect(created.ok()).toBeTruthy();
    const doc = await created.json();
    await page.goto(applicationUrl + doc.url);
    await expect(page.locator('.mermaid-diagram[data-mermaid-state="rendered"]')).toHaveCount(2);
    const flow = page.locator('.mermaid-diagram').nth(0).frameLocator('iframe').locator('svg');
    await expect(flow).toBeVisible();
    await expect(flow).toContainText('开始');
    await expect(page.locator('.mermaid-diagram').nth(1).frameLocator('iframe').locator('svg')).toContainText('Alice');
    await expect(page.locator('.mermaid-error')).toContainText('Mermaid 图表无法渲染');
    await expect(page.locator('.mermaid-diagram').nth(2).locator('pre')).toContainText('A -->');
    await expect(page.locator('code.language-javascript')).toContainText('Still code');
    expect((await page.locator('.mermaid-frame').first().boundingBox())!.height).toBeGreaterThan(60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('mermaid-document.png'), fullPage: true });

    await page.getByRole('link', { name: '编辑', exact: true }).click();
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#preview .mermaid-diagram[data-mermaid-state="rendered"]')).toHaveCount(2);
    expect(blockedStyles).toEqual([]);
    await page.getByRole('button', { name: '书写', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Markdown 正文' });
    await editor.fill('```mermaid\nflowchart TD\nA -->\n```');
    await editor.fill('```mermaid\nflowchart TD\nA["新的起点"] --> B["最新预览"]\n```');
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#preview .mermaid-diagram')).toHaveCount(1);
    await expect(page.locator('#preview .mermaid-diagram').frameLocator('iframe').locator('svg')).toContainText('最新预览');
    await expect(page.locator('#preview .mermaid-error')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('mermaid-preview.png'), fullPage: true });
    expect(errors).toEqual([]);
    // Chromium text insertion can emit existing CodeMirror style warnings in the parent page.
    expect(blockedRendererStyles).toEqual([]);
    expect(externalRequests).toEqual([]);
  });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`interactive HTML embeds stay isolated in documents and live previews at ${viewport.width}px`, async ({ page, applicationUrl }, testInfo) => {
    await page.setViewportSize(viewport);
    const example = readFileSync(join(process.cwd(), 'examples/interactive-html.md'), 'utf8');
    const fullDocument = `<!doctype html><html><head><style>body{background:#f4f7fa}#extra{height:460px}</style></head><body>
      <button id="toggle" onclick="document.querySelector('#extra').hidden = !document.querySelector('#extra').hidden">展开详情</button>
      <div id="extra" hidden>更多内容</div><output id="isolation"></output><output id="network"></output>
      <script>
        try { parent.document.body.dataset.compromised = 'yes'; } catch { document.querySelector('#isolation').textContent = '父页面已隔离'; }
        fetch('/api/preview', {method:'POST'}).catch(() => document.querySelector('#network').textContent = '请求已隔离');
      </script></body></html>`;
    const source = example + '\n\n```html\n' + fullDocument + '\n```\n\n```html source\n<button>仅源码</button>\n```\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n<script>document.body.dataset.compromised="yes"</script>';
    const created = await page.request.post(applicationUrl + '/new', { form: { vault: 'default', title: 'HTML interactive diagrams', content: source }, headers: { Accept: 'application/json' } });
    expect(created.ok()).toBeTruthy();
    const doc = await created.json();
    await page.goto(applicationUrl + doc.url);
    await expect(page.locator('.html-diagram[data-html-state="rendered"]')).toHaveCount(2);
    const diagram = page.locator('.html-diagram').first().frameLocator('iframe');
    await expect(diagram.getByRole('button', { name: /Web/ })).toHaveAttribute('aria-pressed', 'true');
    await diagram.getByRole('button', { name: /MCP/ }).click();
    await expect(diagram.locator('#description')).toContainText('Agent');
    await expect(diagram.getByRole('button', { name: /MCP/ })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: testInfo.outputPath('interactive-html-document.png'), fullPage: true });

    const second = page.locator('.html-diagram').nth(1);
    const frame = second.frameLocator('iframe');
    await expect(frame.locator('#isolation')).toHaveText('父页面已隔离');
    await expect(frame.locator('#network')).toHaveText('请求已隔离');
    expect(await page.locator('body').getAttribute('data-compromised')).toBeNull();
    const initialHeight = (await second.locator('iframe').boundingBox())!.height;
    const toggleDetails = async () => {
      const button = frame.getByRole('button', { name: '展开详情' });
      if (viewport.width === 390) {
        await button.focus();
        await button.press('Enter');
      } else await button.click();
    };
    await toggleDetails();
    await expect.poll(async () => (await second.locator('iframe').boundingBox())!.height).toBeGreaterThan(initialHeight + 300);
    await toggleDetails();
    await expect.poll(async () => (await second.locator('iframe').boundingBox())!.height).toBe(initialHeight);
    await second.getByText('查看 HTML 源码', { exact: true }).click();
    await expect(second.locator('pre')).toContainText('<!doctype html>');
    await expect(page.locator('pre').filter({ hasText: '<button>仅源码</button>' })).toBeVisible();
    await expect(page.locator('.mermaid-diagram[data-mermaid-state="rendered"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();

    await page.getByRole('link', { name: '编辑', exact: true }).click();
    await page.getByRole('button', { name: '书写', exact: true }).click();
    await expect(page.locator('#preview')).toBeHidden();
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#preview .html-diagram[data-html-state="rendered"]')).toHaveCount(2);
    await page.locator('#preview .html-diagram').first().frameLocator('iframe').getByRole('button', { name: /MCP/ }).click();
    await expect(page.locator('#preview .html-diagram').first().frameLocator('iframe').locator('#description')).toContainText('Agent');
    await page.getByRole('button', { name: '书写', exact: true }).click();
    await page.getByRole('textbox', { name: 'Markdown 正文' }).fill('```html\n<button onclick="this.textContent=\'更新成功\'">新交互</button>\n```');
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#preview .html-diagram')).toHaveCount(1);
    const updated = page.locator('#preview .html-diagram').frameLocator('iframe');
    await updated.getByRole('button', { name: '新交互' }).click();
    await expect(updated.getByRole('button', { name: '更新成功' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
    await page.getByRole('link', { name: '返回阅读', exact: true }).click();
    await page.reload();
    await page.locator('.html-diagram').frameLocator('iframe').getByRole('button', { name: '新交互' }).click();
    await expect(page.locator('.html-diagram').frameLocator('iframe').getByRole('button', { name: '更新成功' })).toBeVisible();
  });
}

test('LaTeX math renders locally with CSP in documents and previews', async ({ page, applicationUrl }, testInfo) => {
  const width = 1280;
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(applicationUrl)) external.push(request.url()); });
  await page.addInitScript(() => {
    (window as any).mathCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => (window as any).mathCspViolations.push(event.violatedDirective));
  });
  const source = String.raw`# LayerNorm 与 RMSNorm

行内均值 $\mu$ 和括号公式 \(x_i\)。

$$
\begin{aligned}
\mu &= \frac{1}{d}\sum_{i=1}^{d}x_i, \\
\sigma^2 &= \frac{1}{d}\sum_{i=1}^{d}(x_i-\mu)^2
\end{aligned}
$$

$$
y_i=\gamma_i\frac{x_i-\mu}{\sqrt{\sigma^2+\varepsilon}}+\beta_i
$$

$$
\begin{aligned}
r &= \sqrt{\frac{1}{d}\sum_{i=1}^{d}x_i^2+\varepsilon}, \\
y_i &= \gamma_i\frac{x_i}{r}
\end{aligned}
$$

${'`$literal$`'}

$$
\frac{
$$`;
  const created = await page.request.post(applicationUrl + '/new', { form: { vault: 'default', title: '数学公式', content: source }, headers: { Accept: 'application/json' } });
  expect(created.ok()).toBeTruthy();
  await page.goto(applicationUrl + (await created.json()).url);
  await expect(page.locator('article .katex')).toHaveCount(5);
  await expect(page.locator('article .katex-display')).toHaveCount(3);
  await expect(page.locator('article .katex-error')).toHaveCount(1);
  await expect(page.locator('article code')).toHaveText('$literal$');
  await expect(page.locator('article .frac-line').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBeTruthy();
  expect(await page.locator('article .katex-html .base').first().evaluate(node => getComputedStyle(node).whiteSpace)).toBe('nowrap');
  expect(await page.locator('article .frac-line').first().evaluate(node => parseFloat(getComputedStyle(node).borderBottomWidth))).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).mathCspViolations)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath(`math-${width}.png`), fullPage: true });
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.locator('#preview .katex-display')).toHaveCount(3);
  await page.getByRole('button', { name: '书写', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown 正文' }).fill('$$\n\\frac{a}{\\sqrt{b}}\n$$');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.locator('#preview .katex-display')).toHaveCount(1);
  await expect(page.locator('#preview .katex-error')).toHaveCount(0);
  expect(await page.locator('#preview .frac-line').first().evaluate(node => parseFloat(getComputedStyle(node).borderBottomWidth))).toBeGreaterThan(0);
  expect(await page.locator('#preview [style]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('CJK bold labels with punctuation render in documents and live previews', async ({ page, applicationUrl }) => {
  const source = '# 中文强调\n\n**参考答案：**不能。同一次注入读取旧 code。\n\n这是**“重点”**内容。\n\n`**参考答案：**不能。`';
  const created = await page.request.post(applicationUrl + '/new', { form: { vault: 'default', title: '中文强调', content: source }, headers: { Accept: 'application/json' } });
  expect(created.ok()).toBeTruthy();
  await page.goto(applicationUrl + (await created.json()).url);
  await expect(page.locator('article strong')).toHaveText(['参考答案：', '“重点”']);
  await expect(page.locator('article code')).toHaveText('**参考答案：**不能。');
  expect(await page.locator('article strong').first().evaluate(node => Number(getComputedStyle(node).fontWeight))).toBeGreaterThanOrEqual(600);
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await expect(page.locator('#preview strong')).toHaveText(['参考答案：', '“重点”']);
  await page.getByRole('textbox', { name: 'Markdown 正文' }).fill('**更新答案：**可以。');
  await expect(page.locator('#preview strong')).toHaveText(['更新答案：']);
});

test('Chinese paragraph indentation is opt-in and matches reading and live preview without padding source', async ({ page, applicationUrl }, testInfo) => {
  const prose = '这是用于验证中文首行缩进的普通叙述段落，续行应回到正文左边界。'.repeat(9);
  const body = `# 中文排版\n\n${prose}\n\n## 标题后的首段\n\n第二段包含**加粗文字**、[链接](https://example.com)和行内公式 $x_i$。\n\n- 列表首项\n\n  列表里的独立段落。\n\n> 引用段落保持原有对齐。\n\n| 项目 | 说明 |\n| --- | --- |\n| 表格 | 表格内容 |\n\n![示意图](assets/pixel.png)\n\n*图 1：图片说明保持原有对齐。*\n\n$$\nx_i = 1\n$$\n\n\`单独的代码段落\`\n\n\`\`\`typescript\nconst value = 1;\n\`\`\`\n`;
  const source = '---\ntitle: 中文排版\nparagraph_indent: 2em\n---\n' + body;
  const client = new Client({ name: 'paragraph-layout-agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(applicationUrl + '/mcp')));
  let uri = '';
  try {
    const created = await client.callTool({ name: 'create_document', arguments: { vault_id: 'default', title: '中文排版', content: source } });
    expect(created.isError).toBeFalsy();
    uri = String(created.structuredContent!.uri);
  } finally { await client.close(); }
  await page.goto(applicationUrl + '/document?uri=' + encodeURIComponent(uri));
  const assertLayout = async (selector: string, enabled: boolean) => {
    const rendered = page.locator(selector);
    await expect(rendered.locator('p').filter({ hasText: '这是用于验证中文首行缩进' })).toHaveCount(1);
    for (const paragraph of [rendered.locator(':scope > p').filter({ hasText: '这是用于验证中文首行缩进' }), rendered.locator(':scope > p').filter({ hasText: '第二段包含' })]) {
      expect(await paragraph.evaluate(element => parseFloat(getComputedStyle(element).textIndent) / parseFloat(getComputedStyle(element).fontSize))).toBe(enabled ? 2 : 0);
    }
    for (const selector of ['h2', 'li', 'li p', 'blockquote', 'blockquote p', 'td', 'pre', 'p:has(img)', 'p:has(em)', '.katex-block', 'p:has(> code:only-child)']) {
      const elements = rendered.locator(selector);
      expect(await elements.count(), selector).toBeGreaterThan(0);
      expect(await elements.evaluateAll(elements => elements.map(element => parseFloat(getComputedStyle(element).textIndent)))).toEqual(Array(await elements.count()).fill(0));
    }
  };
  await assertLayout('article', true);
  const lines = await page.locator('article > p').first().evaluate(element => {
    const text = element.firstChild!, range = document.createRange();
    const positions = [];
    for (let i = 0; i < (text.textContent?.length ?? 0); i++) {
      range.setStart(text, i); range.setEnd(text, i + 1);
      const rect = range.getBoundingClientRect();
      positions.push({ x: rect.x - element.getBoundingClientRect().x, y: rect.y });
    }
    return { first: positions[0], second: positions.find(position => position.y > positions[0].y + 5), font: parseFloat(getComputedStyle(element).fontSize) };
  });
  expect(lines.first.x).toBeCloseTo(lines.font * 2, 0);
  expect(lines.second!.x).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath('chinese-paragraph-reading.png'), fullPage: true });
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await assertLayout('#preview', true);
  await page.screenshot({ path: testInfo.outputPath('chinese-paragraph-preview.png') });
  const editor = page.getByRole('textbox', { name: 'Markdown 正文' });
  await editor.fill(source.replace('paragraph_indent: 2em', 'paragraph_indent: none'));
  await expect.poll(() => page.locator('#preview > p').first().evaluate(element => getComputedStyle(element).textIndent)).toBe('0px');
  await assertLayout('#preview', false);
  await editor.fill(source);
  await expect.poll(() => page.locator('#preview > p').first().evaluate(element => parseFloat(getComputedStyle(element).textIndent))).toBe(40);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.getByRole('link', { name: '返回阅读', exact: true }).click();
  await assertLayout('article', true);
  const downloaded = await (await page.request.get(applicationUrl + '/download?' + new URLSearchParams({ uri }))).text();
  expect(downloaded).toContain(body);
  expect(downloaded).not.toMatch(/\u3000|&emsp;|&#(?:x2003|8195);/i);
  const english = await page.request.post(applicationUrl + '/new', { form: { vault: 'default', title: 'English default', content: 'A normal English paragraph.' }, headers: { Accept: 'application/json' } });
  await page.goto(applicationUrl + (await english.json()).url);
  expect(await page.locator('article > p').evaluate(element => getComputedStyle(element).textIndent)).toBe('0px');
});

test('an agent can retrieve the MCP guide and create a working Mermaid and HTML example', async ({ page, applicationUrl }) => {
  const client = new Client({ name: 'guide-example-agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(applicationUrl + '/mcp')));
  try {
    const guide = await client.callTool({ name: 'get_writing_guide', arguments: { topic: 'examples' } });
    expect(guide.isError).toBeFalsy();
    const markdown = String(guide.structuredContent?.markdown).match(/````markdown\r?\n([\s\S]*?)\r?\n````/)?.[1];
    expect(markdown).toBeTruthy();
    const created = await client.callTool({ name: 'create_document', arguments: { vault_id: 'default', title: 'Agent guide example', content: markdown } });
    expect(created.isError).toBeFalsy();
    const uri = String(created.structuredContent?.uri);
    const read = await client.callTool({ name: 'read_document', arguments: { uri } });
    expect(String(read.structuredContent?.content)).toContain(markdown!);
    await page.goto(applicationUrl + '/document?uri=' + encodeURIComponent(uri));
    await expect(page.locator('.mermaid-diagram[data-mermaid-state="rendered"]')).toHaveCount(1);
    await expect(page.locator('.html-diagram[data-html-state="rendered"]')).toHaveCount(1);
    const html = page.locator('.html-diagram').frameLocator('iframe');
    await expect(html.getByRole('button', { name: 'Web', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await html.getByRole('button', { name: 'MCP', exact: true }).click();
    await expect(html.locator('#detail')).toContainText('Agent');
    await expect(html.getByRole('button', { name: 'MCP', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally { await client.close(); }
});

test('browse, search, edit preview, download and upload', async ({ page, applicationUrl }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(applicationUrl);
  await expect(page.getByRole('heading', { name: /知识库/, level: 1 })).toBeVisible();
  await expect(page.locator('svg.lucide').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('knowledge-base.png'), fullPage: true });
  await page.getByRole('link', { name: 'default', exact: true }).click();

  await page.getByRole('link', { name: '项目设计', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目设计', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '开发记录', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('document.png'), fullPage: true });

  await openActions(page, '文档操作');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: '下载', exact: true }).click()]);
  expect(download.suggestedFilename()).toBe('项目设计.md');
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 正文' });
  await expect(page.locator('#preview')).toContainText('数据模型');
  await page.screenshot({ path: testInfo.outputPath('markdown-editor.png'), fullPage: true });
  await editor.fill('# 修改后的标题\n\n实时预览内容。');
  await expect(page.locator('#preview')).toContainText('实时预览内容');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
  await expect(page).toHaveURL(/\/edit\?/);
  await page.getByRole('link', { name: '返回阅读', exact: true }).click();
  await expect(page.locator('article')).toContainText('实时预览内容。');
  await expect(page.locator('article > h1')).toHaveCount(0);

  await page.getByRole('searchbox', { name: '搜索知识库' }).fill('实时预览');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.result-item')).toHaveCount(1);
  await page.locator('.result-location').click();
  await openActions(page, '导入文档');
  await page.getByLabel('Markdown 文档').setInputFiles({ name: '上传笔记.md', mimeType: 'text/markdown', buffer: Buffer.from('# 上传内容\n\n上传验证。') });
  await page.getByRole('button', { name: '上传 Markdown' }).click();
  await expect(page.getByRole('link', { name: '上传笔记', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('writing tools, modes, local drafts and conflict protection', async ({ page, applicationUrl }, testInfo) => {
  await page.goto(applicationUrl + '/?vault=default');
  await page.getByRole('link', { name: '项目设计', exact: true }).click();
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 正文' });
  await editor.fill('写作体验验证');
  await editor.press('ControlOrMeta+a');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(editor).toHaveText('**写作体验验证**');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor).toHaveText('写作体验验证');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(editor).toHaveText('**写作体验验证**');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.locator('#preview strong')).toHaveText('写作体验验证');
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: '书写', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(page.locator('#preview')).toBeHidden();
  await page.getByRole('button', { name: '分栏', exact: true }).click();
  await page.getByRole('button', { name: '专注模式', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('writing-focused.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('#save-status')).toHaveText('草稿已存于本机');
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(editor).toHaveText('**写作体验验证**');
  await editor.press('ControlOrMeta+s');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('coral:draft:')).length)).toBe(0);

  // Simulate an Obsidian edit while the browser holds an older version.
  const uri = await page.locator('[name="uri"]').inputValue();
  const version = await page.locator('[name="version"]').inputValue();
  const response = await page.request.post(applicationUrl + '/edit', { form: { uri, version, content: 'Obsidian 外部修改' }, headers: { Accept: 'application/json' } });
  expect(response.ok()).toBeTruthy();
  await editor.fill('浏览器未保存的内容');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#save-error')).toContainText('文档已被修改');
  await expect(page.getByRole('link', { name: '查看最新版本' })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载我的草稿' })).toBeVisible();
  await expect(editor).toHaveText('浏览器未保存的内容');
  await expect(page.locator('#save-status')).toHaveText('保存失败');
  const latest = await (await page.request.get(applicationUrl + '/api/document?uri=' + encodeURIComponent(uri))).json();
  expect(latest.content).toContain('Obsidian 外部修改');
  await page.screenshot({ path: testInfo.outputPath('writing-conflict.png'), fullPage: true });
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(editor).toHaveText('浏览器未保存的内容');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#save-error')).toContainText('文档已被修改');
});

test('search returns to the same scoped result page after reading and editing', async ({ page, applicationUrl, applicationDirectory }, testInfo) => {
  const root = join(applicationDirectory, 'obsdian/default');
  for (let i = 1; i <= 25; i++) writeFileSync(join(root, `search-${i}.md`), `---\ntitle: 查找笔记 ${i}\n---\n回到原处的搜索流程。`);
  const query = '回到 原处';
  await page.goto(applicationUrl + '/search?' + new URLSearchParams({ q: query, vault: 'default', cursor: '20' }));
  await expect(page.locator('.result-item')).toHaveCount(5);
  await expect(page.locator('.snippet mark').first()).toContainText('回到');
  await page.locator('.result-item > a').first().click();
  await expect(page.getByRole('link', { name: '返回搜索', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown 正文' }).fill('回到原处的搜索流程，补充阅读记录。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.getByRole('link', { name: '返回阅读', exact: true }).click();
  await page.getByRole('link', { name: '返回搜索', exact: true }).click();
  const returned = new URL(page.url());
  expect(returned.searchParams.get('q')).toBe(query);
  expect(returned.searchParams.get('vault')).toBe('default');
  expect(returned.searchParams.get('cursor')).toBe('20');
  await expect(page.locator('.result-item:target')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('search-return.png'), fullPage: true });
});

test('deep folder stays visible and long reading resumes after editing and an MCP update', async ({ page, applicationUrl, applicationDirectory }, testInfo) => {
  const root = join(applicationDirectory, 'obsdian/default');
  for (let i = 0; i < 100; i++) mkdirSync(join(root, `folder${String(i).padStart(3, '0')}`));
  const directory = 'folder099/长文阅读';
  mkdirSync(join(root, directory));
  const body = Array.from({ length: 20 }, (_, i) => `## 第 ${i + 1} 节\n\n` + '阅读位置与文档更新需要保持连续。\n\n'.repeat(8)).join('\n');
  writeFileSync(join(root, directory, '1.md'), '---\ntitle: 长文阅读样例\n---\n' + body);
  writeFileSync(join(root, directory, '2.md'), '---\ntitle: 接下来的一篇\n---\n第二篇内容。');
  const uri = 'coral://vault/default/' + directory.split('/').map(encodeURIComponent).join('/') + '/1.md';
  const url = applicationUrl + '/document?uri=' + encodeURIComponent(uri);
  await page.goto(url);
  const folder = page.getByRole('link', { name: '打开文件夹：' + directory, exact: true });
  const folderBox = (await folder.boundingBox())!, sidebarBox = (await page.locator('.sidebar-scroll').boundingBox())!;
  expect(folderBox.y).toBeGreaterThanOrEqual(sidebarBox.y);
  expect(folderBox.y + folderBox.height).toBeLessThanOrEqual(sidebarBox.y + sidebarBox.height + 1);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.locator('article h2').nth(9).evaluate(element => element.scrollIntoView());
  const position = await page.evaluate(() => scrollY);
  await expect.poll(() => page.evaluate(uri => Boolean(localStorage.getItem('coral:reading-position:' + uri)), uri)).toBeTruthy();
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await page.getByRole('link', { name: '返回阅读', exact: true }).click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(position - 80);
  const client = new Client({ name: 'reading-update-agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(applicationUrl + '/mcp')));
  try {
    const read = await client.callTool({ name: 'read_document', arguments: { uri, max_chars: 64000 } });
    const updated = await client.callTool({ name: 'update_document', arguments: { uri, version: read.structuredContent!.version, content: String(read.structuredContent!.content) + '\nAgent 添加的新内容。' } });
    expect(updated.isError).toBeFalsy();
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await expect(page.locator('article')).toContainText('Agent 添加的新内容。');
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(position - 80);
    await page.screenshot({ path: testInfo.outputPath('reading-resumed.png') });
    let navigations = 0;
    page.on('framenavigated', () => navigations++);
    await page.waitForLoadState('networkidle');
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/api/document?')),
      page.evaluate(() => dispatchEvent(new Event('focus'))),
    ]);
    expect(navigations).toBe(0);
  } finally { await client.close(); }
  await page.getByRole('navigation', { name: '文末阅读导航' }).getByRole('link', { name: /下一篇/ }).click();
  await expect(page.locator('.page-head h1')).toHaveText('接下来的一篇');
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.goto(url + '#' + encodeURIComponent('第-3-节'));
  await expect.poll(() => page.locator('article h2').nth(2).evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(180);
});

test('two new documents retain independent drafts and saving clears only its own draft', async ({ page, context, applicationUrl }, testInfo) => {
  await page.goto(applicationUrl + '/new?vault=default');
  await page.getByRole('textbox', { name: '标题', exact: true }).fill('第一份草稿');
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('第一份未完成正文');
  await expect(page.locator('#save-status')).toHaveText('草稿已存于本机');
  const second = await context.newPage();
  try {
    await second.goto(applicationUrl + '/new?vault=default');
    await second.getByRole('textbox', { name: '标题', exact: true }).fill('第二份草稿');
    await second.getByRole('textbox', { name: '正文', exact: true }).fill('第二份未完成正文');
    await expect(second.locator('#save-status')).toHaveText('草稿已存于本机');
    expect(new URL(second.url()).searchParams.get('draft')).not.toBe(new URL(page.url()).searchParams.get('draft'));
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.locator('.page-head h1')).toHaveText('第一份草稿');
    second.once('dialog', dialog => dialog.accept());
    await second.reload();
    await second.getByRole('button', { name: '恢复草稿', exact: true }).click();
    await expect(second.getByRole('textbox', { name: '标题', exact: true })).toHaveValue('第二份草稿');
    await expect(second.getByRole('textbox', { name: '正文', exact: true })).toHaveText('第二份未完成正文');
    await expect.poll(() => second.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('coral:draft:')).length)).toBe(1);
    await second.screenshot({ path: testInfo.outputPath('independent-draft.png') });
  } finally { await second.close({ runBeforeUnload: false }); }
});

test('saved reading position survives an image loading above the current section', async ({ page, applicationUrl, applicationDirectory }) => {
  const root = join(applicationDirectory, 'obsdian/default');
  writeFileSync(join(root, 'image-reading.md'), '---\ntitle: 图片加载后的阅读位置\n---\n## 开头\n\n![[assets/pixel.png|600]]\n\n## 当前章节\n\n' + '继续阅读的正文。\n\n'.repeat(80));
  const uri = 'coral://vault/default/image-reading.md';
  await page.goto(applicationUrl + '/document?uri=' + encodeURIComponent(uri));
  const current = page.locator('article h2').nth(1);
  await current.evaluate(element => element.scrollIntoView());
  await expect.poll(() => page.evaluate(uri => JSON.parse(localStorage.getItem('coral:reading-position:' + uri) ?? 'null')?.heading, uri)).toBe('当前章节');
  const top = await current.evaluate(element => element.getBoundingClientRect().top);
  await page.route('**/asset?*', async route => {
    const response = await route.fetch();
    await new Promise(resolve => setTimeout(resolve, 700));
    await route.fulfill({ response });
  });
  await page.reload();
  await expect.poll(() => current.evaluate((element, previousTop) => Math.abs(element.getBoundingClientRect().top - previousTop), top)).toBeLessThan(30);
});

test('typing during a delayed save leaves an accurate pending draft status', async ({ page, applicationUrl }) => {
  await page.goto(applicationUrl + '/?vault=default');
  await page.getByRole('link', { name: '项目设计', exact: true }).click();
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 正文' });
  await editor.fill('这部分已提交');
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/edit', async route => {
    const response = await route.fetch();
    await hold;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('正在保存…');
  await editor.fill('这部分已提交\n继续输入尚未提交');
  release();
  await expect(page.locator('#save-status')).toHaveText('草稿已存于本机');
  const uri = await page.locator('input[name="uri"]').inputValue();
  const read = await (await page.request.get(applicationUrl + '/api/document?' + new URLSearchParams({ uri }))).json();
  expect(read.content).not.toContain('继续输入尚未提交');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('已保存');
});

test('move notes from the directory and document pages with collision protection', async ({ page, applicationUrl, applicationDirectory }, testInfo) => {
  const root = join(applicationDirectory, 'obsdian/default');
  mkdirSync(join(root, 'work/2026-11'), { recursive: true });
  const raw = '\uFEFF---\r\ntitle: 每日记录\r\ncustom: preserved\r\n---\r\n# 每日记录\r\n\r\n需要完整保留的工作记录。\r\n';
  writeFileSync(join(root, 'work/2026-11-6.md'), raw);
  writeFileSync(join(root, 'work/2026-11/2026-11-6.md'), '已有文件');
  await page.goto(applicationUrl + '/?' + new URLSearchParams({ vault: 'default', directory: 'work' }));
  await openActions(page, '文档操作：每日记录');
  await page.getByRole('link', { name: '移动文档：每日记录', exact: true }).click();
  const destination = page.getByRole('combobox', { name: '目标文件夹', exact: true });
  await destination.selectOption('work/2026-11');
  await page.getByRole('button', { name: '确认移动', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('同名');
  await expect(destination).toHaveValue('work/2026-11');
  expect(readFileSync(join(root, 'work/2026-11/2026-11-6.md'), 'utf8')).toBe('已有文件');
  rmSync(join(root, 'work/2026-11/2026-11-6.md'));
  await page.getByRole('button', { name: '确认移动', exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('directory') === 'work/2026-11' && url.hash.startsWith('#doc-'));
  expect(readFileSync(join(root, 'work/2026-11/2026-11-6.md'), 'utf8')).toBe(raw);
  expect(() => readFileSync(join(root, 'work/2026-11-6.md'))).toThrow();
  await page.locator('.file-list').getByRole('link', { name: '每日记录', exact: true }).click();
  await expect(page.locator('article')).toContainText('需要完整保留的工作记录。');
  await openActions(page, '文档操作');
  await page.getByRole('link', { name: '移动', exact: true }).click();
  await destination.selectOption('');
  await page.screenshot({ path: testInfo.outputPath('move-note.png'), fullPage: true });
  await page.getByRole('button', { name: '确认移动', exact: true }).click();
  await expect(page).toHaveURL(/uri=coral%3A%2F%2Fvault%2Fdefault%2F2026-11-6.md$/);
  await expect(page.locator('.page-head h1')).toHaveText('每日记录');
  expect(readFileSync(join(root, '2026-11-6.md'), 'utf8')).toBe(raw);
});

test('moving and renaming through Web maintains inbound notes, images and a readable result report', async ({ page, applicationUrl, applicationDirectory }, testInfo) => {
  const root = join(applicationDirectory, 'obsdian/default');
  mkdirSync(join(root, 'work/assets'), { recursive: true });
  mkdirSync(join(root, 'archive'));
  writeFileSync(join(root, 'work/assets/pixel.png'), readFileSync(join(root, 'assets/pixel.png')));
  writeFileSync(join(root, 'work/day.md'), '---\ntitle: 每日工作\ncustom: keep\n---\n# 每日工作\n\n![示意图](assets/pixel.png)');
  writeFileSync(join(root, 'index.md'), '---\ntitle: 工作索引\n---\n[今天的记录](work/day.md)\n\n[[work/day|每日工作]]');
  await page.goto(applicationUrl + '/document?uri=' + encodeURIComponent('coral://vault/default/work/day.md'));
  await openActions(page, '文档操作');
  await page.getByRole('link', { name: '移动', exact: true }).click();
  await page.getByRole('combobox', { name: '目标文件夹' }).selectOption('archive');
  await page.getByRole('button', { name: '确认移动' }).click();
  await expect(page.locator('.page-head h1')).toHaveText('每日工作');
  const result = page.getByRole('region', { name: '整理结果' });
  await expect(result).toContainText('已更新 2 篇笔记的链接');
  await result.locator('summary').first().click();
  await expect(result.getByRole('link', { name: 'default/index.md', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('article img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  expect(readFileSync(join(root, 'index.md'), 'utf8')).toContain('(archive/day.md)');
  expect(readFileSync(join(root, 'archive/day.md'), 'utf8')).toContain('../work/assets/pixel.png');
  await openActions(page, '文档操作');
  await page.getByRole('link', { name: '重命名', exact: true }).click();
  await page.getByRole('textbox', { name: '文件名称（含扩展名）' }).fill('每日 #100%.md');
  await page.getByRole('button', { name: '保存名称' }).click();
  await expect(page.locator('.page-head h1')).toHaveText('每日工作');
  expect(readFileSync(join(root, 'index.md'), 'utf8')).toContain('archive/' + encodeURIComponent('每日 #100%.md'));
  await expect.poll(() => page.locator('article img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('relocation-report.png'), fullPage: true });
  await page.getByRole('link', { name: '所在目录', exact: true }).click();
  await openActions(page, '知识库工具');
  await page.getByRole('link', { name: '重命名当前文件夹', exact: true }).click();
  await page.getByRole('textbox', { name: '文件夹名称', exact: true }).fill('归档资料');
  await page.getByRole('button', { name: '保存名称' }).click();
  await expect(page.getByRole('navigation', { name: '当前位置' })).toContainText('归档资料');
  await page.locator('.file-list').getByRole('link', { name: '每日工作', exact: true }).click();
  await expect.poll(() => page.locator('article img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  expect(readFileSync(join(root, 'index.md'), 'utf8')).toContain(encodeURIComponent('归档资料') + '/');
});

test('mouse selection is visible on the active editor line and supports copy and replace', async ({ page, applicationUrl }, testInfo) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: applicationUrl });
  await page.goto(applicationUrl + '/?vault=default');
  await page.getByRole('link', { name: '项目设计', exact: true }).click();
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 正文' });
  const original = '鼠标拖选这段文字，应该能看到清晰的选区。';
  await editor.fill(original);
  await editor.press('Home');
  const before = await page.screenshot();
  const line = (await editor.locator('.cm-line').first().boundingBox())!;
  await page.mouse.move(line.x + 18, line.y + line.height / 2);
  await page.mouse.down();
  await page.mouse.move(line.x + 160, line.y + line.height / 2, { steps: 15 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected.length).toBeGreaterThan(3);
  const highlight = page.locator('.cm-selectionBackground').first();
  await expect(highlight).toBeVisible();
  const box = (await highlight.boundingBox())!;
  const point = { x: Math.floor(box.x + box.width / 2), y: Math.ceil(box.y) + 1 };
  const after = await page.screenshot({ path: testInfo.outputPath('editor-mouse-selection.png') });
  const pixels = await page.evaluate(async ({ screenshots, point }) => {
    return Promise.all(screenshots.map(async data => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), char => char.charCodeAt(0))], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return Array.from(context.getImageData(point.x, point.y, 1, 1).data).slice(0, 3);
    }));
  }, { screenshots: [before.toString('base64'), after.toString('base64')], point });
  // Check the painted background, since an opaque active line can hide a valid selection layer.
  expect(pixels[0].reduce((difference, value, index) => difference + Math.abs(value - pixels[1][index]), 0)).toBeGreaterThan(30);
  await editor.press('ControlOrMeta+c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
  await page.keyboard.insertText('替换');
  await expect(editor).toHaveText(original.replace(selected, '替换'));
  await editor.press('ControlOrMeta+z');
  await expect(editor).toHaveText(original);
});

test('create a knowledge base then create and upload Markdown documents', async ({ page, applicationUrl }, testInfo) => {
  await page.goto(applicationUrl);
  await page.getByRole('link', { name: '创建知识库', exact: true }).click();
  await page.getByLabel('仓库名称（英文）').fill('research');
  await expect(page.getByLabel('知识库标识')).toHaveCount(0);
  await page.getByLabel('简介').fill('研发设计与记录');
  await page.getByRole('button', { name: '创建知识库', exact: true }).click();
  await expect(page).toHaveURL(/vault=research$/);
  const vaultId = new URL(page.url()).searchParams.get('vault')!;
  await page.getByRole('link', { name: '创建文档' }).click();
  await page.getByLabel('标题', { exact: true }).fill('第一篇文档');
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('# 设计内容\n\n独立仓库的 Markdown。');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.locator('article')).toContainText('独立仓库的 Markdown');
  await openActions(page, '文档操作');
  await expect(page.getByRole('button', { name: '复制 Coral 链接', exact: true })).toHaveAttribute('data-copy', new RegExp(`^coral://vault/${vaultId}/`));
  await page.getByRole('navigation', { name: '当前位置' }).getByRole('link', { name: 'research', exact: true }).click();
  await openActions(page, '导入文档');
  await page.getByLabel('Markdown 文档').setInputFiles({ name: '上传.md', mimeType: 'text/markdown', buffer: Buffer.from('# 上传内容') });
  await page.getByRole('button', { name: '上传 Markdown' }).click();
  await expect(page.getByRole('heading', { name: /research.*2 个文档/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('created-vault.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('link', { name: '全部知识库', exact: true }).click();
  await expect(page.getByRole('link', { name: 'research', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'default', exact: true }).click();
  await expect(page.getByRole('link', { name: '第一篇文档', exact: true })).toHaveCount(0);
});

test('create empty folders in the current directory and handle duplicate names', async ({ page, applicationUrl }, testInfo) => {
  await page.goto(applicationUrl + '/?vault=default');
  await openActions(page, '知识库工具');
  await page.getByRole('link', { name: '创建文件夹', exact: true }).click();
  await page.getByLabel('文件夹名称').fill('项目资料');
  await page.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await page.getByRole('link', { name: '项目资料', exact: true }).click();
  await openActions(page, '知识库工具');
  await page.getByRole('link', { name: '创建文件夹', exact: true }).click();
  await page.getByLabel('文件夹名称').fill('设计文档');
  await page.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await expect(page.getByRole('link', { name: '设计文档', exact: true })).toBeVisible();
  await openActions(page, '知识库工具');
  await page.getByRole('link', { name: '创建文件夹', exact: true }).click();
  await page.getByLabel('文件夹名称').fill('设计文档');
  await page.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('同名');
  await expect(page.getByLabel('文件夹名称')).toHaveValue('设计文档');
  await page.getByRole('link', { name: '返回', exact: true }).click();
  expect(new URL(page.url()).searchParams.get('directory')).toBe('项目资料');
  await page.getByRole('link', { name: '设计文档', exact: true }).click();
  await expect(page.getByRole('link', { name: '创建文档', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('empty-folder.png'), fullPage: true });
});

test('browse Obsidian folders, create and upload in the selected directory', async ({ page, applicationUrl }, testInfo) => {
  await page.goto(applicationUrl + '/?vault=default');
  await page.getByRole('link', { name: '创建文档', exact: true }).click();
  await expect(page.locator('[name="type"]')).toHaveCount(0);
  await page.getByRole('textbox', { name: '标题', exact: true }).fill('方案');
  await page.getByRole('textbox', { name: '保存目录', exact: true }).fill('项目资料/docs');
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('# 方案\n\nObsidian 文件夹。');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await openActions(page, '文档操作');
  await expect(page.getByRole('button', { name: '复制 Coral 链接', exact: true })).toHaveAttribute('data-copy', /\/docs\//);
  await expect(page.getByRole('button', { name: '转换分类' })).toHaveCount(0);
  await page.getByRole('link', { name: '所在目录', exact: true }).click();
  await expect(page.locator('.file-list').getByRole('link', { name: '方案', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '当前位置' }).getByRole('link', { name: 'default', exact: true }).click();
  await page.getByRole('link', { name: '项目资料', exact: true }).click();
  await page.getByRole('link', { name: 'docs', exact: true }).click();
  await expect(page.locator('.file-list').getByRole('link', { name: '方案', exact: true })).toBeVisible();
  await openActions(page, '导入文档');
  await page.getByLabel('Markdown 文档').setInputFiles({ name: '会议.md', mimeType: 'text/markdown', buffer: Buffer.from('---\ntype: meeting\ntags: [研发]\n---\n# 会议记录') });
  await page.getByRole('button', { name: '上传 Markdown' }).click();
  await expect(page).toHaveURL(/directory=/);
  await expect(page.getByRole('link', { name: '会议', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('folder-browser.png'), fullPage: true });
  await page.getByRole('link', { name: '创建文档', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '保存目录', exact: true })).toHaveValue('项目资料/docs');
  await page.getByRole('link', { name: '返回', exact: true }).click();
  await page.getByRole('link', { name: '上级目录', exact: true }).click();
  await expect(page.getByRole('link', { name: 'docs', exact: true })).toBeVisible();
});

test('delete documents and folders directly from the listing with confirmation', async ({ page, applicationUrl }, testInfo) => {
  await page.request.post(applicationUrl + '/new', { form: { vault: 'default', title: '目录文档', content: 'Nested document', directory: '待删除/nested' } });
  await page.goto(applicationUrl + '/?vault=default');
  await expect(page.getByLabel('文档操作：开发记录', { exact: true })).toBeVisible();
  await expect(page.getByLabel('文件夹操作：待删除', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('listing-delete.png'), fullPage: true });
  page.once('dialog', dialog => dialog.dismiss());
  await openActions(page, '文档操作：开发记录');
  await page.getByRole('button', { name: '删除文档：开发记录', exact: true }).click();
  await expect(page.getByRole('link', { name: '开发记录', exact: true })).toBeVisible();
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('回收站'); await dialog.accept(); });
  await openActions(page, '文档操作：开发记录');
  await page.getByRole('button', { name: '删除文档：开发记录', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  await expect(page.getByRole('link', { name: '开发记录', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '待删除', exact: true }).click();
  await page.getByRole('link', { name: 'nested', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await openActions(page, '文档操作：目录文档');
  await page.getByRole('button', { name: '删除文档：目录文档', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  expect(new URL(page.url()).searchParams.get('directory')).toBe('待删除/nested');
  await page.getByRole('link', { name: '上级目录', exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await openActions(page, '文件夹操作：nested');
  await page.getByRole('button', { name: '删除文件夹：nested', exact: true }).click();
  await expect(page.getByRole('link', { name: 'nested', exact: true })).toBeVisible();
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('全部 0 个文件'); await dialog.accept(); });
  await openActions(page, '文件夹操作：nested');
  await page.getByRole('button', { name: '删除文件夹：nested', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  await expect(page.getByRole('link', { name: 'nested', exact: true })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('directory')).toBe('待删除');
  await page.getByRole('navigation', { name: '当前位置', exact: true }).getByRole('link', { name: 'default', exact: true }).click();
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('附件'); await dialog.accept(); });
  await openActions(page, '文件夹操作：assets');
  await page.getByRole('button', { name: '删除文件夹：assets', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  await expect(page.getByRole('link', { name: 'assets', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '项目设计', exact: true })).toBeVisible();
});

test('restore documents and folders from trash and confirm permanent deletion and emptying', async ({ page, applicationUrl }, testInfo) => {
  await page.goto(applicationUrl + '/?vault=default');
  page.once('dialog', dialog => dialog.accept());
  await openActions(page, '文档操作：项目设计');
  await page.getByRole('button', { name: '删除文档：项目设计', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  await page.getByRole('link', { name: '回收站', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('回收站');
  await expect(page.locator('.sidebar-trash')).toHaveAttribute('href', '/trash?vault=default');
  await page.getByRole('button', { name: '恢复：项目设计.md', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已恢复。');
  await page.getByRole('link', { name: '返回知识库', exact: true }).click();
  await expect(page.getByRole('link', { name: '项目设计', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await openActions(page, '文件夹操作：assets');
  await page.getByRole('button', { name: '删除文件夹：assets', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  await page.goto(applicationUrl + '/trash');
  await page.getByRole('button', { name: '恢复：assets', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已恢复。');
  await page.goto(applicationUrl + '/?vault=default');
  page.once('dialog', dialog => dialog.accept());
  await openActions(page, '文件夹操作：assets');
  await page.getByRole('button', { name: '删除文件夹：assets', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  await page.goto(applicationUrl + '/trash');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('trash-files.png'), fullPage: true });
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '彻底删除：assets', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复：assets', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '彻底删除：assets', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已彻底删除回收内容。');
  await expect(page.getByRole('button', { name: '恢复：assets', exact: true })).toHaveCount(0);
  await page.goto(applicationUrl + '/?vault=default');
  page.once('dialog', dialog => dialog.accept());
  await openActions(page, '文档操作：开发记录');
  await page.getByRole('button', { name: '删除文档：开发记录', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  await page.goto(applicationUrl + '/trash');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '清空回收站', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('回收站已清空。');
  await expect(page.getByText('回收站为空。', { exact: true })).toBeVisible();
});

test('recycle an entire knowledge base, restore it, and permanently delete it', async ({ page, applicationUrl }, testInfo) => {
  const created = await page.request.post(applicationUrl + '/vaults/new', { form: { name: 'recycle' }, maxRedirects: 0 });
  const vaultId = new URL(created.headers().location, applicationUrl).searchParams.get('vault')!;
  await page.request.post(applicationUrl + '/new', { form: { vault: vaultId, title: '保留文档', content: '可恢复的内容' } });
  await page.goto(applicationUrl);
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '删除知识库：recycle', exact: true }).click();
  await expect(page.getByRole('link', { name: 'recycle', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除知识库：recycle', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('知识库已移入回收站。');
  await expect(page.getByRole('link', { name: 'recycle', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '回收站', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复知识库：recycle', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('trash-vaults.png'), fullPage: true });
  await page.getByRole('button', { name: '恢复知识库：recycle', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已恢复。');
  await page.getByRole('link', { name: '返回知识库', exact: true }).click();
  await page.getByRole('link', { name: 'recycle', exact: true }).click();
  await page.getByRole('link', { name: '保留文档', exact: true }).click();
  await expect(page.locator('article')).toHaveText('可恢复的内容');
  await page.goto(applicationUrl);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除知识库：recycle', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('知识库已移入回收站。');
  await page.getByRole('link', { name: '回收站', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '彻底删除知识库：recycle', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已彻底删除回收内容。');
  await expect(page.getByRole('button', { name: '恢复知识库：recycle', exact: true })).toHaveCount(0);
});
