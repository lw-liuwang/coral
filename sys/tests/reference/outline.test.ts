import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from './src/config.js';
import { renderMarkdown, renderMarkdownWithOutline } from './src/markdown.js';
import { VaultRegistry } from './src/vault.js';
import { documentPage } from './src/views.js';

test('outline uses actual rendered headings, plain labels and unique nonempty anchors', () => {
  const body = '# 笔记\n\n## **原理**与 `buffer`\n\nSetext 标题\n---\n\n### 跳级细节\n\n## A\n\n## A\n\n## A-1\n\n## !!!\n\n## ???\n\n```md\n## 围栏里的标题\n```\n\n```html\n<h2>图块里的标题</h2>\n```\n';
  const rendered = renderMarkdownWithOutline(body, []);
  assert.deepEqual(rendered.headings.map(heading => heading.title), ['笔记', '原理与 buffer', 'Setext 标题', '跳级细节', 'A', 'A', 'A-1', '!!!', '???']);
  const ids = rendered.headings.map(heading => heading.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(Boolean));
  assert.deepEqual(ids.slice(4), ['a', 'a-1', 'a-1-1', 'section', 'section-1']);
  for (const id of ids) assert.ok(rendered.html.includes('id="' + id + '"'));
  assert.equal(renderMarkdown(body, []), rendered.html);
  assert.equal(renderMarkdownWithOutline('## ![示意**图**](image.png)', []).headings[0].title, '示意图');
});

test('reading pages separate the article outline from folders without duplicating the main title', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coral-outline-'));
  const registry = new VaultRegistry(createConfig({ data_dir: directory }));
  try {
    const doc = registry.create('default', '笔记标题', '# 笔记标题\n\n## 章节 <script>\n\n### 小节\n\n普通内容。');
    const html = documentPage(registry, doc);
    const sidebar = html.match(/<aside\b[^>]*aria-label="知识库导航"[^>]*>[\s\S]*?<\/aside>/)![0];
    const outline = html.match(/<aside\b[^>]*aria-label="文章导航"[^>]*>[\s\S]*?<\/aside>/)![0];
    assert.ok(!sidebar.includes('data-article-toc'));
    assert.ok(sidebar.includes('aria-label="目录树"'));
    assert.ok(outline.includes('data-article-toc'));
    assert.ok(!outline.includes('aria-label="目录树"'));
    assert.ok(html.indexOf(sidebar) < html.indexOf(outline));
    assert.ok(html.indexOf(outline) < html.indexOf('<main'));
    assert.match(outline, /<details class="article-outline" open>/);
    assert.ok(outline.includes('href="#' + encodeURIComponent('章节-script') + '"'));
    assert.ok(outline.includes('章节 &lt;script&gt;'));
    assert.ok(!outline.includes('<script>'));
    assert.ok(!outline.includes('href="#' + encodeURIComponent('笔记标题') + '"'));
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
    const plain = registry.create('default', '短笔记', '# 短笔记\n\n没有其他章节。');
    assert.ok(!documentPage(registry, plain).includes('data-article-toc'));
  } finally { registry.close(); rmSync(directory, { recursive: true, force: true }); }
});
