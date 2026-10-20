import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, lstatSync, unlinkSync, writeFileSync, rmSync, rmdirSync, linkSync } from 'node:fs';
import { basename, dirname, extname, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Config } from './config.js';
import { AppError, headings, parseMarkdown, parseUri, resourceUri, safeParts, serialize, titleFor } from './content.js';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export interface Vault { id: string; name: string; description: string; root: string }
export interface Document {
  uri: string; vaultId: string; relative: string; title: string;
  version: string; size: number; raw: string; body: string;
  metadata: Record<string, unknown>; warning?: string;
}
function publicDocument(doc: Document) {
  return { uri: doc.uri, vault_id: doc.vaultId, title: doc.title, path: doc.relative,
    size_bytes: doc.size, version: doc.version, mime_type: 'text/markdown' };
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const today = () => new Date().toLocaleDateString('en-CA');
const cjkSplit = (text: string) => text.toLowerCase().replace(/([\u3000-\u9fff\uff00-\uffef])/g, ' $1 ');
const vaultStateSchema = z.object({ id: z.string(), name: z.string(), description: z.string(), root: z.string(),
  source: z.enum(['managed', 'external']), state: z.enum(['trash', 'removed']), deleted_at: z.string().datetime() });
type VaultState = z.infer<typeof vaultStateSchema>;
const trashRecordSchema = z.object({ path: z.string(), kind: z.enum(['file', 'directory']), deleted_at: z.string().datetime() });
interface TrashItem { id: string; vault_id: string; vault_name: string; path: string; uri: string; kind: 'file' | 'directory'; deleted_at: string; version: string }
const validId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);
const validVaultName = (name: string) => /^[a-z][a-z0-9_-]{0,63}$/.test(name);

export class VaultRegistry {
  readonly vaults = new Map<string, Vault>();
  private db: DatabaseSync;
  private fts: boolean;
  private scans = new Map<string, { root: string; files: Map<string, { stamp: string; doc?: Document }>; result: { documents: Document[]; skipped: number } }>();
  private indexed = new Map<string, string>();

  constructor(readonly config: Config) {
    const root = join(config.data_dir, 'obsdian', 'default');
    if (!existsSync(join(this.stateDirectory('default'), 'state.json'))) mkdirSync(join(root, '.obsidian'), { recursive: true });
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
    this.vaults.set('default', { id: 'default', name: 'default', description: 'coral 网页知识库', root: join(this.config.data_dir, 'obsdian', 'default') });
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
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
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
        return { ...entry, available: true, document_count: scan.documents.length, skipped_documents: scan.skipped };
      } catch {
        return { ...entry, available: false, document_count: 0, skipped_documents: 0 };
      }
    }) };
  }

  listDocuments(vaultId: string, directory = '', cursor = 0, limit = 50) {
    safeParts(directory, true);
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError('分页参数无效');
    const scan = this.scan(vaultId);
    const documents = scan.documents.filter(doc => !directory || doc.relative.startsWith(directory + '/'));
    return { vault_uri: resourceUri(vaultId), documents: documents.slice(cursor, cursor + limit).map(publicDocument),
      total: documents.length, skipped_documents: scan.skipped, next_cursor: cursor + limit < documents.length ? cursor + limit : null };
  }

  browse(vaultId: string, directory = '') {
    safeParts(directory, true);
    const vault = this.vault(vaultId);
    const root = directory ? this.filePath(vault, directory) : realpathSync(vault.root);
    if (!lstatSync(root).isDirectory()) throw new AppError('目录不存在', 404);
    const scan = this.scanVault(vault);
    const prefix = directory ? directory + '/' : '';
    const documents = scan.documents.filter(doc => doc.relative.startsWith(prefix) && !doc.relative.slice(prefix.length).includes('/'));
    const directories = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => {
        let snapshot: { version: string; file_count: number } | undefined;
        try { snapshot = this.directorySnapshot(join(root, entry.name)); } catch { /* Unreadable folders remain browsable. */ }
        return { name: entry.name, relative: prefix + entry.name, version: snapshot?.version,
          file_count: snapshot?.file_count,
          document_count: scan.documents.filter(doc => doc.relative.startsWith(prefix + entry.name + '/')).length };
      });
    return { documents, directories, total: scan.documents.length, skipped: scan.skipped };
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
    return { ...publicDocument(doc), content: doc.raw.slice(start, end), offset,
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
        for (const doc of scan.documents) {
          documents.set(doc.uri, doc);
          if (this.indexed.get(doc.uri) !== doc.version) {
            if (this.indexed.has(doc.uri)) remove.run(doc.uri);
            insert.run(doc.uri, this.fts ? cjkSplit(doc.title) : doc.title, this.fts ? cjkSplit(doc.body) : doc.body);
          }
        }
      }
      for (const uri of this.indexed.keys()) if (!documents.has(uri)) remove.run(uri);
      this.db.exec('COMMIT');
      this.indexed = new Map([...documents.values()].map(doc => [doc.uri, doc.version]));
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const match = '"' + cjkSplit(query).replaceAll('"', '""') + '"';
    const rows = this.fts
      ? this.db.prepare('SELECT uri FROM search WHERE search MATCH ? ORDER BY bm25(search)').all(match)
      : this.db.prepare('SELECT uri FROM search WHERE instr(lower(title), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0').all(query, query);
    const results = rows.slice(cursor, cursor + limit).map(row => {
      const doc = documents.get(row.uri as string)!;
      const at = doc.body.toLowerCase().indexOf(query.toLowerCase());
      const begin = Math.max(0, at - 100), end = Math.min(doc.body.length, Math.max(at, 0) + query.length + 250);
      return { ...publicDocument(doc), snippet: doc.body.slice(begin, end),
        start_line: doc.raw.slice(0, Math.max(0, doc.raw.indexOf(doc.body)) + begin).split('\n').length };
    });
    return { results, total: rows.length, next_cursor: cursor + limit < rows.length ? cursor + limit : null,
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
    const metadata = { ...(/^(?:\uFEFF)?---\r?\n/.test(raw) ? parsed.metadata : old.metadata), updated: today() };
    const target = this.filePath(this.vault(old.vaultId), old.relative);
    const temporary = join(dirname(target), `.coral-${randomUUID()}.tmp`);
    const backupRoot = join(realpathSync(this.vault(old.vaultId).root), '.coral-backups');
    try { mkdirSync(backupRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (lstatSync(backupRoot).isSymbolicLink() || !lstatSync(backupRoot).isDirectory()) throw new AppError('文档备份目录不可用');
    const backupDirectory = join(backupRoot, randomUUID());
    const backup = join(backupDirectory, basename(target));
    try {
      writeFileSync(temporary, serialize(metadata, parsed.body), { flag: 'wx' });
      if (this.document(uri).version !== old.version) throw new AppError('文档已被修改，请重新打开后再保存', 409);
      mkdirSync(backupDirectory, { recursive: true });
      // Move the original inode aside before exclusive creation. Keep it for late writes through external file descriptors.
      renameSync(target, backup);
      try {
        if (!lstatSync(backup).isFile() || digest(readFileSync(backup)) !== old.version) throw new AppError('文档已被修改，原文件已保留，请重新打开', 409);
        linkSync(temporary, target);
      } catch (error) {
        try { linkSync(backup, target); } catch { /* A concurrent writer owns the destination; preserve both copies. */ }
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('文档已被其他程序写入，原文件备份已保留，请重新打开', 409);
        throw error;
      }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    this.commit(this.vault(old.vaultId), [old.relative], `页面：编辑 ${old.title}`);
    return this.document(uri);
  }

  delete(uri: string, version?: string) {
    const doc = this.document(uri);
    if (version && version !== doc.version) throw new AppError('文档已修改，请刷新后重试', 409);
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
    const trash = join(realpathSync(vault.root), '.trash');
    try { mkdirSync(trash); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = lstatSync(trash);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AppError('知识库回收站不可用');
    const batch = join(trash, randomUUID());
    mkdirSync(batch);
    writeFileSync(join(batch, '.coral-trash.json'), JSON.stringify({ path, kind: lstatSync(target).isDirectory() ? 'directory' : 'file', deleted_at: new Date().toISOString() }) + '\n', { flag: 'wx' });
    const destination = join(batch, path);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(target, destination);
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
    let target = batch;
    for (const part of safeParts(record.path)) {
      target = join(target, part);
      if (lstatSync(target).isSymbolicLink()) throw new AppError('回收记录不允许符号链接路径');
    }
    const stat = lstatSync(target);
    if (record.kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new AppError('回收记录类型无效');
    return { batch, target, vault, record, version: this.directorySnapshot(batch).version };
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
    const target = this.filePath(this.vault(vaultId), relative);
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
