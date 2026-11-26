import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from './src/config.js';
import { AppError, resourceUri } from './src/content.js';
import { VaultRegistry } from './src/vault.js';
import { documentPage } from './src/views.js';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'coral-languages-'));
  const registry = new VaultRegistry(createConfig({ data_dir: directory }));
  cleanup.push(() => { registry.close(); rmSync(directory, { recursive: true, force: true }); });
  return { registry, root: join(directory, 'obsdian/default') };
}

test('a language version uses two ordinary files but one browsable note and keeps independent content', () => {
  const { registry, root } = fixture();
  const original = registry.create('default', '缓存容量', '# 缓存容量\n\n中文内容。', { tags: ['cache'], paragraph_indent: '2em' }, 'cache', '课程 #1');
  const english = registry.createLanguageVersion(original.uri, 'en', '---\ntitle: Cache capacity\nowner: writer\n---\n# Cache capacity\n\nEnglish content.', original.version);
  const source = registry.document(original.uri);
  assert.equal(source.body, original.body);
  assert.deepEqual(source.metadata.tags, ['cache']);
  assert.equal(source.metadata.paragraph_indent, '2em');
  assert.notEqual(source.version, original.version);
  assert.equal(english.relative, '课程 #1/cache.en.md');
  assert.equal(english.metadata.owner, 'writer');
  assert.equal(english.metadata.paragraph_indent, undefined);
  assert.equal(english.metadata.coral_note_id, source.metadata.coral_note_id);
  assert.equal(english.metadata.coral_primary, false);
  assert.equal(source.metadata.coral_primary, true);
  assert.ok(existsSync(join(root, english.relative)));
  assert.equal(registry.scan('default').documents.length, 2);
  assert.equal(registry.notes('default').length, 1);
  assert.equal(registry.browse('default', '课程 #1').documents[0].uri, original.uri);
  assert.equal(registry.browse('default').directories[0].document_count, 1);
  const listed = registry.listDocuments('default');
  assert.equal(listed.total, 1);
  assert.equal(listed.documents[0].language_versions?.length, 2);
  assert.equal(registry.listVaults().vaults[0].document_count, 1);
  const read = registry.readDocument(english.uri);
  assert.equal(read.note_uri, original.uri);
  assert.equal(read.language, 'en');
  assert.equal(read.language_versions?.length, 2);
  assert.equal(read.content, english.raw);
  assert.equal(registry.download(english.uri).bytes.toString('utf8'), english.raw);
});

test('an English source can add Chinese explicitly and updates protect the language identity', () => {
  const { registry } = fixture();
  const original = registry.create('default', 'English source', '# English source\n\nOriginal.', {}, 'source');
  const chinese = registry.createLanguageVersion(original.uri, 'zh', '# 中文版本\n\n解释。', original.version, { sourceLanguage: 'en', title: '中文版本' });
  const before = registry.noteLanguages(chinese.uri);
  assert.equal(before.versions.find(item => item.document.uri === original.uri)?.language, 'en');
  assert.equal(before.primary.uri, chinese.uri);
  assert.equal(registry.notes('default')[0].uri, chinese.uri);
  assert.equal(chinese.title, '中文版本');
  const updated = registry.update(chinese.uri, '---\ntitle: 更新的中文标题\n---\n# 中文版本\n\n改写。', chinese.version);
  assert.equal(updated.metadata.coral_note_id, chinese.metadata.coral_note_id);
  assert.equal(updated.metadata.coral_language, 'zh');
  assert.equal(registry.notes('default').length, 1);
  assert.notEqual(registry.noteLanguages(original.uri).signature, before.signature);
  assert.equal(registry.document(original.uri).body, original.body);
  assert.throws(() => registry.update(updated.uri, '---\ncoral_language: en\n---\nWrong identity', updated.version), /关联字段/);
  assert.throws(() => registry.update(updated.uri, 'old edit', chinese.version), /文档已被修改/);
});

test('language creation rejects stale sources, duplicate languages and collisions without overwriting', () => {
  const { registry, root } = fixture();
  const original = registry.create('default', '原文', '# Original', {}, 'original');
  const latest = registry.update(original.uri, '# Changed', original.version);
  assert.throws(() => registry.createLanguageVersion(original.uri, 'en', '# Stale', original.version), /原文已被修改/);
  assert.ok(!existsSync(join(root, 'original.en.md')));
  assert.throws(() => registry.createLanguageVersion(original.uri, 'zh', '# Same language', latest.version), /必须与原文语言不同/);
  writeFileSync(join(root, 'original.en.md'), '# Unrelated existing English file');
  assert.throws(() => registry.createLanguageVersion(original.uri, 'en', '# Translation', latest.version), /同名语言版本文件/);
  assert.equal(registry.document(latest.uri).raw, latest.raw);
  assert.equal(readFileSync(join(root, 'original.en.md'), 'utf8'), '# Unrelated existing English file');
  unlinkSync(join(root, 'original.en.md'));
  const english = registry.createLanguageVersion(original.uri, 'en', '# Translation', latest.version);
  const current = registry.document(original.uri);
  assert.throws(() => registry.createLanguageVersion(current.uri, 'en', '# Duplicate', current.version), /已有此语言版本/);
  assert.equal(registry.document(english.uri).body, '# Translation');
});

test('search indexes the Chinese primary only and paginates logical notes', () => {
  const { registry } = fixture();
  const source = registry.create('default', '共享关键词', '# 共享关键词\n\n共同 needle.', {}, 'one');
  const english = registry.createLanguageVersion(source.uri, 'en', '---\ntitle: English exact title\n---\n# English\n\nneedle and English-only phrase.', source.version);
  registry.create('default', 'Other needle', 'needle', {}, 'two');
  const first = registry.search('needle', 'default', 1);
  const second = registry.search('needle', 'default', 1, 1);
  assert.equal(first.total, 2);
  assert.equal(second.total, 2);
  assert.notEqual(first.results[0].note_uri, second.results[0].note_uri);
  assert.equal(first.next_cursor, 1);
  assert.equal(second.next_cursor, null);
  const englishMatch = registry.search('English exact title', 'default');
  assert.equal(englishMatch.total, 0);
  assert.equal(registry.search('English-only phrase', 'default').total, 0);
  const chineseMatch = registry.search('共享关键词', 'default').results[0];
  assert.equal(chineseMatch.uri, source.uri);
  assert.equal(chineseMatch.note_uri, source.uri);
  assert.equal(chineseMatch.language_versions?.find(item => item.language === 'en')?.uri, english.uri);
});

test('ordinary language-like filenames are independent and ambiguous declarations never hide files', () => {
  const { registry, root } = fixture();
  registry.create('default', 'One', '# One', {}, 'note');
  registry.create('default', 'Separate English', '# English', {}, 'note.en');
  assert.equal(registry.notes('default').length, 2);
  const source = registry.create('default', 'Grouped', '# Grouped', {}, 'grouped');
  const english = registry.createLanguageVersion(source.uri, 'en', '# English', source.version);
  writeFileSync(join(root, 'duplicate.md'), english.raw);
  assert.equal(registry.notes('default').length, 5);
  assert.ok(registry.notes('default').filter(doc => doc.metadata.coral_note_id).every(doc => /歧义/.test(doc.warning!)));
  assert.equal(documentPage(registry, registry.document(source.uri)).split('语言版本关联有歧义').length - 1, 1);
  assert.throws(() => registry.createLanguageVersion(source.uri, 'en', '# More', registry.document(source.uri).version), /歧义/);
});

test('manual rename and deletion leave surviving language versions discoverable', () => {
  const { registry, root } = fixture();
  const source = registry.create('default', 'Grouped', '# Grouped', {}, 'grouped');
  const english = registry.createLanguageVersion(source.uri, 'en', '# English', source.version);
  renameSync(join(root, 'grouped.md'), join(root, 'renamed.md'));
  const renamedUri = resourceUri('default', 'renamed.md');
  assert.equal(registry.noteLanguages(english.uri).primary.uri, renamedUri);
  assert.equal(registry.notes('default').length, 1);
  unlinkSync(join(root, 'renamed.md'));
  assert.equal(registry.notes('default')[0].uri, english.uri);
  const recreated = registry.createLanguageVersion(english.uri, 'zh', '# 新中文版本', english.version);
  assert.equal(registry.notes('default').length, 1);
  assert.equal(registry.noteLanguages(recreated.uri).primary.uri, recreated.uri);
});

test('reading uses the same fresh snapshot for displayed content and deletion protection', () => {
  const { registry } = fixture();
  const source = registry.create('default', 'Versioned', '# Versioned\n\nOld visible body.', {}, 'versioned');
  registry.createLanguageVersion(source.uri, 'en', '# English', source.version);
  const stale = registry.document(source.uri);
  const latest = registry.update(source.uri, '# Versioned\n\nNew visible body.', stale.version);
  const html = documentPage(registry, stale);
  assert.ok(html.includes('New visible body.'));
  assert.ok(!html.includes('Old visible body.'));
  assert.ok(html.includes('name="version" value="' + latest.version + '"'));
  assert.ok(html.includes('data-reading-version="' + latest.version + '"'));
});

test('language discovery rejects a file changing while its family is scanned', () => {
  const { registry, root } = fixture();
  const source = registry.create('default', 'Race', '# Race', {}, 'race');
  registry.createLanguageVersion(source.uri, 'en', '# English', source.version);
  const before = registry.document(source.uri);
  const realReaddir = fs.readdirSync;
  let changed = false;
  fs.readdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
    if (!changed && String(path) === root) {
      changed = true;
      writeFileSync(join(root, 'race.md'), before.raw.replace('# Race', '# External write'));
    }
    return (realReaddir as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try { assert.throws(() => registry.noteLanguages(source.uri), /读取期间笔记内容发生变化/); }
  finally { fs.readdirSync = realReaddir; syncBuiltinESMExports(); }
});

test('an incomplete language inventory does not block physical reads or ordinary note edits', () => {
  const { registry, root } = fixture();
  const ordinary = registry.create('default', 'Ordinary', '# Ordinary', {}, 'ordinary');
  const source = registry.create('default', 'Grouped', '# Grouped', {}, 'grouped');
  const english = registry.createLanguageVersion(source.uri, 'en', '# English', source.version);
  const blocked = join(root, 'unreadable');
  mkdirSync(blocked);
  const realReaddir = fs.readdirSync;
  fs.readdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
    if (String(path) === blocked) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    return (realReaddir as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try {
    const read = registry.readDocument(english.uri);
    assert.equal(read.content, english.raw);
    assert.equal(read.language_info_incomplete, true);
    assert.equal(read.language_versions, undefined);
    assert.equal(read.note_uri, undefined);
    assert.match(read.language_info_error!, /无法读取/);
    assert.equal(registry.update(ordinary.uri, '# Still editable', ordinary.version).body, '# Still editable');
    const updatedEnglish = registry.update(english.uri, '# English updated independently', english.version);
    assert.equal(updatedEnglish.body, '# English updated independently');
    assert.equal(updatedEnglish.languageInfoIncomplete, true);
    assert.equal(updatedEnglish.metadata.coral_note_id, english.metadata.coral_note_id);
    assert.throws(() => registry.moveDocument(english.uri, '', updatedEnglish.version), /无法读取/);
  } finally { fs.readdirSync = realReaddir; syncBuiltinESMExports(); }
});

test('failed language creation restores owned source content and removes its new file', () => {
  const { registry, root } = fixture();
  const original = registry.create('default', 'Rollback', '# Original', {}, 'rollback');
  const realLink = fs.linkSync;
  let failed = false;
  fs.linkSync = ((from, to) => {
    if (!failed && String(to) === join(root, 'rollback.md') && String(from).includes('.coral-')) {
      failed = true;
      throw new Error('injected write failure');
    }
    return realLink(from, to);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => registry.createLanguageVersion(original.uri, 'en', '# Translation', original.version), error => error instanceof AppError && error.details?.recovery?.partial === false);
  } finally { fs.linkSync = realLink; syncBuiltinESMExports(); }
  assert.equal(registry.document(original.uri).raw, original.raw);
  assert.ok(!existsSync(join(root, 'rollback.en.md')));
});

test('language creation preserves an externally modified new file and reports partial recovery', () => {
  const { registry, root } = fixture();
  const original = registry.create('default', 'Concurrent', '# Original', {}, 'concurrent');
  const realLink = fs.linkSync;
  let failed = false;
  fs.linkSync = ((from, to) => {
    if (!failed && String(to) === join(root, 'concurrent.md') && String(from).includes('.coral-')) {
      failed = true;
      writeFileSync(join(root, 'concurrent.en.md'), '# External writing');
      throw new Error('injected write failure');
    }
    return realLink(from, to);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => registry.createLanguageVersion(original.uri, 'en', '# Translation', original.version), error => error instanceof AppError
      && error.details?.recovery?.partial === true && error.details.recovery.conflicts.some(item => item.uri.endsWith('/concurrent.en.md')));
  } finally { fs.linkSync = realLink; syncBuiltinESMExports(); }
  assert.equal(registry.document(original.uri).raw, original.raw);
  assert.equal(readFileSync(join(root, 'concurrent.en.md'), 'utf8'), '# External writing');
});
