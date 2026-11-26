import { parseUri, resourceUri, safeParts, type AppError } from './content.js';
import { createHash, randomBytes } from 'node:crypto';
import { backlinksFor, editUrl, renderMarkdownWithOutline, resolveLink, viewUrl, wikiTargets, type RenderedHeading } from './markdown.js';
import { stringify } from 'yaml';
import { isIndexDocument, type Document, type DocumentLanguage, type RelocationReport, type VaultRegistry } from './vault.js';
import { searchReturn, withSearchReturn } from './web-context.js';
import { searchMatchRanges, splitSearchQuery } from './search-query.js';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const icon = (name: string) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const linkButton = (url: string, label: string, symbol: string, primary = false) => `<a class="btn${primary ? ' primary' : ''}" href="${escape(url)}">${icon(symbol)}<span>${escape(label)}</span></a>`;
const alert = (message?: string) => message ? `<div class="alert" role="alert">${escape(message)}</div>` : '';
const directoryUrl = (vault: string, directory = '') => '/?' + new URLSearchParams({ vault, directory });
export const documentAnchor = (uri: string) => 'doc-' + createHash('sha256').update(uri).digest('hex').slice(0, 16);
const copyButton = (uri: string, label = '复制 Coral 链接') => `<button class="btn" type="button" data-copy="${escape(uri)}" title="${escape(label)}" aria-label="${escape(label)}">${icon('copy')}<span>复制链接</span></button>`;
const renameLink = (uri: string, label = '重命名', from = '', returnTo?: string) => `<a class="btn" href="${escape(withSearchReturn('/rename?' + new URLSearchParams({ uri, from }), returnTo))}" title="${escape(label)}" aria-label="${escape(label)}">${icon('text-cursor-input')}<span>重命名</span></a>`;
const moveLink = (uri: string, label = '移动', from = '', returnTo?: string) => `<a class="btn" href="${escape(withSearchReturn('/move?' + new URLSearchParams({ uri, from }), returnTo))}" title="${escape(label)}" aria-label="${escape(label)}">${icon('folder-input')}<span>移动</span></a>`;
const actionMenu = (label: string, content: string, text = '更多', symbol = 'ellipsis') => `<details class="tools-menu"><summary class="btn" aria-label="${escape(label)}" title="${escape(label)}">${icon(symbol)}<span>${escape(text)}</span></summary><div class="menu-content">${content}</div></details>`;
function highlight(value: string, query: string) {
  let result = '', offset = 0;
  for (const match of searchMatchRanges(value, splitSearchQuery(query))) {
    result += escape(value.slice(offset, match.start)) + '<mark>' + escape(value.slice(match.start, match.end)) + '</mark>';
    offset = match.end;
  }
  return result + escape(value.slice(offset));
}
export const editorStyleNonce = randomBytes(24).toString('base64');

function operationNotice(report?: RelocationReport) {
  if (!report) return '';
  const label = (uri: string) => { try { return decodeURIComponent(uri.replace(/^coral:\/\/vault\//, '')); } catch { return uri; } };
  return `<section class="operation-result" aria-label="整理结果"><details${report.updated_documents.length ? '' : ' hidden'}><summary>已更新 ${report.updated_documents.length} 篇笔记的链接</summary><ul>${report.updated_documents.map(doc => `<li><a href="${escape(viewUrl(doc.uri))}">${escape(label(doc.uri))}</a></li>`).join('')}</ul></details>${report.unresolved_links.length ? `<details><summary>有 ${report.unresolved_links.length} 处引用未处理</summary><ul>${report.unresolved_links.map(link => `<li><a href="${escape(viewUrl(link.uri))}">${escape(label(link.uri))}</a>：${escape(link.target)} · ${escape(link.reason)}</li>`).join('')}</ul></details>` : ''}</section>`;
}

function recoveryNotice(registry: VaultRegistry, details?: AppError['details']) {
  const recovery = details?.recovery;
  if (!recovery) return '';
  const paths = [...new Set([...recovery.conflicts.map(item => item.uri), ...recovery.affected_uris])];
  return `<section class="recovery-result"><p>恢复编号：<code>${escape(recovery.operation_id)}</code></p>${recovery.partial ? `<ul>${paths.map(uri => {
    const { vaultId, relative } = parseUri(uri);
    let name = escape(vaultId + '/' + relative);
    try {
      const entry = registry.renameEntry(uri);
      const url = entry.kind === 'document' ? viewUrl(uri) : directoryUrl(vaultId, relative);
      name = `<a href="${escape(url)}">${name}</a>`;
    } catch { /* A missing original path remains readable without offering a broken action. */ }
    const reason = recovery.conflicts.find(item => item.uri === uri)?.reason;
    return `<li>${name}${reason ? '：' + escape(reason) : ''}</li>`;
  }).join('')}</ul>` : ''}</section>`;
}

interface PageOptions {
  vaultId?: string;
  query?: string;
  directory?: string;
  filename?: string;
  header: string;
  documentCount?: number;
  searchScope?: boolean;
  outline?: RenderedHeading[];
}

function articleOutline(headings: RenderedHeading[]) {
  const levels: number[] = [];
  return `<details class="article-outline" open><summary>文章目录</summary><nav class="article-toc-scroll" data-article-toc aria-label="文章目录"><ol>${headings.map(heading => {
    while (levels.length && levels.at(-1)! >= heading.level) levels.pop();
    const depth = levels.length;
    levels.push(heading.level);
    return `<li class="toc-depth-${depth}"><a href="#${escape(encodeURIComponent(heading.id))}">${escape(heading.title)}</a></li>`;
  }).join('')}</ol></nav></details>`;
}

function folderNavigation(registry: VaultRegistry, vaultId: string, directory: string) {
  const children = new Map<string, string[]>();
  for (const path of registry.listDirectories(vaultId).filter(Boolean)) {
    const parent = path.split('/').slice(0, -1).join('/');
    const siblings = children.get(parent) ?? [];
    siblings.push(path);
    children.set(parent, siblings);
  }
  const link = (path: string, name: string) => `<a href="${escape(directoryUrl(vaultId, path))}" aria-label="打开文件夹：${escape(path || '根目录')}" title="${escape(path || '根目录')}"${path === directory ? ' aria-current="page"' : ''}>${icon(path === directory ? 'folder-open' : 'folder')}<span>${escape(name)}</span></a>`;
  const branch = (path: string): string => {
    const nested = children.get(path);
    const entry = link(path, path.split('/').at(-1)!);
    return `<li>${nested?.length ? `<details${directory === path || directory.startsWith(path + '/') ? ' open' : ''}><summary aria-label="展开或收起文件夹：${escape(path)}">${entry}</summary><ul>${nested.map(branch).join('')}</ul></details>` : entry}</li>`;
  };
  return `<nav class="folder-tree" aria-label="目录树">${link('', '根目录')}<ul>${(children.get('') ?? []).map(branch).join('')}</ul></nav>`;
}

function searchForm(registry: VaultRegistry, vaultId: string | undefined, query: string, scoped: boolean) {
  return `<form class="search-form" role="search" action="/search" method="get"><div class="search-query"><input type="search" name="q" aria-label="搜索知识库" placeholder="搜索笔记…" maxlength="500" value="${escape(query)}"><button class="icon-btn" type="submit" aria-label="搜索" title="搜索">${icon('search')}</button></div>${scoped ? `<select name="vault" aria-label="搜索范围"><option value="">全部知识库</option>${[...registry.vaults.values()].map(vault => `<option value="${escape(vault.id)}"${vault.id === vaultId ? ' selected' : ''}>${escape(vault.name)}</option>`).join('')}</select>` : ''}</form>`;
}

function layout(registry: VaultRegistry, title: string, content: string, options: PageOptions) {
  const { vaultId, query = '' } = options;
  const directoryPage = options.documentCount !== undefined;
  registry.refreshVaults();
  const parts = safeParts(options.directory ?? '', true);
  const crumbs: { label: string; url?: string }[] = vaultId ? [
    { label: '全部知识库', url: '/' },
    { label: registry.vaults.get(vaultId)?.name ?? vaultId, url: directoryUrl(vaultId) },
    ...parts.map((part, index) => ({ label: part, url: directoryUrl(vaultId, parts.slice(0, index + 1).join('/')) })),
    ...(options.filename ? [{ label: options.filename }] : []),
  ] : [];
  const breadcrumbs = crumbs.length ? `<nav class="breadcrumbs" aria-label="当前位置">${crumbs.map((crumb, index) => {
    const current = index === crumbs.length - 1;
    const label = crumb.url ? `<a href="${escape(crumb.url)}"${current ? ' aria-current="page"' : ''}>${escape(crumb.label)}</a>`
      : `<span aria-current="page">${escape(crumb.label)}</span>`;
    return (index ? '<span aria-hidden="true">/</span>' : '') + (current && directoryPage
      ? `<h1>${label}<span class="muted">${options.documentCount} 个文档</span></h1>` : label);
  }).join('')}</nav>` : '';
  const vaultLinks = `<nav class="sidebar-nav" aria-label="知识库列表"><a href="/" aria-label="管理知识库">${icon('library')}<span>全部知识库</span></a>${[...registry.vaults.values()].map(vault => `<a href="${escape(directoryUrl(vault.id))}" aria-label="打开知识库：${escape(vault.name)}"${vault.id === vaultId ? ' aria-current="true"' : ''}>${icon('folder')}<span>${escape(vault.name)}</span></a>`).join('')}</nav>`;
  const sidebar = `<aside class="sidebar" aria-label="知识库导航"><a class="brand" href="/" aria-label="coral · 全部知识库">${icon('library')} coral</a>
    ${searchForm(registry, vaultId, query, options.searchScope === true)}
    ${actionMenu('切换知识库', vaultLinks, registry.vaults.get(vaultId ?? '')?.name ?? '知识库', 'library')}
    <div class="sidebar-scroll">${vaultId && options.directory !== undefined ? folderNavigation(registry, vaultId, options.directory) : ''}</div>
    <a class="sidebar-trash" href="${escape('/trash' + (vaultId ? '?' + new URLSearchParams({ vault: vaultId }) : ''))}">${icon('trash-2')}回收站</a></aside>`;
  const outline = options.outline?.length ? `<aside class="reading-outline" aria-label="文章导航">${articleOutline(options.outline)}</aside>` : '';
  const header = directoryPage ? `<div class="page-head">${breadcrumbs}${options.header}</div>` : breadcrumbs + options.header;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="editor-style-nonce" content="${editorStyleNonce}"><title>${escape(title)} · coral</title><link rel="stylesheet" href="/static/coral.css"><link rel="stylesheet" href="/static/highlight.css"><link rel="stylesheet" href="/static/katex/katex.min.css"></head>
    <body class="app-shell${outline ? ' has-article-outline' : ''}">${sidebar}${outline}<main class="workspace"><header class="topbar${directoryPage ? ' directory-header' : ''}">${header}</header><div class="page-content">${content}</div></main><script src="/static/client.js" defer></script></body></html>`;
}

export function vaultCatalog(registry: VaultRegistry, trashed = false) {
  const { vaults } = registry.listVaults();
  const header = `<div class="page-head"><h1>知识库 <span class="muted">${vaults.length} 个</span></h1><div class="btns"><a class="btn" href="/" title="刷新知识库" aria-label="刷新知识库">${icon('refresh-cw')}<span>刷新知识库</span></a>${linkButton('/vaults/new', '创建知识库', 'folder-plus', true)}</div></div>`;
  return layout(registry, '知识库', `${trashed ? '<div class="alert ok" role="status">知识库已移入回收站。</div>' : ''}
    <ul class="vault-list">${vaults.map(vault => `<li><div class="vault-description"><h2>${vault.available ? `<a href="/?vault=${escape(vault.id)}">${escape(vault.name)}</a>` : escape(vault.name)}</h2>${vault.description ? `<p>${escape(vault.description)}</p>` : ''}</div><span class="muted">${vault.available ? `${vault.document_count} 个文档` : '暂不可用'}</span><div class="row-actions">${copyButton(vault.uri, `复制 Coral 链接：${vault.name}`)}${vault.available || vault.external ? `<form action="/vaults/delete" method="post" data-confirm="${escape(vault.external ? `将知识库「${vault.name}」的注册记录移入回收站？Obsidian 原文件保留，Coral 和 MCP 将暂停访问。` : `将知识库「${vault.name}」及全部文件移入回收站？之后可恢复。`)}"><input type="hidden" name="vault" value="${escape(vault.id)}"><input type="hidden" name="version" value="${vault.version}"><button class="btn danger" title="删除知识库：${escape(vault.name)}" aria-label="删除知识库：${escape(vault.name)}">${icon('trash-2')}<span>删除</span></button></form>` : ''}</div></li>`).join('')}</ul>`, { header });
}

export function trashPage(registry: VaultRegistry, vaultId?: string, done = '') {
  const listing = registry.listTrash(vaultId);
  const notice = ({ restored: '已恢复。', purged: '已彻底删除回收内容。', emptied: '回收站已清空。' } as Record<string, string>)[done];
  const form = (action: string, scope: string, vault: string, id: string, version: string, label: string, symbol: string, message?: string) => `<form action="${action}" method="post"${message ? ` data-confirm="${escape(message)}"` : ''}><input type="hidden" name="scope" value="${scope}"><input type="hidden" name="vault" value="${escape(vault)}"><input type="hidden" name="entry" value="${escape(id)}"><input type="hidden" name="version" value="${version}"><input type="hidden" name="filter" value="${escape(vaultId)}"><button class="btn${message ? ' danger' : ''}" title="${escape(label)}" aria-label="${escape(label)}">${icon(symbol)}<span>${message ? '彻底删除' : '恢复'}</span></button></form>`;
  const rows = [
    ...listing.vaults.map(vault => `<li><div class="trash-description"><h2>${icon('library')}${escape(vault.name)}</h2><p class="muted">知识库${vault.external ? ' · 外部文件保留' : ''}</p>${copyButton(vault.uri, `复制 Coral 链接：${vault.name}`)}<time class="muted" datetime="${vault.deleted_at}">${escape(new Date(vault.deleted_at).toLocaleString('zh-CN'))}</time></div><div class="btns">${form('/trash/restore', 'vault', vault.id, '', vault.version, `恢复知识库：${vault.name}`, 'rotate-ccw')}${form('/trash/purge', 'vault', vault.id, '', vault.version, `彻底删除知识库：${vault.name}`, 'trash-2', vault.external ? `彻底删除「${vault.name}」的注册回收记录？外部文件仍保留。` : `彻底删除知识库「${vault.name}」及全部文件？此操作无法撤销。`)}</div></li>`),
    ...listing.items.map(item => `<li><div class="trash-description"><h2>${icon(item.kind === 'directory' ? 'folder' : 'file-text')}${escape(item.path.split('/').at(-1))}</h2><p class="muted">${escape(item.vault_name)} · ${item.kind === 'directory' ? '文件夹' : '文档'}</p>${copyButton(item.uri, `复制 Coral 链接：${item.path}`)}<time class="muted" datetime="${item.deleted_at}">${escape(new Date(item.deleted_at).toLocaleString('zh-CN'))}</time></div><div class="btns">${form('/trash/restore', 'item', item.vault_id, item.id, item.version, `恢复：${item.path}`, 'rotate-ccw')}${form('/trash/purge', 'item', item.vault_id, item.id, item.version, `彻底删除：${item.path}`, 'trash-2', `彻底删除「${item.path}」${item.kind === 'directory' ? '及其中全部文件' : ''}？此操作无法撤销。`)}</div></li>`),
  ].join('');
  const backUrl = vaultId && registry.vaults.has(vaultId) ? '/?vault=' + vaultId : '/';
  const header = `<div class="page-head"><h1>回收站 <span class="muted">${listing.items.length + listing.vaults.length} 项</span></h1><div class="btns">${linkButton(backUrl, '返回知识库', 'arrow-left')}${rows ? `<form action="/trash/empty" method="post" data-confirm="清空当前回收站中的全部内容？托管知识库及文件会被彻底删除，外部知识库仅删除注册记录。此操作无法撤销。"><input type="hidden" name="filter" value="${escape(vaultId)}"><input type="hidden" name="version" value="${listing.version}"><button class="btn danger">${icon('trash-2')}清空回收站</button></form>` : ''}</div></div>`;
  return layout(registry, '回收站', `${notice ? `<div class="alert ok" role="status">${notice}</div>` : ''}${listing.skipped ? alert(`${listing.skipped} 项回收内容无法读取，未被清空；原文件仍保留在磁盘。`) : ''}${rows ? `<ul class="trash-list">${rows}</ul>` : '<div class="empty">回收站为空。</div>'}`, { vaultId: vaultId && registry.vaults.has(vaultId) ? vaultId : undefined, header });
}

export function newVault(registry: VaultRegistry, fields: { name?: string; description?: string; error?: string } = {}) {
  const header = `<div class="page-head"><h1>创建知识库</h1>${linkButton('/', '返回', 'arrow-left')}</div>`;
  return layout(registry, '创建知识库', `${alert(fields.error)}
    <form class="form" action="/vaults/new" method="post"><label>仓库名称（英文）<input name="name" required maxlength="64" pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" value="${escape(fields.name)}"></label><label>简介<textarea name="description" rows="3" maxlength="2000">${escape(fields.description)}</textarea></label><button class="btn primary" type="submit">${icon('folder-plus')}创建知识库</button></form>`, { header });
}

export function home(registry: VaultRegistry, vaultId: string, options: { upload?: number; rejected?: number; directory?: string; deleted?: boolean; operation?: RelocationReport } = {}) {
  const vault = registry.vault(vaultId), directory = options.directory ?? '';
  const scan = registry.browse(vaultId, directory);
  const documentCount = directory ? scan.documents.length : scan.total;
  const location = (path: string) => '/?' + new URLSearchParams({ vault: vaultId, directory: path });
  const parts = safeParts(directory, true);
  const remove = (action: string, uri: string, version: string, message: string, label: string, noteVersion?: string) => `<form class="row-delete" action="${action}" method="post" data-confirm="${escape(message)}"><input type="hidden" name="uri" value="${escape(uri)}"><input type="hidden" name="version" value="${escape(version)}">${noteVersion ? `<input type="hidden" name="note_version" value="${escape(noteVersion)}">` : ''}<button type="submit" class="btn danger" title="${escape(label)}" aria-label="${escape(label)}">${icon('trash-2')}<span>删除</span></button></form>`;
  const documentRow = (doc: Document) => {
    const bilingual = (doc.languageVersions?.length ?? 1) > 1;
    const filename = doc.relative.split('/').at(-1)!;
    const filenameLabel = filename.replace(/\.(md|markdown)$/i, '') === doc.title ? '' : `<span class="muted">${escape(filename)}</span>`;
    const actions = copyButton(doc.uri, `复制文档 URI：${doc.title}`) + renameLink(doc.uri, `重命名文档：${doc.title}`)
      + moveLink(doc.uri, `移动文档：${doc.title}`) + remove('/delete', doc.uri, doc.version, bilingual ? `将笔记「${doc.relative}」的全部语言版本移入知识库回收站？` : `将文档「${doc.relative}」移入知识库回收站？`, `删除文档：${doc.title}`, doc.noteVersion);
    return `<li id="${documentAnchor(doc.uri)}" data-document-uri="${escape(doc.uri)}"><div class="file-entry"><a class="page-link" href="${escape(viewUrl(doc.uri))}">${icon('file-text')}${escape(doc.title)}</a><span class="reading-marker" hidden>上次阅读</span>${filenameLabel}</div><span class="muted file-updated">${escape(doc.metadata.updated)}</span><div class="row-actions">${actionMenu(`文档操作：${doc.title}`, actions)}</div></li>`;
  };
  const importForm = `<form class="kb-upload" action="/upload" method="post" enctype="multipart/form-data"><input type="hidden" name="vault" value="${escape(vaultId)}"><input type="hidden" name="directory" value="${escape(directory)}"><input type="file" name="files" accept=".md,.markdown" multiple required aria-label="Markdown 文档"><button class="btn" type="submit">${icon('upload')}上传 Markdown</button></form>`;
  const indexes = scan.documents.filter(doc => isIndexDocument(doc.relative));
  const items = `<ul class="page-list file-list" data-reading-list="${escape(resourceUri(vaultId, directory))}">${directory ? `<li><a href="${escape(location(parts.slice(0, -1).join('/')))}">${icon('corner-left-up')}上级目录</a></li>` : ''}${indexes.map(documentRow).join('')}${scan.directories.map(folder => `<li><div class="file-entry"><a class="page-link" href="${escape(location(folder.relative))}">${icon('folder')}${escape(folder.name)}</a><span class="muted">${folder.document_count} 个文档</span></div><div class="row-actions">${actionMenu(`文件夹操作：${folder.name}`, copyButton(folder.uri, `复制文件夹 URI：${folder.name}`) + (folder.version ? renameLink(folder.uri, `重命名文件夹：${folder.name}`) + remove('/delete-directory', folder.uri, folder.version, `删除文件夹「${folder.relative}」？其中全部 ${folder.file_count} 个文件（含附件）和子目录将一起移入知识库回收站。`, `删除文件夹：${folder.name}`) : ''))}</div></li>`).join('')}${scan.documents.filter(doc => !isIndexDocument(doc.relative)).map(documentRow).join('')}</ul>`;
  const header = `<div class="btns">${linkButton('/new?' + new URLSearchParams({ vault: vaultId, directory }), '创建文档', 'file-plus', true)}${actionMenu('导入文档', importForm, '导入', 'upload')}${actionMenu('知识库工具', linkButton('/directories/new?' + new URLSearchParams({ vault: vaultId, directory }), '创建文件夹', 'folder-plus') + (directory ? renameLink(resourceUri(vaultId, directory), '重命名当前文件夹', 'directory') : '') + copyButton(resourceUri(vaultId, directory)) + linkButton('/lint?vault=' + vaultId, '结构检查', 'scan-search'))}</div>`;
  return layout(registry, vault.name, `
    ${operationNotice(options.operation)}
    <section class="reading-resume" data-reading-resume hidden aria-label="阅读进度"><div><a data-resume-title></a></div><div class="btns"><a class="btn" data-resume-open>继续阅读</a><a class="btn primary" data-resume-next>下一篇</a></div></section>
    ${options.deleted ? '<div class="alert ok" role="status">已移入知识库回收站。</div>' : ''}${options.upload ? `<div class="alert ok">已导入 ${options.upload} 个 Markdown 文档。</div>` : ''}${options.rejected ? alert(`${options.rejected} 个文件无法导入，仅支持有效的 UTF-8 Markdown 文档。`) : ''}${scan.skipped ? alert(`${scan.skipped} 个文档无法读取或超过大小限制。`) : ''}

    ${items}${!scan.documents.length && !scan.directories.length ? '<div class="empty"><p>此目录暂无文档。</p></div>' : ''}`, { vaultId, directory, header, documentCount });
}

export function newDirectory(registry: VaultRegistry, vaultId: string, directory = '', fields: { name?: string; error?: string } = {}) {
  registry.browse(vaultId, directory);
  const backUrl = '/?' + new URLSearchParams({ vault: vaultId, directory });
  const header = `<div class="page-head"><h1>创建文件夹</h1>${linkButton(backUrl, '返回', 'arrow-left')}</div>`;
  return layout(registry, '创建文件夹', `${alert(fields.error)}
    <form class="form" action="/directories/new" method="post"><input type="hidden" name="vault" value="${escape(vaultId)}"><input type="hidden" name="directory" value="${escape(directory)}"><label>文件夹名称<input name="name" required maxlength="255" value="${escape(fields.name)}" autofocus></label><button class="btn primary" type="submit">${icon('folder-plus')}创建文件夹</button></form>`, { vaultId, directory, header });
}

export function newPage(registry: VaultRegistry, vaultId: string, fields: { title?: string; directory?: string; content?: string; error?: string } = {}) {
  registry.vault(vaultId);
  let directory = '';
  try { safeParts(fields.directory ?? '', true); directory = fields.directory ?? ''; }
  catch { /* Keep invalid form input available for correction without making it a navigation link. */ }
  const header = `<div class="page-head"><h1>创建文档</h1><div class="btns">${linkButton('/?' + new URLSearchParams({ vault: vaultId, directory: fields.directory ?? '' }), '返回', 'arrow-left')}<button class="btn primary" form="write-form" type="submit">${icon('save')}创建</button></div></div>`;
  return layout(registry, '创建文档', `${alert(fields.error)}
    <form id="write-form" class="writing-form" action="/new" method="post"><input type="hidden" name="vault" value="${escape(vaultId)}"><div class="document-fields"><label>标题<input name="title" placeholder="文档标题" value="${escape(fields.title)}" required maxlength="200"></label><label>保存目录<input name="directory" placeholder="根目录" value="${escape(fields.directory)}" maxlength="1000"></label></div>
    <input type="hidden" id="preview-vault" value="${escape(vaultId)}">${writingSurface(fields.content ?? '', '正文')}</form>`, { vaultId, directory, header });
}

export function newLanguagePage(registry: VaultRegistry, doc: Document, language: DocumentLanguage, fields: { title?: string; content?: string; version?: string; sourceLanguage?: DocumentLanguage; error?: string; returnTo?: string; conflict?: boolean } = {}) {
  const note = registry.noteLanguages(doc.uri);
  const sourceLanguage = fields.sourceLanguage ?? note.versions.find(item => item.document.uri === doc.uri)!.language;
  const returnTo = searchReturn(fields.returnTo);
  const directory = note.primary.relative.split('/').slice(0, -1).join('/');
  const backUrl = withSearchReturn(viewUrl(doc.uri), returnTo);
  const languageOptions = (selected: DocumentLanguage) => `<option value="zh"${selected === 'zh' ? ' selected' : ''}>中文</option><option value="en"${selected === 'en' ? ' selected' : ''}>English</option>`;
  const header = `<div class="page-head"><h1>添加语言版本</h1><div class="btns">${linkButton(backUrl, '返回阅读', 'arrow-left')}<button class="btn primary" form="language-form" type="submit">${icon('save')}保存版本</button></div></div>`;
  const languageFields = note.grouped ? `<input type="hidden" name="source_language" value="${sourceLanguage}"><input type="hidden" name="language" value="${language}">`
    : `<label>原文语言<select name="source_language">${languageOptions(sourceLanguage)}</select></label><label>新增语言<select name="language">${languageOptions(language)}</select></label>`;
  return layout(registry, '添加语言版本', `${alert(fields.error)}<form id="language-form" class="writing-form" action="/languages/new" method="post"><input type="hidden" name="return_to" value="${escape(returnTo)}"><input type="hidden" name="uri" value="${escape(doc.uri)}"><input type="hidden" name="version" value="${escape(fields.version ?? doc.version)}"><input type="hidden" id="preview-vault" value="${escape(doc.vaultId)}"><input type="hidden" id="preview-context-uri" value="${escape(doc.uri)}"><div class="document-fields language-fields"><label>标题<input name="title" value="${escape(fields.title ?? doc.title)}" required maxlength="200"></label>${languageFields}</div>${writingSurface(fields.content ?? '', '新版本正文')}<div id="conflict-actions" class="btns"${fields.conflict ? '' : ' hidden'}><a class="btn" data-latest-document href="${escape(backUrl)}" target="_blank" rel="noopener">查看最新版本</a><button class="btn" type="button" data-download-draft hidden>下载我的草稿</button></div></form>`, { vaultId: doc.vaultId, directory, filename: note.primary.relative.split('/').at(-1), header, query: returnTo ? new URL(returnTo, 'http://coral.local').searchParams.get('q') ?? '' : '' });
}

export function renamePage(registry: VaultRegistry, entry: ReturnType<VaultRegistry['renameEntry']>, fields: { name?: string; version?: string; noteVersion?: string; error?: string; from?: string; returnTo?: string; details?: AppError['details'] } = {}) {
  const directory = entry.relative.split('/').slice(0, -1).join('/');
  const note = entry.kind === 'document' ? registry.noteLanguages(entry.uri) : undefined;
  const noteVersion = fields.noteVersion ?? (note?.grouped ? note.signature : undefined);
  const backUrl = fields.from === 'document' && entry.kind === 'document' ? withSearchReturn(viewUrl(entry.uri), fields.returnTo)
    : directoryUrl(entry.vaultId, fields.from === 'directory' && entry.kind === 'directory' ? entry.relative : directory);
  const header = `<div class="page-head"><h1>重命名${entry.kind === 'directory' ? '文件夹' : '文件'}</h1><div class="btns">${linkButton(backUrl, '取消', 'arrow-left')}${copyButton(entry.uri)}</div></div>`;
  return layout(registry, '重命名', `${alert(fields.error)}${recoveryNotice(registry, fields.details)}
    <form class="form" action="/rename" method="post"><input type="hidden" name="return_to" value="${escape(searchReturn(fields.returnTo))}"><input type="hidden" name="uri" value="${escape(entry.uri)}"><input type="hidden" name="version" value="${escape(fields.version ?? entry.version)}">${noteVersion ? `<input type="hidden" name="note_version" value="${escape(noteVersion)}">` : ''}<input type="hidden" name="from" value="${escape(fields.from)}"><label>${entry.kind === 'directory' ? '文件夹名称' : '文件名称（含扩展名）'}<input name="name" required maxlength="255" value="${escape(fields.name ?? entry.name)}" autofocus></label><button class="btn primary" type="submit">${icon('save')}保存名称</button></form>`, { vaultId: entry.vaultId, directory, filename: entry.name, header });
}

export function movePage(registry: VaultRegistry, doc: Document, fields: { directory?: string; version?: string; noteVersion?: string; error?: string; from?: string; returnTo?: string; details?: AppError['details'] } = {}) {
  const directory = doc.relative.split('/').slice(0, -1).join('/');
  const note = registry.noteLanguages(doc.uri);
  const noteVersion = fields.noteVersion ?? (note.grouped ? note.signature : undefined);
  const selected = fields.directory ?? directory;
  const directories = registry.listDirectories(doc.vaultId);
  const backUrl = fields.from === 'document' ? withSearchReturn(viewUrl(doc.uri), fields.returnTo) : directoryUrl(doc.vaultId, directory);
  const header = `<div class="page-head"><h1>移动笔记</h1>${linkButton(backUrl, '取消', 'arrow-left')}</div>`;
  return layout(registry, '移动笔记', `${alert(fields.error)}${recoveryNotice(registry, fields.details)}
    <form class="form" action="/move" method="post"><input type="hidden" name="return_to" value="${escape(searchReturn(fields.returnTo))}"><input type="hidden" name="uri" value="${escape(doc.uri)}"><input type="hidden" name="version" value="${escape(fields.version ?? doc.version)}">${noteVersion ? `<input type="hidden" name="note_version" value="${escape(noteVersion)}">` : ''}<input type="hidden" name="from" value="${escape(fields.from)}"><label>目标文件夹<select name="directory">${directories.includes(selected) ? '' : `<option value="${escape(selected)}" selected>${escape(selected || '知识库根目录')}（不可用）</option>`}${directories.map(path => `<option value="${escape(path)}"${path === selected ? ' selected' : ''}>${escape(path || '知识库根目录')}</option>`).join('')}</select></label><button class="btn primary" type="submit">${icon('folder-input')}确认移动</button></form>`, { vaultId: doc.vaultId, directory, filename: doc.relative.split('/').at(-1), header });
}

function writingSurface(content: string, label: string) {
  const tool = (command: string, name: string, symbol: string) => `<button type="button" class="icon-btn" data-editor-command="${command}" aria-label="${name}" title="${name}">${icon(symbol)}</button>`;
  return `<section class="writing-surface" data-mode="split"><div class="draft-notice" hidden role="status"><span data-draft-message>有未保存的本地草稿</span><div class="btns"><button type="button" class="btn small" data-restore-draft>恢复草稿</button><button type="button" class="btn small" data-discard-draft>丢弃草稿</button></div></div>
    <div class="writing-toolbar"><div class="format-tools" role="toolbar" aria-label="Markdown 格式">${tool('undo', '撤销', 'undo-2')}${tool('redo', '重做', 'redo-2')}<span class="tool-divider"></span>${tool('heading', '二级标题', 'heading-2')}${tool('bold', '加粗', 'bold')}${tool('italic', '斜体', 'italic')}${tool('link', '插入链接', 'link')}${tool('list', '无序列表', 'list')}${tool('task', '任务列表', 'list-todo')}${tool('quote', '引用', 'quote')}${tool('code', '代码块', 'code')}</div>
    <div class="writing-modes" role="group" aria-label="编辑视图"><button type="button" data-mode="write" aria-pressed="false">书写</button><button type="button" data-mode="split" aria-pressed="true">分栏</button><button type="button" data-mode="preview" aria-pressed="false">预览</button></div><button type="button" class="icon-btn" data-focus-editor aria-pressed="false" aria-label="专注模式" title="专注模式">${icon('maximize-2')}</button></div>
    <div class="editor-grid"><div class="source-pane"><textarea id="editor" name="content" aria-label="${escape(label)}" spellcheck="false">${escape(content)}</textarea><div id="markdown-editor"></div></div><div id="preview" class="preview md-body" aria-label="文档预览"></div></div>
    <footer class="writing-status"><span id="save-status" role="status" aria-live="polite">未修改</span><span id="word-count"></span></footer><div id="save-error" class="alert" role="alert" hidden></div></section>`;
}

export function documentPage(registry: VaultRegistry, doc: Document, options: { returnTo?: string; operation?: RelocationReport } = {}) {
  const returnTo = searchReturn(options.returnTo);
  const note = registry.noteLanguages(doc.uri);
  doc = note.current;
  const currentLanguage = note.versions.find(item => item.document.uri === doc.uri)!.language;
  const otherLanguage = currentLanguage === 'zh' ? 'en' : 'zh';
  const otherVersion = note.versions.find(item => item.language === otherLanguage)?.document;
  const languageLink = otherVersion ? `<a class="btn" href="${escape(withSearchReturn(viewUrl(otherVersion.uri), returnTo))}" aria-label="切换到${otherLanguage === 'en' ? '英文' : '中文'}"><span lang="${otherLanguage}">${otherLanguage === 'en' ? 'English' : '中文'}</span></a>`
    : `<a class="btn" href="${escape(withSearchReturn('/languages/new?' + new URLSearchParams({ uri: doc.uri, language: otherLanguage }), returnTo))}">添加${otherLanguage === 'en' ? '英文版' : '中文版'}</a>`;
  const directory = note.primary.relative.split('/').slice(0, -1).join('/');
  const documents = registry.scan(doc.vaultId).documents;
  const notes = registry.notes(doc.vaultId);
  const returnUrl = directoryUrl(doc.vaultId, directory) + '#' + documentAnchor(note.primary.uri);
  const siblings = notes.filter(other => other.relative.split('/').slice(0, -1).join('/') === directory);
  const index = siblings.findIndex(other => other.uri === note.primary.uri);
  const neighbor = (other: Document | undefined, next: boolean) => {
    const label = next ? '下一篇' : '上一篇';
    return other ? `<a class="reading-neighbor${next ? ' reading-next' : ''}" rel="${next ? 'next' : 'prev'}" href="${escape(withSearchReturn(viewUrl(other.uri) + '&reading=start', returnTo))}"><span class="reading-direction">${icon(next ? 'chevron-right' : 'chevron-left')}${label}</span><span class="reading-title">${escape(other.title)}</span></a>`
      : `<div class="reading-boundary${next ? ' reading-next' : ''}"><span class="reading-direction">${label}</span><span class="reading-title">${next ? '已是本目录最后一篇' : '这是本目录第一篇'}</span></div>`;
  };
  const readingNav = index < 0 ? '' : `<nav class="reading-nav reading-nav-bottom" aria-label="文末阅读导航">${neighbor(siblings[index - 1], false)}<div class="reading-position"><span>第 ${index + 1} / ${siblings.length} 篇</span><a href="${escape(returnUrl)}">返回目录</a></div>${neighbor(siblings[index + 1], true)}</nav>`;
  const primaryByUri = new Map<string, Document>();
  for (const other of notes) {
    primaryByUri.set(other.uri, other);
    for (const version of other.languageVersions ?? []) primaryByUri.set(version.uri, other);
  }
  const backlinkNotes = new Map<string, Document>();
  for (const version of note.versions) for (const other of backlinksFor(documents, version.document.uri)) {
    const primary = primaryByUri.get(other.uri) ?? other;
    if (primary.uri !== note.primary.uri) backlinkNotes.set(primary.uri, primary);
  }
  const backlinks = [...backlinkNotes.values()];
  const properties = Object.entries(doc.metadata).filter(([key]) => !['title', 'coral_note_id', 'coral_language', 'coral_primary'].includes(key));
  let titleAnchor = '';
  const rendered = renderMarkdownWithOutline(doc.body, documents, doc, editorStyleNonce);
  const renderedBody = rendered.html.replace(/^\s*<h1\b([^>]*)>[\s\S]*?<\/h1>\s*/, (_, attributes: string) => {
    titleAnchor = attributes.match(/\sid="[^"]*"/)?.[0] ?? '';
    rendered.headings.shift();
    return '';
  });
  const header = `<div class="page-head"><h1${titleAnchor}>${escape(doc.title)}</h1><div class="btns">${returnTo ? linkButton(returnTo, '返回搜索', 'arrow-left') : ''}${languageLink}${linkButton(returnUrl, '所在目录', 'folder')}${linkButton(withSearchReturn(editUrl(doc.uri), returnTo), '编辑', 'pencil', true)}${actionMenu('文档操作', copyButton(doc.uri) + renameLink(note.primary.uri, '重命名', 'document', returnTo) + moveLink(note.primary.uri, '移动', 'document', returnTo) + linkButton('/download?uri=' + encodeURIComponent(doc.uri), '下载', 'download') + `<form class="inline" action="/delete" method="post" data-confirm="${note.grouped ? '将这篇笔记的全部语言版本移入知识库回收站？' : '将这个文档移入知识库回收站？'}"><input type="hidden" name="uri" value="${escape(note.primary.uri)}"><input type="hidden" name="version" value="${note.primary.version}">${note.grouped ? `<input type="hidden" name="note_version" value="${note.signature}">` : ''}<button class="btn danger" title="删除" aria-label="删除">${icon('trash-2')}<span>删除</span></button></form>`)}</div></div>`;
  return layout(registry, doc.title, `${operationNotice(options.operation)}${alert(doc.warning ?? note.issue)}
    <div class="alert" role="alert" data-document-update-error hidden></div><article class="md-body" lang="${currentLanguage}" data-reading-version="${doc.version}" data-reading-note-version="${note.signature}" data-reading-note="${escape(note.primary.uri)}" data-reading-document="${escape(doc.uri)}" data-reading-directory="${escape(resourceUri(doc.vaultId, directory))}">${renderedBody}</article>${readingNav}${backlinks.length ? `<section class="backlinks"><h2>反向链接 <span class="muted">${backlinks.length}</span></h2><ul>${backlinks.map(other => `<li><a href="${escape(viewUrl(other.uri))}">${escape(other.title)}</a></li>`).join('')}</ul></section>` : ''}${properties.length ? `<details class="meta"><summary>文档属性</summary><dl>${properties.map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(typeof value === 'object' ? stringify(value).trimEnd() : value)}</dd>`).join('')}</dl></details>` : ''}`, { vaultId: doc.vaultId, directory, filename: note.primary.relative.split('/').at(-1), header, outline: rendered.headings, query: returnTo ? new URL(returnTo, 'http://coral.local').searchParams.get('q') ?? '' : '' });
}

export function editPage(registry: VaultRegistry, doc: Document, options: { content?: string; version?: string; error?: string; returnTo?: string; conflict?: boolean } = {}) {
  const returnTo = searchReturn(options.returnTo);
  const directory = doc.relative.split('/').slice(0, -1).join('/');
  const header = `<div class="page-head"><h1>${escape(doc.title)}</h1><div class="btns">${linkButton(withSearchReturn(viewUrl(doc.uri), returnTo), '返回阅读', 'arrow-left')}<button class="btn primary" form="edit-form" type="submit">${icon('save')}保存</button></div></div>`;
  return layout(registry, '编辑 ' + doc.title, `${alert(options.error)}
    <form id="edit-form" class="writing-form" action="/edit" method="post"><input type="hidden" name="return_to" value="${escape(returnTo)}"><input type="hidden" name="uri" value="${escape(doc.uri)}"><input type="hidden" name="version" value="${escape(options.version ?? doc.version)}"><input type="hidden" id="preview-vault" value="${escape(doc.vaultId)}"><input type="hidden" id="preview-uri" value="${escape(doc.uri)}">${writingSurface(options.content ?? doc.raw, 'Markdown 正文')}<div id="conflict-actions" class="btns"${options.conflict ? '' : ' hidden'}><a class="btn" data-latest-document href="${escape(withSearchReturn(viewUrl(doc.uri), returnTo))}" target="_blank" rel="noopener">查看最新版本</a><button class="btn" type="button" data-download-draft hidden>下载我的草稿</button></div></form>`, { vaultId: doc.vaultId, directory, filename: doc.relative.split('/').at(-1), header, query: returnTo ? new URL(returnTo, 'http://coral.local').searchParams.get('q') ?? '' : '' });
}

export function searchPage(registry: VaultRegistry, vaultId: string | undefined, query: string, cursor = 0) {
  const limit = registry.config.search.results_per_page;
  const searching = Boolean(query.trim());
  const found = searching ? registry.search(query, vaultId, limit, cursor) : { results: [], total: 0, next_cursor: null, unavailable_vaults: [], skipped_documents: 0 };
  const unavailableNames = found.unavailable_vaults.map(uri => [...registry.vaults.values()].find(vault => resourceUri(vault.id) === uri)?.name ?? uri);
  const pageUrl = (offset: number) => '/search?' + new URLSearchParams({ q: query, vault: vaultId ?? '', cursor: String(offset) });
  const header = `<div class="page-head"><h1>搜索${searching ? ` <span class="muted">${found.total} 条结果</span>` : ''}</h1></div>`;
  const resultItems = found.results.map(doc => {
    const noteUri = doc.note_uri ?? doc.uri;
    const notePath = parseUri(noteUri).relative;
    return `<div class="result-item" id="${documentAnchor(noteUri)}" data-document-uri="${escape(noteUri)}"><a href="${escape(withSearchReturn(viewUrl(doc.uri), pageUrl(cursor) + '#' + documentAnchor(noteUri)))}">${highlight(doc.title, query)}</a>${copyButton(doc.uri, `复制 Coral 链接：${doc.title}`)}<a class="result-location" href="${escape(directoryUrl(doc.vault_id, notePath.split('/').slice(0, -1).join('/')) + '#' + documentAnchor(noteUri))}" aria-label="打开结果目录：${escape(notePath)}">${escape(registry.vaults.get(doc.vault_id)?.name ?? doc.vault_id)} / ${highlight(notePath, query)}</a><p class="snippet">${highlight(doc.snippet, query)}</p></div>`;
  }).join('');
  return layout(registry, '搜索', `${unavailableNames.length ? alert(`知识库「${unavailableNames.join('、')}」暂不可用，未包含在搜索结果中。`) : ''}${found.skipped_documents ? alert(`${found.skipped_documents} 个文档无法读取或超过大小限制，未包含在搜索结果中。`) : ''}
    ${resultItems || `<div class="empty">${searching ? '没有找到匹配的内容。' : '输入标题、正文或路径关键词搜索笔记。'}</div>`}
    <nav class="pagination" aria-label="搜索分页">${searching && cursor > 0 ? linkButton(pageUrl(Math.max(0, cursor - limit)), '上一页', 'chevron-left') : ''}${found.next_cursor !== null ? linkButton(pageUrl(found.next_cursor), '下一页', 'chevron-right') : ''}</nav>`, { vaultId, query, header, searchScope: true });
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
  const header = `<div class="page-head"><h1>结构检查</h1></div>`;
  return layout(registry, '结构检查', `<section class="lint-section"><h2>断链 · ${broken.length}</h2><ul>${broken.map(({ doc, target }) => `<li><a href="${escape(viewUrl(doc.uri))}">${escape(doc.title)}</a>：${escape(target)}</li>`).join('') || '<li>没有断链。</li>'}</ul></section>
    <section class="lint-section"><h2>孤立文档</h2><ul>${list(documents.filter(doc => !inbound.has(doc.uri))) || '<li>没有孤立文档。</li>'}</ul></section><section class="lint-section"><h2>无出链文档</h2><ul>${list(documents.filter(doc => !outbound.has(doc.uri))) || '<li>没有无出链文档。</li>'}</ul></section>`, { vaultId, header });
}

export function errorPage(registry: VaultRegistry, message: string, options: { details?: AppError['details']; vaultId?: string } = {}) {
  const header = `<div class="page-head"><h1>无法完成操作</h1></div>`;
  return layout(registry, '无法完成操作', `${alert(message)}${recoveryNotice(registry, options.details)}${linkButton(options.vaultId ? directoryUrl(options.vaultId) : '/', '返回知识库', 'arrow-left')}`, { header, vaultId: options.vaultId });
}
