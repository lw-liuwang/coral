type Katex = typeof import('katex')['default'];
interface Formula { html: string; rules: string[] }
interface MathJob {
  root: ParentNode;
  pending: HTMLElement[];
  styles: HTMLStyleElement;
  added: Set<Formula>;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

let runtime: Katex | undefined;
let loading: Promise<Katex> | undefined;
let sequence = 0;
const templates = new Map<string, Formula>();
const jobs = new WeakMap<ParentNode, MathJob>();
const active = new Set<MathJob>();

function formula(source: string, displayMode: boolean): Formula {
  const key = JSON.stringify([source, displayMode]);
  let result = templates.get(key);
  if (result) return result;
  const id = 'math-' + sequence++;
  const rules: string[] = [];
  const html = runtime!.renderToString(source, {
    displayMode, trust: false, throwOnError: false, maxExpand: 1000, maxSize: 20,
  }).replace(/ style="([^"<>]*)"/g, (_attribute, style: string) => {
    const name = id + '-' + rules.length;
    rules.push(`[data-math-style="${name}"]{${style}}`);
    return ` data-math-style="${name}"`;
  });
  result = { html, rules };
  if (templates.size >= 256) templates.delete(templates.keys().next().value!);
  templates.set(key, result);
  return result;
}

function renderBlock(job: MathJob, block: HTMLElement) {
  if (!block.isConnected || !job.root.contains(block)) return;
  const rendered = formula(block.dataset.tex ?? '', block.hasAttribute('data-math-display'));
  if (!job.added.has(rendered)) {
    for (const rule of rendered.rules) job.styles.sheet!.insertRule(rule, job.styles.sheet!.cssRules.length);
    job.added.add(rendered);
  }
  block.innerHTML = rendered.html;
  block.dataset.mathRendered = 'true';
}

function finish(job: MathJob) {
  job.cancelled = true;
  active.delete(job);
  document.dispatchEvent(new CustomEvent('coral:math-ready', { detail: { root: job.root } }));
}

function renderBatch(job: MathJob) {
  if (job.cancelled) return;
  // Keep the visible paragraph in place as formulas above it acquire their height.
  const article = job.root instanceof Document ? job.root.querySelector('article[data-reading-document]') : null;
  const top = Math.max(0, document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) + 24;
  const bounds = article?.getBoundingClientRect();
  const anchor = bounds ? document.elementFromPoint(Math.min(innerWidth - 1, bounds.left + bounds.width / 2), top)
    ?.closest<HTMLElement>('p,h1,h2,h3,h4,h5,h6,li,pre,table') : null;
  const anchorY = anchor && article?.contains(anchor) ? anchor.getBoundingClientRect().top : undefined;
  const started = performance.now();
  do {
    renderBlock(job, job.pending.shift()!);
  } while (job.pending.length && performance.now() - started < 8);
  if (anchorY !== undefined && anchor?.isConnected) {
    const difference = anchor.getBoundingClientRect().top - anchorY;
    if (Math.abs(difference) > 1) window.scrollBy(0, difference);
  }
  if (job.pending.length) job.timer = setTimeout(() => renderBatch(job), 0);
  else finish(job);
}

export function renderMath(root: ParentNode = document) {
  const previous = jobs.get(root);
  if (previous) {
    previous.cancelled = true;
    clearTimeout(previous.timer);
    active.delete(previous);
  }
  const pending = Array.from(root.querySelectorAll<HTMLElement>('[data-tex]:not([data-math-rendered])'));
  if (!pending.length) return;
  const styles = document.createElement('style');
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="editor-style-nonce"]')?.content;
  if (nonce) styles.nonce = nonce;
  (root instanceof Document ? root.head : root).appendChild(styles);
  const job: MathJob = { root, pending, styles, added: new Set(), cancelled: false };
  jobs.set(root, job);
  active.add(job);
  loading ??= import('katex').then(module => (runtime = module.default));
  void loading.then(() => {
    if (job.cancelled) return;
    // Reading restoration runs first. Then render its viewport before distant formulas.
    requestAnimationFrame(() => {
      if (job.cancelled) return;
      const positions = new Map(pending.map(block => [block, block.getBoundingClientRect().top]));
      const priority = (block: HTMLElement) => {
        const y = positions.get(block)!;
        return y >= 0 && y <= innerHeight ? -1 : Math.min(Math.abs(y), Math.abs(y - innerHeight));
      };
      pending.sort((a, b) => priority(a) - priority(b));
      renderBatch(job);
    });
  }).catch(() => {
    loading = undefined;
    active.delete(job); // The original TeX remains readable if the module cannot load.
  });
}

window.addEventListener('beforeprint', () => {
  if (!runtime) return;
  for (const job of active) {
    clearTimeout(job.timer);
    if (!job.cancelled) while (job.pending.length) renderBlock(job, job.pending.shift()!);
    finish(job);
  }
});
