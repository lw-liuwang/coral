import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createConfig } from './src/config.js';
import { createApp } from './src/web.js';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'coral-language-mcp-'));
  const application = createApp(createConfig({ data_dir: root }));
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: 'language-writing-agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    application.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { ...application, client, base, root };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response));
  assert.ok(response.structuredContent);
  return response.structuredContent;
}

async function readAll(client: Client, uri: string) {
  let content = '', offset = 0;
  let version: string | undefined;
  for (;;) {
    const chunk = await call(client, 'read_document', { uri, offset, max_chars: 100, ...(version ? { version } : {}) });
    version ??= String(chunk.version);
    assert.equal(chunk.version, version);
    content += String(chunk.content);
    if (chunk.next_offset === null) return { ...chunk, content, version };
    offset = Number(chunk.next_offset);
  }
}

test('MCP discovers and creates a language version without duplicating the logical note', async t => {
  const { registry, client } = await fixture(t);
  const source = registry.create('default', '缓存带宽', '# 缓存带宽\n\n同一笔记的原文。\n\n## 计算\n\n$2+2=4$\n\n```ts\nconst bytes = 4;\n```', { tags: ['reading'] }, 'cache', '课程');
  const tools = (await client.listTools()).tools;
  const tool = tools.find(item => item.name === 'create_language_version')!;
  assert.ok(tool);
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.annotations?.destructiveHint, false);
  assert.ok(tool.inputSchema.required?.includes('version'));
  assert.ok(tool.inputSchema.required?.includes('content'));
  assert.match(client.getInstructions()!, /create_language_version/);
  const guide = await call(client, 'get_writing_guide', { topic: 'languages' });
  assert.match(String(guide.markdown), /^## 中英文版本/);
  assert.match(String(guide.markdown), /不运行翻译模型/);
  assert.match(String(guide.markdown), /source_language/);
  const complete = await call(client, 'get_writing_guide');
  assert.ok(String(complete.markdown).includes(String(guide.markdown).trim()));

  const before = await readAll(client, source.uri);
  const english = '# Cache bandwidth\n\nThe original note in English.\n\n## Calculation\n\n$2+2=4$\n\n```ts\nconst bytes = 4;\n```';
  const created = await call(client, 'create_language_version', { uri: source.uri, version: before.version, language: 'en', title: 'Cache bandwidth', content: english });
  assert.equal(created.language, 'en');
  assert.equal(created.note_uri, source.uri);
  assert.notEqual(created.uri, source.uri);
  assert.deepEqual((created.language_versions as { language: string }[]).map(item => item.language).sort(), ['en', 'zh']);
  const translated = await readAll(client, String(created.uri));
  assert.ok(translated.content.endsWith(english));
  assert.equal(translated.note_uri, source.uri);
  assert.equal(translated.language, 'en');
  const currentSource = await readAll(client, source.uri);
  assert.notEqual(currentSource.version, source.version, 'Establishing the group changes the source metadata version');
  assert.equal(registry.document(source.uri).body, source.body);
  assert.deepEqual(registry.document(source.uri).metadata.tags, ['reading']);
  assert.equal(registry.scan('default').documents.length, 2, 'Both language files remain on disk');
  const listing = await call(client, 'list_documents', { vault_id: 'default' });
  assert.equal(listing.total, 1);
  assert.equal((listing.documents as { uri: string }[])[0].uri, source.uri);
  const directory = await call(client, 'browse_directory', { vault_id: 'default', directory: '课程' });
  assert.equal(directory.total, 1);
  assert.equal((directory.entries as { uri: string }[])[0].uri, source.uri);
  const englishSearch = await call(client, 'search_documents', { query: 'Calculation', vault_id: 'default' });
  assert.equal(englishSearch.total, 0, 'The English alternative is not independently searched');
  const chineseSearch = await call(client, 'search_documents', { query: '缓存带宽', vault_id: 'default' });
  assert.equal(chineseSearch.total, 1);
  const hit = (chineseSearch.results as { uri: string; title: string; version: string; snippet: string }[])[0];
  assert.equal(hit.uri, source.uri);
  assert.equal(hit.title, source.title);
  assert.equal(hit.version, currentSource.version);
  assert.match(hit.snippet, /缓存带宽/);
  const sharedSearch = await call(client, 'search_documents', { query: 'bytes', vault_id: 'default', limit: 1 });
  assert.equal(sharedSearch.total, 1);
  assert.equal(sharedSearch.next_cursor, null);

  const sourceBytes = registry.document(source.uri).raw;
  const updated = await call(client, 'update_document', { uri: created.uri, version: created.version, content: '---\ntitle: Updated English title\n---\n# Updated English title\n\nRevised explanation.' });
  assert.equal(updated.language, 'en');
  assert.equal(updated.note_uri, source.uri);
  assert.equal(registry.document(source.uri).raw, sourceBytes, 'Editing English must not synchronize Chinese implicitly');
  const duplicate = await client.callTool({ name: 'create_language_version', arguments: { uri: source.uri, version: currentSource.version, language: 'en', content: 'Must not overwrite English' } });
  assert.equal(duplicate.isError, true);
  assert.equal(registry.document(String(created.uri)).version, updated.version);
});

test('MCP preserves ordinary English filenames and rejects stale or invalid language creation', async t => {
  const { registry, client } = await fixture(t);
  const ordinary = registry.create('default', 'Ordinary English file', '# Separate note', {}, 'separate.en');
  const source = registry.create('default', 'English source', '# English source\n\nTechnical explanation.', {}, 'original');
  const stale = source.version;
  const current = registry.update(source.uri, '# English source\n\nChanged before translation.', stale);
  const conflict = await client.callTool({ name: 'create_language_version', arguments: { uri: source.uri, version: stale, language: 'zh', source_language: 'en', content: '# 中文版本' } });
  assert.equal(conflict.isError, true);
  assert.equal(registry.scan('default').documents.length, 2);
  const invalid = await client.callTool({ name: 'create_language_version', arguments: { uri: source.uri, version: current.version, language: 'fr', content: '# Unsupported language' } });
  assert.equal(invalid.isError, true);
  const translated = await call(client, 'create_language_version', { uri: source.uri, version: current.version, source_language: 'en', language: 'zh', title: '中文版本', content: '# 中文版本\n\n技术说明。' });
  assert.equal(translated.language, 'zh');
  assert.equal(translated.note_uri, translated.uri);
  const originalEnglish = await call(client, 'read_document', { uri: source.uri });
  assert.equal(originalEnglish.language, 'en');
  assert.equal(originalEnglish.note_uri, translated.uri);
  const notes = await call(client, 'list_documents', { vault_id: 'default' });
  assert.equal(notes.total, 2);
  assert.ok((notes.documents as { uri: string }[]).some(item => item.uri === ordinary.uri));
  assert.ok((notes.documents as { uri: string }[]).some(item => item.uri === translated.uri));
  assert.ok(!(notes.documents as { uri: string }[]).some(item => item.uri === source.uri));
  assert.equal((await call(client, 'search_documents', { query: 'Changed before translation', vault_id: 'default' })).total, 0);
  assert.equal((await call(client, 'search_documents', { query: 'Separate note', vault_id: 'default' })).total, 1, 'Existing unpaired English notes keep their search behavior');
});

test('MCP note_version guards other-language changes before grouped operations', async t => {
  const { registry, client, root } = await fixture(t);
  const source = registry.create('default', 'Grouped note', '# Source', {}, 'grouped');
  const english = await call(client, 'create_language_version', { uri: source.uri, version: source.version, language: 'en', content: '# English' });
  const observed = await call(client, 'read_document', { uri: source.uri });
  await call(client, 'update_document', { uri: english.uri, version: english.version, content: '# Changed English' });
  mkdirSync(join(root, 'obsdian/default/archive'));
  for (const [name, extra] of [
    ['move_document', { directory: 'archive' }],
    ['rename_document', { name: 'renamed.md' }],
    ['delete_document', {}],
  ] as const) {
    const response = await client.callTool({ name, arguments: { uri: source.uri, version: observed.version, note_version: observed.note_version, ...extra } });
    assert.equal(response.isError, true, name);
  }
  assert.equal(registry.scan('default').documents.length, 2);
  assert.equal(registry.document(source.uri).relative, 'grouped.md');
  const latest = await call(client, 'read_document', { uri: source.uri });
  const moved = await call(client, 'move_document', { uri: source.uri, version: latest.version, note_version: latest.note_version, directory: 'archive' });
  assert.ok(String(moved.uri).includes('/archive/'));
  assert.ok(registry.scan('default').documents.every(doc => doc.relative.startsWith('archive/')));
});

test('MCP reads a safe file when unrelated language discovery is incomplete but refuses creation', async t => {
  const { registry, client, root } = await fixture(t);
  const originalSource = registry.create('default', 'Readable source', '# Readable source', {}, 'readable');
  await call(client, 'create_language_version', { uri: originalSource.uri, version: originalSource.version, language: 'en', content: '# Readable English' });
  const source = registry.document(originalSource.uri);
  const blocked = join(root, 'obsdian/default/blocked');
  mkdirSync(blocked);
  const original = fs.readdirSync;
  fs.readdirSync = ((path, ...args) => {
    if (String(path) === blocked) throw Object.assign(new Error('injected directory permission failure'), { code: 'EACCES' });
    return Reflect.apply(original, fs, [path, ...args]);
  }) as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try {
    const read = await call(client, 'read_document', { uri: source.uri });
    assert.equal(read.content, source.raw);
    assert.equal(read.version, source.version);
    assert.equal(read.language_info_incomplete, true);
    assert.match(String(read.language_info_error), /目录/);
    assert.equal(read.note_uri, undefined);
    assert.equal(read.language_versions, undefined);
    const refused = await client.callTool({ name: 'create_language_version', arguments: { uri: source.uri, version: source.version, language: 'en', content: '# Translation' } });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused), /目录/);
  } finally {
    fs.readdirSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(registry.scan('default').documents.length, 2);
});
