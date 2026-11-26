import { createIcons, Library, Search, FilePlus, FolderPlus, Upload, Save, ArrowLeft, Pencil, Download, Trash2, Copy, Folder, FolderOpen, FolderInput, FileText, CornerLeftUp, ChevronLeft, ChevronRight, Check, Undo2, Redo2, Heading2, Bold, Italic, Link, List, ListTodo, Quote, Code, Maximize2, Ellipsis, ScanSearch, RotateCcw, RefreshCw, TextCursorInput } from 'lucide';
import { mountEditor } from './editor.js';
import { renderDiagrams } from './diagrams.js';
import { renderHtmlBlocks } from './html.js';
import { mountReading } from './reading.js';
import { renderMath } from './math-client.js';

const icons = { Library, Search, FilePlus, FolderPlus, Upload, Save, ArrowLeft, Pencil, Download, Trash2, Copy, Folder, FolderOpen, FolderInput, FileText, CornerLeftUp, ChevronLeft, ChevronRight, Check, Undo2, Redo2, Heading2, Bold, Italic, Link, List, ListTodo, Quote, Code, Maximize2, Ellipsis, ScanSearch, RotateCcw, RefreshCw, TextCursorInput };
createIcons({ icons });

const treeScroll = document.querySelector<HTMLElement>('.sidebar-scroll');
const currentFolder = treeScroll?.querySelector<HTMLElement>('[aria-current="page"]');
if (treeScroll && currentFolder) {
  const viewport = treeScroll.getBoundingClientRect(), current = currentFolder.getBoundingClientRect();
  if (current.top < viewport.top || current.bottom > viewport.bottom) {
    treeScroll.scrollTop += current.top - viewport.top - (viewport.height - current.height) / 2;
  }
}

const menus = document.querySelectorAll<HTMLDetailsElement>('.tools-menu');
document.addEventListener('click', event => {
  menus.forEach(menu => { if (!menu.contains(event.target as Node)) menu.open = false; });
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const menu = (event.target as Element).closest<HTMLDetailsElement>('.tools-menu[open]');
  if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); }
});

document.querySelectorAll<HTMLFormElement>('form[data-confirm]').forEach(form => form.addEventListener('submit', event => {
  if (!window.confirm(form.dataset.confirm)) event.preventDefault();
}));
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  try {
    const originalTitle = button.title;
    const originalContent = button.innerHTML;
    const label = button.querySelector('span')?.outerHTML ?? '';
    await navigator.clipboard.writeText(button.dataset.copy ?? '');
    button.innerHTML = '<i data-lucide="check"></i>' + label;
    button.title = '已复制';
    createIcons({ icons });
    setTimeout(() => { button.innerHTML = originalContent; button.title = originalTitle; createIcons({ icons }); }, 1500);
  } catch { button.title = '复制失败'; }
}));

mountEditor();
renderMath();
mountReading();
renderDiagrams();
renderHtmlBlocks();
