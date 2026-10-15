import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { posix, extname } from 'node:path';
import { resourceUri, safeParts } from './content.js';
import type { Document } from './vault.js';

export const viewUrl = (uri: string) => '/document?uri=' + encodeURIComponent(uri);
export const editUrl = (uri: string) => '/edit?uri=' + encodeURIComponent(uri);
export const headingId = (title: string) => title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
const linkIndexes = new WeakMap<Document[], { paths: Map<string, Document>; names: Map<string, Set<Document>> }>();

function linkIndex(documents: Document[]) {
  let index = linkIndexes.get(documents);
  if (!index) {
    index = { paths: new Map(), names: new Map() };
    for (const doc of documents) {
      const path = doc.relative.replace(/\.(md|markdown)$/i, '');
      index.paths.set(path, doc);
      const parts = path.split('/');
      const names = parts.map((_, i) => parts.slice(i).join('/'));
      if (Array.isArray(doc.metadata.aliases)) names.push(...doc.metadata.aliases.filter((name): name is string => typeof name === 'string'));
      for (const name of names) {
        if (!index.names.has(name)) index.names.set(name, new Set());
        index.names.get(name)!.add(doc);
      }
    }
    linkIndexes.set(documents, index);
  }
  return index;
}

export function resolveRelativeLink(target: string, documents: Document[], current: Document) {
  const path = posix.normalize(posix.join(posix.dirname(current.relative), target.split('#')[0])).replace(/\.(md|markdown)$/i, '');
  return linkIndex(documents).paths.get(path);
}

export function resolveLink(target: string, documents: Document[], current?: Document): Document | undefined {
  let base = target.split('#')[0].replace(/^wiki\//, '').replace(/\.(md|markdown)$/i, '');
  if (!base && current) return current;
  const index = linkIndex(documents);
  const exact = index.paths.get(base);
  if (exact) return exact;
  if (current) {
    base = posix.normalize(posix.join(posix.dirname(current.relative), base));
    const local = index.paths.get(base);
    if (local) return local;
  }
  const short = target.split('#')[0].replace(/\.(md|markdown)$/i, '');
  const candidates = index.names.get(short);
  return candidates?.size === 1 ? candidates.values().next().value : undefined;
}

const backlinkIndexes = new WeakMap<Document[], Map<string, Document[]>>();
const documentTargets = new WeakMap<Document, string[]>();
export function backlinksFor(documents: Document[], uri: string) {
  let index = backlinkIndexes.get(documents);
  if (!index) {
    index = new Map();
    for (const doc of documents) {
      let links = documentTargets.get(doc);
      if (!links) { links = wikiTargets(doc.body); documentTargets.set(doc, links); }
      const targets = new Set(links.map(target => resolveLink(target, documents, doc)?.uri));
      for (const target of targets) {
        if (!target || target === doc.uri) continue;
        if (!index.has(target)) index.set(target, []);
        index.get(target)!.push(doc);
      }
    }
    backlinkIndexes.set(documents, index);
  }
  return index.get(uri) ?? [];
}

export function wikiTargets(body: string): string[] {
  if (!body.includes('[[')) return [];
  const md = new MarkdownIt({ html: false });
  const result: string[] = [];
  for (const block of md.parse(body, {})) {
    for (const child of block.children ?? []) {
      if (child.type !== 'text') continue;
      for (const match of child.content.matchAll(/(?<!!)\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g)) result.push(match[1].trim());
    }
  }
  return result;
}

export function renderMarkdown(body: string, documents: Document[], current?: Document): string {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false,
    highlight(code, language) {
      if (language && hljs.getLanguage(language)) return hljs.highlight(code, { language }).value;
      return '';
    },
  });
  const usedIds = new Map<string, number>();
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const base = headingId(tokens[idx + 1]?.content ?? '');
    const count = usedIds.get(base) ?? 0;
    usedIds.set(base, count + 1);
    tokens[idx].attrSet('id', base + (count ? '-' + count : ''));
    return self.renderToken(tokens, idx, options);
  };
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const match = /^(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) {
      const target = match[2].trim(), label = match[3]?.trim() || target;
      if (match[1]) {
        if (current && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(target)) {
          const relative = posix.normalize(posix.join(posix.dirname(current.relative), target));
          try {
            safeParts(relative);
            const token = state.push('image', 'img', 0);
            token.attrSet('src', '/asset?uri=' + encodeURIComponent(resourceUri(current.vaultId, relative)));
            token.attrSet('alt', target);
            const description = new state.Token('text', '', 0);
            description.content = target;
            token.children = [description];
            if (/^\d{1,4}$/.test(match[3] ?? '')) token.attrSet('width', match[3]);
          } catch { const token = state.push('text', '', 0); token.content = match[0]; }
        } else { const token = state.push('text', '', 0); token.content = match[0]; }
      } else {
        const doc = resolveLink(target, documents, current);
        const heading = target.includes('#') ? '#' + encodeURIComponent(headingId(target.slice(target.indexOf('#') + 1))) : '';
        const token = state.push('link_open', 'a', 1);
        token.attrSet('href', doc ? viewUrl(doc.uri) + heading : '/new?vault=' + encodeURIComponent(current?.vaultId ?? 'default') + '&title=' + encodeURIComponent(target.split('#')[0]));
        if (!doc) { token.attrSet('class', 'broken'); token.attrSet('title', '页面不存在'); }
        const text = state.push('text', '', 0); text.content = label;
        state.push('link_close', 'a', -1);
      }
    }
    state.pos += match[0].length;
    return true;
  });
  const originalLink = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet('href') ?? '';
    if (current && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) {
      try {
        const target = decodeURIComponent(href);
        if (/\.(md|markdown)(?:#.*)?$/i.test(target)) {
          const doc = resolveRelativeLink(target, documents, current);
          if (doc) tokens[idx].attrSet('href', viewUrl(doc.uri) + (target.includes('#') ? '#' + encodeURIComponent(headingId(target.split('#')[1])) : ''));
          else tokens[idx].attrSet('class', 'broken');
        }
      } catch { /* Preserve malformed URLs as inert Markdown output. */ }
    }
    return originalLink ? originalLink(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
  const originalImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const src = tokens[idx].attrGet('src') ?? '';
    if (current && !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(src)) {
      try {
        const relative = posix.normalize(posix.join(posix.dirname(current.relative), decodeURIComponent(src)));
        safeParts(relative);
        if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(extname(relative))) tokens[idx].attrSet('src', '/asset?uri=' + encodeURIComponent(resourceUri(current.vaultId, relative)));
      } catch { tokens[idx].attrSet('src', ''); }
    }
    return originalImage(tokens, idx, options, env, self);
  };
  return md.render(body);
}
