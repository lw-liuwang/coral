import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchReturn, withSearchReturn } from './src/web-context.js';

test('search returns preserve only the scoped query, cursor and result anchor', () => {
  const target = '/search?' + new URLSearchParams({ q: 'KV 带宽', vault: 'research', cursor: '20', ignored: 'value' }) + '#doc-1234567890abcdef';
  const returned = new URL(searchReturn(target)!, 'http://coral.local');
  assert.equal(returned.searchParams.get('q'), 'KV 带宽');
  assert.equal(returned.searchParams.get('vault'), 'research');
  assert.equal(returned.searchParams.get('cursor'), '20');
  assert.equal(returned.searchParams.get('ignored'), null);
  assert.equal(returned.hash, '#doc-1234567890abcdef');
  assert.equal(new URL(withSearchReturn('/edit?uri=note', target), returned).searchParams.get('return_to'), returned.pathname + returned.search + returned.hash);
});

test('external and non-search return destinations are rejected', () => {
  for (const target of ['https://example.com/search?q=x', '//example.com/search', '/searching?q=x', '/edit?uri=x', '/search?cursor=-1', '/search?vault=../x', '/search?q=' + 'x'.repeat(501)]) {
    assert.equal(searchReturn(target), undefined, target);
    assert.equal(withSearchReturn('/document?uri=note', target), '/document?uri=note');
  }
});
