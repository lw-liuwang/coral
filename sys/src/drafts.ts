export interface Draft {
  content: string; title: string; directory: string; version: string; updated: number;
  language?: string; sourceLanguage?: string;
}

export interface DraftRecord extends Draft {
  format: 2; id: string; editor: string; writer?: string; resource: string; vault: string; folder: string; url: string;
  state: 'active' | 'discarded'; consumed: string[]; undo?: string;
}

const prefix = 'coral:draft:v2:';
const key = (id: string) => prefix + id;
export const draftId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
  : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
export const draftFingerprint = (draft: Draft) => JSON.stringify([
  draft.content, draft.title, draft.directory, draft.language ?? '', draft.sourceLanguage ?? '',
]);

function parseDraft(raw: string | null): Draft | undefined {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object' || !['content', 'title', 'version'].every(field => typeof value[field] === 'string')) return;
    return { content: value.content, title: value.title, version: value.version,
      directory: typeof value.directory === 'string' ? value.directory : '',
      updated: typeof value.updated === 'number' && Number.isFinite(value.updated) ? value.updated : 0,
      language: value.language === 'zh' || value.language === 'en' ? value.language : undefined,
      sourceLanguage: value.sourceLanguage === 'zh' || value.sourceLanguage === 'en' ? value.sourceLanguage : undefined };
  } catch { return; }
}

export function readDraft(storage: Storage, id: string): DraftRecord | undefined {
  try {
    const raw = storage.getItem(key(id));
    const value = JSON.parse(raw ?? 'null');
    const draft = parseDraft(raw);
    if (!draft || value.format !== 2 || value.id !== id || !['editor', 'resource', 'vault', 'folder', 'url'].every(field => typeof value[field] === 'string')
      || !['active', 'discarded'].includes(value.state)) return;
    return { ...draft, format: 2, id, editor: value.editor, writer: typeof value.writer === 'string' ? value.writer : undefined,
      resource: value.resource, vault: value.vault, folder: value.folder,
      url: value.url, state: value.state, consumed: Array.isArray(value.consumed) ? value.consumed.filter((item: unknown) => typeof item === 'string') : [],
      undo: typeof value.undo === 'string' ? value.undo : undefined };
  } catch { return; }
}

export function listDrafts(storage: Storage): DraftRecord[] {
  const records: DraftRecord[] = [];
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index);
    if (!name?.startsWith(prefix)) continue;
    const record = readDraft(storage, name.slice(prefix.length));
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.updated - a.updated);
}

export interface DraftLocation { editor: string; resource: string; vault: string; folder: string; url: string }

export function recoveryDrafts(records: DraftRecord[]) {
  return records.filter(record => record.state === 'active' && !records.some(descendant => record.writer
    && descendant.writer === record.writer && descendant.consumed.includes(record.id)));
}

export const draftResolved = (storage: Storage, id: string) => storage.getItem('coral:draft-resolved:' + id) === '1';

// Entries are immutable. A page can replace its own entry, but never another tab's entry.
export class DraftStore {
  private owned?: string;
  private writer = draftId();
  private updated = 0;
  constructor(private storage: Storage, readonly location: DraftLocation) {}

  list() { return listDrafts(this.storage).filter(record => record.resource === this.location.resource); }

  write(draft: Draft, consumed: string[] = [], undo?: string, state: DraftRecord['state'] = 'active', replaceOwn = true) {
    const record: DraftRecord = { ...draft, ...this.location, folder: draft.directory || this.location.folder,
      format: 2, id: draftId(), writer: this.writer, consumed, undo, state,
      updated: Math.max(Date.now(), draft.updated + 1, this.updated + 1) };
    this.storage.setItem(key(record.id), JSON.stringify(record));
    this.updated = record.updated;
    if (state === 'active' && replaceOwn) {
      const previous = this.owned;
      this.owned = record.id;
      if (previous) this.storage.removeItem(key(previous));
    }
    return record;
  }

  migrate(legacyKey: string) {
    const raw = this.storage.getItem(legacyKey);
    const marker = 'coral:migrated-draft:' + legacyKey;
    const draft = parseDraft(raw);
    if (!draft || this.storage.getItem(marker) === raw) return;
    const record = this.write(draft, [], undefined, 'active', false);
    // Leave the old key intact; a still-open older client may own it.
    this.storage.setItem(marker, raw!);
    return record;
  }

  remove(ids: Iterable<string>) {
    for (const id of ids) {
      if (readDraft(this.storage, id)?.writer !== this.writer) continue;
      this.storage.removeItem(key(id));
      this.storage.removeItem('coral:draft-resolved:' + id);
    }
    if (this.owned && !this.storage.getItem(key(this.owned))) this.owned = undefined;
  }

  clearOwn() {
    if (this.owned) this.remove([this.owned]);
  }

  markSaved(draft: Draft) {
    for (const record of this.list()) {
      if (record.state === 'active' && record.writer !== this.writer && draftFingerprint(record) === draftFingerprint(draft)) {
        this.storage.setItem('coral:draft-resolved:' + record.id, '1');
      }
    }
  }
}

export function mountDirectoryDrafts() {
  const container = document.querySelector<HTMLElement>('[data-directory-drafts]');
  if (!container) return;
  const refresh = () => {
    try {
      const records = recoveryDrafts(listDrafts(localStorage)).filter(record =>
        record.vault === container.dataset.vault && record.folder === (container.dataset.directory ?? ''));
      const seen = new Set<string>();
      container.replaceChildren();
      const heading = document.createElement('h2');
      heading.textContent = '未保存草稿';
      const list = document.createElement('ul');
      const older = document.createElement('ul');
      for (const record of records) {
        const identity = record.resource + ':' + draftFingerprint(record) + ':' + record.version;
        if (seen.has(identity)) continue;
        const target = new URL(record.url, location.origin);
        if (target.origin !== location.origin || !['/edit', '/new', '/languages/new'].includes(target.pathname)) continue;
        seen.add(identity);
        target.searchParams.set('draft', record.editor);
        target.searchParams.set('recover', record.id);
        const link = document.createElement('a');
        link.href = target.pathname + target.search;
        const title = record.title || record.content.match(/^#\s+(.+)$/m)?.[1]
          || decodeURIComponent(new URL(record.resource.startsWith('coral:') ? record.resource : 'coral://vault/未命名草稿').pathname.split('/').at(-1) || '未命名草稿').replace(/\.markdown$|\.md$/i, '');
        link.textContent = title;
        link.setAttribute('aria-label', '恢复草稿：' + title);
        const item = document.createElement('li');
        item.append(link);
        (draftResolved(localStorage, record.id) ? older : list).append(item);
      }
      container.hidden = !list.childElementCount && !older.childElementCount;
      if (!container.hidden) container.append(heading);
      if (list.childElementCount) container.append(list);
      if (older.childElementCount) {
        const details = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = '较早草稿';
        details.append(summary, older); container.append(details);
      }
    } catch { container.hidden = true; }
  };
  refresh();
  window.addEventListener('pageshow', refresh);
  window.addEventListener('storage', refresh);
}
