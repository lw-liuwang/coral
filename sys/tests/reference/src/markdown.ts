import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import hljs from 'highlight.js';
import { posix, extname } from 'node:path';
import { decodedPathCandidates, resourceUri, safeParts } from './content.js';
import type { Document } from './vault.js';
import { configureMath } from './math.js';

export const viewUrl = (uri: string) => '/document?uri=' + encodeURIComponent(uri);
export const editUrl = (uri: string) => '/edit?uri=' + encodeURIComponent(uri);
const headingId = (title: string) => title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
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
  for (const candidate of decodedPathCandidates(target.split('#')[0]).reverse()) {
    const path = posix.normalize(posix.join(posix.dirname(current.relative), candidate)).replace(/\.(md|markdown)$/i, '');
    const document = linkIndex(documents).paths.get(path);
    if (document) return document;
  }
  return undefined;
}

export function resolveLink(target: string, documents: Document[], current?: Document): Document | undefined {
  const index = linkIndex(documents);
  for (const path of decodedPathCandidates(target.split('#')[0])) {
    const base = path.replace(/\.(md|markdown)$/i, '');
    if (!base && current) return current;
    const exact = index.paths.get(base);
    if (exact) return exact;
    if (current) {
      const local = index.paths.get(posix.normalize(posix.join(posix.dirname(current.relative), base)));
      if (local) return local;
    }
    const candidates = index.names.get(base);
    // An existing literal percent-containing name or alias takes priority, even if ambiguous.
    if (candidates?.size) return candidates.size === 1 ? candidates.values().next().value : undefined;
  }
  return undefined;
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

export interface RenderedHeading { id: string; title: string; level: number }

function headingText(tokens: Token[]): string {
  return tokens.map(token => token.type === 'image' ? headingText(token.children ?? [])
    : ['text', 'code_inline', 'math_inline'].includes(token.type) ? token.content
    : ['softbreak', 'hardbreak'].includes(token.type) ? ' ' : '').join('');
}

export function renderMarkdown(body: string, documents: Document[], current?: Document, styleNonce?: string, metadata: Record<string, unknown> | undefined = current?.metadata): string {
  return renderMarkdownWithOutline(body, documents, current, styleNonce, metadata).html;
}

export function renderMarkdownWithOutline(body: string, documents: Document[], current?: Document, styleNonce?: string, metadata: Record<string, unknown> | undefined = current?.metadata) {
  const headings: RenderedHeading[] = [];
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false,
    highlight(code, language) {
      if (language && hljs.getLanguage(language)) return hljs.highlight(code, { language }).value;
      return '';
    },
  });
  const mathStyles = configureMath(md, styleNonce);
  if (metadata?.paragraph_indent === '2em') {
    md.renderer.rules.paragraph_open = (tokens, index, options, _env, renderer) => {
      const children = tokens[index + 1]?.children ?? [];
      const previous = tokens[index - 1];
      const imageParagraph = previous?.type === 'paragraph_close' && tokens[index - 2]?.children?.some(token => token.type === 'image');
      const diagram = previous?.type === 'fence' && /^(?:html|mermaid)(?:\s|$)/i.test(previous.info.trim()) && !/^html\s+source(?:\s|$)/i.test(previous.info.trim());
      const afterVisual = imageParagraph || diagram || previous?.type === 'table_close';
      // Markdown has no caption node. Recognize a numbered caption only beside its visual.
      const caption = afterVisual && /^(?:图|表|Figure|Fig\.?|Table)\s*(?:\d+(?:[.\-–]\d+)*|[一二三四五六七八九十百]+)\s*(?:[:：．、]|\.(?!\d))/i.test(children.filter(token => token.type === 'text' || token.type === 'code_inline').map(token => token.content).join('').trim());
      if (tokens[index].level === 0 && !tokens[index].hidden && children.some(token => token.type === 'text' && token.content.trim())
        && !children.some(token => token.type === 'image') && !caption) tokens[index].attrJoin('class', 'paragraph-indent');
      return renderer.renderToken(tokens, index, options);
    };
  }
  // CommonMark treats punctuation next to emphasis as a word boundary. CJK
  // prose has no spaces between words, so allow punctuation-bearing labels
  // beside CJK characters, while keeping normal delimiter pairing/escaping.
  md.inline.ruler.before('emphasis', 'cjk_emphasis', (state, silent) => {
    if (silent || state.src[state.pos] !== '*') return false;
    const scanned = state.scanDelims(state.pos, true);
    const previous = Array.from(state.src.slice(Math.max(0, state.pos - 2), state.pos)).at(-1) ?? '';
    const next = String.fromCodePoint(state.src.codePointAt(state.pos + scanned.length) ?? 32);
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
    const punctuation = /\p{P}/u;
    const open = scanned.can_open || (cjk.test(previous) && punctuation.test(next));
    const close = scanned.can_close || (punctuation.test(previous) && cjk.test(next));
    if (open === scanned.can_open && close === scanned.can_close) return false;
    for (let i = 0; i < scanned.length; i++) {
      state.push('text', '', 0).content = '*';
      state.delimiters.push({ marker: 0x2A, length: scanned.length, token: state.tokens.length - 1,
        end: -1, open, close });
    }
    state.pos += scanned.length;
    return true;
  });
  const usedIds = new Set<string>();
  const nextHeadingSuffix = new Map<string, number>();
  const originalFence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const [language, mode] = tokens[idx].info.trim().toLowerCase().split(/\s+/);
    if (language === 'html' && mode !== 'source') {
      return `<div class="html-diagram" data-html><details class="html-source"><summary>查看 HTML 源码</summary><pre><code class="language-html">${md.utils.escapeHtml(tokens[idx].content)}</code></pre></details></div>\n`;
    }
    if (tokens[idx].info.trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid') {
      return `<div class="mermaid-diagram" data-mermaid><pre><code class="language-mermaid">${md.utils.escapeHtml(tokens[idx].content)}</code></pre></div>\n`;
    }
    return originalFence(tokens, idx, options, env, self);
  };
  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    const base = headingId(tokens[idx + 1]?.content ?? '') || 'section';
    let id = base;
    let suffix = nextHeadingSuffix.get(base) ?? 1;
    while (usedIds.has(id)) id = base + '-' + suffix++;
    nextHeadingSuffix.set(base, suffix);
    usedIds.add(id);
    tokens[idx].attrSet('id', id);
    const title = headingText(tokens[idx + 1]?.children ?? []);
    headings.push({ id, title: title.trim() || tokens[idx + 1]?.content || '章节', level: Number(tokens[idx].tag.slice(1)) });
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
        const target = href;
        if (/\.(md|markdown)(?:#.*)?$/i.test(target)) {
          const doc = resolveRelativeLink(target, documents, current);
          if (doc) tokens[idx].attrSet('href', viewUrl(doc.uri) + (target.includes('#') ? '#' + encodeURIComponent(headingId(decodeURIComponent(target.split('#')[1]))) : ''));
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
  const html = md.render(body);
  return { html: html + mathStyles(), headings };
}
