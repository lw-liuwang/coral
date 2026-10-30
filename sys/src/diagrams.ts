const frames = new WeakMap<Window, HTMLIFrameElement>();

window.addEventListener('message', event => {
  const frame = event.source && frames.get(event.source as Window);
  if (!frame?.isConnected || event.data?.type !== 'coral-mermaid-result') return;
  const block = frame.parentElement!;
  if (event.data.error) {
    block.dataset.mermaidState = 'error';
    frame.remove();
    const message = document.createElement('p');
    message.className = 'mermaid-error';
    message.setAttribute('role', 'alert');
    message.textContent = 'Mermaid 图表无法渲染：' + String(event.data.error).slice(0, 1000);
    block.prepend(message);
  } else if (Number.isFinite(event.data.height) && event.data.height > 0) {
    frame.style.height = Math.min(50000, Math.ceil(event.data.height)) + 'px';
    block.dataset.mermaidState = 'rendered';
  }
});

export function renderDiagrams(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-mermaid]:not([data-mermaid-state])').forEach(block => {
    const source = block.querySelector('code')?.textContent ?? '';
    block.dataset.mermaidState = 'loading';
    const frame = document.createElement('iframe');
    frame.className = 'mermaid-frame';
    frame.title = 'Mermaid 图表';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = '/static/mermaid.html';
    frame.addEventListener('load', () => {
      if (!frame.contentWindow) return;
      frames.set(frame.contentWindow, frame);
      frame.contentWindow.postMessage({ type: 'coral-mermaid-render', source }, '*');
    }, { once: true });
    block.prepend(frame);
  });
}
