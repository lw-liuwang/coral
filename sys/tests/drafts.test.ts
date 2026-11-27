import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftStore, listDrafts, type Draft } from '../src/drafts.js';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(name: string) { return this.values.get(name) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(name: string) { this.values.delete(name); }
  setItem(name: string, value: string) { this.values.set(name, value); }
}

const location = { editor: 'editor-instance', resource: 'coral://vault/default/note.md', vault: 'default', folder: '', url: '/edit?uri=coral%3A%2F%2Fvault%2Fdefault%2Fnote.md' };
const draft: Draft = { title: '', content: 'Unfinished work', directory: '', version: 'original', updated: 1 };

test('a save or a new snapshot cannot erase a different tab’s draft for the same note', () => {
  const storage = new MemoryStorage();
  const first = new DraftStore(storage, location);
  const second = new DraftStore(storage, location);
  const a = first.write(draft);
  const b = second.write({ ...draft, content: 'Other tab' });
  const c = first.write({ ...draft, content: 'First tab continued' });
  assert.deepEqual(listDrafts(storage).map(record => record.id).sort(), [b.id, c.id].sort());
  assert.notEqual(a.id, c.id);
  first.clearOwn();
  assert.equal(listDrafts(storage)[0].content, 'Other tab');
});

test('reloading forks the inherited snapshot and only resolves explicitly consumed recovery', () => {
  const storage = new MemoryStorage();
  const beforeReload = new DraftStore(storage, location);
  const original = beforeReload.write(draft);
  const reopened = new DraftStore(storage, location);
  const fork = reopened.write({ ...original, content: 'Recovered and continued' }, [original.id]);
  assert.equal(listDrafts(storage).length, 2);
  beforeReload.clearOwn();
  assert.equal(listDrafts(storage)[0].id, fork.id);
  assert.equal(listDrafts(storage)[0].version, 'original');
});

test('saving or discarding a recovered snapshot cannot delete its foreign writer, even with a copied editor URL', () => {
  const storage = new MemoryStorage();
  const first = new DraftStore(storage, location);
  const original = first.write(draft);
  const copiedURL = new DraftStore(storage, location);
  copiedURL.write({ ...draft, content: 'Second writer changed this' }, [original.id]);
  copiedURL.remove([original.id]);
  copiedURL.clearOwn();
  assert.equal(listDrafts(storage).find(record => record.id === original.id)?.content, draft.content);
  assert.notEqual(new DraftStore(storage, location).write(draft).writer, original.writer);
});

test('saved identical content is marked resolved without deleting its recovery snapshot', () => {
  const storage = new MemoryStorage();
  const first = new DraftStore(storage, location);
  const original = first.write(draft);
  const second = new DraftStore(storage, location);
  second.markSaved(draft);
  assert.ok(listDrafts(storage).some(record => record.id === original.id));
  assert.equal(storage.getItem('coral:draft-resolved:' + original.id), '1');
});

test('discarding a foreign recovery candidate remains the latest editor state after reload', () => {
  const storage = new MemoryStorage();
  const source = new DraftStore(storage, location).write(draft);
  const reopened = new DraftStore(storage, location);
  const discarded = reopened.write(source, [source.id], undefined, 'discarded');
  reopened.remove([source.id]);
  assert.equal(listDrafts(storage)[0].id, discarded.id);
  assert.ok(listDrafts(storage).some(record => record.id === source.id));
});

test('failed writes preserve the last durable snapshot', () => {
  const storage = new MemoryStorage();
  const store = new DraftStore(storage, location);
  const original = store.write(draft);
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  assert.throws(() => store.write({ ...draft, content: 'Not yet durable' }), /Quota/);
  assert.equal(listDrafts(storage)[0].id, original.id);
});

test('migration preserves the legacy record and detects a later write from an older client', () => {
  const storage = new MemoryStorage();
  const store = new DraftStore(storage, location);
  const legacyKey = 'coral:draft:' + location.resource;
  const raw = JSON.stringify(draft);
  storage.setItem(legacyKey, raw);
  assert.equal(store.migrate(legacyKey)?.content, draft.content);
  assert.equal(storage.getItem(legacyKey), raw);
  assert.equal(store.migrate(legacyKey), undefined);
  storage.setItem(legacyKey, JSON.stringify({ ...draft, content: 'Older client continued' }));
  assert.equal(store.migrate(legacyKey)?.content, 'Older client continued');
  assert.equal(listDrafts(storage).length, 2);
});

test('discard and undo entries remain durable without replacing the current editor snapshot', () => {
  const storage = new MemoryStorage();
  const store = new DraftStore(storage, location);
  const current = store.write({ ...draft, content: 'Keep typing this' });
  const discarded = store.write(draft, [], undefined, 'discarded');
  const reopened = new DraftStore(storage, location);
  assert.equal(reopened.list().find(record => record.id === discarded.id)?.state, 'discarded');
  const restored = reopened.write(discarded, [], undefined, 'active', false);
  reopened.remove([discarded.id]);
  reopened.write({ ...draft, content: 'New text' });
  assert.ok(listDrafts(storage).some(record => record.id === current.id));
  assert.ok(listDrafts(storage).some(record => record.id === restored.id && record.state === 'active'));
});
