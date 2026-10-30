import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  theme: 'neutral',
  fontFamily: 'system-ui, sans-serif',
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  maxTextSize: 100000,
  maxEdges: 1000,
});

const diagram = document.querySelector<HTMLElement>('#diagram')!;
let source: string | undefined;
let started = false;
let rendered = false;
const reportSize = () => {
  if (rendered) parent.postMessage({ type: 'coral-mermaid-result', height: diagram.getBoundingClientRect().height + 16 }, '*');
};

async function render() {
  // Hidden editor previews have no measurable width until the user opens them.
  if (started || source === undefined || document.documentElement.clientWidth === 0) return;
  started = true;
  try {
    if (source.length > 100000) throw new Error('图表源码超过 100000 字符限制');
    const result = await mermaid.render('coral-diagram', source, diagram);
    diagram.innerHTML = result.svg;
    rendered = true;
    reportSize();
  } catch (error) {
    diagram.replaceChildren();
    parent.postMessage({ type: 'coral-mermaid-result', error: String(error instanceof Error ? error.message : error).slice(0, 1000) }, '*');
  }
}

window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'coral-mermaid-render' || typeof event.data.source !== 'string') return;
  if (source !== undefined) return;
  source = event.data.source;
  void render();
});
new ResizeObserver(() => { void render(); reportSize(); }).observe(diagram);
