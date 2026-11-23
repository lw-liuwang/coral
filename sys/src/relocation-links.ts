import MarkdownIt from 'markdown-it';
import { posix } from 'node:path';
import { AppError, decodedPathCandidates, parseUri, resourceUri, safeParts } from './content.js';
import { resolveLink, resolveRelativeLink } from './markdown.js';
import type { Document } from './vault.js';

export interface UnresolvedLink { uri: string; target: string; reason: string }
interface Destination { start: number; end: number; target: string; fragment?: string; unlocated?: boolean; kind: 'link' | 'image' | 'wiki' | 'wiki-image' }
const images = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const withoutExtension = (path: string) => path.replace(/\.(md|markdown)$/i, '');
const encodedPath = (path: string) => path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())).join('/');
const encodedWikiPath = (path: string) => path.replace(/[%#[\]|]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());

export function rewriteRelocationLinks(documents: Document[], mapping: ReadonlyMap<string, string>, filePaths: ReadonlySet<string> = new Set(mapping.keys())) {
  const relocated = documents.map(doc => ({ ...doc, relative: mapping.get(doc.relative) ?? doc.relative,
    uri: resourceUri(doc.vaultId, mapping.get(doc.relative) ?? doc.relative) }));
  const unresolved_links: UnresolvedLink[] = [];
  const changed: { original: Document; relative: string; raw: string }[] = [];
  const originalPaths = new Set(mapping.keys());
  const relocatedPaths = new Set(mapping.values());
  const relocatedFiles = new Set([...filePaths].map(path => mapping.get(path) ?? path));
  for (const [index, doc] of documents.entries()) {
    const after = relocated[index];
    const unresolved = (target: string, reason: string) => {
      if (!unresolved_links.some(link => link.uri === after.uri && link.target === target && link.reason === reason)) {
        unresolved_links.push({ uri: after.uri, target, reason });
      }
    };
    const destinations = sourceDestinations(doc.raw);
    const edits: { start: number; end: number; value: string }[] = [];
    for (const destination of destinations) {
      const { target, kind } = destination;
      const hash = kind === 'wiki-image' ? -1 : target.indexOf('#');
      const path = hash < 0 ? target : target.slice(0, hash);
      const fragment = destination.fragment ?? (hash < 0 ? '' : target.slice(hash));
      const wiki = kind === 'wiki' || kind === 'wiki-image';
      const image = kind === 'image' || kind === 'wiki-image';
      let replacement: string | undefined;
      if (wiki && !image) {
        const original = resolveLink(target, documents, doc);
        if (!original) { unresolved(target, '目标不存在或名称不唯一'); continue; }
        const expected = resourceUri(doc.vaultId, mapping.get(original.relative) ?? original.relative);
        if (resolveLink(target, relocated, after)?.uri !== expected) {
          const next = mapping.get(original.relative) ?? original.relative;
          replacement = encodedWikiPath(/\.(md|markdown)$/i.test(path) ? next : withoutExtension(next)) + fragment;
          if (resolveLink(replacement, relocated, after)?.uri !== expected) throw new AppError('无法明确保持 Wiki 链接目标，尚未整理：' + doc.uri, 409);
        }
      } else if (!wiki && /^coral:\/\//i.test(path)) {
        try {
          const original = parseUri(path);
          if (original.vaultId !== doc.vaultId) continue;
          const next = mapping.get(original.relative);
          if (next === undefined) { unresolved(target, '目标不存在'); continue; }
          if (next !== original.relative) replacement = resourceUri(doc.vaultId, next).replace(/[()]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()) + fragment;
        } catch { unresolved(target, 'Coral 链接格式无效'); }
      } else if (kind === 'wiki-image') {
        const locate = (source: string, base: string, paths: ReadonlySet<string>, files: ReadonlySet<string>) => {
          for (const candidate of decodedPathCandidates(source)) {
            const relative = posix.normalize(posix.join(posix.dirname(base), candidate));
            try { safeParts(relative); } catch { return undefined; }
            if (paths.has(relative)) return files.has(relative) ? relative : undefined;
          }
          return undefined;
        };
        const originalPath = locate(target, doc.relative, originalPaths, filePaths);
        if (!originalPath || !images.test(originalPath)) { unresolved(target, '图片目标不存在或路径无效'); continue; }
        const next = mapping.get(originalPath)!;
        if (locate(target, after.relative, relocatedPaths, relocatedFiles) !== next) {
          replacement = encodedWikiPath(posix.relative(posix.dirname(after.relative), next));
          if (locate(replacement, after.relative, relocatedPaths, relocatedFiles) !== next) throw new AppError('无法明确保持 Wiki 图片目标，尚未整理：' + doc.uri, 409);
        }
      } else {
        if (!path || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(path)) continue;
        let decoded: string;
        try { decoded = wiki ? path : decodeURIComponent(path); }
        catch { unresolved(target, '链接编码无效'); continue; }
        if (image ? !images.test(decoded) : !/\.(md|markdown)$/i.test(decoded)) continue;
        const originalDocument = image ? undefined : resolveRelativeLink(path, documents, doc);
        const originalPath = image ? posix.normalize(posix.join(posix.dirname(doc.relative), decoded)) : originalDocument?.relative;
        if (!originalPath) { unresolved(target, '目标不存在'); continue; }
        try { safeParts(originalPath); }
        catch { unresolved(target, '目标超出知识库或使用受保护路径'); continue; }
        const original = image ? filePaths.has(originalPath) : Boolean(originalDocument);
        const next = mapping.get(originalPath);
        if (!original || next === undefined) { unresolved(target, '目标不存在'); continue; }
        const currentTarget = posix.normalize(posix.join(posix.dirname(after.relative), decoded));
        const unchanged = image ? currentTarget === next : resolveRelativeLink(path, relocated, after)?.uri === resourceUri(doc.vaultId, next);
        if (!unchanged) {
          const relative = posix.relative(posix.dirname(after.relative), next);
          replacement = (wiki ? relative : encodedPath(relative)) + fragment;
        }
      }
      if (replacement !== undefined && replacement !== target) {
        if (destination.unlocated) throw new AppError('无法准确定位受影响的链接，尚未整理：' + doc.uri, 409);
        edits.push({ start: destination.start, end: destination.end, value: replacement });
      }
    }
    let raw = doc.raw;
    for (const edit of edits.sort((a, b) => b.start - a.start)) raw = raw.slice(0, edit.start) + edit.value + raw.slice(edit.end);
    if (raw !== doc.raw) changed.push({ original: doc, relative: after.relative, raw });
  }
  return { documents: changed, unresolved_links };
}

function sourceDestinations(raw: string): Destination[] {
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?^---[ \t]*(?:\r?\n|$)/m.exec(raw);
  const offset = frontmatter?.index === 0 ? frontmatter[0].length : 0;
  const body = raw.slice(offset);
  const lines = body.split('\n');
  const starts: number[] = [];
  let position = offset;
  for (const line of lines) { starts.push(position); position += line.length + 1; }
  const md = new MarkdownIt({ html: true });
  md.core.ruler.disable('inline');
  const references: Record<string, { href: string }> = {};
  const env = { references };
  const tokens = md.parse(body, env);
  const destinations: Destination[] = [];
  const usedReferences = new Map<string, Set<'link' | 'image'>>();
  let locations: number[] = [];
  let inlineSource = '';
  const referenceKind = (target: string, kinds: Set<'link' | 'image'>) => kinds.has('image') && images.test(target.split('#')[0]) ? 'image' : kinds.has('link') ? 'link' : 'image';
  const capture = (start: number, end: number, target: string, kind: Destination['kind']) => {
    const from = locations[start], to = locations[end - 1];
    if (from === undefined || to === undefined || to - from + 1 !== end - start) {
      destinations.push({ start: -1, end: -1, target, kind, unlocated: true }); return;
    }
    const original = raw.slice(from, to + 1);
    destinations.push({ start: from, end: to + 1, target, kind,
      fragment: original.includes('#') ? original.slice(original.indexOf('#')) : undefined });
  };
  md.inline.ruler.before('link', 'relocation-destination', (state, silent) => {
    if (silent || state.src !== inlineSource) return false;
    const start = state.pos;
    const autolink = /^<(coral:\/\/[^<>\s]+)>/i.exec(state.src.slice(start));
    if (autolink) { capture(start + 1, start + 1 + autolink[1].length, autolink[1], 'link'); return false; }
    const wiki = /^(!?)\[\[([^\]|\r\n]+)(?:\|[^\]\r\n]*)?\]\]/.exec(state.src.slice(start));
    if (wiki) {
      const target = wiki[2].trim();
      const leading = wiki[2].length - wiki[2].trimStart().length;
      capture(start + wiki[1].length + 2 + leading, start + wiki[1].length + 2 + leading + target.length, target, wiki[1] ? 'wiki-image' : 'wiki');
      state.push('text', '', 0).content = wiki[0];
      state.pos += wiki[0].length;
      return true;
    }
    const image = state.src[start] === '!';
    const labelStart = start + (image ? 1 : 0);
    if (state.src[labelStart] !== '[') return false;
    const labelEnd = md.helpers.parseLinkLabel(state, labelStart, !image);
    if (labelEnd < 0) return false;
    let at = labelEnd + 1;
    const kind = image ? 'image' : 'link';
    if (state.src[at] === '(') {
      at++;
      while (/\s/.test(state.src[at] ?? '') && at < state.posMax) at++;
      const destination = md.helpers.parseLinkDestination(state.src, at, state.posMax);
      if (!destination.ok) return false;
      let end = destination.pos;
      while (/\s/.test(state.src[end] ?? '') && end < state.posMax) end++;
      if (end > destination.pos) {
        const title = md.helpers.parseLinkTitle(state.src, end, state.posMax);
        if (title.ok) { end = title.pos; while (/\s/.test(state.src[end] ?? '') && end < state.posMax) end++; }
      }
      if (state.src[end] !== ')') return false;
      const angled = state.src[at] === '<';
      const targetStart = at + (angled ? 1 : 0), targetEnd = destination.pos - (angled ? 1 : 0);
      capture(targetStart, targetEnd, destination.str, kind);
    } else {
      let label = state.src.slice(labelStart + 1, labelEnd);
      if (state.src[at] === '[') {
        const end = state.src.indexOf(']', at + 1);
        if (end < 0) return false;
        label = state.src.slice(at + 1, end) || label;
      }
      const normalized = md.utils.normalizeReference(label);
      if (references[normalized]) {
        const uses = usedReferences.get(normalized) ?? new Set<'link' | 'image'>();
        uses.add(kind); usedReferences.set(normalized, uses);
      }
    }
    return false;
  });
  // A raw HTML fragment is source material, including Markdown-looking text inside it.
  md.inline.ruler.before('html_inline', 'relocation-preserve-html', (state, silent) => {
    const match = /^<([a-z][\w:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/i.exec(state.src.slice(state.pos));
    if (!match || /\/>$/.test(match[0])) return false;
    const tags = /<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/ig;
    tags.lastIndex = state.pos + match[0].length;
    let depth = 1;
    for (let tag = tags.exec(state.src); tag; tag = tags.exec(state.src)) {
      if (tag[1]?.toLowerCase() !== match[1].toLowerCase() || /\/>$/.test(tag[0])) continue;
      depth += tag[0].startsWith('</') ? -1 : 1;
      if (depth) continue;
      const end = tag.index + tag[0].length;
      if (!silent) state.push('text', '', 0).content = state.src.slice(state.pos, end);
      state.pos = end;
      return true;
    }
    return false;
  });
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.map) continue;
    locations = [];
    const contentLines = token.content.split('\n');
    for (const [number, content] of contentLines.entries()) {
      const lineNumber = token.map[0] + number;
      const source = (lines[lineNumber] ?? '').replace(/\r$/, '');
      const column = source.indexOf(content);
      for (let character = 0; character < content.length; character++) locations.push(column < 0 ? NaN : starts[lineNumber] + column + character);
      if (number < contentLines.length - 1) locations.push(starts[lineNumber] + source.length);
    }
    inlineSource = token.content;
    md.inline.parse(token.content, md, env, []);
  }
  const protectedLines = new Set<number>();
  for (const token of tokens) if (['fence', 'code_block', 'html_block'].includes(token.type) && token.map) {
    for (let line = token.map[0]; line < token.map[1]; line++) protectedLines.add(line);
  }
  const seen = new Set<string>();
  let definitionLine = 0;
  const definition = /^([ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?)\[((?:\\.|[^\]\\\r\n])+)\]:[ \t]*(?:\r?\n[ \t]*)?/gm;
  for (const match of body.matchAll(definition)) {
    const label = md.utils.normalizeReference(match[2]);
    const kinds = usedReferences.get(label);
    if (!kinds || seen.has(label)) continue;
    while (definitionLine + 1 < starts.length && starts[definitionLine + 1] <= offset + match.index!) definitionLine++;
    if (protectedLines.has(definitionLine)) continue;
    const at = match.index! + match[0].length;
    const destination = md.helpers.parseLinkDestination(body, at, body.length);
    if (!destination.ok || md.normalizeLink(destination.str) !== references[label]?.href) continue;
    seen.add(label);
    const angled = body[at] === '<';
    const start = offset + at + (angled ? 1 : 0), end = offset + destination.pos - (angled ? 1 : 0);
    const original = raw.slice(start, end);
    destinations.push({ start, end, target: destination.str, fragment: original.includes('#') ? original.slice(original.indexOf('#')) : undefined,
      kind: referenceKind(destination.str, kinds) });
  }
  for (const [label, kinds] of usedReferences) if (!seen.has(label)) destinations.push({ start: -1, end: -1,
    target: references[label].href, kind: referenceKind(references[label].href, kinds), unlocated: true });
  return destinations;
}
