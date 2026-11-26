import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from './src/config.js';
import { createApp } from './src/web.js';
import { hasFrontmatter } from './src/content.js';
import { renderMarkdown } from './src/markdown.js';

test('paragraph indentation recognizes narrative and numbered captions without altering Markdown content', () => {
  const prose = '# 标题\n\n标题后的正文。\n\n' +
    '## 小节\n\n正文含 **强调**、[链接](https://example.com)与 $x_i$。\n\n' +
    '![图](pixel.png)\n\n*图 1：图片说明。*\n\n图 1：这里是独立的叙述，已经离开图片。\n\n' +
    '![图](pixel.png)\n\n图 1.2 是正文讨论，不是图注。\n\n' +
    '[![链接图片](pixel.png)](https://example.com)\n\nFigure 2: Linked image.\n\n图 2 展示了普通叙述。\n\n' +
    '```html\n<figure><figcaption>图内说明</figcaption></figure>\n```\n\n**图三：图表说明。**\n\n' +
    '| 项目 | 说明 |\n| --- | --- |\n| 甲 | 表内文字 |\n\n表 1：表格说明。\n\n' +
    '- 项目\n\n  列表内段落。\n\n> 引用内段落。\n\n' +
    '$$\nx = 1\n$$\n\n$x_i$\n\n`const x = 1`\n\n```text\n代码原文\n```\n';
  const html = renderMarkdown(prose, [], undefined, undefined, { paragraph_indent: '2em' });
  const indented = [...html.matchAll(/<p class="paragraph-indent">([\s\S]*?)<\/p>/g)].map(match => match[1]);
  assert.equal(indented.length, 5);
  assert.ok(indented.some(text => text === '标题后的正文。'));
  assert.ok(indented.some(text => text.includes('<strong>强调</strong>') && text.includes('katex')));
  assert.ok(indented.includes('图 1：这里是独立的叙述，已经离开图片。'));
  assert.ok(indented.includes('图 2 展示了普通叙述。'));
  assert.ok(indented.includes('图 1.2 是正文讨论，不是图注。'));
  for (const caption of ['<em>图 1：图片说明。</em>', 'Figure 2: Linked image.', '<strong>图三：图表说明。</strong>', '表 1：表格说明。']) {
    assert.ok(html.includes('<p>' + caption + '</p>'), caption);
  }
  for (const value of [undefined, 'none', false, true, 2, null, '2EM', '2em; color:red', { value: '2em' }]) {
    assert.ok(!renderMarkdown(prose, [], undefined, undefined, { paragraph_indent: value }).includes('class="paragraph-indent"'));
  }
  assert.equal(renderMarkdown('默认段落。', []), '<p>默认段落。</p>\n');
});

test('preview frontmatter matches saving semantics for existing and new documents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-indent-'));
  const app = createApp(createConfig({ data_dir: root }));
  const server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const doc = app.registry.create('default', '缩进设置', '磁盘正文。', { paragraph_indent: '2em', custom: 'preserve' });
    const preview = async (markdown: string, uri?: string) => {
      const response = await fetch(base + '/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vault: 'default', uri, markdown }) });
      assert.equal(response.status, 200);
      return (await response.json()).html as string;
    };
    assert.ok((await preview('省略整个属性块。', doc.uri)).includes('class="paragraph-indent"'));
    for (const source of ['---\nparagraph_indent: none\n---\n关闭。', '---\n---\n清空属性。', '---\ncustom: changed\n---\n移除缩进设置。']) {
      assert.ok(!(await preview(source, doc.uri)).includes('class="paragraph-indent"'));
    }
    const current = app.registry.document(doc.uri);
    assert.equal(current.version, doc.version);
    assert.equal(current.metadata.paragraph_indent, '2em');
    assert.equal(current.metadata.custom, 'preserve');
    const enabled = '\uFEFF--- \t\r\nparagraph_indent: 2em\r\n---\r\n新建预览。';
    assert.ok(hasFrontmatter(enabled));
    assert.ok((await preview(enabled)).includes('class="paragraph-indent"'));
    assert.ok(!(await preview('English default.')).includes('class="paragraph-indent"'));
    const disabled = '\uFEFF--- \t\r\nparagraph_indent: none\r\n---\r\n关闭设置。';
    assert.ok(!(await preview(disabled, doc.uri)).includes('class="paragraph-indent"'));
    const updated = app.registry.update(doc.uri, disabled, doc.version);
    assert.equal(updated.metadata.paragraph_indent, 'none');
    assert.ok(!Object.hasOwn(updated.metadata, 'custom'));
    assert.ok(!renderMarkdown(updated.body, app.registry.scan('default').documents, updated).includes('class="paragraph-indent"'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
