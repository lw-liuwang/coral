import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import multer from 'multer';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { AppError, parseMarkdown, safeParts, titleFor } from './content.js';
import { createMcpServer } from './mcp.js';
import { renderMarkdown, viewUrl } from './markdown.js';
import { MAX_FILE_BYTES, VaultRegistry } from './vault.js';
import { documentPage, editPage, editorStyleNonce, errorPage, home, lintPage, newDirectory, newPage, newVault, renamePage, searchPage, trashPage, vaultCatalog } from './views.js';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const integer = (value: unknown, fallback = 0) => value === undefined ? fallback : z.coerce.number().int().min(0).parse(value);
const uri = (request: Request) => text(request.query.uri ?? request.body?.uri);

export function createApp(config: Config) {
  const app = express();
  const registry = new VaultRegistry(config);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '18mb' }));
  app.use(express.urlencoded({ extended: false, limit: '18mb' }));
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      try { if (new URL(origin).host !== req.get('host')) { res.status(403).json({ error: '请求来源无效' }); return; } }
      catch { res.status(403).json({ error: '请求来源无效' }); return; }
    }
    next();
  });
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${editorStyleNonce}'; img-src 'self' https: http: data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`);
    next();
  });
  app.get('/static/mermaid.html', (_req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts");
    res.sendFile(join(base, 'static/mermaid.html'));
  });
  app.get('/static/html-frame.html', (_req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts");
    res.sendFile(join(base, 'static/html-frame.html'));
  });
  app.use('/static', express.static(join(base, 'dist/public')));
  app.get('/static/highlight.css', (_req, res) => res.sendFile(join(base, 'node_modules/highlight.js/styles/github.css')));
  app.use('/static', express.static(join(base, 'static')));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 20, fields: 5 } });
  app.get('/', (req, res) => res.send(req.query.vault === undefined ? vaultCatalog(registry, req.query.trashed === '1') : home(registry, text(req.query.vault, 'default'), {
    upload: integer(req.query.upload), rejected: integer(req.query.rejected), directory: text(req.query.directory), deleted: req.query.deleted === '1',
  })));
  app.get('/vaults/new', (_req, res) => res.send(newVault(registry)));
  app.post('/vaults/delete', (req, res) => {
    registry.deleteVault(text(req.body.vault), text(req.body.version));
    res.redirect(303, '/?trashed=1');
  });
  app.get('/trash', (req, res) => res.send(trashPage(registry, text(req.query.vault) || undefined, text(req.query.done))));
  for (const action of ['restore', 'purge'] as const) app.post('/trash/' + action, (req, res) => {
    const vault = text(req.body.vault), version = text(req.body.version);
    if (req.body.scope === 'vault') {
      if (action === 'restore') registry.restoreVault(vault, version); else registry.purgeVault(vault, version);
    } else if (req.body.scope === 'item') {
      if (action === 'restore') registry.restoreTrash(vault, text(req.body.entry), version); else registry.purgeTrash(vault, text(req.body.entry), version);
    } else throw new AppError('回收内容类型无效');
    res.redirect(303, '/trash?' + new URLSearchParams({ vault: text(req.body.filter), done: action === 'restore' ? 'restored' : 'purged' }));
  });
  app.post('/trash/empty', (req, res) => {
    registry.emptyTrash(text(req.body.filter) || undefined, text(req.body.version));
    res.redirect(303, '/trash?' + new URLSearchParams({ vault: text(req.body.filter), done: 'emptied' }));
  });
  app.post('/vaults/new', (req, res) => {
    const fields = { name: text(req.body.name), description: text(req.body.description) };
    try {
      const vault = registry.createVault(fields.name, fields.description);
      res.redirect(303, '/?vault=' + vault.id);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      res.status(error.status).send(newVault(registry, { ...fields, error: error.message }));
    }
  });
  app.get('/directories/new', (req, res) => res.send(newDirectory(registry, text(req.query.vault, 'default'), text(req.query.directory))));
  app.post('/directories/new', (req, res) => {
    const vaultId = text(req.body.vault, 'default'), directory = text(req.body.directory), name = text(req.body.name);
    try {
      registry.createDirectory(vaultId, directory, name);
      res.redirect(303, '/?' + new URLSearchParams({ vault: vaultId, directory }));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      res.status(error.status).send(newDirectory(registry, vaultId, directory, { name, error: error.message }));
    }
  });
  app.get('/new', (req, res) => res.send(newPage(registry, text(req.query.vault, 'default'), { title: text(req.query.title), directory: text(req.query.directory) })));
  app.post('/new', (req, res) => {
    const vaultId = text(req.body.vault, 'default');
    try {
      const doc = registry.create(vaultId, text(req.body.title), text(req.body.content), {}, undefined, text(req.body.directory));
      if (req.get('accept') === 'application/json') { res.json({ uri: doc.uri, version: doc.version, url: viewUrl(doc.uri) }); return; }
      res.redirect(303, viewUrl(doc.uri));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (req.get('accept') === 'application/json') { res.status(error.status).json({ error: error.message }); return; }
      res.status(error.status).send(newPage(registry, vaultId, { title: text(req.body.title), directory: text(req.body.directory), content: text(req.body.content), error: error.message }));
    }
  });
  app.post('/upload', upload.array('files'), (req, res) => {
    const vaultId = text(req.body.vault, 'default');
    const directory = text(req.body.directory);
    safeParts(directory, true);
    registry.vault(vaultId);
    let saved = 0, rejected = 0;
    for (const file of req.files as Express.Multer.File[] ?? []) {
      // Multer follows multipart's Latin-1 filename convention; browsers send UTF-8.
      const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
      if (!/\.(md|markdown)$/i.test(filename) || filename.startsWith('.')) { rejected++; continue; }
      try {
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
        const { metadata, body } = parseMarkdown(raw);
        const stem = filename.replace(/\.(md|markdown)$/i, '');
        registry.create(vaultId, titleFor(metadata, stem), body, metadata, stem, directory);
        saved++;
      } catch (error) {
        if (error instanceof AppError || error instanceof TypeError) rejected++; else throw error;
      }
    }
    res.redirect(303, '/?' + new URLSearchParams({ vault: vaultId, upload: String(saved), rejected: String(rejected), directory }));
  });
  app.get('/document', (req, res) => res.send(documentPage(registry, registry.document(uri(req)))));
  app.get('/rename', (req, res) => res.send(renamePage(registry, registry.renameEntry(uri(req)), { from: text(req.query.from) })));
  app.post('/rename', (req, res) => {
    const entry = registry.renameEntry(uri(req));
    const fields = { name: text(req.body.name), version: text(req.body.version), from: text(req.body.from) };
    try {
      const renamed = registry.rename(entry.uri, fields.name, fields.version);
      const directory = fields.from === 'directory' && renamed.kind === 'directory' ? renamed.relative : renamed.relative.split('/').slice(0, -1).join('/');
      const url = fields.from === 'document' && renamed.kind === 'document' ? viewUrl(renamed.uri)
        : '/?' + new URLSearchParams({ vault: renamed.vaultId, directory });
      if (req.get('accept') === 'application/json') { res.json({ ...renamed, url }); return; }
      res.redirect(303, url);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (req.get('accept') === 'application/json') { res.status(error.status).json({ error: error.message }); return; }
      res.status(error.status).send(renamePage(registry, entry, { ...fields, error: error.message }));
    }
  });
  app.get('/edit', (req, res) => res.send(editPage(registry, registry.document(uri(req)))));
  app.post('/edit', (req, res) => {
    if (!text(req.body.version)) throw new AppError('缺少文档版本，请重新打开编辑页');
    try {
      const doc = registry.update(uri(req), text(req.body.content), text(req.body.version));
      if (req.get('accept') === 'application/json') { res.json({ uri: doc.uri, version: doc.version, url: viewUrl(doc.uri) }); return; }
      res.redirect(303, viewUrl(doc.uri));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (req.get('accept') === 'application/json') { res.status(error.status).json({ error: error.message }); return; }
      const doc = registry.document(uri(req));
      res.status(error.status).send(editPage(registry, doc, { content: text(req.body.content), version: text(req.body.version), error: error.message }));
    }
  });
  app.post('/delete', (req, res) => {
    if (!text(req.body.version)) throw new AppError('缺少文档版本，请刷新后重试');
    const doc = registry.document(uri(req));
    registry.delete(doc.uri, text(req.body.version));
    res.redirect(303, '/?' + new URLSearchParams({ vault: doc.vaultId, directory: doc.relative.split('/').slice(0, -1).join('/'), deleted: '1' }));
  });
  app.post('/delete-directory', (req, res) => {
    const result = registry.deleteDirectory(uri(req), text(req.body.version));
    res.redirect(303, '/?' + new URLSearchParams({ vault: result.vaultId, directory: result.directory, deleted: '1' }));
  });
  app.get('/search', (req, res) => res.send(searchPage(registry, text(req.query.vault, 'default'), text(req.query.q), integer(req.query.cursor))));
  app.get('/lint', (req, res) => res.send(lintPage(registry, text(req.query.vault, 'default'))));
  app.post('/api/preview', (req, res) => {
    const vaultId = text(req.body.vault, 'default');
    const documents = registry.scan(vaultId).documents;
    const current = text(req.body.uri) ? registry.document(text(req.body.uri)) : undefined;
    res.json({ html: renderMarkdown(parseMarkdown(text(req.body.markdown)).body, documents, current) });
  });
  app.get('/api/vaults', (_req, res) => res.json(registry.listVaults()));
  app.get('/api/documents', (req, res) => res.json(registry.listDocuments(text(req.query.vault, 'default'), text(req.query.directory), integer(req.query.cursor), integer(req.query.limit, 50))));
  app.get('/api/search', (req, res) => res.json(registry.search(text(req.query.q), text(req.query.vault) || undefined, integer(req.query.limit, 20), integer(req.query.cursor))));
  app.get('/api/document', (req, res) => res.json(registry.readDocument(uri(req), { offset: integer(req.query.offset), maxChars: integer(req.query.max_chars, 16000), heading: typeof req.query.heading === 'string' ? req.query.heading : undefined, version: text(req.query.version) || undefined })));
  app.get('/download', (req, res) => {
    const file = registry.download(uri(req));
    res.setHeader('ETag', '"' + file.metadata.version + '"');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="document.md"; filename*=UTF-8''${encodeURIComponent(file.metadata.filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
    res.send(file.bytes);
  });
  app.get('/asset', (req, res) => {
    const file = registry.asset(uri(req));
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.type(file.mime).send(file.bytes);
  });
  const mcpGuard = config.server.host === '127.0.0.1' || config.server.host === 'localhost'
    ? hostHeaderValidation(['localhost', '127.0.0.1', '[::1]']) : (_req: Request, _res: Response, next: () => void) => next();
  app.post('/mcp', mcpGuard, async (req, res) => {
    const server = createMcpServer(registry);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP request failed' } });
    }
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use Streamable HTTP POST' } }));
  app.use((_req, res) => res.status(404).send(errorPage(registry, '页面不存在')));
  const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
    const status = error instanceof AppError ? error.status : error instanceof multer.MulterError ? 413 : error instanceof z.ZodError || error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    const message = error instanceof AppError ? error.message : error instanceof multer.MulterError ? '上传文件过多或超过 16 MiB 限制' : status === 400 ? '请求参数无效' : status === 413 ? '请求内容超过大小限制' : '暂时无法完成操作';
    if (req.path.startsWith('/api/') || req.path === '/download' || req.path === '/asset' || req.get('accept') === 'application/json') res.status(status).json({ error: message });
    else res.status(status).send(errorPage(registry, message));
  };
  app.use(errorHandler);
  return { app, registry, close: () => registry.close() };
}
