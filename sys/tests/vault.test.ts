import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createConfig } from '../src/config.js';
import { AppError, headings, parseMarkdown, parseUri, resourceUri, serialize } from '../src/content.js';
import { backlinksFor, renderMarkdown, resolveLink, resolveRelativeLink, wikiTargets } from '../src/markdown.js';
import { MAX_FILE_BYTES, VaultRegistry } from '../src/vault.js';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'coral-ts-'));
  const project = join(directory, 'project');
  mkdirSync(join(project, 'docs'), { recursive: true });
  const config = createConfig({ data_dir: join(directory, 'data'), vaults: { project: { name: 'Project', path: project } } });
  const registry = new VaultRegistry(config);
  cleanup.push(() => { registry.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, registry, project, root: join(config.data_dir, 'obsdian', 'default') };
}

test('configuration defaults and validation', () => {
  assert.equal(createConfig().server.port, 8300);
  assert.throws(() => createConfig({ vaults: { default: { path: '/tmp' } } }));
  assert.throws(() => createConfig({ vaults: { '../escape': { path: '/tmp' } } }));
  assert.throws(() => createConfig({ search: { results_per_page: 0 } }));
  assert.throws(() => createConfig({ vaults: { x: { path: 2 } } }));
});

test('scans reuse unchanged documents and refresh links and search after external edits and removal', () => {
  const { registry, project } = fixture();
  writeFileSync(join(project, 'docs/a.md'), '# A\n[[b]]');
  writeFileSync(join(project, 'docs/b.md'), '# B\nOriginal');
  let refreshes = 0;
  const refresh = registry.refreshVaults.bind(registry);
  registry.refreshVaults = () => { refreshes++; refresh(); };
  const first = registry.scan('project');
  assert.equal(refreshes, 1);
  const second = registry.scan('project');
  assert.equal(first, second);
  refreshes = 0;
  assert.equal(registry.listVaults().vaults.find(v => v.id === 'project')!.document_count, 2);
  assert.equal(refreshes, 1);
  assert.equal(backlinksFor(first.documents, 'coral://vault/project/docs/b.md').length, 1);
  assert.equal(registry.search('Original', 'project').total, 1);
  writeFileSync(join(project, 'docs/a.md'), '# A\nNo outgoing link');
  writeFileSync(join(project, 'docs/b.md'), '# B\nReplaced');
  const changed = registry.scan('project');
  assert.notEqual(changed, first);
  assert.equal(backlinksFor(changed.documents, 'coral://vault/project/docs/b.md').length, 0);
  assert.equal(registry.search('Original', 'project').total, 0);
  assert.equal(registry.search('Replaced', 'project').total, 1);
  rmSync(join(project, 'docs/b.md'));
  assert.equal(registry.search('Replaced', 'project').total, 0);
});

test('saving detects writes during backup and never overwrites a concurrently recreated file', () => {
  const { registry, root } = fixture();
  const doc = registry.create('default', 'Concurrent', 'Original');
  const target = join(root, doc.relative);
  const rename = fs.renameSync;
  for (const phase of ['before', 'after']) {
    writeFileSync(target, doc.raw);
    fs.renameSync = ((from, to) => {
      if (String(from) === target && phase === 'before') writeFileSync(target, 'External edit before backup');
      rename(from, to);
      if (String(from) === target && phase === 'after') writeFileSync(target, 'External replacement');
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => registry.update(doc.uri, 'Web edit', doc.version), (error: unknown) => error instanceof AppError && error.status === 409);
      assert.equal(readFileSync(target, 'utf8'), phase === 'before' ? 'External edit before backup' : 'External replacement');
    } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  }
  writeFileSync(target, doc.raw);
  const updated = registry.update(doc.uri, 'Successful edit', doc.version);
  assert.equal(updated.body, 'Successful edit');
  assert.ok(readdirSync(join(root, '.coral-backups')).length >= 3);
  assert.equal(registry.scan('default').documents.length, 1);
  const descriptor = fs.openSync(target, 'r+');
  try {
    registry.update(doc.uri, 'Next edit', updated.version);
    fs.writeSync(descriptor, 'Late write through an existing Obsidian descriptor');
    const retained = readdirSync(join(root, '.coral-backups')).map(batch => readFileSync(join(root, '.coral-backups', batch, doc.relative), 'utf8'));
    assert.ok(retained.some(content => content.includes('Late write through an existing Obsidian descriptor')));
    assert.equal(registry.document(doc.uri).body, 'Next edit');
  } finally { fs.closeSync(descriptor); }
});

test('web Git commits preserve unrelated staged changes', () => {
  const { registry, root, directory } = fixture();
  const systemGit = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  systemGit('init', '-q');
  writeFileSync(join(directory, 'system.ts'), 'User staged code');
  systemGit('add', 'system.ts');
  registry.create('default', 'First', 'One');
  const gitRoot = root;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: gitRoot, encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'unrelated.md'), 'User staged work');
  git('add', 'unrelated.md');
  const doc = registry.create('default', 'Second', 'Two');
  assert.deepEqual(git('show', '--pretty=', '--name-only', 'HEAD').split('\n'), ['Second.md']);
  assert.equal(git('diff', '--cached', '--name-only'), 'unrelated.md');
  registry.delete(doc.uri, doc.version);
  assert.equal(git('diff', '--cached', '--name-only'), 'unrelated.md');
  assert.equal(systemGit('diff', '--cached', '--name-only'), 'system.ts');
  assert.ok(existsSync(join(root, '.git')));
});

test('managed Vault trash restores into the current data directory after relocation', () => {
  const { registry, directory } = fixture();
  const managed = registry.createVault('Relocated');
  registry.create(managed.id, 'Retained', 'Original content');
  for (const id of ['default', managed.id]) {
    const vault = registry.listVaults().vaults.find(item => item.id === id)!;
    registry.deleteVault(id, vault.version);
  }
  const moved = join(directory, 'moved');
  renameSync(registry.config.data_dir, moved);
  const restarted = new VaultRegistry(createConfig({ data_dir: moved }));
  try {
    for (const vault of restarted.listTrash().vaults) restarted.restoreVault(vault.id, vault.version);
    assert.equal(restarted.vault('default').root, join(moved, 'obsdian', 'default'));
    assert.equal(restarted.vault(managed.id).root, join(moved, 'obsdian', managed.name));
    assert.equal(restarted.scan(managed.id).documents[0].body, 'Original content');
    assert.ok(!existsSync(registry.config.data_dir));
  } finally { restarted.close(); }
});

test('corrupt knowledge base trash states are isolated, preserved and keep affected Vaults hidden', () => {
  const { registry } = fixture();
  const vault = registry.createVault('Damaged');
  const stateRoot = join(registry.config.data_dir, '.coral/vault-trash');
  mkdirSync(join(stateRoot, vault.id), { recursive: true });
  writeFileSync(join(stateRoot, vault.id, 'state.json'), '{');
  assert.ok(!registry.listVaults().vaults.some(item => item.id === vault.id));
  assert.equal(registry.listTrash().skipped, 1);
  assert.equal(registry.listTrash(vault.id).skipped, 1);
  const listing = registry.listTrash();
  registry.emptyTrash(undefined, listing.version);
  assert.equal(readFileSync(join(stateRoot, vault.id, 'state.json'), 'utf8'), '{');
  const restarted = new VaultRegistry(registry.config);
  try { assert.equal(restarted.listTrash().skipped, 1); }
  finally { restarted.close(); }
});

test('Markdown relative links prefer the current directory while Wiki links retain Vault path semantics', () => {
  const { registry, project } = fixture();
  writeFileSync(join(project, 'design.md'), '# Root');
  writeFileSync(join(project, 'docs/design.md'), '# Local');
  writeFileSync(join(project, 'docs/current.md'), '# Current');
  const docs = registry.scan('project').documents;
  const current = docs.find(doc => doc.relative === 'docs/current.md')!;
  assert.equal(resolveRelativeLink('design.md', docs, current)?.relative, 'docs/design.md');
  assert.equal(resolveRelativeLink('../design.md', docs, current)?.relative, 'design.md');
  assert.equal(resolveRelativeLink('../../design.md', docs, current), undefined);
  assert.equal(resolveLink('design', docs, current)?.relative, 'design.md');
  const rendered = renderMarkdown('[Local](design.md) [Root](../design.md)', docs, current);
  assert.ok(rendered.includes(encodeURIComponent('coral://vault/project/docs/design.md')));
  assert.ok(rendered.includes(encodeURIComponent('coral://vault/project/design.md')));
});

test('empty folders support nested parents and reject collisions, traversal and symlinks', () => {
  const { registry, project, directory } = fixture();
  registry.createDirectory('project', 'docs', '  设计资料  ');
  assert.deepEqual(readdirSync(join(project, 'docs/设计资料')), []);
  assert.ok(registry.browse('project', 'docs').directories.some(folder => folder.name === '设计资料'));
  assert.throws(() => registry.createDirectory('project', 'docs', '设计资料'), (error: unknown) => error instanceof AppError && error.status === 409);
  writeFileSync(join(project, 'docs/existing.md'), 'keep');
  assert.throws(() => registry.createDirectory('project', 'docs', 'existing.md'), AppError);
  for (const name of ['', ' ', '.', '..', '.obsidian', '../outside', 'a/b', 'a\\b', 'bad\u0000', 'a'.repeat(256)]) {
    assert.throws(() => registry.createDirectory('project', 'docs', name), AppError);
  }
  symlinkSync(directory, join(project, 'linked'));
  assert.throws(() => registry.createDirectory('project', 'linked', 'outside'), AppError);
  assert.throws(() => registry.createDirectory('project', '../outside', 'child'), AppError);
  assert.throws(() => registry.createDirectory('project', 'missing', 'child'), AppError);
  assert.equal(readFileSync(join(project, 'docs/existing.md'), 'utf8'), 'keep');
});

test('created Vaults persist and are discovered by an already running registry', () => {
  const { registry, directory } = fixture();
  const observer = new VaultRegistry(registry.config);
  try {
    const vault = registry.createVault(' Project-Notes ', '设计文档');
    assert.equal(vault.name, 'project-notes');
    assert.equal(vault.root, join(registry.config.data_dir, 'obsdian', 'project-notes'));
    assert.ok(existsSync(join(vault.root, '.obsidian')));
    const doc = registry.create(vault.id, '设计', '独立知识库内容');
    assert.equal(observer.listVaults().vaults.find(v => v.id === vault.id)?.document_count, 1);
    assert.equal(observer.document(doc.uri).body, '独立知识库内容');
    assert.equal(observer.scan('default').documents.length, 0);
    assert.ok(!JSON.stringify(observer.listVaults()).includes(directory));
    const restarted = new VaultRegistry(registry.config);
    try { assert.equal(restarted.vault(vault.id).description, '设计文档'); }
    finally { restarted.close(); }
    for (const name of ['default', 'project', 'project-notes', '../escape', '.hidden', 'a/b', '']) {
      assert.throws(() => registry.createVault(name), AppError);
    }
    assert.throws(() => registry.createVault(' '), AppError);
    mkdirSync(join(registry.config.data_dir, 'obsdian', 'unregistered'));
    writeFileSync(join(registry.config.data_dir, 'obsdian', 'unregistered', 'keep.md'), 'keep');
    assert.throws(() => registry.createVault('unregistered'), AppError);
    assert.equal(readFileSync(join(registry.config.data_dir, 'obsdian', 'unregistered', 'keep.md'), 'utf8'), 'keep');
  } finally { observer.close(); }
});

test('manually removed managed Vaults disappear from the catalog and search, including default after restart', () => {
  const { registry, root } = fixture();
  const managed = registry.createVault('manual');
  registry.create('default', 'Default note', 'removedneedle');
  registry.create(managed.id, 'Managed note', 'removedneedle');
  assert.equal(registry.search('removedneedle').total, 2);

  rmSync(root, { recursive: true });
  rmSync(managed.root, { recursive: true });
  assert.deepEqual(registry.listVaults().vaults.map(vault => vault.id), ['project']);
  assert.equal(registry.search('removedneedle').total, 0);
  assert.deepEqual(registry.search('removedneedle').unavailable_vaults, []);
  assert.throws(() => registry.vault('default'), /知识库不存在/);
  assert.throws(() => registry.vault(managed.id), /知识库不存在/);
  assert.equal(registry.listTrash().vaults.length, 0);

  const restarted = new VaultRegistry(registry.config);
  try {
    assert.ok(!existsSync(root));
    assert.deepEqual(restarted.listVaults().vaults.map(vault => vault.id), ['project']);
    mkdirSync(root);
    writeFileSync(join(root, 'restored.md'), 'restoredneedle');
    assert.equal(registry.listVaults().vaults.find(vault => vault.id === 'default')?.document_count, 1);
    assert.equal(registry.search('restoredneedle').total, 1);
  } finally { restarted.close(); }
});

test('English Vault names determine directories and default IDs, with duplicate and invalid names rejected', () => {
  const { registry } = fixture();
  const vault = registry.createVault(' Kernel ', '内核知识');
  assert.equal(vault.id, 'kernel');
  assert.equal(vault.name, 'kernel');
  assert.equal(vault.root, join(registry.config.data_dir, 'obsdian', 'kernel'));
  assert.throws(() => registry.createVault('KERNEL'), /同名/);
  for (const name of ['内核', '../kernel', '.hidden', 'kernel/notes', 'kernel notes', '123', 'a'.repeat(65)]) {
    assert.throws(() => registry.createVault(name), /仓库名称/);
  }
  registry.deleteVault(vault.id, registry.listVaults().vaults.find(item => item.id === vault.id)!.version);
  assert.throws(() => registry.createVault('kernel'), /回收站/);
  registry.deleteVault('default', registry.listVaults().vaults.find(item => item.id === 'default')!.version);
  assert.throws(() => registry.createVault('default'), AppError);
});

test('Obsidian folders are discovered without Coral metadata and migrated IDs remain stable', () => {
  const { registry } = fixture();
  const root = join(registry.config.data_dir, 'obsdian', 'kernel');
  mkdirSync(join(root, '.obsidian'), { recursive: true });
  writeFileSync(join(root, 'notes.md'), 'Core knowledge');
  assert.equal(registry.vault('kernel').root, root);
  assert.equal(registry.scan('kernel').documents[0].body, 'Core knowledge');
  writeFileSync(join(root, '.coral-vault.json'), JSON.stringify({ id: 'old-uuid', name: 'Old title', description: 'Migrated' }));
  registry.refreshVaults();
  assert.ok(!registry.vaults.has('kernel'));
  assert.equal(registry.vault('old-uuid').name, 'kernel');
  assert.equal(registry.scan('old-uuid').documents[0].uri, 'coral://vault/old-uuid/notes.md');
  registry.deleteVault('old-uuid', registry.listVaults().vaults.find(item => item.id === 'old-uuid')!.version);
  const entry = registry.listTrash().vaults.find(item => item.id === 'old-uuid')!;
  assert.throws(() => registry.createVault('kernel'), /回收站/);
  registry.restoreVault(entry.id, entry.version);
  assert.equal(registry.vault('old-uuid').root, root);
  assert.equal(registry.scan('old-uuid').documents[0].body, 'Core knowledge');
});

test('frontmatter preserves custom properties, quoted values and empty bodies', () => {
  const metadata = { title: 'A "quoted" title', aliases: ['别名', 'Alias'], custom: { nested: [1, true, '2026-10-15'] } };
  assert.deepEqual(parseMarkdown(serialize(metadata, '')).metadata, metadata);
  assert.equal(parseMarkdown('plain\ntext').body, 'plain\ntext');
  assert.deepEqual(parseMarkdown('---\n---\nBody'), { metadata: {}, body: 'Body' });
  assert.deepEqual(parseMarkdown('\uFEFF---\r\ntitle: 中文\r\n---\r\nBody'), { metadata: { title: '中文' }, body: 'Body' });
  assert.throws(() => parseMarkdown('---\ntitle: [\n---\nBody'), AppError);
  assert.throws(() => parseMarkdown('---\n- list\n---\nBody'), AppError);
});

test('index and log are ordinary Markdown documents in every Vault', () => {
  const { registry, root, project } = fixture();
  for (const [id, directory] of [['default', root], ['project', project]]) {
    writeFileSync(join(directory, 'index.md'), 'Knowledge index');
    writeFileSync(join(directory, 'log.md'), 'Research log');
    assert.deepEqual(registry.listDocuments(id).documents.map(doc => doc.path), ['index.md', 'log.md']);
    assert.equal(registry.search('Research log', id).total, 1);
  }
});

test('resource URIs round-trip Unicode, spaces, percent signs and punctuation', () => {
  const uri = resourceUri('project', 'docs/中文 #?% note.md');
  assert.deepEqual(parseUri(uri), { vaultId: 'project', relative: 'docs/中文 #?% note.md' });
  for (const invalid of ['file:///etc/passwd', 'coral://other/project/a.md', 'coral://vault/project/../secret.md',
    'coral://vault/project/docs/%2e%2e/secret.md', 'coral://vault/project/%2Fetc/a.md',
    'coral://vault/project/.obsidian/a.md', 'coral://vault/project/a.md?x=y', 'coral://vault/project/a.md#h',
    'coral://vault/project/a%00.md', 'coral://vault/project/%ZZ.md', 'coral://vault/project/docs\\secret.md']) assert.throws(() => parseUri(invalid), AppError);
});

test('one Vault per knowledge base, no local paths in catalog and list responses', () => {
  const { registry, project, directory } = fixture();
  writeFileSync(join(project, 'docs/design.md'), '# Design\n设计内容');
  const catalog = registry.listVaults();
  assert.equal(catalog.vaults.find(v => v.id === 'project')?.document_count, 1);
  assert.equal(catalog.vaults.find(v => v.id === 'project')?.uri, 'coral://vault/project/');
  const listed = registry.listDocuments('project', 'docs', 0, 1);
  assert.equal(listed.documents[0].uri, 'coral://vault/project/docs/design.md');
  assert.ok(!JSON.stringify({ catalog, listed }).includes(directory));
  assert.throws(() => registry.listDocuments('unknown'), AppError);
});

test('Obsidian root and arbitrary nested notes, pagination and filename collisions', () => {
  const { registry, root } = fixture();
  writeFileSync(join(root, 'Root Note.md'), '# Root');
  mkdirSync(join(root, 'A'));
  mkdirSync(join(root, 'B'));
  writeFileSync(join(root, 'A/Same.md'), 'A');
  writeFileSync(join(root, 'B/Same.md'), 'B');
  assert.equal(registry.listDocuments('default', '', 0, 2).next_cursor, 2);
  assert.equal(registry.listDocuments('default', 'A').documents.length, 1);
  assert.equal(registry.document('coral://vault/default/A/Same.md').raw, 'A');
  const one = registry.create('default', 'My Note', 'One');
  const two = registry.create('default', 'My Note', 'Two');
  assert.equal(one.relative, 'My Note.md');
  assert.equal(two.relative, 'My Note-2.md');
  assert.equal(one.metadata.type, undefined);
  for (const folder of ['notes', 'concepts', 'entities', 'sources']) assert.ok(!existsSync(join(root, folder)));
  assert.equal(registry.document(one.uri).body, 'One');
  assert.ok(!existsSync(join(root, '../journal')));
  assert.ok(!existsSync(join(root, '../jobs')));
});

test('saving preserves file location, YAML custom fields and detects Obsidian edits', () => {
  const { registry, project } = fixture();
  const filename = join(project, 'docs/design.md');
  const metadata = { title: '设计', aliases: ['D'], custom: { value: 42 } };
  writeFileSync(filename, serialize(metadata, 'Original'));
  const doc = registry.document('coral://vault/project/docs/design.md');
  registry.update(doc.uri, serialize(metadata, 'Updated'), doc.version);
  const updated = registry.document(doc.uri);
  assert.equal(updated.relative, 'docs/design.md');
  assert.deepEqual(updated.metadata.custom, { value: 42 });
  assert.deepEqual(updated.metadata.aliases, ['D']);
  assert.equal(updated.body, 'Updated');
  assert.throws(() => registry.update(doc.uri, 'Lost update', doc.version), /修改/);
  writeFileSync(filename, '# External edit');
  assert.throws(() => registry.delete(doc.uri, updated.version), /修改/);
  assert.throws(() => registry.update(doc.uri, '---\nbroken: [\n---', registry.document(doc.uri).version), AppError);
  assert.equal(readFileSync(filename, 'utf8'), '# External edit');
});

test('custom properties can be removed intentionally by editing frontmatter', () => {
  const { registry } = fixture();
  const doc = registry.create('default', 'Properties', '', { custom: 'remove me' });
  const updated = registry.update(doc.uri, '---\ntitle: Properties\n---\nBody', doc.version);
  assert.equal(updated.metadata.custom, undefined);
});

test('Chinese and English full-text search follows external additions, edits and deletions', () => {
  const { registry, project } = fixture();
  const filename = join(project, 'docs/design.md');
  writeFileSync(filename, '# Design\n' + 'x'.repeat(1000) + '\n数据库索引优化\nTransformer attention');
  assert.equal(registry.search('数据库').results.length, 1);
  assert.match(registry.search('优化').results[0].snippet, /优化/);
  assert.equal(registry.search('TRANSFORMER').results.length, 1);
  assert.equal(registry.search('量子纠缠').total, 0);
  writeFileSync(filename, '外部修改');
  assert.equal(registry.search('外部修改', 'project').total, 1);
  assert.equal(registry.search('优化').total, 0);
  rmSync(filename);
  assert.equal(registry.search('外部修改').total, 0);
});

test('search and reads support pagination, heading slices, and version consistency', () => {
  const { registry, project } = fixture();
  const raw = '# Intro\nHello\n## Details\n' + 'Long text 🪸 '.repeat(100) + '\n# End\nBye';
  writeFileSync(join(project, 'docs/design.md'), raw);
  writeFileSync(join(project, 'docs/second.md'), 'Hello');
  assert.equal(registry.search('Hello', 'project', 1).next_cursor, 1);
  const uri = 'coral://vault/project/docs/design.md';
  let chunk = registry.readDocument(uri, { maxChars: 17 });
  let content = chunk.content;
  while (chunk.next_offset !== null) {
    chunk = registry.readDocument(uri, { offset: chunk.next_offset, maxChars: 17, version: chunk.version });
    content += chunk.content;
  }
  assert.equal(content, raw);
  const section = registry.readDocument(uri, { heading: 'Intro', maxChars: 64000 });
  assert.match(section.content, /## Details/);
  assert.ok(!section.content.includes('# End'));
  const version = section.version;
  writeFileSync(join(project, 'docs/design.md'), '# Changed');
  assert.throws(() => registry.readDocument(uri, { version }), /修改/);
  assert.throws(() => registry.readDocument(uri, { offset: 99999 }), AppError);
  assert.throws(() => registry.readDocument(uri, { heading: 'Missing' }), AppError);
});

test('downloads preserve exact original bytes including BOM and CRLF', () => {
  const { registry, project } = fixture();
  const bytes = Buffer.from('\uFEFF---\r\ntitle: 中文\r\n---\r\n# Original\r\n');
  writeFileSync(join(project, 'docs/design.md'), bytes);
  assert.deepEqual(registry.download('coral://vault/project/docs/design.md').bytes, bytes);
  assert.equal(registry.download('coral://vault/project/docs/design.md').metadata.size_bytes, bytes.length);
});

test('hidden files, symlinks, outside paths and oversized documents are rejected', () => {
  const { registry, project, directory } = fixture();
  mkdirSync(join(project, '.obsidian'));
  writeFileSync(join(project, '.obsidian/secret.md'), 'Hidden');
  writeFileSync(join(directory, 'outside.md'), 'Outside');
  symlinkSync(join(directory, 'outside.md'), join(project, 'linked.md'));
  symlinkSync(directory, join(project, 'linked-folder'));
  for (const relative of ['linked.md', 'linked-folder/outside.md', '.obsidian/secret.md', '../outside.md']) {
    assert.throws(() => registry.download('coral://vault/project/' + relative), AppError);
  }
  writeFileSync(join(project, 'large.md'), Buffer.alloc(MAX_FILE_BYTES + 1));
  assert.throws(() => registry.download('coral://vault/project/large.md'), /16 MiB/);
  assert.equal(registry.scan('project').documents.length, 0);
  assert.equal(registry.scan('project').skipped, 1);
});

test('unavailable Vaults are explicit and do not break searches across available Vaults', () => {
  const { registry, project } = fixture();
  registry.create('default', 'Available', 'findme');
  rmSync(project, { recursive: true });
  assert.equal(registry.listVaults().vaults.find(v => v.id === 'project')?.available, false);
  assert.equal(registry.search('findme').results.length, 1);
  assert.deepEqual(registry.search('findme').unavailable_vaults, ['coral://vault/project/']);
});

test('creation, deletion and Git history work on Markdown files', () => {
  const { registry, root } = fixture();
  const doc = registry.create('default', 'Note', 'Content');
  assert.ok(existsSync(join(root, doc.relative)));
  const log = execFileSync('git', ['log', '--format=%an'], { cwd: root, encoding: 'utf8' });
  assert.match(log, /coral-user/);
  registry.delete(doc.uri, doc.version);
  assert.throws(() => registry.document(doc.uri), AppError);
});

test('deleting documents and folders moves exact bytes and attachments to a local trash', () => {
  const { registry, root, directory } = fixture();
  const standalone = registry.create('default', '单独文档', '保留字节');
  registry.delete(standalone.uri, standalone.version);
  const docBatch = readdirSync(join(root, '.trash'))[0];
  assert.equal(readFileSync(join(root, '.trash', docBatch, standalone.relative), 'utf8'), standalone.raw);
  const doc = registry.create('default', '设计', '内容', {}, undefined, '项目/nested');
  writeFileSync(join(root, '项目/image.png'), Buffer.from([0, 1, 255]));
  writeFileSync(join(root, '项目/.hidden'), 'hidden');
  writeFileSync(join(directory, 'outside.md'), 'outside');
  symlinkSync(join(directory, 'outside.md'), join(root, '项目/link.md'));
  mkdirSync(join(root, '项目/empty'));
  const snapshot = registry.browse('default').directories.find(folder => folder.name === '项目')!;
  assert.equal(snapshot.file_count, 4);
  registry.deleteDirectory(resourceUri('default', '项目'), snapshot.version!);
  assert.ok(!existsSync(join(root, '项目')));
  assert.equal(readFileSync(join(directory, 'outside.md'), 'utf8'), 'outside');
  const batch = readdirSync(join(root, '.trash')).find(batch => existsSync(join(root, '.trash', batch, '项目')))!;
  assert.equal(readFileSync(join(root, '.trash', batch, doc.relative), 'utf8'), doc.raw);
  assert.deepEqual(readFileSync(join(root, '.trash', batch, '项目/image.png')), Buffer.from([0, 1, 255]));
  assert.equal(readFileSync(join(root, '.trash', batch, '项目/.hidden'), 'utf8'), 'hidden');
  assert.ok(lstatSync(join(root, '.trash', batch, '项目/link.md')).isSymbolicLink());
  assert.ok(existsSync(join(root, '.trash', batch, '项目/empty')));
  assert.equal(registry.search('内容').total, 0);
  assert.ok(!registry.browse('default').directories.some(folder => folder.name === '.trash'));
  mkdirSync(join(root, 'empty'));
  const empty = registry.browse('default').directories[0];
  registry.deleteDirectory(resourceUri('default', 'empty'), empty.version!);
  assert.ok(!existsSync(join(root, 'empty')));
});

test('folder deletion detects external changes and refuses roots, traversal and symlinks', () => {
  const { registry, root, directory, project } = fixture();
  const doc = registry.create('default', 'Old', 'old', {}, undefined, 'folder');
  const snapshot = registry.browse('default').directories[0];
  writeFileSync(join(root, doc.relative), 'Changed by Obsidian');
  assert.throws(() => registry.deleteDirectory(resourceUri('default', 'folder'), snapshot.version!), /修改/);
  assert.throws(() => registry.deleteDirectory(resourceUri('default', 'folder'), ''), /版本/);
  for (const path of ['', '../escape', '.obsidian', '.trash', 'folder/..']) {
    assert.throws(() => registry.deleteDirectory(resourceUri('default', path), 'version'), AppError);
  }
  symlinkSync(project, join(root, 'linked'));
  assert.throws(() => registry.deleteDirectory(resourceUri('default', 'linked'), 'version'), AppError);
  const alias = new VaultRegistry(createConfig({ data_dir: registry.config.data_dir, vaults: { nested: { path: join(root, 'folder') } } }));
  try {
    const folder = alias.browse('default').directories.find(folder => folder.name === 'folder')!;
    assert.throws(() => alias.deleteDirectory(resourceUri('default', 'folder'), folder.version!), /知识库/);
  } finally { alias.close(); }
  symlinkSync(directory, join(root, '.trash'));
  const current = registry.document(doc.uri);
  assert.throws(() => registry.delete(doc.uri, current.version), /回收站/);
  assert.ok(existsSync(join(root, doc.relative)));
});

test('trash restores original files and directories, rejects conflicts, and permanently purges entries', () => {
  const { registry, root } = fixture();
  const doc = registry.create('default', 'Recover', 'Original', { tags: ['保留'] }, undefined, 'docs');
  registry.delete(doc.uri, doc.version);
  let item = registry.listTrash('default').items[0];
  assert.equal(item.path, 'docs/Recover.md');
  assert.ok(!JSON.stringify(registry.listTrash()).includes(root));
  registry.create('default', 'Recover', 'New content', {}, undefined, 'docs');
  assert.throws(() => registry.restoreTrash('default', item.id, item.version), /同名/);
  const conflict = registry.document(doc.uri);
  registry.delete(conflict.uri, conflict.version);
  registry.restoreTrash('default', item.id, item.version);
  assert.equal(registry.document(doc.uri).raw, doc.raw);
  item = registry.listTrash('default').items[0];
  assert.throws(() => registry.purgeTrash('default', item.id, 'stale'), /变化/);
  registry.purgeTrash('default', item.id, item.version);
  assert.equal(registry.listTrash().items.length, 0);
  writeFileSync(join(root, 'docs/image.png'), Buffer.from([1, 2, 3]));
  const folder = registry.browse('default').directories.find(folder => folder.name === 'docs')!;
  registry.deleteDirectory(resourceUri('default', 'docs'), folder.version!);
  item = registry.listTrash().items[0];
  assert.equal(item.kind, 'directory');
  registry.restoreTrash('default', item.id, item.version);
  assert.equal(registry.document(doc.uri).raw, doc.raw);
  assert.deepEqual(readFileSync(join(root, 'docs/image.png')), Buffer.from([1, 2, 3]));
  assert.equal(registry.listTrash().items.length, 0);
});

test('unrecognized trash stays untouched and invalid paths and stale clear requests are rejected', () => {
  const { registry, root, directory } = fixture();
  const oldId = '11111111-1111-4111-8111-111111111111';
  mkdirSync(join(root, '.trash', oldId, 'old/path'), { recursive: true });
  writeFileSync(join(root, '.trash', oldId, 'old/path/Legacy.md'), 'Exact old bytes');
  assert.equal(registry.listTrash().items.length, 0);
  assert.equal(registry.listTrash().skipped, 1);
  const doc = registry.create('default', 'Discard', 'Gone');
  registry.delete(doc.uri, doc.version);
  const snapshot = registry.listTrash();
  const second = registry.create('default', 'Second', 'Keep until confirmed');
  registry.delete(second.uri, second.version);
  assert.throws(() => registry.emptyTrash(undefined, snapshot.version), /变化/);
  assert.equal(registry.listTrash().items.length, 2);
  const badId = '22222222-2222-4222-8222-222222222222';
  mkdirSync(join(root, '.trash', badId));
  writeFileSync(join(root, '.trash', badId, '.coral-trash.json'), JSON.stringify({ path: '../outside.md', kind: 'file', deleted_at: new Date().toISOString() }));
  writeFileSync(join(directory, 'outside.md'), 'Keep outside');
  assert.throws(() => registry.restoreTrash('default', badId, 'x'), AppError);
  assert.throws(() => registry.purgeTrash('default', '../escape', 'x'), AppError);
  const listing = registry.listTrash();
  assert.equal(listing.skipped, 2);
  registry.emptyTrash(undefined, listing.version);
  assert.equal(registry.listTrash().items.length, 0);
  assert.ok(existsSync(join(root, '.trash', badId)));
  assert.equal(readFileSync(join(root, '.trash', oldId, 'old/path/Legacy.md'), 'utf8'), 'Exact old bytes');
  assert.equal(readFileSync(join(directory, 'outside.md'), 'utf8'), 'Keep outside');
});

test('managed knowledge bases recycle, restore and purge durably across running registries', () => {
  const { registry } = fixture();
  const vault = registry.createVault('recycle');
  const doc = registry.create(vault.id, 'Document', 'Unique recycled content');
  const observer = new VaultRegistry(registry.config);
  try {
    registry.deleteVault(vault.id, registry.listVaults().vaults.find(v => v.id === vault.id)!.version);
    assert.ok(!existsSync(vault.root));
    assert.ok(!observer.listVaults().vaults.some(v => v.id === vault.id));
    assert.equal(observer.search('Unique recycled content').total, 0);
    assert.throws(() => observer.document(doc.uri), AppError);
    assert.throws(() => registry.createVault('recycle'), AppError);
    let entry = observer.listTrash().vaults.find(v => v.id === vault.id)!;
    assert.equal(entry.external, false);
    assert.ok(!JSON.stringify(entry).includes(vault.root));
    mkdirSync(vault.root);
    assert.throws(() => registry.restoreVault(vault.id, entry.version), /已存在/);
    rmSync(vault.root, { recursive: true });
    registry.restoreVault(vault.id, entry.version);
    assert.equal(observer.document(doc.uri).raw, doc.raw);
    registry.deleteVault(vault.id, registry.listVaults().vaults.find(v => v.id === vault.id)!.version);
    entry = registry.listTrash().vaults.find(v => v.id === vault.id)!;
    registry.purgeVault(vault.id, entry.version);
    assert.ok(!observer.listTrash().vaults.some(v => v.id === vault.id));
    assert.ok(!observer.listVaults().vaults.some(v => v.id === vault.id));
    assert.throws(() => registry.restoreVault(vault.id, entry.version), AppError);
    const fresh = registry.createVault('recycle');
    assert.equal(observer.vault(vault.id).name, fresh.name);
    assert.equal(observer.scan(vault.id).documents.length, 0);
  } finally { observer.close(); }
});

test('external knowledge bases recycle only their registration and default never resurrects on restart', () => {
  const { registry, project, root } = fixture();
  writeFileSync(join(project, 'docs/External.md'), 'Obsidian source');
  registry.deleteVault('project', registry.listVaults().vaults.find(v => v.id === 'project')!.version);
  let entry = registry.listTrash().vaults.find(v => v.id === 'project')!;
  assert.equal(entry.external, true);
  assert.equal(readFileSync(join(project, 'docs/External.md'), 'utf8'), 'Obsidian source');
  registry.restoreVault('project', entry.version);
  registry.deleteVault('project', registry.listVaults().vaults.find(v => v.id === 'project')!.version);
  entry = registry.listTrash().vaults.find(v => v.id === 'project')!;
  registry.purgeVault('project', entry.version);
  assert.equal(readFileSync(join(project, 'docs/External.md'), 'utf8'), 'Obsidian source');
  assert.throws(() => registry.createVault('project'), /已存在/);
  assert.ok(!existsSync(join(registry.config.data_dir, 'obsdian/project')));
  assert.ok(!registry.listVaults().vaults.some(v => v.id === 'project'));
  registry.deleteVault('default', registry.listVaults().vaults.find(v => v.id === 'default')!.version);
  const restarted = new VaultRegistry(registry.config);
  try {
    assert.ok(!existsSync(root));
    assert.equal(restarted.listVaults().vaults.length, 0);
    const deleted = restarted.listTrash().vaults.find(v => v.id === 'default')!;
    restarted.restoreVault('default', deleted.version);
    assert.ok(existsSync(root));
    assert.ok(registry.listVaults().vaults.some(v => v.id === 'default'));
  } finally { restarted.close(); }
});

test('emptying one knowledge base trash leaves other knowledge base entries intact', () => {
  const { registry } = fixture();
  const first = registry.create('default', 'First', 'one');
  const second = registry.create('project', 'Second', 'two');
  registry.delete(first.uri, first.version); registry.delete(second.uri, second.version);
  registry.emptyTrash('default', registry.listTrash('default').version);
  assert.equal(registry.listTrash('default').items.length, 0);
  assert.equal(registry.listTrash('project').items.length, 1);
});

test('folders replace fixed classifications without moving legacy documents or changing properties', () => {
  const { registry, root, directory, project } = fixture();
  mkdirSync(join(root, 'concepts'));
  mkdirSync(join(root, '空目录'));
  const raw = serialize({ title: '旧文档', type: 'concept', tags: ['设计'], custom: 42 }, '旧内容');
  writeFileSync(join(root, 'concepts/旧文档.md'), raw);
  const listing = registry.browse('default');
  assert.equal(listing.documents.length, 0);
  assert.ok(listing.directories.some(folder => folder.name === '空目录' && folder.document_count === 0));
  assert.equal(registry.browse('default', 'concepts').documents[0].title, '旧文档');
  const old = registry.document('coral://vault/default/concepts/' + encodeURIComponent('旧文档.md'));
  const updated = registry.update(old.uri, raw.replace('旧内容', '新内容'), old.version);
  assert.equal(updated.relative, old.relative);
  assert.equal(updated.metadata.type, 'concept');
  assert.deepEqual(updated.metadata.tags, ['设计']);
  const created = registry.create('default', '设计', 'Markdown', { tags: ['项目'] }, undefined, '项目/docs');
  assert.equal(created.relative, '项目/docs/设计.md');
  assert.equal(created.metadata.type, undefined);
  assert.equal(registry.create('default', '设计', 'Same name', {}, undefined, '其他').relative, '其他/设计.md');
  assert.equal(registry.create('default', '设计', 'Collision', {}, undefined, '项目/docs').relative, '项目/docs/设计-2.md');
  const result = registry.listDocuments('default', '项目');
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[0].path, '项目/docs/设计-2.md');
  assert.ok(!Object.hasOwn(result.documents[0], 'type'));
  assert.ok(!JSON.stringify(result).includes(directory));
  for (const folder of ['../escape', '.obsidian', '项目/../escape', '项目\\escape']) {
    assert.throws(() => registry.browse('default', folder), AppError);
    assert.throws(() => registry.create('default', 'Blocked', '', {}, undefined, folder), AppError);
  }
  symlinkSync(directory, join(root, 'linked'));
  assert.ok(!registry.browse('default').directories.some(folder => folder.name === 'linked'));
  assert.throws(() => registry.browse('default', 'linked'), AppError);
  assert.throws(() => registry.create('default', 'Blocked', '', {}, undefined, 'linked'), AppError);
  symlinkSync(project, join(directory, 'project-link'));
  const alias = new VaultRegistry(createConfig({ data_dir: registry.config.data_dir, vaults: { alias: { path: join(directory, 'project-link') } } }));
  try { assert.equal(alias.browse('alias').directories[0].name, 'docs'); }
  finally { alias.close(); }
});

test('Wiki links support paths, aliases, headings, duplicates and safe rendering', () => {
  const { registry, project } = fixture();
  writeFileSync(join(project, 'docs/design.md'), '---\naliases: [架构]\n---\n# 设计 标题');
  writeFileSync(join(project, 'Origin.md'), 'Origin');
  mkdirSync(join(project, 'other'));
  writeFileSync(join(project, 'other/Same.md'), 'One');
  writeFileSync(join(project, 'docs/Same.md'), 'Two');
  mkdirSync(join(project, 'wiki'));
  writeFileSync(join(project, 'wiki/Origin.md'), 'A real wiki directory');
  const docs = registry.scan('project').documents;
  const current = docs.find(doc => doc.relative === 'Origin.md')!;
  assert.equal(resolveLink('docs/design', docs)?.relative, 'docs/design.md');
  assert.equal(resolveLink('架构', docs)?.relative, 'docs/design.md');
  assert.equal(resolveLink('Same', docs, current), undefined);
  assert.equal(resolveLink('wiki/Origin', docs, current)?.relative, 'wiki/Origin.md');
  const html = renderMarkdown('[[docs/design#设计 标题|别名]] [[Missing]] `[[Not a link]]`\n\n<script>alert(1)</script>', docs, current);
  assert.match(html, /别名/);
  assert.match(html, /class="broken"/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('title=Not'));
  assert.deepEqual(wikiTargets('[[design]] `[[skip]]`\n\n```\n[[skip2]]\n```'), ['design']);
  assert.deepEqual(headings('---\ntitle: x\n---\n# Real\n```md\n# Fake\n```').map(h => h.title), ['Real']);
});
