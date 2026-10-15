import { parse, stringify } from 'yaml';

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function parseMarkdown(raw: string): { metadata: Record<string, unknown>; body: string } {
  raw = raw.replace(/^\uFEFF/, '');
  if (!/^---[ \t]*\r?\n/.test(raw)) return { metadata: {}, body: raw };
  try {
    const match = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(raw);
    if (!match || match.index !== 0) throw new Error('unclosed frontmatter');
    const data: unknown = parse(match[1], { maxAliasCount: 50 });
    if (data !== null && data !== undefined && (typeof data !== 'object' || Array.isArray(data))) throw new Error('mapping required');
    return { metadata: (data ?? {}) as Record<string, unknown>, body: raw.slice(match[0].length) };
  } catch { throw new AppError('Markdown 的 YAML 属性格式无效'); }
}

export function serialize(metadata: Record<string, unknown>, body: string): string {
  return `---\n${stringify(metadata).trimEnd()}\n---\n${body.replace(/^\n/, '')}`;
}

export function titleFor(metadata: Record<string, unknown>, fallback: string): string {
  return typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title : fallback;
}

export function safeParts(relative: string, empty = false): string[] {
  if (relative === '' && empty) return [];
  const parts = relative.split('/');
  if (parts.some(part => !part || part.startsWith('.') || /[\\\x00-\x1f\x7f]/.test(part))) {
    throw new AppError('无效的知识库相对路径');
  }
  return parts;
}

export function resourceUri(vaultId: string, relative = ''): string {
  return `coral://vault/${vaultId}/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

export function parseUri(uri: string): { vaultId: string; relative: string } {
  const match = /^coral:\/\/vault\/([a-zA-Z0-9_-]+)\/(.+)$/.exec(uri);
  if (!match || /[?#]/.test(match[2])) throw new AppError('需要 coral://vault/<知识库ID>/<文档> 资源 URI');
  let segments: string[];
  try { segments = match[2].split('/').map(decodeURIComponent); }
  catch { throw new AppError('资源 URI 编码无效'); }
  if (segments.some(s => s.includes('/'))) throw new AppError('资源 URI 编码无效');
  const relative = segments.join('/');
  safeParts(relative);
  return { vaultId: match[1], relative };
}

export interface Heading { title: string; level: number; offset: number; line: number }
export function headings(raw: string): Heading[] {
  const result: Heading[] = [];
  let offset = 0, lineNumber = 1, fence = '', inFrontmatter = /^(?:\uFEFF)?---\r?\n/.test(raw);
  for (const line of raw.split(/(?<=\n)/)) {
    if (inFrontmatter) {
      if (lineNumber > 1 && /^---\s*$/.test(line)) inFrontmatter = false;
    } else {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
      } else if (!fence) {
        const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading) result.push({ title: heading[2], level: heading[1].length, offset, line: lineNumber });
      }
    }
    offset += line.length;
    lineNumber++;
  }
  return result;
}
