import { createIcons, Library, Search, FilePlus, FolderPlus, Upload, Save, ArrowLeft, Pencil, Download, Trash2, Copy, Folder, FileText, CornerLeftUp, ChevronLeft, ChevronRight, Check, Undo2, Redo2, Heading2, Bold, Italic, Link, List, ListTodo, Quote, Code, Maximize2, Ellipsis, ScanSearch, RotateCcw, RefreshCw, TextCursorInput } from 'lucide';
import { mountEditor } from './editor.js';
import { renderDiagrams } from './diagrams.js';

const icons = { Library, Search, FilePlus, FolderPlus, Upload, Save, ArrowLeft, Pencil, Download, Trash2, Copy, Folder, FileText, CornerLeftUp, ChevronLeft, ChevronRight, Check, Undo2, Redo2, Heading2, Bold, Italic, Link, List, ListTodo, Quote, Code, Maximize2, Ellipsis, ScanSearch, RotateCcw, RefreshCw, TextCursorInput };
createIcons({ icons });

document.querySelectorAll<HTMLDetailsElement>('.tools-menu').forEach(menu => {
  document.addEventListener('click', event => { if (!menu.contains(event.target as Node)) menu.open = false; });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { menu.open = false; menu.querySelector('summary')?.focus(); }
  });
});

document.querySelectorAll<HTMLSelectElement>('[data-vault-switch]').forEach(select => select.addEventListener('change', () => select.form?.requestSubmit()));
document.querySelectorAll<HTMLFormElement>('form[data-confirm]').forEach(form => form.addEventListener('submit', event => {
  if (!window.confirm(form.dataset.confirm)) event.preventDefault();
}));
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  try {
    const originalTitle = button.title;
    await navigator.clipboard.writeText(button.dataset.copy ?? '');
    button.innerHTML = '<i data-lucide="check"></i>';
    button.title = '已复制';
    createIcons({ icons });
    setTimeout(() => { button.innerHTML = '<i data-lucide="copy"></i>'; button.title = originalTitle; createIcons({ icons }); }, 1500);
  } catch { button.title = '复制失败'; }
}));

mountEditor();
renderDiagrams();
