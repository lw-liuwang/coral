// This bootstrap runs in an opaque-origin sandbox. Only its parent supplies HTML.
let source: string | undefined;
let started = false;

function render() {
  if (started || source === undefined || document.documentElement.clientWidth === 0) return;
  started = true;
  resizeObserver.disconnect();
  const content = new DOMParser().parseFromString(source, 'text/html');
  const viewport = content.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width,initial-scale=1';
  const style = content.createElement('style');
  style.textContent = '*{box-sizing:border-box}body{display:flow-root;margin:0;padding:16px;font-family:system-ui,"Microsoft YaHei",sans-serif;color:#24292f;line-height:1.6}img,svg,canvas{max-width:100%}button,input,select,textarea{font:inherit}';
  const runtime = content.createElement('script');
  runtime.src = '/static/html-runtime.js';
  content.head.prepend(viewport, style, runtime);
  document.open();
  document.write('<!doctype html>' + content.documentElement.outerHTML);
  document.close();
}

window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'coral-html-render' || typeof event.data.source !== 'string' || source !== undefined) return;
  source = event.data.source;
  render();
});
const resizeObserver = new ResizeObserver(render);
resizeObserver.observe(document.documentElement);

export {};
