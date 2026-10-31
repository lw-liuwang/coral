import { test as base, expect } from '@playwright/test';
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
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      application.close();
    }
  },
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
      vault: 'default', title: '深层文档', content: '# Original content', directory: '团队资料/推理 系统',
    } });
    await page.goto(applicationUrl + '/?vault=default');
    const folderUri = 'coral://vault/default/' + encodeURIComponent('团队资料');
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
    await expect(page.locator('.document-uri code')).toHaveText(currentUri);
    await page.getByRole('link', { name: '深层文档', exact: true }).click();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('深层文档.md');
    await expect(crumbs.getByRole('link')).toHaveText(['全部知识库', 'default', '团队资料-改名', '推理 系统']);
    await page.getByRole('link', { name: '编辑', exact: true }).click();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('深层文档.md');
    await page.getByRole('link', { name: '取消', exact: true }).click();
    await page.getByRole('link', { name: '重命名', exact: true }).click();
    await page.getByRole('textbox', { name: '文件名称（含扩展名）', exact: true }).fill('新文件 #100%.md');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('新文件 #100%.md');
    await expect(page.locator('article')).toContainText('Original content');
    await expect(page.locator('.document-uri code')).toHaveText(currentUri + '/' + encodeURIComponent('新文件 #100%.md'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('full-document-path.png'), fullPage: true });
    await crumbs.getByRole('link', { name: '推理 系统', exact: true }).click();
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
    await frame.getByRole('button', { name: '展开详情' }).click();
    await expect.poll(async () => (await second.locator('iframe').boundingBox())!.height).toBeGreaterThan(initialHeight + 300);
    await frame.getByRole('button', { name: '展开详情' }).click();
    await expect.poll(async () => (await second.locator('iframe').boundingBox())!.height).toBe(initialHeight);
    await second.getByText('查看 HTML 源码', { exact: true }).click();
    await expect(second.locator('pre')).toContainText('<!doctype html>');
    await expect(page.locator('pre').filter({ hasText: '<button>仅源码</button>' })).toBeVisible();
    await expect(page.locator('.mermaid-diagram[data-mermaid-state="rendered"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();

    await page.getByRole('link', { name: '编辑', exact: true }).click();
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
    await page.getByRole('link', { name: '取消', exact: true }).click();
    await page.reload();
    await page.locator('.html-diagram').frameLocator('iframe').getByRole('button', { name: '新交互' }).click();
    await expect(page.locator('.html-diagram').frameLocator('iframe').getByRole('button', { name: '更新成功' })).toBeVisible();
  });
}

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
  await expect(page.getByRole('heading', { name: '数据模型' })).toBeVisible();
  await expect(page.getByRole('link', { name: '开发记录', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('document.png'), fullPage: true });

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
  await page.getByRole('link', { name: '取消', exact: true }).click();
  await expect(page.locator('article')).toContainText('修改后的标题');

  await page.getByRole('searchbox').fill('实时预览');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.result-item')).toHaveCount(1);
  await page.getByRole('link', { name: '文档', exact: true }).click();
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
  await expect(page.locator('.topbar')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('writing-focused.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.locator('.topbar')).toBeVisible();
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
  await expect(page.locator('.document-uri')).toContainText(`coral://vault/${vaultId}/`);
  await page.getByRole('link', { name: '文档', exact: true }).click();
  await page.getByLabel('Markdown 文档').setInputFiles({ name: '上传.md', mimeType: 'text/markdown', buffer: Buffer.from('# 上传内容') });
  await page.getByRole('button', { name: '上传 Markdown' }).click();
  await expect(page.getByRole('heading', { name: /research.*2 个文档/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('created-vault.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('link', { name: '全部知识库' }).click();
  await expect(page.getByRole('link', { name: 'research', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'default', exact: true }).click();
  await expect(page.getByRole('link', { name: '第一篇文档', exact: true })).toHaveCount(0);
});

test('create empty folders in the current directory and handle duplicate names', async ({ page, applicationUrl }, testInfo) => {
  await page.goto(applicationUrl + '/?vault=default');
  await page.getByRole('link', { name: '创建文件夹', exact: true }).click();
  await page.getByLabel('文件夹名称').fill('项目资料');
  await page.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await page.getByRole('link', { name: '项目资料', exact: true }).click();
  await page.getByRole('link', { name: '创建文件夹', exact: true }).click();
  await page.getByLabel('文件夹名称').fill('设计文档');
  await page.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await expect(page.getByRole('link', { name: '设计文档', exact: true })).toBeVisible();
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
  await expect(page.locator('.document-uri')).toContainText('/docs/');
  await expect(page.getByRole('button', { name: '转换分类' })).toHaveCount(0);
  await page.getByRole('link', { name: '所在目录', exact: true }).click();
  await expect(page.getByRole('link', { name: '方案', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '文档', exact: true }).click();
  await page.getByRole('link', { name: '项目资料', exact: true }).click();
  await page.getByRole('link', { name: 'docs', exact: true }).click();
  await expect(page.getByRole('link', { name: '方案', exact: true })).toBeVisible();
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
  await expect(page.getByRole('button', { name: '删除文档：开发记录', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '删除文件夹：待删除', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('listing-delete.png'), fullPage: true });
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '删除文档：开发记录', exact: true }).click();
  await expect(page.getByRole('link', { name: '开发记录', exact: true })).toBeVisible();
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('回收站'); await dialog.accept(); });
  await page.getByRole('button', { name: '删除文档：开发记录', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  await expect(page.getByRole('link', { name: '开发记录', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '待删除', exact: true }).click();
  await page.getByRole('link', { name: 'nested', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除文档：目录文档', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  expect(new URL(page.url()).searchParams.get('directory')).toBe('待删除/nested');
  await page.getByRole('link', { name: '上级目录', exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '删除文件夹：nested', exact: true }).click();
  await expect(page.getByRole('link', { name: 'nested', exact: true })).toBeVisible();
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('全部 0 个文件'); await dialog.accept(); });
  await page.getByRole('button', { name: '删除文件夹：nested', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  await expect(page.getByRole('link', { name: 'nested', exact: true })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('directory')).toBe('待删除');
  await page.getByRole('navigation', { name: '当前位置', exact: true }).getByRole('link', { name: 'default', exact: true }).click();
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('附件'); await dialog.accept(); });
  await page.getByRole('button', { name: '删除文件夹：assets', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  await expect(page.getByRole('link', { name: 'assets', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '项目设计', exact: true })).toBeVisible();
});

test('restore documents and folders from trash and confirm permanent deletion and emptying', async ({ page, applicationUrl }, testInfo) => {
  await page.goto(applicationUrl + '/?vault=default');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除文档：项目设计', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  await page.getByTitle('知识库工具', { exact: true }).click();
  await page.getByRole('link', { name: '回收站', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('回收站');
  await page.getByRole('button', { name: '恢复：项目设计.md', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已恢复。');
  await page.getByRole('link', { name: '返回知识库', exact: true }).click();
  await expect(page.getByRole('link', { name: '项目设计', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除文件夹：assets', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已移入知识库回收站');
  await page.goto(applicationUrl + '/trash');
  await page.getByRole('button', { name: '恢复：assets', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已恢复。');
  await page.goto(applicationUrl + '/?vault=default');
  page.once('dialog', dialog => dialog.accept());
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
