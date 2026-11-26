import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from './reference/src/web.js';
import { createConfig } from './reference/src/config.js';

async function native(root: string) {
  const config = join(root, 'config.yaml');
  writeFileSync(config, JSON.stringify({ data_dir: root }));
  const child = spawn(resolve('dist', process.platform === 'win32' ? 'coral.exe' : 'coral'), ['--config', config, '--listen', '127.0.0.1:0'], { env: { ...process.env, CORAL_DATA_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(output || 'Startup timeout')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
    child.stderr.on('data', data => { output += data; });
    child.stdout.on('data', data => { output += data; const match = /coral: (http:\/\/[^\s]+)/.exec(output); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  return { base, close: async () => { child.kill(); await exited; } };
}

test('native Go preserves MCP schemas, resource bytes, search entries and versioned Web edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-go-parity-'));
  const fixtures = ['native', 'reference'].map(name => join(root, name));
  for (const directory of fixtures) {
    mkdirSync(join(directory, 'obsdian/default/docs/assets'), { recursive: true });
    for (const [name, content] of Object.entries({ 'index.md': '# Start\n\n[[docs/note]]', 'docs/note.md': '\uFEFF---\r\ntitle: KV Cache 容量与带宽\r\n---\r\n# Note\r\n\r\nKV 带宽\r\n![pixel](assets/pixel.png)\r\n', 'docs/11.md': '# Eleven', 'docs/100.md': '# Hundred' })) writeFileSync(join(directory, 'obsdian/default', name), content);
    writeFileSync(join(directory, 'obsdian/default/docs/assets/pixel.png'), Buffer.from([1, 2, 3]));
  }
  const go = await native(fixtures[0]);
  const old = createApp(createConfig({ data_dir: fixtures[1] }));
  const server = old.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const clients = [new Client({ name: 'parity-go', version: '1' }), new Client({ name: 'parity-reference', version: '1' })];
  try {
    const bases = [go.base, `http://127.0.0.1:${address.port}`];
    await Promise.all(clients.map((client, index) => client.connect(new StreamableHTTPClientTransport(new URL(bases[index] + '/mcp')))));
    const tools = await Promise.all(clients.map(client => client.listTools()));
    const normalize = (list: typeof tools[number]) => list.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(normalize(tools[0]), normalize(tools[1]));
    const call = async (client: Client, name: string, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent!; };
    const uri = 'coral://vault/default/docs/note.md';
    const reads = await Promise.all(clients.map(client => call(client, 'read_document', { uri })));
    for (const key of ['content', 'version', 'path', 'uri', 'total_chars', 'headings']) assert.deepEqual(reads[0][key], reads[1][key], key);
    for (const query of ['KV 带宽', 'Cache', 'docs/note.md']) {
      const found = await Promise.all(clients.map(client => call(client, 'search_documents', { query })));
      const select = (result: typeof found[number]) => (result.results as any[]).map(item => ({ uri: item.uri, snippet: item.snippet, start_line: item.start_line }));
      assert.deepEqual(select(found[0]), select(found[1]));
    }
    for (const [index, base] of bases.entries()) {
      const download = await fetch(base + '/download?' + new URLSearchParams({ uri }));
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(String(reads[index].content)));
      const edited = await fetch(base + '/edit', { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams({ uri, content: '# Updated\n\nShared write', version: String(reads[index].version) }) });
      assert.equal(edited.status, 200);
      const stale = await clients[index].callTool({ name: 'update_document', arguments: { uri, content: 'stale', version: reads[index].version } });
      assert.equal(stale.isError, true);
      const current = await call(clients[index], 'read_document', { uri });
      assert.match(String(current.content), /Shared write/);
    }
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await go.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); old.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('native executable serves MCP over stdio without Node at runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-go-stdio-'));
  const config = join(root, 'config.yaml'); writeFileSync(config, JSON.stringify({ data_dir: root }));
  const client = new Client({ name: 'stdio-go', version: '1' });
  const transport = new StdioClientTransport({ command: resolve('dist', process.platform === 'win32' ? 'coral.exe' : 'coral'), args: ['--config', config, '--stdio'], env: { ...process.env as Record<string, string>, CORAL_DATA_DIR: root }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: 'create_document', arguments: { vault_id: 'default', title: 'Stdio', content: 'Native process' } });
    assert.ok(!response.isError, JSON.stringify(response));
    const uri = String(response.structuredContent!.uri);
    const resource = await client.readResource({ uri });
    assert.ok('text' in resource.contents[0] && resource.contents[0].text.includes('Native process'));
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});
