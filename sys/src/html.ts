const frames = new WeakMap<Window, HTMLIFrameElement>();

window.addEventListener('message', event => {
  const frame = event.source && frames.get(event.source as Window);
  if (!frame?.isConnected || event.data?.type !== 'coral-html-result') return;
  if (Number.isFinite(event.data.height) && event.data.height > 0) {
    frame.style.height = Math.max(120, Math.min(1600, Math.ceil(event.data.height))) + 'px';
    frame.parentElement!.dataset.htmlState = 'rendered';
  }
});

export function renderHtmlBlocks(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-html]:not([data-html-state])').forEach(block => {
    const source = block.querySelector('code')?.textContent ?? '';
    block.dataset.htmlState = 'loading';
    const frame = document.createElement('iframe');
    frame.className = 'html-frame';
    frame.title = 'HTML 交互图';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = '/static/html-frame.html';
    frame.addEventListener('load', () => {
      if (!frame.contentWindow) return;
      frames.set(frame.contentWindow, frame);
      frame.contentWindow.postMessage({ type: 'coral-html-render', source }, '*');
    }, { once: true });
    block.prepend(frame);
  });
}
