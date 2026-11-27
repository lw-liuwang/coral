import { createIcons, Library, Search, FilePlus, FolderPlus, Upload, Save, ArrowLeft, Pencil, Download, Trash2, Copy, Folder, FolderOpen, FolderInput, FileText, CornerLeftUp, ChevronLeft, ChevronRight, Check, Undo2, Redo2, Heading2, Bold, Italic, Link, List, ListTodo, Quote, Code, Maximize2, Ellipsis, ScanSearch, RotateCcw, RefreshCw, TextCursorInput } from 'lucide';
import { renderDiagrams } from './diagrams.js';
import { renderHtmlBlocks } from './html.js';
import { mountReading } from './reading.js';
import { renderMath } from './math-client.js';
import { mountDirectoryDrafts } from './drafts.js';

const icons = { Library, Search, FilePlus, FolderPlus, Upload, Save, ArrowLeft, Pencil, Download, Trash2, Copy, Folder, FolderOpen, FolderInput, FileText, CornerLeftUp, ChevronLeft, ChevronRight, Check, Undo2, Redo2, Heading2, Bold, Italic, Link, List, ListTodo, Quote, Code, Maximize2, Ellipsis, ScanSearch, RotateCcw, RefreshCw, TextCursorInput };
createIcons({ icons });
const drawerPreferences = (window as Window & { coralDrawers?: {
  isClosed(name: string): boolean; setClosed(name: string, closed: boolean): void;
} }).coralDrawers;

function revealCurrent(container: HTMLElement) {
  const selected = container.querySelector<HTMLElement>('[aria-current="page"], [aria-current="location"]');
  if (!selected || !container.clientHeight) return;
  const viewport = container.getBoundingClientRect(), current = selected.getBoundingClientRect();
  if (current.top < viewport.top || current.bottom > viewport.bottom) {
    container.scrollTop += current.top - viewport.top - (viewport.height - current.height) / 2;
  }
}
for (const drawer of Array.from(document.querySelectorAll<HTMLElement>('[data-drawer]'))) {
  const name = drawer.dataset.drawer!;
  const toggle = document.querySelector<HTMLButtonElement>('[data-drawer-toggle="' + name + '"]')!;
  const label = toggle.textContent!.trim();
  // Start the three-column layout open instead of inheriting the old menu's hidden panels.
  const key = 'coral:drawer:v2:' + name;
  const apply = (closed: boolean) => {
    drawer.dataset.collapsed = String(closed);
    document.body.setAttribute('data-' + name + '-drawer', closed ? 'closed' : 'open');
    drawer.inert = closed;
    toggle.setAttribute('aria-expanded', String(!closed));
    toggle.setAttribute('aria-label', (closed ? '展开' : '收起') + label);
    toggle.title = (closed ? '展开' : '收起') + label;
    if (drawerPreferences) drawerPreferences.setClosed(name, closed);
    else {
      document.documentElement.setAttribute('data-' + name + '-drawer', closed ? 'closed' : 'open');
      try { localStorage.setItem(key, closed ? 'closed' : 'open'); } catch { /* Optional preference. */ }
    }
  };
  let closed = false;
  try { closed = drawerPreferences?.isClosed(name) ?? localStorage.getItem(key) === 'closed'; } catch { /* Navigation works without storage. */ }
  apply(closed);
  toggle.addEventListener('click', () => {
    const closed = drawer.dataset.collapsed !== 'true';
    apply(closed);
    if (!closed) setTimeout(() => {
      const container = drawer.querySelector<HTMLElement>('.sidebar-scroll, .note-list-scroll, .article-toc-scroll');
      if (container) revealCurrent(container);
    }, 180);
  });
}
const drawerControls = document.querySelector<HTMLElement>('.drawer-controls');
if (drawerControls) drawerControls.hidden = false;
document.querySelectorAll<HTMLElement>('.sidebar-scroll, .note-list-scroll').forEach(revealCurrent);

const menus = document.querySelectorAll<HTMLDetailsElement>('.tools-menu');
document.addEventListener('click', event => {
  const path = event.composedPath();
  menus.forEach(menu => { if (!path.includes(menu)) menu.open = false; });
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const menu = (event.target as Element).closest<HTMLDetailsElement>('.tools-menu[open]');
  if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); }
});

document.querySelectorAll<HTMLFormElement>('form[data-confirm]').forEach(form => form.addEventListener('submit', event => {
  if (!window.confirm(form.dataset.confirm)) {
    event.preventDefault();
    (event.submitter as HTMLElement | null)?.focus();
    return;
  }
  let confirmed = form.querySelector<HTMLInputElement>('input[name="confirmed"]');
  if (!confirmed) {
    confirmed = document.createElement('input');
    confirmed.type = 'hidden'; confirmed.name = 'confirmed'; form.append(confirmed);
  }
  confirmed.value = '1';
}));
const copyStatus = document.createElement('span');
copyStatus.className = 'sr-only'; copyStatus.setAttribute('role', 'status'); copyStatus.setAttribute('aria-live', 'polite');
copyStatus.hidden = true;
let copyAnnouncement = 0;
if (document.querySelector('[data-copy]')) document.body.append(copyStatus);
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => {
  const originalTitle = button.title;
  const originalContent = button.innerHTML;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  button.addEventListener('click', async () => {
    const current = ++attempt;
    clearTimeout(timer);
    let message = '已复制';
    try { await navigator.clipboard.writeText(button.dataset.copy ?? ''); }
    catch { message = '复制失败，请重试'; }
    if (current !== attempt) return;
    button.replaceChildren();
    const label = document.createElement('span'); label.textContent = message;
    button.append(label);
    button.title = message;
    const announcement = ++copyAnnouncement;
    copyStatus.hidden = false;
    copyStatus.textContent = message;
    timer = setTimeout(() => {
      button.innerHTML = originalContent; button.title = originalTitle;
      if (announcement === copyAnnouncement) { copyStatus.textContent = ''; copyStatus.hidden = true; }
      createIcons({ icons });
    }, 1800);
  });
});

if (document.querySelector('#editor')) {
  void import('./editor.js').then(({ mountEditor }) => mountEditor()).catch(() => {
    const status = document.querySelector<HTMLElement>('#save-status');
    if (status) status.textContent = '增强编辑暂不可用，仍可书写和保存';
  });
}
renderMath();
mountReading();
mountDirectoryDrafts();
renderDiagrams();
renderHtmlBlocks();
