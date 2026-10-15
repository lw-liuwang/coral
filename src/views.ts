import { resourceUri, safeParts } from './content.js';
import { randomBytes } from 'node:crypto';
import { backlinksFor, editUrl, renderMarkdown, resolveLink, viewUrl, wikiTargets } from './markdown.js';
import { stringify } from 'yaml';
import type { Document, VaultRegistry } from './vault.js';

export const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export const icon = (name: string) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
export const linkButton = (url: string, label: string, symbol: string, primary = false) => `<a class="btn${primary ? ' primary' : ''}" href="${escape(url)}">${icon(symbol)}<span>${escape(label)}</span></a>`;
const alert = (message?: string) => message ? `<div class="alert" role="alert">${escape(message)}</div>` : '';
export const editorStyleNonce = randomBytes(24).toString('base64');

export function layout(registry: VaultRegistry, title: string, content: string, vaultId: string | null = 'default', query = '') {
  registry.refreshVaults();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="editor-style-nonce" content="${editorStyleNonce}"><title>${escape(title)} · coral</title><link rel="stylesheet" href="/static/coral.css"><link rel="stylesheet" href="/static/highlight.css"></head>
  <body><header class="topbar"><a class="brand" href="/">${icon('library')} coral</a><nav aria-label="主导航"><a href="/">知识库</a>${vaultId ? `<a href="/?vault=${escape(vaultId)}">文档</a>` : ''}</nav>
  ${vaultId ? `<form class="vault-switch" action="/" method="get"><select name="vault" aria-label="知识库" data-vault-switch>${[...registry.vaults.values()].map(v => `<option value="${escape(v.id)}"${v.id === vaultId ? ' selected' : ''}>${escape(v.name)}</option>`).join('')}</select></form>
  <form class="searchbox" action="/search" method="get"><input type="hidden" name="vault" value="${escape(vaultId)}"><input type="search" name="q" aria-label="搜索知识库" placeholder="搜索知识库…" value="${escape(query)}"><button class="icon-btn" title="搜索" aria-label="搜索">${icon('search')}</button></form>` : ''}</header>
  <main>${vaultId ? `<nav class="breadcrumbs" aria-label="当前位置"><a href="/">全部知识库</a><span>/</span><a href="/?vault=${escape(vaultId)}">${escape(registry.vaults.get(vaultId)?.name)}</a></nav>` : ''}${content}</main><script src="/static/client.js" defer></script></body></html>`;
}

export function vaultCatalog(registry: VaultRegistry, trashed = false) {
  const { vaults } = registry.listVaults();
  return layout(registry, '知识库', `<div class="page-head"><h1>知识库 <span class="muted">${vaults.length} 个</span></h1><div class="btns">${linkButton('/trash', '回收站', 'trash-2')}${linkButton('/vaults/new', '创建知识库', 'folder-plus', true)}</div></div>${trashed ? '<div class="alert ok" role="status">知识库已移入回收站。</div>' : ''}
    <ul class="vault-list">${vaults.map(vault => `<li><div class="vault-description"><h2>${vault.available ? `<a href="/?vault=${escape(vault.id)}">${escape(vault.name)}</a>` : escape(vault.name)}</h2>${vault.description ? `<p>${escape(vault.description)}</p>` : ''}<code>${escape(vault.uri)}</code></div><span class="muted">${vault.available ? `${vault.document_count} 个文档` : '暂不可用'}</span>${vault.available || vault.external ? `<form action="/vaults/delete" method="post" data-confirm="${escape(vault.external ? `将知识库「${vault.name}」的注册记录移入回收站？Obsidian 原文件保留，Coral 和 MCP 将暂停访问。` : `将知识库「${vault.name}」及全部文件移入回收站？之后可恢复。`)}"><input type="hidden" name="vault" value="${escape(vault.id)}"><input type="hidden" name="version" value="${vault.version}"><button class="icon-btn danger" title="删除知识库：${escape(vault.name)}" aria-label="删除知识库：${escape(vault.name)}">${icon('trash-2')}</button></form>` : ''}</li>`).join('')}</ul>`, null);
}

export function trashPage(registry: VaultRegistry, vaultId?: string, done = '') {
  const listing = registry.listTrash(vaultId);
  const notice = ({ restored: '已恢复。', purged: '已彻底删除回收内容。', emptied: '回收站已清空。' } as Record<string, string>)[done];
  const form = (action: string, scope: string, vault: string, id: string, version: string, label: string, symbol: string, message?: string) => `<form action="${action}" method="post"${message ? ` data-confirm="${escape(message)}"` : ''}><input type="hidden" name="scope" value="${scope}"><input type="hidden" name="vault" value="${escape(vault)}"><input type="hidden" name="entry" value="${escape(id)}"><input type="hidden" name="version" value="${version}"><input type="hidden" name="filter" value="${escape(vaultId)}"><button class="icon-btn${message ? ' danger' : ''}" title="${escape(label)}" aria-label="${escape(label)}">${icon(symbol)}</button></form>`;
  const rows = [
    ...listing.vaults.map(vault => `<li><div class="trash-description"><h2>${icon('library')}${escape(vault.name)}</h2><p class="muted">知识库${vault.external ? ' · 外部文件保留' : ''}</p><code>${escape(vault.uri)}</code><time class="muted" datetime="${vault.deleted_at}">${escape(new Date(vault.deleted_at).toLocaleString('zh-CN'))}</time></div><div class="btns">${form('/trash/restore', 'vault', vault.id, '', vault.version, `恢复知识库：${vault.name}`, 'rotate-ccw')}${form('/trash/purge', 'vault', vault.id, '', vault.version, `彻底删除知识库：${vault.name}`, 'trash-2', vault.external ? `彻底删除「${vault.name}」的注册回收记录？外部文件仍保留。` : `彻底删除知识库「${vault.name}」及全部文件？此操作无法撤销。`)}</div></li>`),
    ...listing.items.map(item => `<li><div class="trash-description"><h2>${icon(item.kind === 'directory' ? 'folder' : 'file-text')}${escape(item.path.split('/').at(-1))}</h2><p class="muted">${escape(item.vault_name)} · ${item.kind === 'directory' ? '文件夹' : '文档'}</p><code>${escape(item.uri)}</code><time class="muted" datetime="${item.deleted_at}">${escape(new Date(item.deleted_at).toLocaleString('zh-CN'))}</time></div><div class="btns">${form('/trash/restore', 'item', item.vault_id, item.id, item.version, `恢复：${item.path}`, 'rotate-ccw')}${form('/trash/purge', 'item', item.vault_id, item.id, item.version, `彻底删除：${item.path}`, 'trash-2', `彻底删除「${item.path}」${item.kind === 'directory' ? '及其中全部文件' : ''}？此操作无法撤销。`)}</div></li>`),
  ].join('');
  const backUrl = vaultId && registry.vaults.has(vaultId) ? '/?vault=' + vaultId : '/';
  return layout(registry, '回收站', `<div class="page-head"><h1>回收站 <span class="muted">${listing.items.length + listing.vaults.length} 项</span></h1><div class="btns">${linkButton(backUrl, '返回知识库', 'arrow-left')}${rows ? `<form action="/trash/empty" method="post" data-confirm="清空当前回收站中的全部内容？托管知识库及文件会被彻底删除，外部知识库仅删除注册记录。此操作无法撤销。"><input type="hidden" name="filter" value="${escape(vaultId)}"><input type="hidden" name="version" value="${listing.version}"><button class="btn danger">${icon('trash-2')}清空回收站</button></form>` : ''}</div></div>${notice ? `<div class="alert ok" role="status">${notice}</div>` : ''}${listing.skipped ? alert(`${listing.skipped} 项回收内容无法读取，未被清空；原文件仍保留在磁盘。`) : ''}${rows ? `<ul class="trash-list">${rows}</ul>` : '<div class="empty">回收站为空。</div>'}`, null);
}

export function newVault(registry: VaultRegistry, fields: { name?: string; description?: string; error?: string } = {}) {
  return layout(registry, '创建知识库', `<div class="page-head"><h1>创建知识库</h1>${linkButton('/', '返回', 'arrow-left')}</div>${alert(fields.error)}
    <form class="form" action="/vaults/new" method="post"><label>知识库名称<input name="name" required maxlength="200" value="${escape(fields.name)}"></label><label>简介<textarea name="description" rows="3" maxlength="2000">${escape(fields.description)}</textarea></label><button class="btn primary" type="submit">${icon('folder-plus')}创建知识库</button></form>`, null);
}

export function home(registry: VaultRegistry, vaultId: string, options: { upload?: number; rejected?: number; directory?: string; deleted?: boolean } = {}) {
  const vault = registry.vault(vaultId), directory = options.directory ?? '';
  const scan = registry.browse(vaultId, directory);
  const location = (path: string) => '/?' + new URLSearchParams({ vault: vaultId, directory: path });
  const parts = safeParts(directory, true);
  const crumbs = `<nav class="breadcrumbs" aria-label="目录"><a href="${escape(location(''))}">根目录</a>${parts.map((part, index) => `<span>/</span><a href="${escape(location(parts.slice(0, index + 1).join('/')))}">${escape(part)}</a>`).join('')}</nav>`;
  const remove = (action: string, uri: string, version: string, message: string, label: string) => `<form class="row-delete" action="${action}" method="post" data-confirm="${escape(message)}"><input type="hidden" name="uri" value="${escape(uri)}"><input type="hidden" name="version" value="${escape(version)}"><button type="submit" class="icon-btn danger" title="${escape(label)}" aria-label="${escape(label)}">${icon('trash-2')}</button></form>`;
  const items = `<ul class="page-list file-list">${directory ? `<li><a href="${escape(location(parts.slice(0, -1).join('/')))}">${icon('corner-left-up')}上级目录</a></li>` : ''}${scan.directories.map(folder => `<li><div class="file-entry"><a class="page-link" href="${escape(location(folder.relative))}">${icon('folder')}${escape(folder.name)}</a><span class="muted">${folder.document_count} 个文档</span></div>${folder.version ? remove('/delete-directory', resourceUri(vaultId, folder.relative), folder.version, `删除文件夹「${folder.relative}」？其中全部 ${folder.file_count} 个文件（含附件）和子目录将一起移入知识库回收站。`, `删除文件夹：${folder.name}`) : ''}</li>`).join('')}${scan.documents.map(doc => `<li><div class="file-entry"><a class="page-link" href="${escape(viewUrl(doc.uri))}">${icon('file-text')}${escape(doc.title)}</a><span class="muted">${escape(doc.relative.split('/').at(-1))}</span></div><span class="muted file-updated">${escape(doc.metadata.updated)}</span>${remove('/delete', doc.uri, doc.version, `将文档「${doc.relative}」移入知识库回收站？`, `删除文档：${doc.title}`)}</li>`).join('')}</ul>`;
  return layout(registry, vault.name, `<div class="page-head"><h1>${escape(vault.name)} <span class="muted">${scan.total} 个文档</span></h1><div class="btns">${linkButton('/new?' + new URLSearchParams({ vault: vaultId, directory }), '创建文档', 'file-plus', true)}${linkButton('/directories/new?' + new URLSearchParams({ vault: vaultId, directory }), '创建文件夹', 'folder-plus')}<details class="tools-menu"><summary class="icon-btn" aria-label="知识库工具" title="知识库工具">${icon('ellipsis')}</summary><nav aria-label="知识库工具"><a href="/trash?vault=${escape(vaultId)}">${icon('trash-2')}回收站</a><a href="/lint?vault=${escape(vaultId)}">${icon('scan-search')}结构检查</a></nav></details></div></div>
    ${options.deleted ? '<div class="alert ok" role="status">已移入知识库回收站。</div>' : ''}${options.upload ? `<div class="alert ok">已导入 ${options.upload} 个 Markdown 文档。</div>` : ''}${options.rejected ? alert(`${options.rejected} 个文件无法导入，仅支持有效的 UTF-8 Markdown 文档。`) : ''}${scan.skipped ? alert(`${scan.skipped} 个文档无法读取或超过大小限制。`) : ''}
    <form class="kb-upload" action="/upload" method="post" enctype="multipart/form-data"><input type="hidden" name="vault" value="${escape(vaultId)}"><input type="hidden" name="directory" value="${escape(directory)}"><input type="file" name="files" accept=".md,.markdown" multiple required aria-label="Markdown 文档"><button class="btn" type="submit">${icon('upload')}上传 Markdown</button>${vaultId === 'default' && registry.legacyFiles().length ? '<a class="muted" href="/sources">历史资料</a>' : ''}</form>
    ${crumbs}${items}${!scan.documents.length && !scan.directories.length ? '<div class="empty"><p>此目录暂无文档。</p></div>' : ''}`, vaultId);
}

export function newDirectory(registry: VaultRegistry, vaultId: string, directory = '', fields: { name?: string; error?: string } = {}) {
  registry.browse(vaultId, directory);
  const backUrl = '/?' + new URLSearchParams({ vault: vaultId, directory });
  return layout(registry, '创建文件夹', `<div class="page-head"><h1>创建文件夹</h1>${linkButton(backUrl, '返回', 'arrow-left')}</div>${alert(fields.error)}
    <form class="form" action="/directories/new" method="post"><input type="hidden" name="vault" value="${escape(vaultId)}"><input type="hidden" name="directory" value="${escape(directory)}"><p class="muted">所在目录：${escape(directory || '根目录')}</p><label>文件夹名称<input name="name" required maxlength="255" value="${escape(fields.name)}" autofocus></label><button class="btn primary" type="submit">${icon('folder-plus')}创建文件夹</button></form>`, vaultId);
}

export function newPage(registry: VaultRegistry, vaultId: string, fields: { title?: string; directory?: string; content?: string; error?: string } = {}) {
  registry.vault(vaultId);
  return layout(registry, '创建文档', `<div class="page-head"><h1>创建文档</h1><div class="btns">${linkButton('/?' + new URLSearchParams({ vault: vaultId, directory: fields.directory ?? '' }), '返回', 'arrow-left')}<button class="btn primary" form="write-form" type="submit">${icon('save')}创建</button></div></div>${alert(fields.error)}
    <form id="write-form" class="writing-form" action="/new" method="post"><input type="hidden" name="vault" value="${escape(vaultId)}"><div class="document-fields"><label>标题<input name="title" placeholder="文档标题" value="${escape(fields.title)}" required maxlength="200"></label><label>保存目录<input name="directory" placeholder="根目录" value="${escape(fields.directory)}" maxlength="1000"></label></div>
    <input type="hidden" id="preview-vault" value="${escape(vaultId)}">${writingSurface(fields.content ?? '', '正文')}</form>`, vaultId);
}

function writingSurface(content: string, label: string) {
  const tool = (command: string, name: string, symbol: string) => `<button type="button" class="icon-btn" data-editor-command="${command}" aria-label="${name}" title="${name}">${icon(symbol)}</button>`;
  return `<section class="writing-surface" data-mode="split"><div class="draft-notice" hidden role="status"><span data-draft-message>有未保存的本地草稿</span><div class="btns"><button type="button" class="btn small" data-restore-draft>恢复草稿</button><button type="button" class="btn small" data-discard-draft>丢弃草稿</button></div></div>
    <div class="writing-toolbar"><div class="format-tools" role="toolbar" aria-label="Markdown 格式">${tool('undo', '撤销', 'undo-2')}${tool('redo', '重做', 'redo-2')}<span class="tool-divider"></span>${tool('heading', '二级标题', 'heading-2')}${tool('bold', '加粗', 'bold')}${tool('italic', '斜体', 'italic')}${tool('link', '插入链接', 'link')}${tool('list', '无序列表', 'list')}${tool('task', '任务列表', 'list-todo')}${tool('quote', '引用', 'quote')}${tool('code', '代码块', 'code')}</div>
    <div class="writing-modes" role="group" aria-label="编辑视图"><button type="button" data-mode="write" aria-pressed="false">书写</button><button type="button" data-mode="split" aria-pressed="true">分栏</button><button type="button" data-mode="preview" aria-pressed="false">预览</button></div><button type="button" class="icon-btn" data-focus-editor aria-pressed="false" aria-label="专注模式" title="专注模式">${icon('maximize-2')}</button></div>
    <div class="editor-grid"><div class="source-pane"><textarea id="editor" name="content" aria-label="${escape(label)}" spellcheck="false">${escape(content)}</textarea><div id="markdown-editor"></div></div><div id="preview" class="preview md-body" aria-label="文档预览"></div></div>
    <footer class="writing-status"><span id="save-status" role="status" aria-live="polite">未修改</span><span id="word-count"></span></footer><div id="save-error" class="alert" role="alert" hidden></div></section>`;
}

export function documentPage(registry: VaultRegistry, doc: Document) {
  const documents = registry.scan(doc.vaultId).documents;
  const directoryUrl = '/?' + new URLSearchParams({ vault: doc.vaultId, directory: doc.relative.split('/').slice(0, -1).join('/') });
  const backlinks = backlinksFor(documents, doc.uri);
  const properties = Object.entries(doc.metadata).filter(([key]) => key !== 'title');
  return layout(registry, doc.title, `${alert(doc.warning)}<div class="page-head"><h1>${escape(doc.title)}</h1><div class="btns">${linkButton(directoryUrl, '所在目录', 'folder')}${linkButton(editUrl(doc.uri), '编辑', 'pencil')}${linkButton('/download?uri=' + encodeURIComponent(doc.uri), '下载', 'download')}
    <form class="inline" action="/delete" method="post" data-confirm="将这个文档移入知识库回收站？"><input type="hidden" name="uri" value="${escape(doc.uri)}"><input type="hidden" name="version" value="${doc.version}"><button class="icon-btn danger" title="删除" aria-label="删除">${icon('trash-2')}</button></form></div></div>
    <div class="document-uri"><code>${escape(doc.uri)}</code><button class="icon-btn" type="button" data-copy="${escape(doc.uri)}" title="复制资源 URI" aria-label="复制资源 URI">${icon('copy')}</button></div>
    ${properties.length ? `<details class="meta"><summary>文档属性</summary><dl>${properties.map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(typeof value === 'object' ? stringify(value).trimEnd() : value)}</dd>`).join('')}</dl></details>` : ''}
    <article class="md-body">${renderMarkdown(doc.body, documents, doc)}</article>${backlinks.length ? `<section class="backlinks"><h2>反向链接 <span class="muted">${backlinks.length}</span></h2><ul>${backlinks.map(other => `<li><a href="${escape(viewUrl(other.uri))}">${escape(other.title)}</a></li>`).join('')}</ul></section>` : ''}`, doc.vaultId);
}

export function editPage(registry: VaultRegistry, doc: Document, options: { content?: string; version?: string; error?: string } = {}) {
  return layout(registry, '编辑 ' + doc.title, `<div class="page-head"><h1>编辑 · ${escape(doc.title)}</h1><div class="btns">${linkButton(viewUrl(doc.uri), '取消', 'arrow-left')}<button class="btn primary" form="edit-form" type="submit">${icon('save')}保存</button></div></div>${alert(options.error)}
    <form id="edit-form" class="writing-form" action="/edit" method="post"><input type="hidden" name="uri" value="${escape(doc.uri)}"><input type="hidden" name="version" value="${escape(options.version ?? doc.version)}"><input type="hidden" id="preview-vault" value="${escape(doc.vaultId)}"><input type="hidden" id="preview-uri" value="${escape(doc.uri)}">${writingSurface(options.content ?? doc.raw, 'Markdown 正文')}</form>`, doc.vaultId);
}

export function searchPage(registry: VaultRegistry, vaultId: string, query: string, cursor = 0) {
  const limit = registry.config.search.results_per_page;
  const found = query.trim() ? registry.search(query, vaultId, limit, cursor) : { results: [], total: 0, next_cursor: null };
  return layout(registry, '搜索', `<div class="page-head"><h1>搜索 <span class="muted">${found.total} 条结果</span></h1></div>${found.results.map(doc => `<div class="result-item"><a href="${escape(viewUrl(doc.uri))}">${escape(doc.title)}</a><div class="muted document-uri">${escape(doc.uri)}</div><p class="snippet">${escape(doc.snippet)}</p></div>`).join('') || '<div class="empty">没有找到匹配的内容。</div>'}
    <div class="pagination">${cursor > 0 ? linkButton('/search?' + new URLSearchParams({ q: query, vault: vaultId, cursor: String(Math.max(0, cursor - limit)) }), '上一页', 'chevron-left') : ''}${found.next_cursor !== null ? linkButton('/search?' + new URLSearchParams({ q: query, vault: vaultId, cursor: String(found.next_cursor) }), '下一页', 'chevron-right') : ''}</div>`, vaultId, query);
}

export function lintPage(registry: VaultRegistry, vaultId: string) {
  const documents = registry.scan(vaultId).documents;
  const inbound = new Set<string>(), outbound = new Set<string>(), broken: { doc: Document; target: string }[] = [];
  for (const doc of documents) for (const target of wikiTargets(doc.body)) {
    const other = resolveLink(target, documents, doc);
    outbound.add(doc.uri);
    if (other) inbound.add(other.uri); else broken.push({ doc, target });
  }
  const list = (docs: Document[]) => docs.map(doc => `<li><a href="${escape(viewUrl(doc.uri))}">${escape(doc.title)}</a></li>`).join('');
  return layout(registry, '结构检查', `<div class="page-head"><h1>结构检查</h1></div><section class="lint-section"><h2>断链 · ${broken.length}</h2><ul>${broken.map(({ doc, target }) => `<li><a href="${escape(viewUrl(doc.uri))}">${escape(doc.title)}</a>：${escape(target)}</li>`).join('') || '<li>没有断链。</li>'}</ul></section>
    <section class="lint-section"><h2>孤立文档</h2><ul>${list(documents.filter(doc => !inbound.has(doc.uri))) || '<li>没有孤立文档。</li>'}</ul></section><section class="lint-section"><h2>无出链文档</h2><ul>${list(documents.filter(doc => !outbound.has(doc.uri))) || '<li>没有无出链文档。</li>'}</ul></section>`, vaultId);
}

export function errorPage(registry: VaultRegistry, message: string) {
  return layout(registry, '无法完成操作', `<div class="page-head"><h1>无法完成操作</h1></div>${alert(message)}${linkButton('/', '返回知识库', 'arrow-left')}`);
}
