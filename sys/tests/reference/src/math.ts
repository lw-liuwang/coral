import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type MarkdownIt from 'markdown-it';
import { katex } from '@mdit/plugin-katex';

// Mermaid may use a different KaTeX release. Serve the exact renderer's assets.
export const katexAssetDirectory = dirname(createRequire(import.meta.resolve('@mdit/plugin-katex')).resolve('katex'));

// KaTeX's generated layout uses inline styles. Move only those trusted renderer
// styles into a nonce-bearing stylesheet so the main page keeps its strict CSP.
export function configureMath(md: MarkdownIt, styleNonce?: string) {
  const styles = new Map<string, string>();
  md.use(katex, {
    delimiters: 'all', mathFence: true, trust: false, throwOnError: false,
    maxExpand: 1000, maxSize: 20,
    transformer: (html: string) => html.replace(/ style="([^"<>]*)"/g, (_attribute: string, style: string) => {
      const key = createHash('sha256').update(style).digest('hex');
      styles.set(key, style);
      return ` data-math-style="${key}"`;
    }),
  });
  return () => styles.size ? `<style${styleNonce ? ` nonce="${md.utils.escapeHtml(styleNonce)}"` : ''}>${[...styles].map(([key, style]) => `.md-body [data-math-style="${key}"]{${style}}`).join('')}</style>\n` : '';
}
