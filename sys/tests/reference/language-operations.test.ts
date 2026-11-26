import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from './src/config.js';
import { AppError, resourceUri } from './src/content.js';
import { VaultRegistry } from './src/vault.js';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'coral-language-operations-'));
  const root = join(directory, 'notes');
  mkdirSync(join(root, 'docs/assets'), { recursive: true });
  mkdirSync(join(root, 'archive'));
  const registry = new VaultRegistry(createConfig({ data_dir: join(directory, 'data'), vaults: { notes: { path: root } } }));
  cleanup.push(() => { registry.close(); rmSync(directory, { recursive: true, force: true }); });
  const id = randomUUID();
  const paths = { zh: 'docs/缓存 空格.md', en: 'docs/缓存 空格.en.md' };
  const raw = {
    zh: `---\r\ntitle: 缓存原理\r\ncoral_note_id: ${id}\r\ncoral_language: zh\r\ncoral_primary: true\r\ncustom: [ a, b ]\r\n---\r\n# 缓存原理\r\n![图片](assets/pixel.png)\r\n`,
    en: `---\r\ntitle: Cache mechanics\r\ncoral_note_id: ${id}\r\ncoral_language: en\r\ncoral_primary: false\r\n---\r\n# Cache mechanics\r\n![Image](assets/pixel.png)\r\n`,
  };
  for (const language of ['zh', 'en'] as const) writeFileSync(join(root, paths[language]), raw[language]);
  writeFileSync(join(root, 'docs/assets/pixel.png'), Buffer.from([1, 2, 3]));
  const uri = (path: string) => resourceUri('notes', path);
  const zh = registry.document(uri(paths.zh)), en = registry.document(uri(paths.en));
  return { root, registry, paths, raw, uri, zh, en };
}

function injectLinkFailure(callback: (source: string, target: string) => void) {
  const original = fs.linkSync;
  fs.linkSync = ((source, target) => {
    callback(String(source), String(target));
    return original(source, target);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  return () => { fs.linkSync = original; syncBuiltinESMExports(); };
}

test('moving either language moves the whole note and maintains links and images for both versions', () => {
  const { root, registry, paths, raw, uri, en } = fixture();
  writeFileSync(join(root, 'source.md'), `[中文](docs/${encodeURIComponent('缓存 空格')}.md) [English](docs/${encodeURIComponent('缓存 空格')}.en.md)\n[[docs/缓存 空格.en|English]]\n`);
  const result = registry.moveDocument(en.uri, 'archive', en.version, { updateLinks: true, noteVersion: registry.noteLanguages(en.uri).signature });
  assert.equal(result.uri, uri('archive/缓存 空格.en.md'));
  for (const language of ['zh', 'en'] as const) {
    assert.ok(!existsSync(join(root, paths[language])));
    assert.equal(readFileSync(join(root, paths[language].replace('docs/', 'archive/')), 'utf8'), raw[language].replace('assets/pixel.png', '../docs/assets/pixel.png'));
  }
  assert.equal(registry.noteLanguages(result.uri).primary.uri, uri('archive/缓存 空格.md'));
  assert.equal(registry.notes('notes').filter(doc => doc.metadata.coral_note_id).length, 1);
  const source = readFileSync(join(root, 'source.md'), 'utf8');
  assert.ok(source.includes(`(archive/${encodeURIComponent('缓存 空格')}.md)`));
  assert.ok(source.includes(`(archive/${encodeURIComponent('缓存 空格')}.en.md)`));
  assert.ok(source.includes('[[archive/缓存 空格.en|English]]'));
});

test('grouped rename uses the primary filename and preserves bytes without link maintenance', () => {
  const { root, registry, paths, raw, uri, en } = fixture();
  const renamed = registry.rename(en.uri, '新名称.md', en.version);
  assert.equal(renamed.uri, uri('docs/新名称.en.md'));
  assert.equal(readFileSync(join(root, 'docs/新名称.md'), 'utf8'), raw.zh);
  assert.equal(readFileSync(join(root, 'docs/新名称.en.md'), 'utf8'), raw.en);
  assert.ok(!existsSync(join(root, paths.zh)));
  assert.ok(!existsSync(join(root, paths.en)));
  assert.equal(registry.noteLanguages(renamed.uri).primary.uri, uri('docs/新名称.md'));
  assert.equal(Object.hasOwn(renamed, 'operation_id'), false);
  const moved = registry.moveDocument(renamed.uri, 'archive', renamed.version);
  assert.equal(moved.uri, uri('archive/新名称.en.md'));
  assert.equal(readFileSync(join(root, 'archive/新名称.md'), 'utf8'), raw.zh);
  assert.equal(readFileSync(join(root, 'archive/新名称.en.md'), 'utf8'), raw.en);
  assert.equal(Object.hasOwn(moved, 'operation_id'), false);
});

test('grouped rename and move check all destinations before changing either language', () => {
  const { root, registry, paths, raw, zh } = fixture();
  writeFileSync(join(root, 'docs/new.en.md'), 'Existing English note');
  assert.throws(() => registry.rename(zh.uri, 'new.md', zh.version, { updateLinks: true }), /同名/);
  assert.ok(!existsSync(join(root, 'docs/new.md')));
  writeFileSync(join(root, 'archive/缓存 空格.en.md'), 'Existing English note');
  assert.throws(() => registry.moveDocument(zh.uri, 'archive', zh.version), /同名/);
  assert.ok(!existsSync(join(root, 'archive/缓存 空格.md')));
  for (const language of ['zh', 'en'] as const) assert.equal(readFileSync(join(root, paths[language]), 'utf8'), raw[language]);
});

test('a stale note version protects the other language during rename, move and deletion', () => {
  const { root, registry, paths, raw, zh, en } = fixture();
  const noteVersion = registry.noteLanguages(zh.uri).signature;
  registry.update(en.uri, '# Updated by another agent', en.version);
  assert.throws(() => registry.rename(zh.uri, 'new.md', zh.version, { noteVersion }), /语言版本已变化/);
  assert.throws(() => registry.moveDocument(zh.uri, 'archive', zh.version, { noteVersion }), /语言版本已变化/);
  assert.throws(() => registry.delete(zh.uri, zh.version, { noteVersion }), /语言版本已变化/);
  assert.equal(readFileSync(join(root, paths.zh), 'utf8'), raw.zh);
  assert.ok(readFileSync(join(root, paths.en), 'utf8').includes('# Updated by another agent'));
  assert.equal(registry.listTrash('notes').items.length, 0);
});

test('deleting a language recycles one complete note and restore refuses any member collision', () => {
  const { root, registry, paths, raw, en } = fixture();
  registry.delete(en.uri, en.version, { noteVersion: registry.noteLanguages(en.uri).signature });
  for (const path of Object.values(paths)) assert.ok(!existsSync(join(root, path)));
  assert.equal(registry.notes('notes').length, 0);
  const [trash] = registry.listTrash('notes').items;
  assert.equal(registry.listTrash('notes').items.length, 1);
  assert.equal(trash.path, paths.zh);
  writeFileSync(join(root, paths.en), 'External file must survive');
  assert.throws(() => registry.restoreTrash('notes', trash.id, trash.version), /同名/);
  assert.ok(!existsSync(join(root, paths.zh)));
  assert.equal(readFileSync(join(root, paths.en), 'utf8'), 'External file must survive');
  unlinkSync(join(root, paths.en));
  registry.restoreTrash('notes', trash.id, registry.listTrash('notes').items[0].version);
  for (const language of ['zh', 'en'] as const) assert.equal(readFileSync(join(root, paths[language]), 'utf8'), raw[language]);
  assert.equal(registry.notes('notes').length, 1);
  assert.equal(registry.listTrash('notes').items.length, 0);
});

test('a second-file move failure restores the first file without a ghost version', () => {
  const { root, registry, paths, raw, zh } = fixture();
  let failed = false;
  let attempts = 0;
  const restore = injectLinkFailure((_source, target) => {
    if (!failed && Object.values(paths).some(path => target === join(root, path.replace('docs/', 'archive/')))) {
      if (++attempts === 2) { failed = true; throw new Error('Injected move failure'); }
    }
  });
  try {
    assert.throws(() => registry.moveDocument(zh.uri, 'archive', zh.version, { updateLinks: true }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.recovery?.partial, false);
      return true;
    });
    assert.ok(failed);
    for (const language of ['zh', 'en'] as const) {
      assert.equal(readFileSync(join(root, paths[language]), 'utf8'), raw[language]);
      assert.ok(!existsSync(join(root, paths[language].replace('docs/', 'archive/'))));
    }
  } finally { restore(); }
});

test('grouped rename rollback preserves an external edit and reports the actual remaining paths', () => {
  const { root, registry, paths, raw, uri, zh } = fixture();
  let failed = false;
  const attempts: { source: string; target: string }[] = [];
  const restore = injectLinkFailure((source, target) => {
    if (!failed && [join(root, 'docs/new.md'), join(root, 'docs/new.en.md')].includes(target)) {
      attempts.push({ source, target });
      if (attempts.length !== 2) return;
      failed = true;
      writeFileSync(attempts[0].target, 'External edit must survive');
      throw new Error('Injected rename failure');
    }
  });
  try {
    assert.throws(() => registry.rename(zh.uri, 'new.md', zh.version), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.recovery?.partial, true);
      assert.ok(error.details?.recovery?.affected_uris.includes(uri(attempts[0].target === join(root, 'docs/new.md') ? 'docs/new.md' : 'docs/new.en.md')));
      return true;
    });
    assert.equal(readFileSync(attempts[0].target, 'utf8'), 'External edit must survive');
    const unchangedLanguage = attempts[1].source === join(root, paths.en) ? 'en' : 'zh';
    assert.equal(readFileSync(attempts[1].source, 'utf8'), raw[unchangedLanguage]);
    assert.ok(!existsSync(attempts[0].source));
  } finally { restore(); }
});

test('a second-file delete failure restores both versions and leaves no trash entry', () => {
  const { root, registry, paths, raw, zh } = fixture();
  let failed = false;
  let attempts = 0;
  const restore = injectLinkFailure((_source, target) => {
    if (!failed && target.includes(join(root, '.trash'))) {
      if (++attempts === 2) { failed = true; throw new Error('Injected trash failure'); }
    }
  });
  try {
    assert.throws(() => registry.delete(zh.uri, zh.version), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.recovery?.partial, false);
      return true;
    });
    assert.ok(failed);
    for (const language of ['zh', 'en'] as const) assert.equal(readFileSync(join(root, paths[language]), 'utf8'), raw[language]);
    assert.equal(registry.listTrash('notes').items.length, 0);
  } finally { restore(); }
});

test('partial deletion preserves an external original and leaves a recoverable trash entry', () => {
  const { root, registry, paths, raw, zh } = fixture();
  let failed = false;
  const attempts: { source: string; target: string }[] = [];
  const restore = injectLinkFailure((source, target) => {
    if (!failed && target.includes(join(root, '.trash'))) {
      attempts.push({ source, target });
      if (attempts.length !== 2) return;
      failed = true;
      writeFileSync(attempts[0].source, 'External replacement must survive');
      throw new Error('Injected trash failure');
    }
  });
  try {
    assert.throws(() => registry.delete(zh.uri, zh.version), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.recovery?.partial, true);
      assert.equal(error.details?.recovery?.operation_id, registry.listTrash('notes').items[0].id);
      return true;
    });
    assert.equal(readFileSync(attempts[0].source, 'utf8'), 'External replacement must survive');
    const unchangedLanguage = attempts[1].source === join(root, paths.en) ? 'en' : 'zh';
    assert.equal(readFileSync(attempts[1].source, 'utf8'), raw[unchangedLanguage]);
    const [trash] = registry.listTrash('notes').items;
    assert.equal(trash.path, attempts[0].source === join(root, paths.en) ? paths.en : paths.zh);
    assert.throws(() => registry.restoreTrash('notes', trash.id, trash.version), /同名/);
  } finally { restore(); }
});

test('a second-file restore failure rolls the entire note back into the same trash entry', () => {
  const { root, registry, paths, raw, zh } = fixture();
  registry.delete(zh.uri, zh.version);
  const [trash] = registry.listTrash('notes').items;
  let failed = false;
  let attempts = 0;
  const restore = injectLinkFailure((_source, target) => {
    if (!failed && Object.values(paths).some(path => target === join(root, path))) {
      if (++attempts === 2) { failed = true; throw new Error('Injected restore failure'); }
    }
  });
  try {
    assert.throws(() => registry.restoreTrash('notes', trash.id, trash.version), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.recovery?.partial, false);
      return true;
    });
    for (const path of Object.values(paths)) assert.ok(!existsSync(join(root, path)));
    assert.equal(registry.listTrash('notes').items.length, 1);
  } finally { restore(); }
  registry.restoreTrash('notes', trash.id, registry.listTrash('notes').items[0].version);
  for (const language of ['zh', 'en'] as const) assert.equal(readFileSync(join(root, paths[language]), 'utf8'), raw[language]);
});

test('an edit through a moved file during deletion is preserved and reported instead of claiming success', () => {
  const { root, registry, zh } = fixture();
  const attempts: { source: string; target: string }[] = [];
  const restore = injectLinkFailure((source, target) => {
    if (target.includes(join(root, '.trash'))) {
      attempts.push({ source, target });
      if (attempts.length === 2) writeFileSync(attempts[0].target, 'External update in the moved inode');
    }
  });
  try {
    assert.throws(() => registry.delete(zh.uri, zh.version), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 409);
      assert.equal(error.details?.recovery?.partial, true);
      return true;
    });
    assert.equal(readFileSync(attempts[0].target, 'utf8'), 'External update in the moved inode');
    assert.ok(!existsSync(attempts[0].source));
    assert.ok(existsSync(attempts[1].source));
    assert.equal(registry.listTrash('notes').items.length, 1);
  } finally { restore(); }
});

test('ordinary file operations remain available when an unrelated directory cannot be scanned', () => {
  const { root, registry, uri } = fixture();
  writeFileSync(join(root, 'ordinary.md'), '# Ordinary note');
  mkdirSync(join(root, 'blocked'));
  const original = fs.readdirSync;
  fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]) === join(root, 'blocked')) throw new Error('Injected unreadable directory');
    return original(...args);
  }) as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => registry.scan('notes'), /无法读取/);
    const doc = registry.document(uri('ordinary.md'));
    const renamed = registry.rename(doc.uri, 'renamed.md', doc.version);
    const moved = registry.moveDocument(renamed.uri, 'archive', renamed.version);
    assert.equal(moved.raw, '# Ordinary note');
    registry.delete(moved.uri, moved.version);
    assert.ok(!existsSync(join(root, 'archive/renamed.md')));
    assert.equal(registry.listTrash('notes').items.length, 1);
  } finally { fs.readdirSync = original; syncBuiltinESMExports(); }
});
