// Report content height after interactions, delayed images and width changes.
let scheduled = false;
function reportSize() {
  if (scheduled) return;
  scheduled = true;
  // Offscreen iframes can suspend animation frames, including in long previews.
  setTimeout(() => {
    scheduled = false;
    if (!document.body) return;
    const height = Math.max(document.body.getBoundingClientRect().height, document.body.scrollHeight);
    parent.postMessage({ type: 'coral-html-result', height: Math.max(1, height) }, '*');
  }, 16);
}

window.addEventListener('DOMContentLoaded', () => {
  const observer = new ResizeObserver(reportSize);
  observer.observe(document.documentElement);
  observer.observe(document.body);
  new MutationObserver(reportSize).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  reportSize();
}, { once: true });
window.addEventListener('load', reportSize);

export {};
