import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createConfig } from '../src/config.js';
import { resourceUri } from '../src/content.js';
import { createApp } from '../src/web.js';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'coral-search-'));
  const project = join(root, 'project');
  mkdirSync(project);
  const application = createApp(createConfig({ data_dir: join(root, 'data'), vaults: { project: { path: project } }, search: { results_per_page: 2 } }));
  const server = application.app.listen(0, '127.0.0.1');
  const client = new Client({ name: 'coral-search-integration', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    application.close();
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  const write = (relative: string, raw: string) => {
    mkdirSync(dirname(join(project, relative)), { recursive: true });
    writeFileSync(join(project, relative), raw);
    return resourceUri('project', relative);
  };
  const apiSearch = async (query: string, limit = 20, cursor = 0) => {
    const response = await fetch(base + '/api/search?' + new URLSearchParams({ q: query, vault: 'project', limit: String(limit), cursor: String(cursor) }));
    assert.equal(response.status, 200);
    return await response.json() as ReturnType<typeof application.registry.search>;
  };
  const mcpSearch = async (query: string, limit = 20, cursor = 0) => {
    const result = await client.callTool({ name: 'search_documents', arguments: { query, vault_id: 'project', limit, cursor } });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(result.structuredContent);
    return result.structuredContent;
  };
  const searchHtml = async (query: string, cursor = 0) => {
    const response = await fetch(base + '/search?' + new URLSearchParams({ q: query, vault: 'project', cursor: String(cursor) }));
    assert.equal(response.status, 200);
    return response.text();
  };
  return { ...application, write, apiSearch, mcpSearch, searchHtml };
}

const resultUris = (html: string) => [...html.matchAll(/class="result-item"[^>]*data-document-uri="([^"]+)"/g)].map(match => match[1]);

test('Web, API and MCP rank exact titles and paths before body repetition using all query groups', async t => {
  const { registry, write, apiSearch, mcpSearch, searchHtml } = await fixture(t);
  const title = write('title.md', '---\ntitle: Layer Norm\n---\nPrecise reference.');
  const path = write('course/Layer/Norm.md', '---\ntitle: Normalization reference\n---\nPath match.');
  const repeated = write('repeated.md', '---\ntitle: Body reference\n---\n' + 'Layer Norm '.repeat(200));
  const separated = write('separated.md', 'Layer comes first.\n\nAn explanation separates the terms.\n\nNorm comes later.');
  const splitColumns = write('split.md', '---\ntitle: Layer\n---\nNorm is explained here.');
  write('partial.md', 'Only Layer is present.');
  const query = 'Layer Norm';
  const found = registry.search(query, 'project');
  assert.equal(found.total, 5);
  assert.deepEqual(found.results.slice(0, 2).map(doc => doc.uri), [title, path]);
  assert.deepEqual(new Set(found.results.slice(2).map(doc => doc.uri)), new Set([repeated, separated, splitColumns]));
  assert.deepEqual(await apiSearch(query), found);
  assert.deepEqual(await mcpSearch(query), found);
  assert.deepEqual(resultUris(await searchHtml(query)), [title, path]);
  assert.deepEqual(resultUris(await searchHtml(query, 2)), found.results.slice(2, 4).map(doc => doc.uri));
  assert.deepEqual(await mcpSearch(query, 2, 2), await apiSearch(query, 2, 2));
});

test('Markdown-separated Chinese hits produce relevant snippets, original line numbers and escaped highlights', async t => {
  const { registry, write, apiSearch, mcpSearch, searchHtml } = await fixture(t);
  const body = '# Introduction\r\n' + 'Background without matching words.\r\n'.repeat(80)
    + '## Details\r\n<img src=x onerror=alert(1)> 数**据**库索引，优化会减少开销。\r\n';
  const raw = '\uFEFF---\r\ntitle: Storage reference\r\n---\r\n' + body;
  const uri = write('中文 课程/storage.md', raw);
  const query = '数据库 优化';
  const found = registry.search(query, 'project');
  assert.equal(found.total, 1);
  assert.equal(found.results[0].uri, uri);
  const hit = found.results[0];
  assert.match(hit.snippet, /数\*\*据\*\*库索引，优化/);
  assert.equal(hit.start_line, raw.slice(0, raw.indexOf(hit.snippet, raw.length - body.length)).split('\n').length);
  assert.ok(hit.start_line > 50);
  assert.deepEqual(await apiSearch(query), found);
  assert.deepEqual(await mcpSearch(query), found);
  const html = await searchHtml(query);
  assert.match(html, /<mark>数\*\*据\*\*库<\/mark>/);
  assert.match(html, /<mark>优化<\/mark>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.equal(registry.search('数据库优化', 'project').total, 0);
});

test('real filenames, spaced directories and Latin accents stay searchable across Web and MCP', async t => {
  const { registry, write, apiSearch, mcpSearch, searchHtml } = await fixture(t);
  const uri = write('中文 课程/JAX Transfer/Buffer Transfer.md', '---\ntitle: 不同的属性标题\n---\nCafé reference.');
  for (const query of ['Buffer Transfer', '中文 课程', 'JAX Transfer', 'cafe']) {
    const found = registry.search(query, 'project');
    assert.deepEqual(found.results.map(doc => doc.uri), [uri], query);
    assert.deepEqual(await apiSearch(query), found);
    assert.deepEqual(await mcpSearch(query), found);
    assert.deepEqual(resultUris(await searchHtml(query)), [uri]);
  }
  assert.match(await searchHtml('cafe'), /<mark>Café<\/mark>/);
});
