import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from './src/config.js';
import { AppError, resourceUri } from './src/content.js';
import { VaultRegistry } from './src/vault.js';
import { renderMarkdown, resolveLink, resolveRelativeLink } from './src/markdown.js';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'coral-relocation-'));
  const root = join(folder, 'notes');
  mkdirSync(join(root, 'docs/assets'), { recursive: true });
  mkdirSync(join(root, 'archive'));
  const registry = new VaultRegistry(createConfig({ data_dir: join(folder, 'data'), vaults: { notes: { path: root } } }));
  cleanup.push(() => { registry.close(); rmSync(folder, { recursive: true, force: true }); });
  const write = (path: string, raw: string | Buffer) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), raw);
  };
  const uri = (path: string) => resourceUri('notes', path);
  return { root, registry, write, uri };
}

test('default relocation retains original bytes and the original result contract', () => {
  const { root, registry, write, uri } = fixture();
  const raw = '\uFEFF---\r\ntitle: Original\r\n---\r\n![image](assets/pixel.png)\r\n';
  write('docs/note.md', raw);
  write('docs/assets/pixel.png', Buffer.from([1, 2, 3]));
  write('source.md', '[note](docs/note.md)');
  const doc = registry.document(uri('docs/note.md'));
  const moved = registry.moveDocument(doc.uri, 'archive', doc.version);
  assert.equal(moved.version, doc.version);
  assert.equal(moved.raw, raw);
  assert.equal(readFileSync(join(root, 'source.md'), 'utf8'), '[note](docs/note.md)');
  assert.equal(Object.hasOwn(moved, 'operation_id'), false);
  const renamed = registry.rename(moved.uri, 'new.md', moved.version);
  assert.equal(renamed.version, doc.version);
  assert.equal(readFileSync(join(root, 'archive/new.md'), 'utf8'), raw);
  assert.equal(Object.hasOwn(renamed, 'updated_documents'), false);
});

test('moving with link maintenance fixes references and images while preserving other source bytes', () => {
  const { root, registry, write, uri } = fixture();
  const raw = '\uFEFF---\r\ntitle: "Keep formatting"\r\ncustom: [ a, b ]\r\n---\r\n# Heading\r\n![image](assets/pixel.png)\r\n![[assets/pixel.png|480]]\r\n[other](../other.md#part)\r\n';
  write('docs/note.md', raw);
  write('docs/assets/pixel.png', Buffer.from([1, 2, 3]));
  write('other.md', '# Other');
  const source = '\uFEFF---\r\nreference: "docs/note.md"\r\n---\r\n[inline](docs/note.md#heading "Title")\r\n[ref][n]\r\n\r\n[n]: <docs/note.md#heading> "Title"\r\n\r\n[[docs/note|Label]]\r\n[Coral](coral://vault/notes/docs/note.md#heading)\r\n`[code](docs/note.md)`\r\n```md\r\n[code](docs/note.md)\r\n```\r\n<div>[HTML](docs/note.md)</div>\r\n\r\n[[missing]]\r\n';
  write('source.md', source);
  const doc = registry.document(uri('docs/note.md'));
  const result = registry.moveDocument(doc.uri, 'archive', doc.version, { updateLinks: true });
  assert.equal(readFileSync(join(root, 'archive/note.md'), 'utf8'), raw.replaceAll('assets/pixel.png', '../docs/assets/pixel.png'));
  const expected = source.replace('[inline](docs/note.md#', '[inline](archive/note.md#')
    .replace('[n]: <docs/note.md#', '[n]: <archive/note.md#').replace('[[docs/note|', '[[archive/note|')
    .replace('(coral://vault/notes/docs/note.md#', '(coral://vault/notes/archive/note.md#');
  assert.equal(readFileSync(join(root, 'source.md'), 'utf8'), expected);
  assert.deepEqual(result.updated_documents?.map(doc => doc.uri).sort(), [uri('archive/note.md'), uri('source.md')].sort());
  assert.ok(result.unresolved_links?.some(link => link.uri === uri('source.md') && link.target === 'missing'));
  assert.equal(result.version, registry.document(result.uri).version);
  assert.equal(result.raw, registry.document(result.uri).raw);
  assert.deepEqual(registry.relocationReport('notes', result.operation_id!), {
    operation_id: result.operation_id, updated_documents: result.updated_documents, unresolved_links: result.unresolved_links,
  });
});

test('rename preserves Wiki target identity when a short name becomes ambiguous', () => {
  const { root, registry, write, uri } = fixture();
  write('docs/old.md', '---\naliases: [stable]\n---\n# Original');
  write('archive/new.md', '# Existing');
  write('source.md', '[[old]] [[old#part|Shown]] [[stable]] [relative](docs/old.md)');
  const doc = registry.document(uri('docs/old.md'));
  const result = registry.rename(doc.uri, 'new.md', doc.version, { updateLinks: true });
  assert.equal(readFileSync(join(root, 'source.md'), 'utf8'), '[[docs/new]] [[docs/new#part|Shown]] [[stable]] [relative](docs/new.md)');
  assert.deepEqual(result.updated_documents?.map(doc => doc.uri), [uri('source.md')]);
  assert.equal(readFileSync(join(root, 'archive/new.md'), 'utf8'), '# Existing');
});

test('folder rename fixes incoming and outgoing paths without rewriting unchanged descendants', () => {
  const { root, registry, write, uri } = fixture();
  write('docs/note.md', '[outside](../other.md) ![inside](assets/pixel.png)');
  write('docs/assets/pixel.png', Buffer.from([4, 5, 6]));
  write('other.md', '# Other');
  write('source.md', '[note](docs/note.md) ![image](docs/assets/pixel.png) ![[docs/assets/pixel.png|300]] [folder](coral://vault/notes/docs)');
  const entry = registry.renameEntry(uri('docs'));
  const result = registry.rename(entry.uri, 'renamed', entry.version, { updateLinks: true });
  assert.equal(readFileSync(join(root, 'source.md'), 'utf8'), '[note](renamed/note.md) ![image](renamed/assets/pixel.png) ![[renamed/assets/pixel.png|300]] [folder](coral://vault/notes/renamed)');
  assert.equal(readFileSync(join(root, 'renamed/note.md'), 'utf8'), '[outside](../other.md) ![inside](assets/pixel.png)');
  assert.deepEqual(readFileSync(join(root, 'renamed/assets/pixel.png')), Buffer.from([4, 5, 6]));
  assert.deepEqual(result.updated_documents?.map(doc => doc.uri), [uri('source.md')]);
});

test('source-aware rewriting handles nested image labels, reference images and escaped anchors', () => {
  const { root, registry, write, uri } = fixture();
  write('docs/note.md', '# Note');
  write('docs/assets/pixel.png', Buffer.from([1]));
  const source = '# References\r\n\r\n[![Alt](docs/assets/pixel.png)](docs/note.md#part\\!)\r\n\r\n> [quoted](docs/note.md)\r\n\r\n- [list](docs/note.md)\r\n\r\n![ref][image]\r\n\r\n[image]: docs/assets/pixel.png "Image"\r\n\r\n<em><em>nested</em>[inline HTML](docs/note.md)</em>\r\n\r\n    [indented code](docs/note.md)\r\n';
  write('source.md', source);
  const entry = registry.renameEntry(uri('docs'));
  registry.rename(entry.uri, 'new docs', entry.version, { updateLinks: true });
  const expected = source.replaceAll('docs/assets/pixel.png', 'new%20docs/assets/pixel.png')
    .replace('](docs/note.md#', '](new%20docs/note.md#').replace('[quoted](docs/note.md)', '[quoted](new%20docs/note.md)')
    .replace('[list](docs/note.md)', '[list](new%20docs/note.md)');
  assert.equal(readFileSync(join(root, 'source.md'), 'utf8'), expected);
});

test('renaming an unchanged file cannot silently retarget a previously unique short Wiki link', () => {
  const { root, registry, write, uri } = fixture();
  write('docs/old.md', '# Original');
  write('archive/new.md', '# Other');
  write('source.md', '[[old]] [[new]] [[missing]]');
  const doc = registry.document(uri('docs/old.md'));
  const result = registry.rename(doc.uri, 'new.md', doc.version, { updateLinks: true });
  assert.equal(readFileSync(join(root, 'source.md'), 'utf8'), '[[docs/new]] [[archive/new]] [[missing]]');
  assert.ok(result.unresolved_links?.some(link => link.target === 'missing'));
});

test('special-name renames keep Wiki, relative Markdown and both image forms bound to their original targets', () => {
  const { registry, write, uri } = fixture();
  write('docs/day.md', '# Day');
  write('docs/assets/pixel.png', Buffer.from([8, 9]));
  write('source.md', '[[docs/day#part|显示文字]] [day](docs/day.md#part)\n\n![[docs/assets/pixel.png|300]] ![pixel](docs/assets/pixel.png)');
  let day = registry.document(uri('docs/day.md'));
  const renamed = registry.rename(day.uri, '每日 #100%[x].md', day.version, { updateLinks: true });
  let source = registry.document(uri('source.md'));
  let docs = registry.scan('notes').documents;
  const target = source.body.match(/\[\[([^|]+)\|显示文字\]\]/)![1];
  assert.equal(resolveLink(target, docs, source)?.uri, renamed.uri);
  const relative = source.body.match(/\[day\]\(([^)]+)\)/)![1];
  assert.equal(resolveRelativeLink(relative, docs, source)?.uri, renamed.uri);
  const folder = registry.renameEntry(uri('docs'));
  registry.rename(folder.uri, '资料 #50%[a]', folder.version, { updateLinks: true });
  source = registry.document(uri('source.md'));
  docs = registry.scan('notes').documents;
  day = docs.find(doc => doc.relative.endsWith('每日 #100%[x].md'))!;
  assert.ok(day);
  assert.equal(resolveLink(source.body.match(/\[\[([^|]+)\|显示文字\]\]/)![1], docs, source)?.uri, day.uri);
  assert.equal(resolveRelativeLink(source.body.match(/\[day\]\(([^)]+)\)/)![1], docs, source)?.uri, day.uri);
  const html = renderMarkdown(source.body, docs, source);
  assert.equal([...html.matchAll(/<a[^>]*href="([^"]+)"/g)].filter(match => match[1].startsWith('/document?')).length, 2);
  assert.ok(!html.includes('class="broken"'));
  const srcs = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'http://coral.test').searchParams.get('uri')!);
  assert.equal(srcs.length, 2);
  for (const src of srcs) assert.deepEqual(registry.asset(src).bytes, Buffer.from([8, 9]));
});

test('a resolvable affected reference whose source span cannot be located refuses before moving', () => {
  const { root, registry, write, uri } = fixture();
  write('docs/note.md', '# Note');
  const source = '> [note][n]\n>\n> [n]:\n>   docs/note.md\n';
  write('source.md', source);
  assert.match(renderMarkdown(source, registry.scan('notes').documents, registry.document(uri('source.md'))), /\/document\?uri=/);
  const doc = registry.document(uri('docs/note.md'));
  assert.throws(() => registry.moveDocument(doc.uri, 'archive', doc.version, { updateLinks: true }), /无法准确定位受影响的链接/);
  assert.ok(existsSync(join(root, 'docs/note.md')));
  assert.ok(!existsSync(join(root, 'archive/note.md')));
  assert.equal(readFileSync(join(root, 'source.md'), 'utf8'), source);
});

test('Markdown Coral autolinks keep their destination after relocation', () => {
  const { registry, write, uri } = fixture();
  write('docs/note.md', '# Note');
  write('source.md', '<coral://vault/notes/docs/note.md>');
  const doc = registry.document(uri('docs/note.md'));
  registry.moveDocument(doc.uri, 'archive', doc.version, { updateLinks: true });
  assert.equal(registry.document(uri('source.md')).body, '<coral://vault/notes/archive/note.md>');
});

test('literal percent-containing Wiki names win over optional URL decoding', () => {
  const { registry, write, uri } = fixture();
  write('docs/a%20b.md', '# Literal');
  write('docs/a b.md', '# Space');
  const docs = registry.scan('notes').documents;
  assert.equal(resolveLink('docs/a%20b', docs)?.uri, uri('docs/a%20b.md'));
  assert.equal(resolveLink('docs/a%2520b', docs)?.uri, uri('docs/a%20b.md'));
  write('docs/assets/a%20b.png', Buffer.from([1]));
  write('docs/assets/a b.png', Buffer.from([2]));
  assert.deepEqual(registry.asset(uri('docs/assets/a%20b.png')).bytes, Buffer.from([1]));
});

test('an encoded Wiki destination colliding with a literal filename refuses maintenance before mutation', () => {
  const { root, registry, write, uri } = fixture();
  write('docs/day.md', '# Day');
  write('docs/name%23part.md', '# Literal encoded name');
  write('source.md', '[[docs/day]]');
  const day = registry.document(uri('docs/day.md'));
  assert.throws(() => registry.rename(day.uri, 'name#part.md', day.version, { updateLinks: true }), /无法明确保持 Wiki 链接目标/);
  assert.ok(existsSync(join(root, 'docs/day.md')));
  assert.ok(!existsSync(join(root, 'docs/name#part.md')));
  assert.equal(readFileSync(join(root, 'source.md'), 'utf8'), '[[docs/day]]');
});

test('no-op and byte-preserving maintenance still produce a readable operation report', () => {
  const { registry, write, uri } = fixture();
  write('docs/note.md', '# Note');
  const doc = registry.document(uri('docs/note.md'));
  const result = registry.moveDocument(doc.uri, 'docs', doc.version, { updateLinks: true });
  assert.equal(result.uri, doc.uri);
  assert.equal(result.version, doc.version);
  assert.deepEqual(result.updated_documents, []);
  assert.equal(registry.relocationReport('notes', result.operation_id!).operation_id, result.operation_id);
  assert.throws(() => registry.relocationReport('notes', '../escape'), /编号无效/);
});

test('an incomplete scan refuses maintenance before moving or changing any document', () => {
  const { root, registry, write, uri } = fixture();
  write('docs/note.md', '# Note');
  write('broken.md', '---\ntags: [\n---\n[bad](docs/note.md)');
  const doc = registry.document(uri('docs/note.md'));
  assert.throws(() => registry.moveDocument(doc.uri, 'archive', doc.version, { updateLinks: true }), /无法完整读取/);
  assert.ok(existsSync(join(root, 'docs/note.md')));
  assert.ok(!existsSync(join(root, 'archive/note.md')));
});

test('a mid-batch write failure restores the relocation and already rewritten files', () => {
  const { root, registry, write, uri } = fixture();
  write('docs/note.md', '# Note');
  for (const name of ['a', 'b']) write(name + '.md', '[note](docs/note.md)');
  const doc = registry.document(uri('docs/note.md'));
  const original = fs.linkSync;
  let failed = false;
  fs.linkSync = ((source, target) => {
    if (!failed && String(source).endsWith('.tmp') && String(target) === join(root, 'b.md')) {
      failed = true; throw new Error('injected disk failure');
    }
    return original(source, target);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => registry.moveDocument(doc.uri, 'archive', doc.version, { updateLinks: true }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.recovery?.partial, false);
      assert.equal(error.details?.recovery?.conflicts.length, 0);
      assert.throws(() => registry.relocationReport('notes', error.details!.recovery!.operation_id), /尚未完成/);
      return true;
    });
    assert.equal(readFileSync(join(root, 'docs/note.md'), 'utf8'), '# Note');
    assert.ok(!existsSync(join(root, 'archive/note.md')));
    for (const name of ['a', 'b']) assert.equal(readFileSync(join(root, name + '.md'), 'utf8'), '[note](docs/note.md)');
  } finally { fs.linkSync = original; syncBuiltinESMExports(); }
});

test('rollback preserves an external writer and reports the remaining affected URIs', () => {
  const { root, registry, write, uri } = fixture();
  write('docs/note.md', '# Note');
  for (const name of ['a', 'b']) write(name + '.md', '[note](docs/note.md)');
  const doc = registry.document(uri('docs/note.md'));
  const original = fs.linkSync;
  let failed = false;
  fs.linkSync = ((source, target) => {
    if (!failed && String(source).endsWith('.tmp') && String(target) === join(root, 'b.md')) {
      failed = true;
      writeFileSync(join(root, 'a.md'), 'External writer must survive');
      throw new Error('injected failure after external write');
    }
    return original(source, target);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => registry.moveDocument(doc.uri, 'archive', doc.version, { updateLinks: true }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.recovery?.partial, true);
      assert.ok(error.details?.recovery?.conflicts.some(conflict => conflict.uri === uri('a.md')));
      assert.ok(error.details?.recovery?.affected_uris.includes(uri('archive/note.md')));
      const batch = join(root, '.coral-backups', error.details!.recovery!.operation_id);
      assert.ok(readdirSync(join(batch, 'originals')).some(name => readFileSync(join(batch, 'originals', name), 'utf8') === '[note](docs/note.md)'));
      return true;
    });
    assert.equal(readFileSync(join(root, 'a.md'), 'utf8'), 'External writer must survive');
    assert.equal(readFileSync(join(root, 'b.md'), 'utf8'), '[note](docs/note.md)');
    assert.equal(readFileSync(join(root, 'archive/note.md'), 'utf8'), '# Note');
  } finally { fs.linkSync = original; syncBuiltinESMExports(); }
});

test('an external replacement at the failing write stays intact and is included in recovery details', () => {
  const { root, registry, write, uri } = fixture();
  write('docs/note.md', '# Note');
  write('source.md', '[note](docs/note.md)');
  const doc = registry.document(uri('docs/note.md'));
  const original = fs.linkSync;
  let failed = false;
  fs.linkSync = ((source, target) => {
    if (!failed && String(source).endsWith('.tmp') && String(target) === join(root, 'source.md')) {
      failed = true;
      writeFileSync(target, 'Concurrent replacement');
      throw Object.assign(new Error('occupied'), { code: 'EEXIST' });
    }
    return original(source, target);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => registry.moveDocument(doc.uri, 'archive', doc.version, { updateLinks: true }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.ok(error.details?.recovery?.conflicts.some(conflict => conflict.uri === uri('source.md')));
      assert.ok(error.details?.recovery?.affected_uris.includes(uri('source.md')));
      return true;
    });
    assert.equal(readFileSync(join(root, 'source.md'), 'utf8'), 'Concurrent replacement');
  } finally { fs.linkSync = original; syncBuiltinESMExports(); }
});

test('concurrent additions detected after relocation prevent an unsafe directory rollback', () => {
  const { root, registry, write, uri } = fixture();
  write('docs/note.md', '# Note');
  const entry = registry.renameEntry(uri('docs'));
  const original = fs.renameSync;
  fs.renameSync = ((source, target) => {
    original(source, target);
    if (String(source) === join(root, 'docs')) writeFileSync(join(root, 'renamed/.external'), 'Concurrent addition');
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => registry.rename(entry.uri, 'renamed', entry.version, { updateLinks: true }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.recovery?.partial, true);
      return true;
    });
    assert.equal(readFileSync(join(root, 'renamed/.external'), 'utf8'), 'Concurrent addition');
    assert.ok(!existsSync(join(root, 'docs')));
  } finally { fs.renameSync = original; syncBuiltinESMExports(); }
});
