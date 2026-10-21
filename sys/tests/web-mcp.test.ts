import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createConfig } from '../src/config.js';
import { createApp } from '../src/web.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-http-'));
  const project = join(root, 'project');
  mkdirSync(join(project, 'docs'), { recursive: true });
  const raw = '\uFEFF---\r\ntitle: Design\r\n---\r\n# Overview\r\n数据库索引设计\r\n';
  writeFileSync(join(project, 'docs/design.md'), raw);
  const config = createConfig({ data_dir: join(root, 'data'), vaults: { project: { path: project } } });
  const application = createApp(config);
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); application.close(); rmSync(root, { recursive: true, force: true }); });
  return { ...application, base, root, project, raw };
}
const params = (data: Record<string, string>) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data), redirect: 'manual' as const });
async function callMcp(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response));
  assert.ok(response.structuredContent);
  return response.structuredContent;
}

test('cyclic YAML properties render safely and corrupt Vault trash states do not break other pages', async () => {
  const { base, project, registry } = await fixture();
  writeFileSync(join(project, 'cycle.md'), '---\nvalue: &value\n  self: *value\n---\n# Circular YAML');
  const page = await fetch(base + '/document?' + new URLSearchParams({ uri: 'coral://vault/project/cycle.md' }));
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Circular YAML'));
  const state = join(registry.config.data_dir, '.coral/vault-trash/damaged');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'state.json'), '{');
  const trash = await fetch(base + '/trash');
  assert.equal(trash.status, 200);
  assert.ok((await trash.text()).includes('1 项回收内容无法读取'));
  assert.equal((await fetch(base)).status, 200);
});

test('Web app exposes only the knowledge base and supports multiple Vaults', async () => {
  const { base } = await fixture();
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.ok(page.includes('知识库'));
  assert.ok(!page.includes('随手记') && !page.includes('求职') && !page.includes('LLM'));
  for (const removed of ['/journal', '/jobs', '/ingest', '/sources', '/sources/view/example.md', '/kb', '/pages', '/pages/new', '/pages/example']) assert.equal((await fetch(base + removed)).status, 404);
  assert.equal((await fetch(base + '/sources/upload', params({}))).status, 404);
  assert.equal((await fetch(base + '/pages/new', params({}))).status, 404);
  const project = await (await fetch(base + '/?vault=project&directory=docs')).text();
  assert.ok(project.includes('Design'));
});

test('catalog and API rescan manually removed Vaults and retain unavailable external registrations', async () => {
  const { base, registry, project } = await fixture();
  const managed = registry.createVault('manual');
  const defaultRoot = registry.vault('default').root;
  const initial = await (await fetch(base)).text();
  assert.ok(initial.includes('title="刷新知识库"'));
  assert.ok(initial.includes('href="/?vault=default"'));
  assert.ok(initial.includes('href="/?vault=manual"'));

  rmSync(defaultRoot, { recursive: true });
  rmSync(managed.root, { recursive: true });
  rmSync(project, { recursive: true });
  const refreshed = await (await fetch(base)).text();
  assert.ok(!refreshed.includes('coral://vault/default/'));
  assert.ok(!refreshed.includes('coral://vault/manual/'));
  assert.ok(refreshed.includes('coral://vault/project/') && refreshed.includes('暂不可用'));
  const listing = await (await fetch(base + '/api/vaults')).json();
  assert.deepEqual(listing.vaults.map((vault: { id: string }) => vault.id), ['project']);
  assert.equal(listing.vaults[0].available, false);
  assert.equal((await fetch(base + '/?vault=default')).status, 404);
  assert.equal((await fetch(base + '/?vault=manual')).status, 404);
});

test('manual create, edit, conflict, search and delete over HTTP', async () => {
  const { base, registry } = await fixture();
  const created = await fetch(base + '/new', params({ vault: 'default', title: '中文笔记', content: '原始正文' }));
  assert.equal(created.status, 303);
  const location = created.headers.get('location')!;
  assert.equal((await fetch(base + location)).status, 200);
  const doc = registry.scan('default').documents[0];
  const updated = await fetch(base + '/edit', params({ uri: doc.uri, version: doc.version, content: '修订后的正文' }));
  assert.equal(updated.status, 303);
  const conflict = await fetch(base + '/edit', params({ uri: doc.uri, version: doc.version, content: '不能覆盖' }));
  assert.equal(conflict.status, 409);
  assert.ok((await conflict.text()).includes('不能覆盖'));
  assert.equal(registry.document(doc.uri).body, '修订后的正文');
  const searched = await (await fetch(base + '/api/search?q=' + encodeURIComponent('修订'))).json();
  assert.equal(searched.results[0].uri, doc.uri);
  const deleted = await fetch(base + '/delete', params({ uri: doc.uri, version: registry.document(doc.uri).version }));
  assert.equal(deleted.status, 303);
  assert.equal((await fetch(base + location)).status, 404);
});

test('create empty folders through Web with conflict errors preserving the parent and name', async () => {
  const { base, project } = await fixture();
  assert.equal((await fetch(base + '/directories/new?vault=project&directory=docs')).status, 200);
  const fields = { vault: 'project', directory: 'docs', name: '设计资料' };
  const created = await fetch(base + '/directories/new', params(fields));
  assert.equal(created.status, 303);
  assert.equal(new URL(created.headers.get('location')!, base).searchParams.get('directory'), 'docs');
  const listing = await (await fetch(base + created.headers.get('location'))).text();
  assert.ok(listing.includes('设计资料'));
  const conflict = await fetch(base + '/directories/new', params(fields));
  assert.equal(conflict.status, 409);
  const errorPage = await conflict.text();
  assert.ok(errorPage.includes('同名') && errorPage.includes('value="设计资料"') && errorPage.includes('value="docs"'));
  assert.equal((await fetch(base + '/directories/new', params({ ...fields, name: '../escape' }))).status, 400);
  assert.ok(readFileSync(join(project, 'docs/design.md'), 'utf8').includes('数据库索引设计'));
});

test('catalog creates a knowledge base before documents and preserves form errors', async () => {
  const { base, registry } = await fixture();
  const catalog = await (await fetch(base)).text();
  assert.ok(catalog.includes('创建知识库') && !catalog.includes('创建文档'));
  const form = await (await fetch(base + '/vaults/new')).text();
  assert.ok(!form.includes('name="id"'));
  const created = await fetch(base + '/vaults/new', params({ name: 'kernel', description: '独立仓库' }));
  assert.equal(created.status, 303);
  const location = created.headers.get('location')!;
  const id = new URL(location, base).searchParams.get('vault')!;
  assert.equal(id, 'kernel');
  assert.equal(registry.vault(id).root, join(registry.config.data_dir, 'obsdian', 'kernel'));
  const inside = await (await fetch(base + location)).text();
  assert.ok(inside.includes('创建文档') && inside.includes('kernel'));
  const duplicate = await fetch(base + '/vaults/new', params({ name: 'KERNEL', id: '../escape' }));
  assert.equal(duplicate.status, 409);
  assert.ok((await duplicate.text()).includes('同名'));
  const chinese = await fetch(base + '/vaults/new', params({ name: '研发资料' }));
  assert.equal(chinese.status, 400);
  const invalid = await fetch(base + '/vaults/new', params({ name: '', description: '保留简介' }));
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.text()).includes('保留简介'));
  await fetch(base + '/new', params({ vault: id, title: '新文档', content: '# 内容' }));
  assert.equal(registry.listDocuments(id).total, 1);
  assert.equal(registry.listDocuments('default').total, 0);
  const listed = await (await fetch(base + '/api/vaults')).json();
  assert.ok(listed.vaults.some((v: { id: string }) => v.id === id));
});

test('upload preserves Unicode filenames, rejects unsupported files, and never overwrites', async () => {
  const { base, registry } = await fixture();
  for (let i = 0; i < 2; i++) {
    const form = new FormData();
    form.append('vault', 'default');
    form.append('files', new Blob(['---\ntitle: 上传标题\ncustom: [one, two]\n---\n上传正文']), '中文 Note.markdown');
    form.append('files', new Blob(['bad']), 'bad.txt');
    const response = await fetch(base + '/upload', { method: 'POST', body: form, redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location')!, /upload=1&rejected=1/);
  }
  const docs = registry.scan('default').documents;
  assert.deepEqual(docs.map(doc => doc.relative).sort(), ['中文 Note-2.md', '中文 Note.md']);
  assert.deepEqual(docs[0].metadata.custom, ['one', 'two']);
});

test('directory browsing and uploads preserve arbitrary YAML types as ordinary properties', async () => {
  const { base, registry, project } = await fixture();
  writeFileSync(join(project, 'docs/legacy.md'), '---\ntype: custom-type\ntags: [研发]\n---\n旧文档');
  const root = await (await fetch(base + '/?vault=project')).text();
  assert.ok(root.includes('directory=docs') && !root.includes('转换分类'));
  const formPage = await (await fetch(base + '/new?vault=project&directory=docs')).text();
  assert.ok(formPage.includes('name="directory"') && !formPage.includes('name="type"'));
  const created = await fetch(base + '/new', params({ vault: 'project', title: '新文档', directory: 'docs', content: '# 新文档' }));
  assert.equal(created.status, 303);
  const doc = registry.scan('project').documents.find(doc => doc.title === '新文档')!;
  assert.equal(doc.relative, 'docs/新文档.md');
  assert.equal(doc.metadata.type, undefined);
  const form = new FormData();
  form.append('vault', 'project'); form.append('directory', 'docs');
  form.append('files', new Blob(['---\ntype: meeting\ntags: [团队]\n---\n记录']), '会议.md');
  const uploaded = await fetch(base + '/upload', { method: 'POST', body: form, redirect: 'manual' });
  assert.equal(uploaded.status, 303);
  assert.match(uploaded.headers.get('location')!, /directory=docs/);
  const meeting = registry.document('coral://vault/project/docs/' + encodeURIComponent('会议.md'));
  assert.equal(meeting.metadata.type, 'meeting');
  assert.deepEqual(meeting.metadata.tags, ['团队']);
  const view = await (await fetch(base + '/document?uri=' + encodeURIComponent(meeting.uri))).text();
  assert.ok(view.includes('meeting') && !view.includes('转换分类'));
  assert.equal((await fetch(base + '/?vault=project&directory=../escape')).status, 400);
  assert.equal((await fetch(base + '/new', params({ vault: 'project', title: 'Blocked', directory: '.obsidian', content: '' }))).status, 400);
  assert.equal((await fetch(base + '/retype', params({ uri: doc.uri, type: 'concept' }))).status, 404);
  assert.equal(registry.document(doc.uri).relative, 'docs/新文档.md');
});

test('delete files and folders from their listing, return to parent and reject stale requests', async () => {
  const { base, registry } = await fixture();
  const doc = registry.create('default', '文档', '内容', {}, undefined, '项目/docs');
  const listing = await (await fetch(base + '/?vault=default&directory=' + encodeURIComponent('项目/docs'))).text();
  assert.ok(listing.includes('删除文档：文档') && listing.includes('action="/delete"'));
  assert.equal((await fetch(base + '/delete', params({ uri: doc.uri }))).status, 400);
  registry.update(doc.uri, 'New content', doc.version);
  assert.equal((await fetch(base + '/delete', params({ uri: doc.uri, version: doc.version }))).status, 409);
  const deleted = await fetch(base + '/delete', params({ uri: doc.uri, version: registry.document(doc.uri).version }));
  assert.equal(deleted.status, 303);
  const target = new URL(deleted.headers.get('location')!, base);
  assert.equal(target.searchParams.get('directory'), '项目/docs');
  assert.ok((await (await fetch(target)).text()).includes('已移入知识库回收站'));
  const root = await (await fetch(base + '/?vault=default')).text();
  assert.ok(root.includes('删除文件夹：项目'));
  const folder = registry.browse('default').directories[0];
  const folderUri = 'coral://vault/default/' + encodeURIComponent('项目');
  assert.equal((await fetch(base + '/delete-directory', params({ uri: folderUri }))).status, 400);
  assert.equal((await fetch(base + '/delete-directory', params({ uri: folderUri, version: 'stale' }))).status, 409);
  assert.equal((await fetch(base + '/delete-directory', params({ uri: 'coral://vault/default/../escape', version: 'x' }))).status, 400);
  const removed = await fetch(base + '/delete-directory', params({ uri: folderUri, version: folder.version! }));
  assert.equal(removed.status, 303);
  assert.equal(new URL(removed.headers.get('location')!, base).searchParams.get('directory'), '');
  assert.ok(!registry.browse('default').directories.some(folder => folder.name === '项目'));
});

test('trash web actions restore, reject stale requests, purge, and clear only the selected Vault', async () => {
  const { base, registry } = await fixture();
  const doc = registry.create('default', 'Recover', 'Original');
  registry.delete(doc.uri, doc.version);
  let item = registry.listTrash('default').items[0];
  const page = await (await fetch(base + '/trash?vault=default')).text();
  assert.ok(page.includes('恢复：Recover.md') && page.includes('彻底删除：Recover.md'));
  assert.equal((await fetch(base + '/trash/restore', params({ scope: 'item', vault: 'default', entry: item.id, version: 'stale' }))).status, 409);
  assert.equal((await fetch(base + '/trash/restore', params({ scope: 'item', vault: 'default', entry: item.id, version: item.version }))).status, 303);
  assert.equal(registry.document(doc.uri).raw, doc.raw);
  registry.delete(doc.uri, registry.document(doc.uri).version);
  item = registry.listTrash('default').items[0];
  assert.equal((await fetch(base + '/trash/purge', params({ scope: 'item', vault: 'default', entry: '../escape', version: item.version }))).status, 400);
  assert.equal((await fetch(base + '/trash/purge', params({ scope: 'item', vault: 'default', entry: item.id, version: item.version }))).status, 303);
  assert.equal(registry.listTrash('default').items.length, 0);
  const other = registry.create('project', 'Other', 'Remain');
  registry.delete(other.uri, other.version);
  const snapshot = registry.listTrash('default');
  assert.equal((await fetch(base + '/trash/empty', params({ filter: 'default', version: snapshot.version }))).status, 303);
  assert.equal(registry.listTrash('project').items.length, 1);
});

test('recycled knowledge bases disappear from an actual MCP client and can be restored from Web', async () => {
  const { base, registry, project } = await fixture();
  const client = new Client({ name: 'recycle-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  try {
    const entry = registry.listVaults().vaults.find(v => v.id === 'project')!;
    assert.equal((await fetch(base + '/vaults/delete', params({ vault: 'project', version: entry.version }))).status, 303);
    const catalog = await client.callTool({ name: 'list_vaults', arguments: {} });
    assert.ok(!JSON.stringify(catalog.structuredContent).includes('coral://vault/project/'));
    const denied = await client.callTool({ name: 'read_document', arguments: { uri: 'coral://vault/project/docs/design.md' } });
    assert.equal(denied.isError, true);
    let trash = registry.listTrash().vaults.find(v => v.id === 'project')!;
    assert.equal((await fetch(base + '/trash/restore', params({ scope: 'vault', vault: 'project', version: trash.version }))).status, 303);
    const recovered = await client.callTool({ name: 'read_document', arguments: { uri: 'coral://vault/project/docs/design.md' } });
    assert.ok(!recovered.isError);
    registry.deleteVault('project', registry.listVaults().vaults.find(v => v.id === 'project')!.version);
    trash = registry.listTrash().vaults.find(v => v.id === 'project')!;
    assert.equal((await fetch(base + '/trash/purge', params({ scope: 'vault', vault: 'project', version: trash.version }))).status, 303);
    assert.ok(readFileSync(join(project, 'docs/design.md'), 'utf8').includes('数据库索引设计'));
    const emptyTrash = await fetch(base + '/trash?vault=project');
    assert.equal(emptyTrash.status, 200);
    const emptyPage = await emptyTrash.text();
    assert.match(emptyPage, /href="\/"[^>]*>[^<]*<i[^>]*data-lucide="arrow-left"/);
    assert.ok(!emptyPage.includes('href="/?vault=project"'));
  } finally { await client.close(); }
});

test('HTTP downloads use only coral resource URIs and preserve original file bytes', async () => {
  const { base, root, raw } = await fixture();
  const response = await fetch(base + '/download?' + new URLSearchParams({ uri: 'coral://vault/project/docs/design.md' }));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(raw));
  assert.match(response.headers.get('content-disposition')!, /attachment/);
  assert.ok(!JSON.stringify([...response.headers]).includes(root));
  const invalid = await fetch(base + '/download?' + new URLSearchParams({ uri: 'coral://vault/project/docs/../../secret.md' }));
  assert.equal(invalid.status, 400);
  assert.ok(!(await invalid.text()).includes(root));
});

test('preview escapes HTML and local image assets render from the same Vault', async () => {
  const { base, registry, project } = await fixture();
  const uri = 'coral://vault/project/docs/design.md';
  writeFileSync(join(project, 'docs/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=', 'base64'));
  const response = await fetch(base + '/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vault: 'project', uri, markdown: '<script>alert(1)</script>\n\n![[pixel.png]]' }) });
  const data = await response.json();
  assert.ok(!data.html.includes('<script>'));
  assert.match(data.html, /\/asset\?uri=/);
  const asset = await fetch(base + '/asset?' + new URLSearchParams({ uri: 'coral://vault/project/docs/pixel.png' }));
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.equal(registry.scan('project').documents.length, 1);
});

test('MCP Streamable HTTP handshake, tools, resources, search, read and download', async () => {
  const { base, root, raw, project } = await fixture();
  const client = new Client({ name: 'coral-test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  cleanup.push(() => client.close());
  const listed = await client.listTools();
  const readTools = ['browse_directory', 'download_document', 'list_documents', 'list_trash', 'list_vaults', 'read_document', 'search_documents'];
  const writeTools = ['create_directory', 'create_document', 'create_vault', 'delete_directory', 'delete_document', 'delete_vault', 'restore_trash', 'restore_vault', 'update_document'];
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [...readTools, ...writeTools].sort());
  for (const tool of listed.tools) {
    assert.equal(tool.annotations?.readOnlyHint, readTools.includes(tool.name));
    assert.equal(tool.annotations?.destructiveHint, tool.name.startsWith('delete_') || tool.name === 'update_document');
    assert.equal(tool.annotations?.openWorldHint, false);
    if (writeTools.includes(tool.name)) assert.equal(tool.annotations?.idempotentHint, false);
  }
  for (const name of ['update_document', 'delete_document', 'delete_directory', 'delete_vault', 'restore_trash', 'restore_vault']) {
    assert.ok(listed.tools.find(tool => tool.name === name)!.inputSchema.required?.includes('version'));
  }
  const vaults = await client.callTool({ name: 'list_vaults', arguments: {} });
  assert.ok(!vaults.isError);
  assert.ok(!JSON.stringify(vaults).includes(root));
  const docs = await client.callTool({ name: 'list_documents', arguments: { vault_id: 'project', directory: 'docs' } });
  assert.ok(JSON.stringify(docs).includes('coral://vault/project/docs/design.md'));
  const searched = await client.callTool({ name: 'search_documents', arguments: { query: '索引' } });
  assert.ok(JSON.stringify(searched).includes('coral://vault/project/docs/design.md'));
  const read = await client.callTool({ name: 'read_document', arguments: { uri: 'coral://vault/project/docs/design.md', max_chars: 10 } });
  assert.equal(read.structuredContent?.truncated, true);
  const downloaded = await client.callTool({ name: 'download_document', arguments: { uri: 'coral://vault/project/docs/design.md' } });
  const resource = (downloaded.content as { type: string; resource?: { blob: string; uri: string } }[]).find(item => item.type === 'resource')!.resource!;
  assert.deepEqual(Buffer.from(resource.blob, 'base64'), Buffer.from(raw));
  assert.equal(resource.uri, 'coral://vault/project/docs/design.md');
  const templates = await client.listResourceTemplates();
  assert.equal(templates.resourceTemplates[0].uriTemplate, 'coral://vault/{vault_id}/{+path}');
  const content = await client.readResource({ uri: resource.uri });
  assert.equal(content.contents[0].text, raw);
  writeFileSync(join(project, 'docs/Large.md'), '文'.repeat(350000));
  const largeUri = 'coral://vault/project/docs/Large.md';
  await assert.rejects(() => client.readResource({ uri: largeUri }), /exceeds 1 MiB/);
  const chunk = await client.callTool({ name: 'read_document', arguments: { uri: largeUri, max_chars: 10 } });
  assert.equal(chunk.structuredContent?.content, '文'.repeat(10));
  assert.equal(chunk.structuredContent?.truncated, true);
  const missing = await client.callTool({ name: 'download_document', arguments: { uri: 'coral://vault/project/../secret.md' } });
  assert.equal(missing.isError, true);
  assert.ok(!JSON.stringify(missing).includes(root));
  assert.equal((await fetch(base + '/mcp')).status, 405);
});

test('MCP document writes preserve metadata, reject unsafe and stale edits, and recycle and restore files', async () => {
  const { base, root, project, registry } = await fixture();
  const client = new Client({ name: 'mcp-writing-agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  cleanup.push(() => client.close());
  const args = { vault_id: 'project', title: 'Agent note', directory: '新建/docs', filename: 'note',
    content: '---\ntags: [draft]\ncustom:\n  score: 2\n---\n# Original\ncreatedneedle' };
  const created = await callMcp(client, 'create_document', args);
  assert.equal(created.uri, 'coral://vault/project/' + encodeURIComponent('新建') + '/docs/note.md');
  assert.ok(!JSON.stringify(created).includes(root));
  const uri = String(created.uri);
  const target = join(project, '新建/docs/note.md');
  const original = registry.document(uri);
  assert.deepEqual(original.metadata.tags, ['draft']);
  assert.deepEqual(original.metadata.custom, { score: 2 });
  assert.equal(original.metadata.title, 'Agent note');
  const collision = await callMcp(client, 'create_document', args);
  assert.notEqual(collision.uri, uri);
  assert.equal(readFileSync(target, 'utf8'), original.raw);

  for (const name of ['update_document', 'delete_document']) {
    const missingVersion = await client.callTool({ name, arguments: { uri, content: 'No version' } });
    assert.equal(missingVersion.isError, true);
  }
  for (const invalid of [
    { ...args, directory: '../outside' },
    { ...args, directory: '.hidden' },
    { ...args, vault_id: '../outside' },
    { ...args, content: '---\ntags: [\n---\nBroken YAML' },
  ]) {
    const denied = await client.callTool({ name: 'create_document', arguments: invalid });
    assert.equal(denied.isError, true);
    assert.ok(!JSON.stringify(denied).includes(root));
  }
  for (const unsafeUri of ['coral://vault/project/../outside.md', target]) {
    const denied = await client.callTool({ name: 'update_document', arguments: { uri: unsafeUri, version: created.version, content: 'Escape attempt' } });
    assert.equal(denied.isError, true);
    assert.ok(!JSON.stringify(denied).includes(root));
  }
  assert.equal(readFileSync(target, 'utf8'), original.raw);

  writeFileSync(target, '# External edit\nDo not overwrite');
  for (const name of ['update_document', 'delete_document']) {
    const stale = await client.callTool({ name, arguments: { uri, version: created.version, content: 'Stale edit' } });
    assert.equal(stale.isError, true);
  }
  assert.equal(readFileSync(target, 'utf8'), '# External edit\nDo not overwrite');
  const latest = await callMcp(client, 'read_document', { uri });
  const updated = await callMcp(client, 'update_document', { uri, version: latest.version,
    content: '---\ntitle: Updated\ntags: [published]\n---\n# Updated\nupdatedneedle' });
  assert.equal(updated.uri, uri);
  assert.notEqual(updated.version, latest.version);
  assert.equal(registry.document(uri).body, '# Updated\nupdatedneedle');
  assert.deepEqual(registry.document(uri).metadata.tags, ['published']);
  assert.ok(!Object.hasOwn(registry.document(uri).metadata, 'custom'));
  const backups = readdirSync(join(project, '.coral-backups'));
  assert.ok(backups.some(batch => readFileSync(join(project, '.coral-backups', batch, 'note.md'), 'utf8') === '# External edit\nDo not overwrite'));
  assert.ok((await (await fetch(base + '/document?' + new URLSearchParams({ uri }))).text()).includes('updatedneedle'));
  const found = await callMcp(client, 'search_documents', { query: 'updatedneedle' });
  assert.equal(found.total, 1);

  const malformed = await client.callTool({ name: 'update_document', arguments: { uri, version: updated.version, content: '---\ntags: [\n---\nBroken YAML' } });
  assert.equal(malformed.isError, true);
  assert.equal(registry.document(uri).version, updated.version);
  const deleted = await callMcp(client, 'delete_document', { uri, version: updated.version });
  assert.equal(deleted.trashed, true);
  assert.throws(() => registry.document(uri));
  const trash = await callMcp(client, 'list_trash', { vault_id: 'project' });
  const entry = (trash.items as { id: string; uri: string; version: string }[]).find(item => item.uri === uri)!;
  assert.ok(entry);
  const staleRestore = await client.callTool({ name: 'restore_trash', arguments: { vault_id: 'project', entry_id: entry.id, version: 'stale' } });
  assert.equal(staleRestore.isError, true);
  writeFileSync(target, 'Existing replacement');
  const conflict = await client.callTool({ name: 'restore_trash', arguments: { vault_id: 'project', entry_id: entry.id, version: entry.version } });
  assert.equal(conflict.isError, true);
  assert.equal(readFileSync(target, 'utf8'), 'Existing replacement');
  rmSync(target);
  await callMcp(client, 'restore_trash', { vault_id: 'project', entry_id: entry.id, version: entry.version });
  assert.equal(registry.document(uri).version, updated.version);
});

test('MCP manages Vaults and folders with versioned recycling and preserves external source files', async () => {
  const { base, registry, project, raw, root } = await fixture();
  const client = new Client({ name: 'mcp-vault-agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  cleanup.push(() => client.close());
  const created = await callMcp(client, 'create_vault', { name: ' Agent-Notes ', description: 'Agent workspace' });
  assert.equal(created.vault_id, 'agent-notes');
  assert.ok(!JSON.stringify(created).includes(root));
  const vault_id = String(created.vault_id);
  const vault = registry.vault(vault_id);
  const folder = await callMcp(client, 'create_directory', { vault_id, name: 'docs' });
  assert.equal(folder.uri, 'coral://vault/agent-notes/docs');
  await callMcp(client, 'create_directory', { vault_id, name: 'empty' });
  for (const name of ['docs', '../outside']) {
    const denied = await client.callTool({ name: 'create_directory', arguments: { vault_id, name } });
    assert.equal(denied.isError, true);
  }
  const duplicate = await client.callTool({ name: 'create_vault', arguments: { name: vault_id } });
  assert.equal(duplicate.isError, true);
  const first = await callMcp(client, 'browse_directory', { vault_id, limit: 1 });
  const second = await callMcp(client, 'browse_directory', { vault_id, limit: 1, cursor: first.next_cursor });
  const folders = [...first.entries as { uri: string; version: string }[], ...second.entries as { uri: string; version: string }[]];
  assert.equal(first.total, 2);
  assert.equal(first.next_cursor, 1);
  assert.equal(second.next_cursor, null);
  assert.equal(folders.length, 2);
  const oldFolder = folders.find(entry => entry.uri === folder.uri)!;
  const doc = await callMcp(client, 'create_document', { vault_id, directory: 'docs', title: 'Note', content: 'Folder contents' });
  writeFileSync(join(vault.root, 'docs', 'attachment.bin'), Buffer.from([0, 255, 42]));
  const stale = await client.callTool({ name: 'delete_directory', arguments: { uri: folder.uri, version: oldFolder.version } });
  assert.equal(stale.isError, true);
  const current = await callMcp(client, 'browse_directory', { vault_id });
  const snapshot = (current.entries as { uri: string; version: string }[]).find(entry => entry.uri === folder.uri)!;
  const inside = await callMcp(client, 'browse_directory', { vault_id, directory: 'docs' });
  const document = (inside.entries as { uri: string; content?: string; raw?: string }[])[0];
  assert.equal(document.uri, doc.uri);
  assert.ok(!Object.hasOwn(document, 'content') && !Object.hasOwn(document, 'raw'));
  assert.ok(!JSON.stringify(current).includes(root));
  await callMcp(client, 'delete_directory', { uri: folder.uri, version: snapshot.version });
  assert.throws(() => registry.document(String(doc.uri)));
  let trash = await callMcp(client, 'list_trash', { vault_id });
  const trashedFolder = (trash.items as { id: string; kind: string; version: string }[])[0];
  assert.equal(trashedFolder.kind, 'directory');
  await callMcp(client, 'restore_trash', { vault_id, entry_id: trashedFolder.id, version: trashedFolder.version });
  assert.equal(registry.document(String(doc.uri)).body, 'Folder contents');
  assert.deepEqual(readFileSync(join(vault.root, 'docs', 'attachment.bin')), Buffer.from([0, 255, 42]));

  let listing = await callMcp(client, 'list_vaults');
  const managed = (listing.vaults as { id: string; version: string }[]).find(item => item.id === vault_id)!;
  const staleVault = await client.callTool({ name: 'delete_vault', arguments: { vault_id, version: 'stale' } });
  assert.equal(staleVault.isError, true);
  await callMcp(client, 'delete_vault', { vault_id, version: managed.version });
  assert.throws(() => registry.vault(vault_id));
  trash = await callMcp(client, 'list_trash', { vault_id });
  const trashedVault = (trash.vaults as { id: string; version: string }[])[0];
  const staleVaultRestore = await client.callTool({ name: 'restore_vault', arguments: { vault_id, version: 'stale' } });
  assert.equal(staleVaultRestore.isError, true);
  await callMcp(client, 'restore_vault', { vault_id, version: trashedVault.version });
  assert.equal(registry.document(String(doc.uri)).body, 'Folder contents');

  listing = await callMcp(client, 'list_vaults');
  const external = (listing.vaults as { id: string; version: string }[]).find(item => item.id === 'project')!;
  await callMcp(client, 'delete_vault', { vault_id: 'project', version: external.version });
  assert.equal(readFileSync(join(project, 'docs/design.md'), 'utf8'), raw);
  trash = await callMcp(client, 'list_trash', { vault_id: 'project' });
  const registration = (trash.vaults as { version: string; external: boolean }[])[0];
  assert.equal(registration.external, true);
  await callMcp(client, 'restore_vault', { vault_id: 'project', version: registration.version });
  assert.equal(registry.document('coral://vault/project/docs/design.md').raw, raw);
});

test('MCP stdio reads and writes through an actual agent subprocess without stdout contamination', async () => {
  const { root, project, registry } = await fixture();
  const configPath = join(root, 'config.yaml');
  writeFileSync(configPath, JSON.stringify({ data_dir: './data', vaults: { project: { path: './project' } } }));
  const client = new Client({ name: 'stdio-test-agent', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, resolve('src/stdio.ts')], cwd: root, env: { ...process.env as Record<string, string>, CORAL_CONFIG: configPath }, stderr: 'pipe' });
  await client.connect(transport);
  cleanup.push(() => client.close());
  const response = await client.callTool({ name: 'list_vaults', arguments: {} });
  assert.ok(!response.isError);
  assert.ok(JSON.stringify(response).includes('project'));
  const found = await client.callTool({ name: 'search_documents', arguments: { query: '索引', vault_id: 'project' } });
  assert.ok(JSON.stringify(found).includes('coral://vault/project/docs/design.md'));
  const created = await callMcp(client, 'create_document', { vault_id: 'project', title: 'Stdio note', content: 'Written through stdio' });
  assert.equal(registry.document(String(created.uri)).body, 'Written through stdio');
  assert.ok(!JSON.stringify(created).includes(root));
  const updated = await callMcp(client, 'update_document', { uri: created.uri, version: created.version, content: 'Updated through stdio' });
  assert.equal(registry.document(String(created.uri)).body, 'Updated through stdio');
  await callMcp(client, 'delete_document', { uri: created.uri, version: updated.version });
  assert.throws(() => registry.document(String(created.uri)));
  const trash = await callMcp(client, 'list_trash', { vault_id: 'project' });
  const entry = (trash.items as { id: string; version: string }[])[0];
  await callMcp(client, 'restore_trash', { vault_id: 'project', entry_id: entry.id, version: entry.version });
  assert.equal(registry.document(String(created.uri)).body, 'Updated through stdio');
});
