import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, lstatSync, unlinkSync, writeFileSync, rmSync, rmdirSync, linkSync } from 'node:fs';
import { basename, dirname, extname, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Config } from './config.js';
import { AppError, decodedPathCandidates, hasFrontmatter, headings, parseMarkdown, parseUri, resourceUri, safeParts, serialize, titleFor } from './content.js';
import { rewriteRelocationLinks, type UnresolvedLink } from './relocation-links.js';
import { cjkSplit, ftsQuery, matchesSearchText, rankSearchDocument, searchSnippet, splitSearchQuery } from './search-query.js';
import { documentLanguage, groupNotes, isDocumentLanguage, isNoteId, languageKeys, type DocumentLanguage, type NoteLanguageFamily } from './note-languages.js';

export type { DocumentLanguage } from './note-languages.js';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export interface Vault { id: string; name: string; description: string; root: string }
export interface Document {
  uri: string; vaultId: string; relative: string; title: string;
  version: string; size: number; raw: string; body: string;
  metadata: Record<string, unknown>; warning?: string;
  noteUri?: string; language?: DocumentLanguage; noteVersion?: string;
  languageVersions?: { language: DocumentLanguage; uri: string; title: string; version: string }[];
  languageInfoIncomplete?: boolean; languageInfoError?: string;
}
export interface RelocationOptions { updateLinks?: boolean; noteVersion?: string }
export interface RelocationReport {
  operation_id: string;
  updated_documents: { uri: string; version: string }[];
  unresolved_links: UnresolvedLink[];
}
type RelocationResult<T> = T & Partial<RelocationReport>;
const relocationReportSchema = z.object({ operation_id: z.string().uuid(),
  updated_documents: z.array(z.object({ uri: z.string(), version: z.string() })),
  unresolved_links: z.array(z.object({ uri: z.string(), target: z.string(), reason: z.string() })) });
export function publicDocument(doc: Document) {
  return { uri: doc.uri, vault_id: doc.vaultId, title: doc.title, path: doc.relative,
    size_bytes: doc.size, version: doc.version, mime_type: 'text/markdown',
    ...(doc.noteUri ? { note_uri: doc.noteUri, language: doc.language, language_versions: doc.languageVersions, note_version: doc.noteVersion } : {}),
    ...(doc.languageInfoIncomplete ? { language_info_incomplete: true, language_info_error: doc.languageInfoError } : {}) };
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const today = () => new Date().toLocaleDateString('en-CA');
const vaultStateSchema = z.object({ id: z.string(), name: z.string(), description: z.string(), root: z.string(),
  source: z.enum(['managed', 'external']), state: z.enum(['trash', 'removed']), deleted_at: z.string().datetime() });
type VaultState = z.infer<typeof vaultStateSchema>;
const trashRecordSchema = z.object({ path: z.string(), kind: z.enum(['file', 'directory']), deleted_at: z.string().datetime(),
  members: z.array(z.string()).min(1).max(2).optional() });
interface TrashItem { id: string; vault_id: string; vault_name: string; path: string; uri: string; kind: 'file' | 'directory'; deleted_at: string; version: string }
const validId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);
const validVaultName = (name: string) => /^[a-z][a-z0-9_-]{0,63}$/.test(name);
const naturalNameOrder = new Intl.Collator(undefined, { numeric: true });
// Break ties (e.g. 01/1) consistently so pagination does not depend on filesystem order.
const compareNames = (a: string, b: string) => naturalNameOrder.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
export const isIndexDocument = (path: string) => /^index\.(md|markdown)$/i.test(basename(path));

export class VaultRegistry {
  readonly vaults = new Map<string, Vault>();
  private db: DatabaseSync;
  private fts: boolean;
  private scans = new Map<string, { root: string; files: Map<string, { stamp: string; doc?: Document }>; result: { documents: Document[]; skipped: number } }>();
  private indexed = new Map<string, string>();

  constructor(readonly config: Config) {
    const directory = join(config.data_dir, 'obsdian');
    if (!existsSync(directory) && !existsSync(join(this.stateDirectory('default'), 'state.json'))) mkdirSync(join(directory, 'default', '.obsidian'), { recursive: true });
    this.refreshVaults();
    this.db = new DatabaseSync(':memory:');
    try {
      this.db.exec("CREATE VIRTUAL TABLE search USING fts5(uri UNINDEXED, title, body, tokenize='unicode61')");
      this.fts = true;
    } catch {
      this.db.exec('CREATE TABLE search (uri TEXT, title TEXT, body TEXT)');
      this.fts = false;
    }
  }

  close() { this.db.close(); }

  // Each managed Vault publishes its own manifest, so independent MCP processes discover it.
  refreshVaults() {
    this.vaults.clear();
    const root = join(this.config.data_dir, 'obsdian', 'default');
    if (existsSync(root)) this.vaults.set('default', { id: 'default', name: 'default', description: 'coral 网页知识库', root });
    for (const [id, vault] of Object.entries(this.config.vaults)) this.vaults.set(id, { id, name: vault.name ?? id, description: vault.description, root: vault.path });
    const directory = join(this.config.data_dir, 'obsdian');
    for (const entry of existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : []) {
      if (!entry.isDirectory() || !validVaultName(entry.name) || entry.name === 'default') continue;
      try {
        const root = join(directory, entry.name);
        const filename = join(root, '.coral-vault.json');
        const manifest = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : {};
        const id = manifest.id ?? entry.name;
        if (typeof id !== 'string' || !validId(id) || this.vaults.has(id)) continue;
        if (manifest.description !== undefined && typeof manifest.description !== 'string') continue;
        this.vaults.set(id, { id, name: entry.name, description: manifest.description ?? '', root });
      } catch { /* Incomplete or unregistered directories are not Vaults. */ }
    }
    for (const id of this.vaults.keys()) if (existsSync(join(this.stateDirectory(id), 'state.json'))) this.vaults.delete(id);
    for (const id of this.scans.keys()) if (!this.vaults.has(id)) this.scans.delete(id);
  }

  private stateDirectory(id: string) {
    if (!validId(id)) throw new AppError('知识库标识无效');
    return join(this.config.data_dir, '.coral', 'vault-trash', id);
  }

  private vaultState(id: string): VaultState | undefined {
    const file = join(this.stateDirectory(id), 'state.json');
    if (!existsSync(file)) return;
    const state = vaultStateSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (state.id !== id) throw new AppError('知识库回收记录无效');
    if (state.source === 'managed') {
      const name = id === 'default' ? 'default' : state.name.toLowerCase();
      state.root = join(this.config.data_dir, 'obsdian', validVaultName(name) ? name : id);
    }
    return state;
  }

  private saveVaultState(state: VaultState) {
    const directory = this.stateDirectory(state.id);
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, randomUUID() + '.tmp');
    writeFileSync(temporary, JSON.stringify(state) + '\n', { flag: 'wx' });
    renameSync(temporary, join(directory, 'state.json'));
  }

  private vaultStates(vaultId?: string) {
    const directory = join(this.config.data_dir, '.coral', 'vault-trash');
    const states: VaultState[] = [];
    let skipped = 0;
    for (const id of existsSync(directory) ? readdirSync(directory) : []) {
      if (!validId(id) || (vaultId && id !== vaultId)) continue;
      try {
        const state = this.vaultState(id);
        if (state) states.push(state);
      } catch { skipped++; }
    }
    return { states, skipped };
  }

  private vaultVersion(vault: Vault) { return digest(Buffer.from(JSON.stringify(vault))); }

  deleteVault(id: string, version: string) {
    this.refreshVaults();
    const vault = this.vaults.get(id);
    if (!vault) throw new AppError('知识库不存在', 404);
    if (!version || version !== this.vaultVersion(vault)) throw new AppError('知识库信息已变化，请刷新后重试', 409);
    const external = Object.hasOwn(this.config.vaults, id);
    if (!external) {
      this.vault(id);
      const target = realpathSync(vault.root);
      for (const other of this.vaults.values()) {
        if (other.id === id || !existsSync(other.root)) continue;
        const root = realpathSync(other.root);
        if (root === target || root.startsWith(target + sep)) throw new AppError('该知识库包含其他已注册知识库，请先移除其注册');
      }
      if (lstatSync(vault.root).isSymbolicLink()) throw new AppError('不能移动符号链接形式的知识库');
    }
    const state: VaultState = { ...vault, source: external ? 'external' : 'managed', state: 'trash', deleted_at: new Date().toISOString() };
    this.saveVaultState(state);
    try {
      if (!external) renameSync(vault.root, join(this.stateDirectory(id), 'content'));
    } catch (error) {
      unlinkSync(join(this.stateDirectory(id), 'state.json'));
      throw error;
    }
    this.refreshVaults();
  }

  createVault(name: string, description = ''): Vault {
    name = name.trim().toLowerCase(); description = description.trim();
    const id = name;
    if (!validVaultName(name)) throw new AppError('仓库名称须以英文字母开头，仅包含英文字母、数字、连字符或下划线，最多 64 字符');
    if (description.length > 2000) throw new AppError('简介最多 2000 字');
    this.refreshVaults();
    if (this.vaults.has(id) || Object.hasOwn(this.config.vaults, id) || this.vaultState(id)?.state === 'trash' || id === 'default'
      || this.vaultStates().states.some(state => state.state === 'trash' && state.source === 'managed' && state.name.toLowerCase() === name)) throw new AppError('同名知识库或标识已存在或位于回收站，请使用其他名称', 409);
    const directory = join(this.config.data_dir, 'obsdian');
    mkdirSync(directory, { recursive: true });
    const root = join(directory, name);
    try { mkdirSync(root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('同名仓库目录已存在，请使用其他名称', 409);
      throw error;
    }
    mkdirSync(join(root, '.obsidian'));
    const temporary = join(root, '.coral-vault.tmp');
    writeFileSync(temporary, JSON.stringify({ id, description }) + '\n', { flag: 'wx' });
    renameSync(temporary, join(root, '.coral-vault.json'));
    if (this.vaultState(id)) unlinkSync(join(this.stateDirectory(id), 'state.json'));
    return this.vault(id);
  }

  vault(id: string): Vault {
    this.refreshVaults();
    const vault = this.vaults.get(id);
    if (!vault) throw new AppError('知识库不存在', 404);
    try { if (!lstatSync(vault.root).isDirectory() && !lstatSync(vault.root).isSymbolicLink()) throw new Error(); }
    catch { throw new AppError('知识库暂不可用', 404); }
    return vault;
  }

  private filePath(vault: Vault, relativePath: string, mustExist = true): string {
    const parts = safeParts(relativePath);
    const root = realpathSync(vault.root);
    let target = root;
    for (const [index, part] of parts.entries()) {
      target = join(target, part);
      try {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink()) throw new AppError('不允许访问符号链接');
        if (index < parts.length - 1 && !stat.isDirectory()) throw new AppError('无效的文档路径');
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (mustExist) throw new AppError('文档不存在', 404);
      }
    }
    return target;
  }

  private bytes(vault: Vault, relative: string): Buffer {
    if (!/\.(md|markdown)$/i.test(relative)) throw new AppError('仅支持 Markdown 文档', 404);
    const path = this.filePath(vault, relative);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) throw new AppError('文档不存在', 404);
      if (stat.size > MAX_FILE_BYTES) throw new AppError('文档超过 16 MiB 大小限制', 413);
      const chunks: Buffer[] = [];
      let length = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - length));
        const count = readSync(descriptor, buffer, 0, buffer.length, null);
        if (!count) break;
        chunks.push(buffer.subarray(0, count));
        length += count;
        if (length > MAX_FILE_BYTES) throw new AppError('文档超过 16 MiB 大小限制', 413);
      }
      return Buffer.concat(chunks, length);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('无法读取文档', 404);
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }

  download(uri: string) {
    const { vaultId, relative } = parseUri(uri);
    const bytes = this.bytes(this.vault(vaultId), relative);
    return { bytes, metadata: {
      uri: resourceUri(vaultId, relative), vault_id: vaultId,
      filename: basename(relative), mime_type: 'text/markdown',
      size_bytes: bytes.length, version: digest(bytes),
    } };
  }

  document(uri: string): Document {
    const { vaultId, relative } = parseUri(uri);
    return this.documentAt(this.vault(vaultId), relative);
  }

  private documentAt(vault: Vault, relative: string): Document {
    const bytes = this.bytes(vault, relative);
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new AppError('文档不是 UTF-8 编码，请下载原始文件'); }
    let metadata: Record<string, unknown> = {}, body = raw, warning: string | undefined;
    try { ({ metadata, body } = parseMarkdown(raw)); }
    catch { warning = 'YAML 属性格式无效，已显示原文'; }
    return { uri: resourceUri(vault.id, relative), vaultId: vault.id, relative, raw, body, metadata,
      title: titleFor(metadata, basename(relative, extname(relative))),
      size: bytes.length, version: digest(bytes), warning };
  }

  scan(vaultId: string): { documents: Document[]; skipped: number } {
    return this.scanVault(this.vault(vaultId));
  }

  noteLanguages(uri: string) {
    const current = this.document(uri);
    const inventory = isNoteId(current.metadata.coral_note_id) ? this.scan(current.vaultId) : { documents: [current], skipped: 0 };
    if (inventory.skipped) throw new AppError('部分笔记无法读取，不能确认完整的语言版本关联，请修复后重试', 409);
    const family = groupNotes(inventory.documents).byUri.get(current.uri);
    if (!family) throw new AppError('读取期间笔记位置发生变化，请重新打开', 409);
    const selected = family.versions.find(item => item.document.uri === current.uri)!.document;
    if (selected.version !== current.version) throw new AppError('读取期间笔记内容发生变化，请重新打开', 409);
    const signature = this.noteSignature(family);
    return { ...family, current: selected, signature };
  }

  private noteSignature(family: NoteLanguageFamily) {
    return digest(Buffer.from(JSON.stringify([family.primary.uri, ...family.versions.map(({ language, document }) =>
      [language, document.uri, document.version]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])));
  }

  private withLanguages(doc: Document, family: NoteLanguageFamily): Document {
    return { ...doc, noteUri: family.primary.uri, language: documentLanguage(doc), noteVersion: this.noteSignature(family),
      languageVersions: family.versions.map(({ language, document }) => ({ language, uri: document.uri, title: document.title, version: document.version })) };
  }

  private describeDocument(doc: Document): Document {
    try { return this.withLanguages(doc, this.noteLanguages(doc.uri)); }
    catch (error) { return { ...doc, languageInfoIncomplete: true,
      languageInfoError: error instanceof AppError ? error.message : '无法确认完整的语言版本关联' }; }
  }

  notes(vaultId: string): Document[] {
    const grouped = groupNotes(this.scan(vaultId).documents);
    return grouped.notes.map(doc => this.withLanguages(doc, grouped.byUri.get(doc.uri)!));
  }

  createLanguageVersion(uri: string, language: DocumentLanguage, content: string, version: string,
    options: { sourceLanguage?: DocumentLanguage; title?: string } = {}): Document {
    if (!isDocumentLanguage(language) || options.sourceLanguage !== undefined && !isDocumentLanguage(options.sourceLanguage)) throw new AppError('语言必须是 zh 或 en');
    const family = this.noteLanguages(uri), source = family.current;
    if (!version || source.version !== version) throw new AppError('原文已被修改，请重新打开后再添加语言版本', 409);
    if (source.warning || family.issue) throw new AppError(family.issue ?? '原文的 YAML 属性无效，请修复后再添加语言版本', 409);
    const sourceLanguage = family.grouped ? documentLanguage(source) : options.sourceLanguage ?? documentLanguage(source);
    if (family.grouped && options.sourceLanguage !== undefined && options.sourceLanguage !== sourceLanguage) throw new AppError('原文语言与已保存的语言版本不一致', 409);
    if (language === sourceLanguage) throw new AppError('新增语言必须与原文语言不同');
    if (family.grouped && family.versions.some(item => item.language === language)) throw new AppError('该笔记已有此语言版本，请打开后编辑', 409);
    const parsed = parseMarkdown(content);
    const title = (options.title ?? (typeof parsed.metadata.title === 'string' ? parsed.metadata.title : source.title)).trim();
    if (!title) throw new AppError('标题不能为空');
    const id = isNoteId(source.metadata.coral_note_id) ? source.metadata.coral_note_id : randomUUID();
    const sourceBytes = Buffer.from(serialize({ ...source.metadata, coral_note_id: id, coral_language: sourceLanguage, coral_primary: sourceLanguage === 'zh' }, source.body));
    const translatedBytes = Buffer.from(serialize({ ...parsed.metadata, title, created: parsed.metadata.created ?? today(), updated: today(),
      coral_note_id: id, coral_language: language, coral_primary: language === 'zh' }, parsed.body));
    if (sourceBytes.length > MAX_FILE_BYTES || translatedBytes.length > MAX_FILE_BYTES) throw new AppError('文档超过 16 MiB 大小限制', 413);
    const vault = this.vault(source.vaultId);
    const primary = family.primary, extension = extname(primary.relative);
    const name = basename(primary.relative, extension) + '.' + language + '.md';
    if (Buffer.byteLength(name) > 255) throw new AppError('语言版本文件名过长，请先缩短笔记文件名');
    const directory = dirname(primary.relative) === '.' ? '' : dirname(primary.relative).split(sep).join('/');
    const relative = (directory ? directory + '/' : '') + name;
    const target = this.filePath(vault, relative, false);
    if (readdirSync(dirname(target)).some(existing => existing.toLowerCase() === name.toLowerCase())) throw new AppError('同名语言版本文件已存在，未覆盖原文件', 409);
    const operationId = randomUUID(), folder = join(this.backupRoot(vault), operationId);
    mkdirSync(folder);
    writeFileSync(join(folder, 'original.md'), this.bytes(vault, source.relative), { flag: 'wx' });
    const temporary = join(dirname(target), `.coral-${operationId}.tmp`);
    const sourceVersion = digest(sourceBytes), targetVersion = digest(translatedBytes);
    let targetCreated = false;
    try {
      writeFileSync(temporary, translatedBytes, { flag: 'wx' });
      if (digest(this.bytes(vault, source.relative)) !== version) throw new AppError('原文已被修改，请重新打开后再添加语言版本', 409);
      linkSync(temporary, target);
      targetCreated = true;
      this.replaceDocumentBytes(vault, source.relative, sourceBytes, version, join(folder, 'source'));
      if (digest(this.bytes(vault, source.relative)) !== sourceVersion || digest(this.bytes(vault, relative)) !== targetVersion) throw new AppError('添加语言版本期间文件被其他程序修改', 409);
      this.scans.delete(vault.id);
      this.commit(vault, [source.relative, relative], `语言版本：${source.title} (${language})`);
      const translated = this.document(resourceUri(vault.id, relative));
      return this.withLanguages(translated, this.noteLanguages(translated.uri));
    } catch (error) {
      const conflicts: { uri: string; reason: string }[] = [];
      try {
        const current = digest(this.bytes(vault, source.relative));
        if (current === sourceVersion) this.replaceDocumentBytes(vault, source.relative, readFileSync(join(folder, 'original.md')), sourceVersion);
        else if (current !== version) conflicts.push({ uri: source.uri, reason: '原文已被外部修改，未覆盖；操作前备份已保留' });
      } catch { conflicts.push({ uri: source.uri, reason: '原文无法自动恢复，操作前备份已保留' }); }
      if (targetCreated) {
        try {
          if (digest(this.bytes(vault, relative)) !== targetVersion) throw new Error();
          unlinkSync(target);
        } catch { conflicts.push({ uri: resourceUri(vault.id, relative), reason: '新增版本已被外部修改或无法撤回，内容已保留' }); }
      }
      this.scans.delete(vault.id);
      const message = (error as NodeJS.ErrnoException).code === 'EEXIST' ? '同名语言版本文件已存在，未覆盖原文件' : error instanceof AppError ? error.message : '无法添加语言版本';
      throw new AppError(message + (conflicts.length ? '；部分更改未撤回，备份已保留' : '；本次添加已撤回'), error instanceof AppError ? error.status : 409,
        { recovery: { operation_id: operationId, partial: conflicts.length > 0, conflicts, affected_uris: [source.uri, resourceUri(vault.id, relative)] } });
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private scanVault(vault: Vault): { documents: Document[]; skipped: number } {
    const vaultId = vault.id;
    const root = realpathSync(vault.root);
    const cached = this.scans.get(vaultId);
    const previous = cached?.root === root ? cached : undefined;
    const files = new Map<string, { stamp: string; doc?: Document }>();
    const documents: Document[] = [];
    let skipped = 0;
    const walk = (directory: string, prefix = '') => {
      let entries;
      try { entries = readdirSync(directory, { withFileTypes: true }); }
      catch { throw new AppError('无法读取知识库目录', 404); }
      for (const entry of entries.sort((a, b) =>
        Number(b.isFile() && isIndexDocument(b.name)) - Number(a.isFile() && isIndexDocument(a.name)) || compareNames(a.name, b.name))) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const rel = prefix + entry.name;
        if (entry.isDirectory()) walk(join(directory, entry.name), rel + '/');
        else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
          try {
            const stat = lstatSync(join(directory, entry.name), { bigint: true });
            const stamp = [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
            let item = previous?.files.get(rel);
            if (item?.stamp !== stamp) {
              try { item = { stamp, doc: this.documentAt(vault, rel) }; }
              catch { item = { stamp }; }
            }
            files.set(rel, item!);
            if (item?.doc) documents.push(item.doc); else skipped++;
          }
          catch { skipped++; }
        }
      }
    };
    walk(root);
    const unchanged = previous && files.size === previous.files.size && [...files].every(([path, item]) => previous.files.get(path) === item);
    const result = unchanged ? previous.result : { documents, skipped };
    this.scans.set(vaultId, { root, files, result });
    return result;
  }

  listVaults() {
    this.refreshVaults();
    return { vaults: [...this.vaults.values()].map(vault => {
      const entry = { id: vault.id, name: vault.name, description: vault.description, uri: resourceUri(vault.id), version: this.vaultVersion(vault), external: Object.hasOwn(this.config.vaults, vault.id) };
      try {
        const scan = this.scanVault(vault);
        return { ...entry, available: true, document_count: groupNotes(scan.documents).notes.length, skipped_documents: scan.skipped };
      } catch {
        return { ...entry, available: false, document_count: 0, skipped_documents: 0 };
      }
    }) };
  }

  listDocuments(vaultId: string, directory = '', cursor = 0, limit = 50) {
    safeParts(directory, true);
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError('分页参数无效');
    const scan = this.scan(vaultId);
    const grouped = groupNotes(scan.documents);
    const documents = grouped.notes.filter(doc => !directory || doc.relative.startsWith(directory + '/'))
      .map(doc => this.withLanguages(doc, grouped.byUri.get(doc.uri)!));
    return { vault_uri: resourceUri(vaultId), documents: documents.slice(cursor, cursor + limit).map(publicDocument),
      total: documents.length, skipped_documents: scan.skipped, next_cursor: cursor + limit < documents.length ? cursor + limit : null };
  }

  browse(vaultId: string, directory = '') {
    safeParts(directory, true);
    const vault = this.vault(vaultId);
    const root = directory ? this.filePath(vault, directory) : realpathSync(vault.root);
    if (!lstatSync(root).isDirectory()) throw new AppError('目录不存在', 404);
    const scan = this.scanVault(vault);
    const grouped = groupNotes(scan.documents);
    const prefix = directory ? directory + '/' : '';
    const documents = grouped.notes.filter(doc => doc.relative.startsWith(prefix) && !doc.relative.slice(prefix.length).includes('/'))
      .map(doc => this.withLanguages(doc, grouped.byUri.get(doc.uri)!));
    const directories = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !entry.isSymbolicLink())
      .sort((a, b) => compareNames(a.name, b.name))
      .map(entry => {
        let snapshot: { version: string; file_count: number } | undefined;
        try { snapshot = this.directorySnapshot(join(root, entry.name)); } catch { /* Unreadable folders remain browsable. */ }
        return { name: entry.name, relative: prefix + entry.name, uri: resourceUri(vaultId, prefix + entry.name), version: snapshot?.version,
          file_count: snapshot?.file_count,
          document_count: grouped.notes.filter(doc => doc.relative.startsWith(prefix + entry.name + '/')).length };
      });
    return { documents, directories, total: grouped.notes.length, skipped: scan.skipped };
  }

  listDirectories(vaultId: string) {
    const vault = this.vault(vaultId);
    const directories = [''];
    const walk = (directory: string, prefix: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareNames(a.name, b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const relative = prefix + entry.name;
        directories.push(relative);
        walk(join(directory, entry.name), relative + '/');
      }
    };
    walk(realpathSync(vault.root), '');
    return directories;
  }

  moveDocument(uri: string, directory: string, version: string, options: RelocationOptions = {}): RelocationResult<Document> {
    const current = this.document(uri);
    const languages = isNoteId(current.metadata.coral_note_id) || options.noteVersion ? this.noteLanguages(uri) : undefined;
    if (options.noteVersion && options.noteVersion !== languages?.signature) throw new AppError('笔记的语言版本已变化，请刷新后重试', 409);
    if (languages?.grouped && languages.versions.length > 1) {
      safeParts(directory, true);
      const destinations = new Map(languages.versions.map(({ document }) => [document.relative,
        (directory ? directory + '/' : '') + basename(document.relative)]));
      return this.relocateLanguageGroup(languages.current, languages.versions.map(item => item.document), destinations, version, options);
    }
    if (!options.updateLinks) return this.moveDocumentOnly(uri, directory, version);
    const entry = this.renameEntry(uri);
    if (entry.kind !== 'document') throw new AppError('仅支持移动笔记');
    safeParts(directory, true);
    const relative = (directory ? directory + '/' : '') + entry.name;
    return this.maintainRelocationLinks(entry, relative, version,
      () => this.moveDocumentOnly(uri, directory, version, false),
      () => {
        const current = this.document(resourceUri(entry.vaultId, relative));
        this.moveDocumentOnly(current.uri, entry.relative.split('/').slice(0, -1).join('/'), current.version, false);
      });
  }

  private moveDocumentOnly(uri: string, directory: string, version: string, recordHistory = true) {
    const doc = this.document(uri);
    if (!version) throw new AppError('缺少文档版本，请重新打开移动页面');
    if (version !== doc.version) throw new AppError('文档已被修改，请刷新后重试', 409);
    safeParts(directory, true);
    const vault = this.vault(doc.vaultId);
    const parent = directory ? this.filePath(vault, directory) : realpathSync(vault.root);
    if (!lstatSync(parent).isDirectory()) throw new AppError('目标不是文件夹');
    const name = basename(doc.relative);
    const relative = (directory ? directory + '/' : '') + name;
    if (relative === doc.relative) return doc;
    if (readdirSync(parent).some(existing => existing.toLowerCase() === name.toLowerCase())) {
      throw new AppError('目标文件夹已有同名文件或文件夹', 409);
    }
    const source = this.filePath(vault, doc.relative);
    const target = this.filePath(vault, relative, false);
    try {
      // Reserve the destination without overwriting it or rewriting document bytes.
      linkSync(source, target);
      try {
        if (digest(this.bytes(vault, doc.relative)) !== version) throw new AppError('文档已被修改，请刷新后重试', 409);
        unlinkSync(source);
      } catch (error) { unlinkSync(target); throw error; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('目标文件夹已有同名文件或文件夹', 409);
      if (error instanceof AppError) throw error;
      throw new AppError('无法移动笔记，请检查目标文件夹权限和文件占用情况');
    }
    this.scans.delete(vault.id);
    if (recordHistory) this.commit(vault, [doc.relative, relative], `移动：${doc.relative} → ${relative}`);
    return this.documentAt(vault, relative);
  }

  renameEntry(uri: string) {
    const { vaultId, relative } = parseUri(uri);
    const vault = this.vault(vaultId);
    const target = this.filePath(vault, relative);
    const directory = lstatSync(target).isDirectory();
    return { uri: resourceUri(vaultId, relative), vaultId, relative, name: basename(relative),
      kind: directory ? 'directory' as const : 'document' as const,
      version: directory ? this.directorySnapshot(target).version : digest(this.bytes(vault, relative)) };
  }

  rename(uri: string, name: string, version: string, options: RelocationOptions = {}): RelocationResult<ReturnType<VaultRegistry['renameEntry']>> {
    const selected = this.renameEntry(uri);
    if (selected.kind === 'document') {
      const current = this.document(uri);
      const languages = isNoteId(current.metadata.coral_note_id) || options.noteVersion ? this.noteLanguages(uri) : undefined;
      if (options.noteVersion && options.noteVersion !== languages?.signature) throw new AppError('笔记的语言版本已变化，请刷新后重试', 409);
      if (languages?.grouped && languages.versions.length > 1) {
        name = this.validRenameName(name, 'document');
        const extension = extname(name), stem = name.slice(0, -extension.length);
        const destinations = new Map(languages.versions.map(({ language, document }) => {
          const filename = document.uri === languages.primary.uri ? name : this.validRenameName(stem + '.' + language + extension, 'document');
          const parent = document.relative.split('/').slice(0, -1).join('/');
          return [document.relative, (parent ? parent + '/' : '') + filename];
        }));
        const renamed = this.relocateLanguageGroup(languages.current, languages.versions.map(item => item.document), destinations, version, options);
        return { ...this.renameEntry(renamed.uri), ...(options.updateLinks ? { operation_id: renamed.operation_id,
          updated_documents: renamed.updated_documents, unresolved_links: renamed.unresolved_links } : {}) };
      }
    }
    if (!options.updateLinks) return this.renameOnly(uri, name, version);
    const entry = selected;
    name = name.trim();
    safeParts(name);
    const parent = entry.relative.split('/').slice(0, -1).join('/');
    const relative = (parent ? parent + '/' : '') + name;
    return this.maintainRelocationLinks(entry, relative, version,
      () => this.renameOnly(uri, name, version, false),
      () => {
        const current = this.renameEntry(resourceUri(entry.vaultId, relative));
        this.renameOnly(current.uri, entry.name, current.version, false);
      });
  }

  private renameOnly(uri: string, name: string, version: string, recordHistory = true) {
    const entry = this.renameEntry(uri);
    if (!version) throw new AppError('缺少版本，请重新打开重命名页面');
    if (version !== entry.version) throw new AppError('内容已修改，请刷新后重试', 409);
    name = this.validRenameName(name, entry.kind);
    const vault = this.vault(entry.vaultId);
    const source = this.filePath(vault, entry.relative);
    if (entry.kind === 'directory') {
      this.refreshVaults();
      for (const other of this.vaults.values()) {
        if (!existsSync(other.root)) continue;
        const root = realpathSync(other.root);
        if (root === source || root.startsWith(source + sep)) throw new AppError('不能重命名知识库根目录或包含其他知识库的目录');
      }
    }
    const parent = entry.relative.split('/').slice(0, -1).join('/');
    const relative = (parent ? parent + '/' : '') + name;
    const target = join(dirname(source), name);
    if (readdirSync(dirname(source)).some(existing => existing !== entry.name && existing.toLowerCase() === name.toLowerCase())) {
      throw new AppError('当前目录已有同名文件或文件夹', 409);
    }
    if (name !== entry.name) {
      try {
        // Hard links give file renames an exclusive destination without rewriting their bytes.
        if (entry.kind === 'document' && !(process.platform === 'win32' && name.toLowerCase() === entry.name.toLowerCase())) {
          linkSync(source, target);
          try {
            if (this.renameEntry(uri).version !== version) throw new AppError('内容已修改，请刷新后重试', 409);
            unlinkSync(source);
          } catch (error) { unlinkSync(target); throw error; }
        } else renameSync(source, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') throw new AppError('当前目录已有同名文件或文件夹', 409);
        throw error;
      }
      this.scans.delete(vault.id);
      if (recordHistory) this.commit(vault, [entry.relative, relative], `重命名：${entry.relative} → ${relative}`);
    }
    return this.renameEntry(resourceUri(vault.id, relative));
  }

  private validRenameName(name: string, kind: 'document' | 'directory') {
    name = name.trim();
    if (!name || Buffer.byteLength(name) > 255 || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new AppError('请输入有效的名称');
    safeParts(name);
    if (kind === 'document' && !/\.(md|markdown)$/i.test(name)) throw new AppError('文件名称必须保留 .md 或 .markdown 扩展名');
    return name;
  }

  private relocateLanguageGroup(current: Document, members: Document[], destinations: ReadonlyMap<string, string>, version: string, options: RelocationOptions): RelocationResult<Document> {
    if (!version || version !== current.version) throw new AppError('文档已被修改，请刷新后重试', 409);
    this.assertLanguageMembers(current, members);
    const vault = this.vault(current.vaultId), occupied = new Set<string>();
    for (const member of members) {
      const relative = destinations.get(member.relative)!;
      safeParts(relative);
      const parent = relative.split('/').slice(0, -1).join('/');
      const directory = parent ? this.filePath(vault, parent) : realpathSync(vault.root);
      if (!lstatSync(directory).isDirectory()) throw new AppError('目标不是文件夹');
      const key = relative.toLowerCase();
      if (occupied.has(key)) throw new AppError('语言版本在目标位置存在同名文件', 409);
      occupied.add(key);
      if (readdirSync(directory).some(name => name.toLowerCase() === basename(relative).toLowerCase()
        && (parent !== member.relative.split('/').slice(0, -1).join('/') || name !== basename(member.relative)))) {
        throw new AppError('目标位置已有同名文件或文件夹', 409);
      }
      if (this.document(member.uri).version !== member.version) throw new AppError('语言版本已被修改，请刷新后重试', 409);
    }
    const locations = new Map(members.map(member => [member.relative, member.relative]));
    const relocate = (from: string, to: string, expected: string) => {
      if (from === to) return;
      const parent = to.split('/').slice(0, -1).join('/');
      if (from.split('/').slice(0, -1).join('/') === parent) this.renameOnly(resourceUri(vault.id, from), basename(to), expected, false);
      else this.moveDocumentOnly(resourceUri(vault.id, from), parent, expected, false);
    };
    const result = this.maintainRelocationLinks(this.renameEntry(current.uri), destinations.get(current.relative)!, version, () => {
      this.assertLanguageMembers(current, members);
      for (const member of members) {
        const relative = destinations.get(member.relative)!;
        relocate(member.relative, relative, member.version);
        locations.set(member.relative, relative);
      }
      return this.document(resourceUri(vault.id, destinations.get(current.relative)!));
    }, () => {
      let failed = false;
      for (const member of [...members].reverse()) {
        const location = locations.get(member.relative)!;
        if (location === member.relative) continue;
        try {
          relocate(location, member.relative, member.version);
          locations.set(member.relative, member.relative);
        } catch { failed = true; }
      }
      if (failed) throw new AppError('部分语言版本无法移回原位置', 409);
    }, { mapping: destinations, locations, updateLinks: options.updateLinks === true });
    if (options.updateLinks) return result;
    return this.document(result.uri);
  }

  private assertLanguageMembers(current: Document, members: Document[]) {
    const latest = this.noteLanguages(current.uri);
    if (!latest.grouped || latest.versions.length !== members.length || latest.versions.some(({ document }) =>
      !members.some(member => member.uri === document.uri && member.version === document.version))) {
      throw new AppError('笔记的语言版本已变化，请刷新后重试', 409);
    }
  }

  relocationReport(vaultId: string, operationId: string): RelocationReport {
    if (!z.string().uuid().safeParse(operationId).success) throw new AppError('整理操作编号无效');
    const vault = this.vault(vaultId);
    try {
      const folder = join(this.backupRoot(vault, false), operationId), path = join(folder, 'state.json');
      if (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory() || lstatSync(path).isSymbolicLink()
        || !lstatSync(path).isFile() || lstatSync(path).size > MAX_FILE_BYTES) throw new Error();
      const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const parsed = z.object({ status: z.literal('complete'), report: relocationReportSchema }).parse(state);
      if (parsed.report.operation_id !== operationId) throw new Error();
      return parsed.report;
    } catch { throw new AppError('整理结果不存在或尚未完成', 404); }
  }

  private relocationInventory(vault: Vault) {
    const entries = new Map<string, { directory: boolean; symbolic: boolean; stamp: string }>();
    const walk = (path: string, prefix: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if ((!prefix && ['.git', '.obsidian', '.coral-backups', '.trash'].includes(entry.name)) || /^\.coral-.*\.tmp$/.test(entry.name)) continue;
        const relative = prefix + entry.name;
        const stat = lstatSync(join(path, entry.name), { bigint: true });
        entries.set(relative, { directory: stat.isDirectory(), symbolic: stat.isSymbolicLink(), stamp: [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':') });
        if (stat.isDirectory()) walk(join(path, entry.name), relative + '/');
      }
    };
    walk(realpathSync(vault.root), '');
    return entries;
  }

  private maintainRelocationLinks<T extends { uri: string; version: string }>(entry: ReturnType<VaultRegistry['renameEntry']>,
    relative: string, version: string, relocate: () => T, undo: () => void,
    group?: { mapping: ReadonlyMap<string, string>; locations: Map<string, string>; updateLinks: boolean }): T & RelocationReport {
    if (!version || version !== entry.version) throw new AppError('内容已修改，请刷新后重试', 409);
    const vault = this.vault(entry.vaultId);
    const scan = this.scan(vault.id);
    if ((!group || group.updateLinks) && (scan.skipped || scan.documents.some(doc => doc.warning))) throw new AppError('部分笔记无法完整读取，尚未整理；请先修复后重试', 409);
    const inventory = this.relocationInventory(vault);
    const mapping = new Map([...inventory.keys()].map(path => [path,
      group ? group.mapping.get(path) ?? path : path === entry.relative ? relative : entry.kind === 'directory' && path.startsWith(entry.relative + '/') ? relative + path.slice(entry.relative.length) : path]));
    const linkMapping = new Map([...mapping].filter(([path]) => {
      const entry = inventory.get(path)!;
      return !entry.symbolic && path.split('/').every(part => !part.startsWith('.'));
    }));
    const filePaths = new Set([...linkMapping.keys()].filter(path => !inventory.get(path)!.directory));
    const rewrites = !group || group.updateLinks ? rewriteRelocationLinks(scan.documents, linkMapping, filePaths) : { documents: [], unresolved_links: [] };
    const operationId = randomUUID(), folder = join(this.backupRoot(vault), operationId);
    mkdirSync(join(folder, 'originals'), { recursive: true });
    const documentsByPath = new Map(scan.documents.map(doc => [doc.relative, doc]));
    const files = rewrites.documents.map((change, index) => ({ ...change, bytes: Buffer.from(change.raw),
      backup: join(folder, 'originals', String(index) + '.md'), applied: false, attempted: false }));
    const filesByUri = new Map(files.map(file => [file.original.uri, file]));
    for (const file of files) {
      if (file.bytes.length > MAX_FILE_BYTES) throw new AppError('更新链接后文档超过 16 MiB 大小限制', 413);
      writeFileSync(file.backup, this.bytes(vault, file.original.relative), { flag: 'wx' });
    }
    const report: RelocationReport = { operation_id: operationId, updated_documents: [], unresolved_links: rewrites.unresolved_links };
    const state = { status: 'prepared', original: entry.relative, destination: relative, report,
      ...(group ? { moves: [...group.mapping].map(([original, destination]) => ({ original, destination })) } : {}),
      files: files.map(file => ({ original: file.original.relative, destination: file.relative, before: file.original.version, after: digest(file.bytes) })) };
    const saveState = () => {
      const temporary = join(folder, randomUUID() + '.tmp');
      writeFileSync(temporary, JSON.stringify(state) + '\n', { flag: 'wx' });
      renameSync(temporary, join(folder, 'state.json'));
    };
    let relocated = false;
    const actualPath = (path: string) => group?.locations.get(path) ?? (relocated ? mapping.get(path)! : path);
    const assertState = () => {
      const current = this.relocationInventory(vault);
      if (current.size !== inventory.size) throw new AppError('整理期间知识库目录发生变化，请刷新后重试', 409);
      for (const [path, before] of inventory) {
        const expectedPath = actualPath(path);
        const actual = current.get(expectedPath);
        if (!actual || actual.directory !== before.directory || actual.symbolic !== before.symbolic
          || (!before.directory && !documentsByPath.has(path) && actual.stamp !== before.stamp)) {
          throw new AppError('整理期间知识库文件发生变化，请刷新后重试', 409);
        }
      }
      for (const doc of scan.documents) {
        const file = filesByUri.get(doc.uri);
        const expected = file?.applied ? digest(file.bytes) : doc.version;
        const path = actualPath(doc.relative);
        if (digest(this.bytes(vault, path)) !== expected) throw new AppError('整理期间文档已被其他程序修改，请刷新后重试', 409);
      }
    };
    saveState();
    try {
      assertState();
      const result = relocate();
      relocated = true;
      state.status = 'applying'; saveState();
      assertState();
      for (const [index, file] of files.entries()) {
        file.attempted = true;
        try {
          this.replaceDocumentBytes(vault, file.relative, file.bytes, file.original.version, join(folder, 'inodes', String(index)));
          file.applied = true;
        } catch (error) {
          try { file.applied = digest(this.bytes(vault, file.relative)) === digest(file.bytes); } catch { /* Preserve the original failure. */ }
          throw error;
        }
        saveState();
      }
      assertState();
      report.updated_documents = files.map(file => ({ uri: resourceUri(vault.id, file.relative), version: digest(file.bytes) }));
      state.status = 'complete'; saveState();
      this.scans.delete(vault.id);
      this.commit(vault, [...new Set([entry.relative, relative, ...(group ? [...group.mapping].flat() : []), ...files.map(file => file.relative)])], `整理：${entry.relative} → ${relative}`);
      return { ...result, ...('raw' in result ? this.document(result.uri) : this.renameEntry(result.uri)), ...report };
    } catch (error) {
      if (!group && !relocated && relative !== entry.relative && !existsSync(join(vault.root, entry.relative)) && existsSync(join(vault.root, relative))) relocated = true;
      const conflicts: { uri: string; reason: string }[] = [];
      for (const file of [...files].reverse()) {
        if (!file.applied) continue;
        const uri = resourceUri(vault.id, file.relative);
        try {
          this.replaceDocumentBytes(vault, file.relative, readFileSync(file.backup), digest(file.bytes));
          file.applied = false;
        } catch { conflicts.push({ uri, reason: '内容已被外部修改或无法恢复，原文件备份已保留' }); }
      }
      for (const file of files) {
        if (!file.attempted || file.applied) continue;
        try { if (digest(this.bytes(vault, file.relative)) === file.original.version) continue; } catch { /* Report a missing or replaced file too. */ }
        conflicts.push({ uri: resourceUri(vault.id, file.relative), reason: '写入时文件被外部替换或无法恢复，原文件备份已保留' });
      }
      if (group ? [...group.locations].some(([original, location]) => original !== location) : relocated && relative !== entry.relative) {
        try { assertState(); undo(); relocated = false; }
        catch {
          const paths = group ? [...group.locations].filter(([original, location]) => original !== location).map(([, location]) => location) : [relative];
          for (const path of paths) conflicts.push({ uri: resourceUri(vault.id, path), reason: '原路径已占用或整理后的文件发生变化，未自动移回' });
        }
      }
      state.status = conflicts.length ? 'partial' : 'rolled_back';
      try { saveState(); } catch { /* The prepared originals and earlier state remain available for recovery. */ }
      this.scans.delete(vault.id);
      const message = error instanceof AppError ? error.message : '无法完成整理';
      throw new AppError(message + (conflicts.length ? '；部分更改未撤回，整理记录及可用备份已保留' : '；本次整理已撤回'), error instanceof AppError ? error.status : 500,
        { recovery: { operation_id: operationId, partial: conflicts.length > 0, conflicts,
          affected_uris: [...new Set([resourceUri(vault.id, actualPath(entry.relative)), ...(group ? [...group.locations.values()].map(path => resourceUri(vault.id, path)) : []), ...conflicts.map(conflict => conflict.uri),
            ...files.filter(file => file.applied).map(file => resourceUri(vault.id, file.relative))])] } });
    }
  }

  readDocument(uri: string, options: { offset?: number; maxChars?: number; heading?: string; version?: string } = {}) {
    const { offset = 0, maxChars = 16000, heading, version } = options;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 64000) throw new AppError('读取范围无效');
    const doc = this.document(uri);
    if (version && doc.version !== version) throw new AppError('文档已修改，请从头重新读取', 409);
    const outline = headings(doc.raw);
    let sectionStart = 0, sectionEnd = doc.raw.length;
    if (heading !== undefined) {
      const matches = outline.filter(h => h.title === heading);
      if (matches.length !== 1) throw new AppError('章节标题不存在或不唯一，请使用 offset 读取');
      const selected = matches[0];
      sectionStart = selected.offset;
      sectionEnd = outline.find(h => h.offset > selected.offset && h.level <= selected.level)?.offset ?? sectionEnd;
    }
    const start = sectionStart + offset;
    if (start > sectionEnd) throw new AppError('offset 超出文档范围');
    let end = Math.min(start + maxChars, sectionEnd);
    if (end < sectionEnd && end > start && /[\uD800-\uDBFF]/.test(doc.raw[end - 1]) && /[\uDC00-\uDFFF]/.test(doc.raw[end])) {
      end = end - start === 1 ? end + 1 : end - 1;
    }
    return { ...publicDocument(this.describeDocument(doc)), content: doc.raw.slice(start, end), offset,
      next_offset: end < sectionEnd ? end - sectionStart : null, total_chars: sectionEnd - sectionStart,
      truncated: end < sectionEnd, start_line: doc.raw.slice(0, start).split('\n').length,
      headings: offset === 0 && !heading ? outline.slice(0, 100) : [], headings_truncated: outline.length > 100 };
  }

  search(query: string, vaultId?: string, limit = 20, cursor = 0) {
    this.refreshVaults();
    query = query.trim();
    if (!query || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(cursor) || cursor < 0) throw new AppError('搜索参数无效');
    const vaults = vaultId ? [this.vault(vaultId)] : [...this.vaults.values()];
    const documents = new Map<string, Document>();
    const families = new Map<string, NoteLanguageFamily>();
    const unavailable: string[] = [];
    let skipped = 0;
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare('INSERT INTO search VALUES (?, ?, ?)');
      const remove = this.db.prepare('DELETE FROM search WHERE uri = ?');
      for (const vault of vaults) {
        let scan;
        try { scan = this.scanVault(vault); }
        catch (error) { if (vaultId) throw error; unavailable.push(resourceUri(vault.id)); continue; }
        skipped += scan.skipped;
        const grouped = groupNotes(scan.documents);
        for (const [uri, family] of grouped.byUri) families.set(uri, family);
        for (const doc of grouped.notes) {
          documents.set(doc.uri, doc);
          if (this.indexed.get(doc.uri) !== doc.version) {
            if (this.indexed.has(doc.uri)) remove.run(doc.uri);
            const searchableTitle = doc.title + '\n' + doc.relative;
            insert.run(doc.uri, this.fts ? cjkSplit(searchableTitle) : searchableTitle, this.fts ? cjkSplit(doc.body) : doc.body);
          }
        }
      }
      for (const uri of this.indexed.keys()) if (!documents.has(uri)) remove.run(uri);
      this.db.exec('COMMIT');
      this.indexed = new Map([...documents.values()].map(doc => [doc.uri, doc.version]));
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const terms = splitSearchQuery(query);
    const candidates = this.fts
      ? this.db.prepare('SELECT uri FROM search WHERE search MATCH ? ORDER BY bm25(search), uri').all(ftsQuery(query)).map(row => documents.get(row.uri as string)!)
      : [...documents.values()].filter(doc => terms.every(term => matchesSearchText(doc.title + '\n' + doc.relative, [term]) || matchesSearchText(doc.body, [term]))).sort((a, b) => a.uri.localeCompare(b.uri));
    candidates.sort((a, b) => rankSearchDocument(a, terms) - rankSearchDocument(b, terms));
    const results = candidates.slice(cursor, cursor + limit).map(doc => ({ ...publicDocument(this.withLanguages(doc, families.get(doc.uri)!)), ...searchSnippet(doc.raw, doc.body, terms) }));
    return { results, total: candidates.length, next_cursor: cursor + limit < candidates.length ? cursor + limit : null,
      unavailable_vaults: unavailable, skipped_documents: skipped };
  }

  createDirectory(vaultId: string, directory: string, name: string) {
    name = name.trim();
    if (!name || Buffer.byteLength(name) > 255 || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(name) || name.endsWith('.')) throw new AppError('请输入有效的文件夹名称');
    safeParts(name);
    safeParts(directory, true);
    const vault = this.vault(vaultId);
    const parent = directory ? this.filePath(vault, directory) : realpathSync(vault.root);
    if (!lstatSync(parent).isDirectory()) throw new AppError('上级目录不存在', 404);
    try { mkdirSync(join(parent, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('当前目录已有同名文件或文件夹', 409);
      throw error;
    }
  }

  create(vaultId: string, title: string, body: string, metadata: Record<string, unknown> = {}, filename?: string, folder = ''): Document {
    title = title.trim();
    if (!title) throw new AppError('标题不能为空');
    safeParts(folder, true);
    let stem = (filename ?? title).replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '-').replace(/^\.+/, '').trim().slice(0, 160) || 'untitled';
    const base = stem;
    const vault = this.vault(vaultId);
    const directory = folder ? this.filePath(vault, folder, false) : vault.root;
    mkdirSync(directory, { recursive: true });
    let sequence = 2;
    const names = new Set(readdirSync(directory).map(name => name.toLowerCase()));
    while (names.has(stem.toLowerCase() + '.md') || existsSync(join(directory, stem + '.md'))) stem = `${base}-${sequence++}`;
    const rel = (folder ? folder + '/' : '') + stem + '.md';
    const target = this.filePath(vault, rel, false);
    const raw = serialize({ ...metadata, title, created: metadata.created ?? today(), updated: today() }, body);
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new AppError('文档超过 16 MiB 大小限制', 413);
    writeFileSync(target, raw, { flag: 'wx' });
    this.commit(vault, [rel], `页面：新建 ${title}`);
    return this.documentAt(vault, rel);
  }

  update(uri: string, raw: string, version?: string): Document {
    const old = this.document(uri);
    if (version && version !== old.version) throw new AppError('文档已被修改，请重新打开后再保存', 409);
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new AppError('文档超过 16 MiB 大小限制', 413);
    const parsed = parseMarkdown(raw);
    const metadata: Record<string, unknown> = { ...(hasFrontmatter(raw) ? parsed.metadata : old.metadata), updated: today() };
    if (isNoteId(old.metadata.coral_note_id) && isDocumentLanguage(old.metadata.coral_language) && typeof old.metadata.coral_primary === 'boolean') {
      for (const key of languageKeys) {
        if (Object.hasOwn(parsed.metadata, key) && parsed.metadata[key] !== old.metadata[key]) throw new AppError('语言版本关联字段不能在正文编辑中更改');
        metadata[key] = old.metadata[key];
      }
    }
    this.replaceDocumentBytes(this.vault(old.vaultId), old.relative, Buffer.from(serialize(metadata, parsed.body)), old.version);
    this.commit(this.vault(old.vaultId), [old.relative], `页面：编辑 ${old.title}`);
    const updated = this.document(uri);
    return this.describeDocument(updated);
  }

  private backupRoot(vault: Vault, create = true) {
    const root = join(realpathSync(vault.root), '.coral-backups');
    if (create) {
      try { mkdirSync(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new AppError('文档备份目录不可用');
    return root;
  }

  private replaceDocumentBytes(vault: Vault, relative: string, bytes: Buffer, version: string, preparedBackup?: string) {
    if (bytes.length > MAX_FILE_BYTES) throw new AppError('文档超过 16 MiB 大小限制', 413);
    const target = this.filePath(vault, relative);
    if (digest(this.bytes(vault, relative)) !== version) throw new AppError('文档已被修改，请重新打开后再保存', 409);
    const temporary = join(dirname(target), `.coral-${randomUUID()}.tmp`);
    const backupDirectory = preparedBackup ?? join(this.backupRoot(vault), randomUUID());
    const backup = join(backupDirectory, basename(target));
    try {
      writeFileSync(temporary, bytes, { flag: 'wx' });
      if (digest(this.bytes(vault, relative)) !== version) throw new AppError('文档已被修改，请重新打开后再保存', 409);
      mkdirSync(backupDirectory, { recursive: true });
      // Move the original inode aside before exclusive creation. Keep it for late writes through external file descriptors.
      renameSync(target, backup);
      try {
        if (!lstatSync(backup).isFile() || digest(readFileSync(backup)) !== version) throw new AppError('文档已被修改，原文件已保留，请重新打开', 409);
        linkSync(temporary, target);
      } catch (error) {
        try { linkSync(backup, target); } catch { /* A concurrent writer owns the destination; preserve both copies. */ }
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('文档已被其他程序写入，原文件备份已保留，请重新打开', 409);
        throw error;
      }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }

  delete(uri: string, version?: string, options: { noteVersion?: string } = {}) {
    const doc = this.document(uri);
    if (version && version !== doc.version) throw new AppError('文档已修改，请刷新后重试', 409);
    const languages = isNoteId(doc.metadata.coral_note_id) || options.noteVersion ? this.noteLanguages(uri) : undefined;
    if (options.noteVersion && options.noteVersion !== languages?.signature) throw new AppError('笔记的语言版本已变化，请刷新后重试', 409);
    if (languages?.grouped && languages.versions.length > 1) {
      if (version && version !== languages.current.version) throw new AppError('文档已修改，请刷新后重试', 409);
      const members = languages.versions.map(item => item.document);
      this.moveLanguageGroupToTrash(languages.primary, members);
      this.commit(this.vault(doc.vaultId), members.map(member => member.relative), `页面：删除 ${languages.primary.title}（全部语言版本）`);
      return;
    }
    this.moveToTrash(doc.vaultId, doc.relative);
    this.commit(this.vault(doc.vaultId), [doc.relative], `页面：删除 ${doc.title}`);
  }

  private directorySnapshot(path: string) {
    const hash = createHash('sha256');
    let file_count = 0;
    const walk = (target: string, relativePath: string) => {
      const stat = lstatSync(target, { bigint: true });
      hash.update(JSON.stringify([relativePath, String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), String(stat.ino)]));
      if (stat.isDirectory()) {
        for (const name of readdirSync(target).sort()) walk(join(target, name), relativePath + '/' + name);
      } else file_count++;
    };
    walk(path, '');
    return { version: hash.digest('hex'), file_count };
  }

  deleteDirectory(uri: string, version: string) {
    const { vaultId, relative: path } = parseUri(uri);
    const target = this.filePath(this.vault(vaultId), path);
    if (!lstatSync(target).isDirectory()) throw new AppError('目录不存在', 404);
    if (!version) throw new AppError('缺少目录版本，请刷新后重试');
    this.refreshVaults();
    for (const vault of this.vaults.values()) {
      if (!existsSync(vault.root)) continue;
      const root = realpathSync(vault.root);
      if (root === target || root.startsWith(target + sep)) throw new AppError('不能删除知识库根目录或包含其他知识库的目录');
    }
    if (this.directorySnapshot(target).version !== version) throw new AppError('文件夹内容已修改，请刷新后重试', 409);
    this.moveToTrash(vaultId, path);
    this.commit(this.vault(vaultId), [path], `目录：删除 ${path}`);
    return { vaultId, directory: path.split('/').slice(0, -1).join('/') };
  }

  private moveToTrash(vaultId: string, path: string) {
    const vault = this.vault(vaultId);
    const target = this.filePath(vault, path);
    const batch = this.createTrashBatch(vault);
    writeFileSync(join(batch, '.coral-trash.json'), JSON.stringify({ path, kind: lstatSync(target).isDirectory() ? 'directory' : 'file', deleted_at: new Date().toISOString() }) + '\n', { flag: 'wx' });
    const destination = join(batch, path);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(target, destination);
  }

  private createTrashBatch(vault: Vault) {
    const trash = join(realpathSync(vault.root), '.trash');
    try { mkdirSync(trash); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = lstatSync(trash);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AppError('知识库回收站不可用');
    const batch = join(trash, randomUUID());
    mkdirSync(batch);
    return batch;
  }

  private transferLanguageFile(source: string, destination: string, version: string) {
    const original = lstatSync(source);
    if (!original.isFile() || original.isSymbolicLink() || original.size > MAX_FILE_BYTES || digest(readFileSync(source)) !== version) {
      throw new AppError('语言版本已被修改，请刷新后重试', 409);
    }
    linkSync(source, destination);
    const reserved = lstatSync(destination);
    try {
      const current = lstatSync(source);
      if (current.dev !== reserved.dev || current.ino !== reserved.ino || digest(readFileSync(source)) !== version) {
        throw new AppError('语言版本已被其他程序修改，请刷新后重试', 409);
      }
      unlinkSync(source);
    } catch (error) {
      // Remove only the exclusive link created here, preserving external replacements or edits.
      try {
        const current = lstatSync(destination);
        if (current.dev === reserved.dev && current.ino === reserved.ino && digest(readFileSync(destination)) === version) unlinkSync(destination);
      } catch { /* An external change remains available at its actual path. */ }
      throw error;
    }
  }

  private saveLanguageTrashRecord(batch: string, primary: string, members: string[], deletedAt: string) {
    const temporary = join(batch, randomUUID() + '.tmp');
    writeFileSync(temporary, JSON.stringify({ path: members.includes(primary) ? primary : members[0], kind: 'file', members, deleted_at: deletedAt }) + '\n', { flag: 'wx' });
    renameSync(temporary, join(batch, '.coral-trash.json'));
  }

  private removeEmptyTrashBatch(batch: string, paths: string[]) {
    const metadata = join(batch, '.coral-trash.json');
    if (existsSync(metadata)) unlinkSync(metadata);
    for (const path of paths) {
      let empty = dirname(join(batch, path));
      while (empty === batch || empty.startsWith(batch + sep)) {
        try { rmdirSync(empty); } catch { break; }
        empty = dirname(empty);
      }
    }
  }

  private moveLanguageGroupToTrash(primary: Document, members: Document[]) {
    const vault = this.vault(primary.vaultId);
    this.assertLanguageMembers(primary, members);
    for (const member of members) {
      if (this.document(member.uri).version !== member.version) throw new AppError('语言版本已被修改，请刷新后重试', 409);
    }
    const batch = this.createTrashBatch(vault), deletedAt = new Date().toISOString(), moved: Document[] = [];
    this.saveLanguageTrashRecord(batch, primary.relative, members.map(member => member.relative), deletedAt);
    try {
      this.assertLanguageMembers(primary, members);
      for (const member of members) {
        const target = join(batch, member.relative);
        mkdirSync(dirname(target), { recursive: true });
        this.transferLanguageFile(this.filePath(vault, member.relative), target, member.version);
        moved.push(member);
      }
      for (const member of members) {
        if (digest(this.bytes({ ...vault, root: batch }, member.relative)) !== member.version) throw new AppError('删除期间语言版本被其他程序修改', 409);
      }
      this.scans.delete(vault.id);
    } catch (error) {
      const conflicts: { uri: string; reason: string }[] = [];
      for (const member of moved.reverse()) {
        try { this.transferLanguageFile(join(batch, member.relative), this.filePath(vault, member.relative, false), member.version); }
        catch { conflicts.push({ uri: member.uri, reason: '原位置已占用或回收内容发生变化，未自动恢复' }); }
      }
      const remaining = members.filter(member => existsSync(join(batch, member.relative))).map(member => member.relative);
      for (const path of remaining) if (!conflicts.some(item => item.uri === resourceUri(vault.id, path))) {
        conflicts.push({ uri: resourceUri(vault.id, path), reason: '文件在删除期间发生变化，回收内容已保留' });
      }
      try {
        if (remaining.length) this.saveLanguageTrashRecord(batch, primary.relative, remaining, deletedAt);
        else this.removeEmptyTrashBatch(batch, members.map(member => member.relative));
      } catch { conflicts.push({ uri: primary.uri, reason: '无法更新回收记录，请按操作编号检查保留的文件' }); }
      this.scans.delete(vault.id);
      throw new AppError((error instanceof AppError ? error.message : '无法删除全部语言版本') + (conflicts.length ? '；部分文件保留在回收站' : '；本次删除已撤回'), error instanceof AppError ? error.status : 500,
        { recovery: { operation_id: basename(batch), partial: conflicts.length > 0, conflicts, affected_uris: members.map(member => member.uri) } });
    }
  }

  private trashBatch(vaultId: string, id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new AppError('回收记录无效');
    const vault = this.vault(vaultId);
    const trash = join(realpathSync(vault.root), '.trash');
    const batch = join(trash, id);
    for (const path of [trash, batch]) {
      let stat;
      try { stat = lstatSync(path); } catch { throw new AppError('回收记录不存在', 404); }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AppError('回收记录无效');
    }
    const metadata = join(batch, '.coral-trash.json');
    if (lstatSync(metadata).isSymbolicLink()) throw new AppError('回收记录无效');
    const record = trashRecordSchema.parse(JSON.parse(readFileSync(metadata, 'utf8')));
    const paths = record.members ?? [record.path];
    if (record.members && (record.kind !== 'file' || !record.members.includes(record.path)
      || new Set(paths.map(path => path.toLowerCase())).size !== paths.length)) throw new AppError('语言版本回收记录无效');
    const members = paths.map(path => {
      let target = batch;
      for (const part of safeParts(path)) {
        target = join(target, part);
        if (lstatSync(target).isSymbolicLink()) throw new AppError('回收记录不允许符号链接路径');
      }
      const stat = lstatSync(target);
      if (record.kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new AppError('回收记录类型无效');
      return { path, target };
    });
    return { batch, target: members.find(member => member.path === record.path)!.target, members, vault, record, version: this.directorySnapshot(batch).version };
  }

  listTrash(vaultId?: string) {
    this.refreshVaults();
    if (vaultId && !this.vaults.has(vaultId) && !existsSync(join(this.stateDirectory(vaultId), 'state.json'))) throw new AppError('知识库不存在', 404);
    const items: TrashItem[] = [];
    let skipped = 0;
    for (const vault of [...this.vaults.values()]) {
      if (vaultId && vault.id !== vaultId) continue;
      const trash = join(vault.root, '.trash');
      try {
        if (!existsSync(trash)) continue;
        if (lstatSync(trash).isSymbolicLink() || !lstatSync(trash).isDirectory()) { skipped++; continue; }
        for (const entry of readdirSync(trash, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) { skipped++; continue; }
          try {
            const result = this.trashBatch(vault.id, entry.name);
            items.push({ id: entry.name, vault_id: vault.id, vault_name: vault.name, path: result.record.path,
              uri: resourceUri(vault.id, result.record.path), kind: result.record.kind, deleted_at: result.record.deleted_at, version: result.version });
          } catch { skipped++; }
        }
      } catch { skipped++; }
    }
    const listing = this.vaultStates(vaultId);
    skipped += listing.skipped;
    const vaults = listing.states.filter(state => state.state === 'trash').map(state => ({
      id: state.id, name: state.name, uri: resourceUri(state.id), external: state.source === 'external',
      deleted_at: state.deleted_at, version: digest(Buffer.from(JSON.stringify(state))),
    }));
    items.sort((a, b) => b.deleted_at.localeCompare(a.deleted_at) || a.vault_id.localeCompare(b.vault_id) || a.id.localeCompare(b.id));
    vaults.sort((a, b) => b.deleted_at.localeCompare(a.deleted_at) || a.id.localeCompare(b.id));
    return { items, vaults, skipped, version: digest(Buffer.from(JSON.stringify({ items, vaults }))) };
  }

  restoreTrash(vaultId: string, id: string, version: string) {
    const entry = this.trashBatch(vaultId, id);
    if (!version || version !== entry.version) throw new AppError('回收内容已变化，请刷新后重试', 409);
    if (entry.record.members) {
      this.restoreLanguageGroup(entry);
      return;
    }
    const target = this.filePath(entry.vault, entry.record.path, false);
    if (existsSync(target)) throw new AppError('原位置已有同名内容，请先重命名或移走后再恢复', 409);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(entry.target, target);
    const metadata = join(entry.batch, '.coral-trash.json');
    if (existsSync(metadata)) unlinkSync(metadata);
    let empty = dirname(entry.target);
    while (empty === entry.batch || empty.startsWith(entry.batch + sep)) {
      try { rmdirSync(empty); } catch { break; }
      empty = dirname(empty);
    }
    this.commit(entry.vault, [entry.record.path], `恢复：${entry.record.path}`);
  }

  private restoreLanguageGroup(entry: ReturnType<VaultRegistry['trashBatch']>) {
    const members = entry.members.map(member => ({ ...member, destination: this.filePath(entry.vault, member.path, false),
      version: digest(this.bytes({ ...entry.vault, root: entry.batch }, member.path)) }));
    for (const member of members) {
      const parent = dirname(member.destination);
      if (existsSync(member.destination) || existsSync(parent) && readdirSync(parent).some(name => name.toLowerCase() === basename(member.path).toLowerCase())) {
        throw new AppError('原位置已有同名内容，全部语言版本均未恢复', 409);
      }
    }
    const restored: typeof members = [];
    try {
      for (const member of members) {
        mkdirSync(dirname(member.destination), { recursive: true });
        this.transferLanguageFile(member.target, member.destination, member.version);
        restored.push(member);
      }
      for (const member of members) {
        if (digest(this.bytes(entry.vault, member.path)) !== member.version) throw new AppError('恢复期间语言版本被其他程序修改', 409);
      }
    } catch (error) {
      const conflicts: { uri: string; reason: string }[] = [];
      for (const member of restored.reverse()) {
        try { this.transferLanguageFile(this.filePath(entry.vault, member.path), member.target, member.version); }
        catch { conflicts.push({ uri: resourceUri(entry.vault.id, member.path), reason: '恢复后的文件已变化或回收位置被占用，未自动撤回' }); }
      }
      const remaining = members.filter(member => existsSync(member.target)).map(member => member.path);
      for (const member of members) if (existsSync(member.destination) && !conflicts.some(item => item.uri === resourceUri(entry.vault.id, member.path))) {
        conflicts.push({ uri: resourceUri(entry.vault.id, member.path), reason: '恢复期间目标被其他程序写入，文件已保留' });
      }
      try {
        if (remaining.length) this.saveLanguageTrashRecord(entry.batch, entry.record.path, remaining, entry.record.deleted_at);
        else this.removeEmptyTrashBatch(entry.batch, members.map(member => member.path));
      } catch { conflicts.push({ uri: resourceUri(entry.vault.id, entry.record.path), reason: '无法更新回收记录，请按操作编号检查实际恢复位置' }); }
      this.scans.delete(entry.vault.id);
      throw new AppError((error instanceof AppError ? error.message : '无法恢复全部语言版本') + (conflicts.length ? '；部分文件未撤回，请检查恢复结果' : '；本次恢复已撤回'), error instanceof AppError ? error.status : 500,
        { recovery: { operation_id: basename(entry.batch), partial: conflicts.length > 0, conflicts, affected_uris: members.map(member => resourceUri(entry.vault.id, member.path)) } });
    }
    this.removeEmptyTrashBatch(entry.batch, members.map(member => member.path));
    this.scans.delete(entry.vault.id);
    this.commit(entry.vault, members.map(member => member.path), `恢复：${entry.record.path}（全部语言版本）`);
  }

  purgeTrash(vaultId: string, id: string, version: string) {
    const entry = this.trashBatch(vaultId, id);
    if (!version || version !== entry.version) throw new AppError('回收内容已变化，请刷新后重试', 409);
    rmSync(entry.batch, { recursive: true });
  }

  private trashedVault(id: string, version: string) {
    const state = this.vaultState(id);
    if (!state || state.state !== 'trash') throw new AppError('知识库回收记录不存在', 404);
    if (!version || digest(Buffer.from(JSON.stringify(state))) !== version) throw new AppError('回收记录已变化，请刷新后重试', 409);
    return state;
  }

  restoreVault(id: string, version: string) {
    const state = this.trashedVault(id, version);
    if (state.source === 'external') {
      if (this.config.vaults[id]?.path !== state.root) throw new AppError('知识库配置已变化，请先恢复原配置', 409);
    } else {
      const content = join(this.stateDirectory(id), 'content');
      if (existsSync(content)) {
        if (lstatSync(content).isSymbolicLink() || !lstatSync(content).isDirectory()) throw new AppError('知识库回收内容无效');
        if (existsSync(state.root)) throw new AppError('原知识库目录已存在，请先移走后再恢复', 409);
        try { lstatSync(state.root); throw new AppError('原知识库目录已存在，请先移走后再恢复', 409); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        mkdirSync(dirname(state.root), { recursive: true });
        renameSync(content, state.root);
      } else if (!existsSync(state.root)) throw new AppError('知识库文件不存在，无法恢复', 404);
    }
    unlinkSync(join(this.stateDirectory(id), 'state.json'));
    this.refreshVaults();
  }

  purgeVault(id: string, version: string) {
    const state = this.trashedVault(id, version);
    if (state.source === 'managed') rmSync(join(this.stateDirectory(id), 'content'), { recursive: true, force: true });
    this.saveVaultState({ ...state, state: 'removed' });
    this.refreshVaults();
  }

  emptyTrash(vaultId: string | undefined, version: string) {
    const listing = this.listTrash(vaultId);
    if (!version || listing.version !== version) throw new AppError('回收站已变化，请刷新后重试', 409);
    for (const item of listing.items) this.purgeTrash(item.vault_id, item.id, item.version);
    for (const vault of listing.vaults) this.purgeVault(vault.id, vault.version);
  }

  private commit(vault: Vault, paths: string[], message: string) {
    const root = vault.root;
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=coral', '-c', 'user.email=coral@local', ...args], { cwd: root, stdio: 'ignore', timeout: 5000 });
    try {
      if (!existsSync(join(root, '.git'))) {
        git('init', '-q');
        if (!existsSync(join(root, '.gitignore'))) writeFileSync(join(root, '.gitignore'), '*.tmp\n.trash/\n.coral-backups/\n.obsidian/workspace*.json\n');
      }
      git('add', '-A', '--', ...paths);
      git('commit', '-q', '--only', '--author', 'coral-user <coral-user@coral>', '-m', message, '--', ...paths);
    } catch { /* Git history is optional; Markdown writes remain authoritative. */ }
  }

  asset(uri: string): { bytes: Buffer; mime: string } {
    const { vaultId, relative } = parseUri(uri);
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif' };
    const contentType = mime[extname(relative).toLowerCase()];
    if (!contentType) throw new AppError('附件不存在', 404);
    const vault = this.vault(vaultId);
    let target: string | undefined;
    for (const candidate of decodedPathCandidates(relative)) {
      try { target = this.filePath(vault, candidate); break; }
      catch (error) { if (!(error instanceof AppError) || error.status !== 404) throw error; }
    }
    if (!target) throw new AppError('附件不存在', 404);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new AppError('附件不存在或超过大小限制', 404);
      return { bytes: readFileSync(descriptor), mime: contentType };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('无法读取附件', 404);
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
}
