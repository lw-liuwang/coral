import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cjkSplit, ftsQuery, matchesSearchText, rankSearchDocument, searchMatchRanges, searchSnippet, splitSearchQuery } from '../src/search-query.js';

test('search groups whitespace while keeping Chinese groups continuous', () => {
  assert.deepEqual(splitSearchQuery('  数据库\t优化\nLayer-Norm  '), ['数据库', '优化', 'Layer-Norm']);
  assert.deepEqual(splitSearchQuery(' \n\t'), []);
  assert.equal(ftsQuery('Layer Norm'), '"layer" AND "norm"');
  assert.equal(ftsQuery('a"b'), '"a""b"');
});

test('query matching follows SQLite FTS token phrases and AND without interpreting operators', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE search USING fts5(body, tokenize='unicode61')");
    const insert = db.prepare('INSERT INTO search VALUES (?)');
    const match = db.prepare('SELECT count(*) AS count FROM search WHERE search MATCH ?');
    const cases: [string, string, boolean][] = [
      ['数据库位于开头，经过一段文字以后才讲优化。', '数据库 优化', true],
      ['数据库位于开头，经过一段文字以后才讲优化。', '数据库优化', false],
      ['数**据**库支持索引。', '数据库', true],
      ['数abc据库支持索引。', '数据库', false],
      ['Layer,\n**Norm** handles Café.', 'layer-norm cafe', true],
      ['o\u0323\u0302 Café', 'o cafe', true],
      ['ſample', 'sample', true],
      ['ǣ', 'æ', false],
      ['ộ', 'o', false],
      ['Αθήνα', 'Αθηνα', false],
      ['ガ', 'カ', false],
      ['गोदाम', 'गदाम', false],
      ['Only layer appears here.', 'layer norm', false],
      ['Layer Norm.', 'title:("norm") OR *', false],
      ['Layer Norm.', '"', false],
    ];
    for (const [body, query, expected] of cases) {
      db.exec('DELETE FROM search');
      insert.run(cjkSplit(body));
      assert.equal(Number(match.get(ftsQuery(query))!.count) > 0, expected, query);
      assert.equal(matchesSearchText(body, splitSearchQuery(query)), expected, query);
    }
  } finally { db.close(); }
});

test('highlight ranges use actual token matches and merge duplicate or overlapping phrases', () => {
  const text = '数**据**库，Layer,\n**Norm** Café';
  assert.deepEqual(searchMatchRanges(text, ['数据库', 'layer-norm', 'norm', 'cafe', '数据库']).map(range => text.slice(range.start, range.end)), [
    '数**据**库', 'Layer,\n**Norm', 'Café',
  ]);
  assert.deepEqual(searchMatchRanges('Database', ['data']), []);
});

test('exact titles and actual filenames rank ahead of paths and repeated body matches', () => {
  const terms = splitSearchQuery('Layer Norm');
  const bodyMatch = { title: 'Other', relative: 'docs/other.md', body: 'Layer Norm '.repeat(1000) };
  const pathMatch = { title: 'Normalization', relative: 'course/Layer/Norm.md', body: '' };
  const filenameMatch = { title: '不同的属性标题', relative: 'course/Layer Norm.md', body: '' };
  const titleMatch = { title: 'LAYER  NORM', relative: 'course/reference.md', body: '' };
  assert.equal(rankSearchDocument(bodyMatch, terms), 2);
  assert.equal(rankSearchDocument(pathMatch, terms), 1);
  assert.equal(rankSearchDocument(filenameMatch, terms), 0);
  assert.equal(rankSearchDocument(titleMatch, terms), 0);
  assert.deepEqual([bodyMatch, pathMatch, titleMatch].sort((a, b) => rankSearchDocument(a, terms) - rankSearchDocument(b, terms)), [titleMatch, pathMatch, bodyMatch]);
  assert.equal(rankSearchDocument({ title: 'Layer Normalization', relative: 'cs336/reference.md' }, ['cs336', 'Layer']), 1);
});

test('snippets locate token hits across Markdown, punctuation and line breaks deep in a document', () => {
  const body = '# Intro\r\n' + 'Unrelated background text.\r\n'.repeat(80) + '## Details\r\n数**据**库的优化\r\nLayer,\r\n**Norm**\r\nLast line.\r\n';
  const raw = '\uFEFF---\r\ntitle: Search example\r\n---\r\n' + body;
  const result = searchSnippet(raw, body, splitSearchQuery('数据库 Layer Norm'));
  assert.match(result.snippet, /数\*\*据\*\*库/);
  assert.match(result.snippet, /Layer,\r\n\*\*Norm\*\*/);
  assert.equal(result.start_line, raw.slice(0, raw.indexOf(result.snippet, raw.length - body.length)).split('\n').length);
  assert.ok(result.start_line > 50);
});

test('snippets prefer nearby query groups and count original frontmatter lines accurately', () => {
  const body = 'database\n' + 'background\n'.repeat(100) + 'database indexing and optimization are related.';
  assert.match(searchSnippet(body, body, ['database', 'optimization']).snippet, /database indexing and optimization/);
  assert.deepEqual(searchSnippet('---\r\ntitle: first\r\n---\r\nfirst', 'first', ['first']), { snippet: 'first', start_line: 4 });
  assert.deepEqual(searchSnippet('---\ntitle: empty\n---\n', '', ['title']), { snippet: '', start_line: 4 });
});
