import katex from 'katex';

let mathStyleSequence = 0;

export function renderMath(root: ParentNode = document) {
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="editor-style-nonce"]')?.content;
  const sheet = document.createElement('style');
  if (nonce) sheet.nonce = nonce;
  const rules: string[] = [];
  root.querySelectorAll<HTMLElement>('[data-tex]:not([data-math-rendered])').forEach(block => {
    let index = 0;
    const id = 'math-' + mathStyleSequence++;
    block.innerHTML = katex.renderToString(block.dataset.tex ?? '', {
      displayMode: block.hasAttribute('data-math-display'), trust: false,
      throwOnError: false, maxExpand: 1000, maxSize: 20,
    }).replace(/ style="([^"<>]*)"/g, (_attribute, style: string) => {
      const key = id + '-' + index++;
      rules.push(`[data-math-style="${key}"]{${style}}`);
      return ` data-math-style="${key}"`;
    });
    block.dataset.mathRendered = 'true';
  });
  if (rules.length) {
    sheet.textContent = rules.join('\n');
    const target = root instanceof Document ? root.head : root;
    target.appendChild(sheet);
  }
}
