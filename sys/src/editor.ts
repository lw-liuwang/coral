import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting, indentOnInput } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { renderDiagrams } from './diagrams.js';
import { renderHtmlBlocks } from './html.js';
import { renderMath } from './math-client.js';

interface Draft { content: string; title: string; directory: string; version: string; updated: number; language?: string; sourceLanguage?: string }

export function mountEditor() {
  const fallbackTextarea = document.querySelector<HTMLTextAreaElement>('#editor');
  const host = document.querySelector<HTMLElement>('#markdown-editor');
  const surface = document.querySelector<HTMLElement>('.writing-surface');
  const preview = document.querySelector<HTMLElement>('#preview');
  if (!fallbackTextarea || !host || !surface || !preview || !fallbackTextarea.form) return;
  const form = fallbackTextarea.form;
  let textarea: HTMLTextAreaElement | HTMLInputElement = fallbackTextarea;
  const title = form.querySelector<HTMLInputElement>('[name="title"]');
  const directory = form.querySelector<HTMLInputElement>('[name="directory"]');
  const version = form.querySelector<HTMLInputElement>('[name="version"]');
  const language = form.querySelector<HTMLInputElement | HTMLSelectElement>('[name="language"]');
  const sourceLanguage = form.querySelector<HTMLInputElement | HTMLSelectElement>('[name="source_language"]');
  const vault = document.querySelector<HTMLInputElement>('#preview-vault')!.value;
  const uri = document.querySelector<HTMLInputElement>('#preview-uri')?.value;
  const previewContextUri = document.querySelector<HTMLInputElement>('#preview-context-uri')?.value;
  const draftUrl = new URL(location.href);
  if (!uri && !/^[A-Za-z0-9_-]{8,100}$/.test(draftUrl.searchParams.get('draft') ?? '')) {
    const draftId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    draftUrl.searchParams.set('draft', draftId);
    window.history.replaceState(window.history.state, '', draftUrl);
  }
  const draftKey = `coral:draft:${uri ?? `new:${vault}:${draftUrl.searchParams.get('draft')}`}`;
  const legacyDraftKey = !uri && !previewContextUri ? `coral:draft:new:${vault}` : undefined;
  const status = document.querySelector<HTMLElement>('#save-status')!;
  const count = document.querySelector<HTMLElement>('#word-count')!;
  const errorBox = document.querySelector<HTMLElement>('#save-error')!;
  const conflictActions = document.querySelector<HTMLElement>('#conflict-actions');
  const downloadDraft = document.querySelector<HTMLButtonElement>('[data-download-draft]');
  if (downloadDraft) downloadDraft.hidden = false;
  const notice = surface.querySelector<HTMLElement>('.draft-notice')!;
  const saveButton = document.querySelector<HTMLButtonElement>(`button[form="${form.id}"]`)!;
  let saving = false;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let draftTimer: ReturnType<typeof setTimeout>;
  let controller: AbortController | undefined;
  const snapshot = (): Draft => ({ content: textarea.value, title: title?.value ?? '', directory: directory?.value ?? '', version: version?.value ?? '', updated: Date.now(), language: language?.value, sourceLanguage: sourceLanguage?.value });
  const fingerprint = (draft: Draft) => JSON.stringify([draft.content, draft.title, draft.directory, draft.language ?? '', draft.sourceLanguage ?? '']);
  const defaultLanguage = (field: HTMLInputElement | HTMLSelectElement | null) => field instanceof HTMLSelectElement
    ? Array.from(field.options).find(option => option.defaultSelected)?.value ?? field.options[0]?.value
    : field?.defaultValue;
  let baseline = fingerprint({ ...snapshot(), content: fallbackTextarea.defaultValue,
    title: title?.defaultValue ?? '', directory: directory?.defaultValue ?? '',
    language: defaultLanguage(language), sourceLanguage: defaultLanguage(sourceLanguage) });
  const dirty = () => fingerprint(snapshot()) !== baseline;
  let pendingDraft: Draft | undefined;
  let pendingDraftKey = draftKey;
  try {
    let raw = localStorage.getItem(draftKey);
    if (!raw && legacyDraftKey) {
      raw = localStorage.getItem(legacyDraftKey);
      if (raw) pendingDraftKey = legacyDraftKey;
    }
    const saved: unknown = JSON.parse(raw ?? 'null');
    if (saved && typeof saved === 'object' && ['content', 'title', 'version'].every(key => typeof (saved as Record<string, unknown>)[key] === 'string')) {
      const draft = { ...saved, directory: typeof (saved as Draft).directory === 'string' ? (saved as Draft).directory : '' } as Draft;
      if (fingerprint(draft) !== baseline) { pendingDraft = draft; notice.hidden = false; }
    }
  } catch { /* Storage can be disabled by the browser. */ }

  async function render() {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    try {
      const response = await fetch('/api/preview', { method: 'POST', signal: request.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: textarea!.value, vault, uri, context_uri: previewContextUri }) });
      const data = await response.json();
      if (request.signal.aborted) return;
      if (response.ok) {
        preview!.innerHTML = data.html;
        renderMath(preview!);
        renderDiagrams(preview!);
        renderHtmlBlocks(preview!);
      }
      else preview!.textContent = data.error ?? '预览暂不可用';
    } catch {
      if (!request.signal.aborted) preview!.textContent = '预览暂不可用';
    }
  }

  function persist() {
    clearTimeout(draftTimer);
    if (!dirty()) { status.textContent = '未修改'; return; }
    try {
      localStorage.setItem(draftKey, JSON.stringify(snapshot()));
      status.textContent = saving ? '正在保存…' : '草稿已存于本机';
    } catch { status.textContent = '未保存 · 本地草稿不可用'; }
  }

  function changed() {
    count.textContent = `${Array.from(textarea!.value).length.toLocaleString()} 字符 · ${textarea!.value.split('\n').length} 行`;
    clearTimeout(previewTimer);
    // Abort immediately so an older response cannot replace the latest preview.
    controller?.abort();
    previewTimer = setTimeout(() => void render(), 250);
    clearTimeout(draftTimer);
    status.textContent = saving ? '正在保存…' : dirty() ? '未保存' : '未修改';
    if (dirty()) {
      pendingDraft = undefined;
      notice.hidden = true;
      draftTimer = setTimeout(persist, 400);
    } else if (!pendingDraft) {
      try { localStorage.removeItem(draftKey); } catch { /* Optional storage. */ }
    }
  }

  function wrap(before: string, after: string, fallback: string) {
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to) || fallback;
    view.dispatch({ changes: { from, to, insert: before + selected + after },
      selection: EditorSelection.range(from + before.length, from + before.length + selected.length), scrollIntoView: true });
    view.focus();
  }

  function prefix(value: string) {
    const { from, to } = view.state.selection.main;
    const first = view.state.doc.lineAt(from), last = view.state.doc.lineAt(to);
    const lines = view.state.sliceDoc(first.from, last.to).split('\n');
    const remove = lines.every(line => line.startsWith(value));
    view.dispatch({ changes: { from: first.from, to: last.to, insert: lines.map(line => remove ? line.slice(value.length) : value + line).join('\n') }, scrollIntoView: true });
    view.focus();
  }

  const commands: Record<string, () => void> = {
    undo: () => { undo(view); view.focus(); }, redo: () => { redo(view); view.focus(); },
    bold: () => wrap('**', '**', '加粗文字'), italic: () => wrap('*', '*', '斜体文字'),
    link: () => wrap('[', '](https://)', '链接文字'), code: () => wrap('```\n', '\n```', '代码'),
    heading: () => prefix('## '), list: () => prefix('- '), task: () => prefix('- [ ] '), quote: () => prefix('> '),
  };
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: textarea.value, extensions: [
    EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name="editor-style-nonce"]')!.content),
    lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(), history(),
    yamlFrontmatter({ content: markdown() }), syntaxHighlighting(defaultHighlightStyle), bracketMatching(), closeBrackets(), indentOnInput(),
    highlightSelectionMatches(), EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': textarea.getAttribute('aria-label') ?? 'Markdown 正文', spellcheck: 'false' }),
    keymap.of([
      { key: 'Mod-s', run: () => { form.requestSubmit(); return true; } },
      { key: 'Mod-Enter', run: () => { form.requestSubmit(); return true; } },
      { key: 'Mod-b', run: () => { commands.bold(); return true; } },
      { key: 'Mod-i', run: () => { commands.italic(); return true; } },
      ...markdownKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab,
    ]),
    EditorView.updateListener.of(update => { if (update.docChanged) { textarea!.value = update.state.doc.toString(); changed(); } }),
  ] }) });
  const submittedContent = document.createElement('input');
  submittedContent.type = 'hidden';
  submittedContent.id = 'editor';
  submittedContent.name = 'content';
  submittedContent.value = textarea.value;
  textarea.replaceWith(submittedContent);
  textarea = submittedContent;
  document.body.classList.add('writing-page');
  title?.addEventListener('input', changed);
  directory?.addEventListener('input', changed);
  language?.addEventListener('change', changed);
  sourceLanguage?.addEventListener('change', changed);
  surface.querySelectorAll<HTMLButtonElement>('[data-editor-command]').forEach(button => {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => commands[button.dataset.editorCommand!]?.());
  });
  const setMode = (mode: string) => {
    surface.dataset.mode = mode;
    surface.querySelectorAll<HTMLButtonElement>('button[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
    if (mode !== 'preview') view.requestMeasure();
  };
  if (matchMedia('(max-width: 800px)').matches) setMode('write');
  surface.querySelectorAll<HTMLButtonElement>('button[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode!)));
  const focusButton = surface.querySelector<HTMLButtonElement>('[data-focus-editor]')!;
  const setFocus = (active: boolean) => {
    document.body.classList.toggle('editor-focused', active);
    focusButton.setAttribute('aria-pressed', String(active));
    view.requestMeasure();
  };
  focusButton.addEventListener('click', () => setFocus(!document.body.classList.contains('editor-focused')));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') setFocus(false);
    if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); form.requestSubmit();
    }
  });
  surface.querySelector('[data-restore-draft]')!.addEventListener('click', () => {
    if (!pendingDraft) return;
    const draft = pendingDraft;
    if (title) title.value = draft.title;
    if (directory) directory.value = draft.directory;
    if (language && (draft.language === 'zh' || draft.language === 'en')) language.value = draft.language;
    if (sourceLanguage && (draft.sourceLanguage === 'zh' || draft.sourceLanguage === 'en')) sourceLanguage.value = draft.sourceLanguage;
    // Keep the original version so restoring an old draft never overwrites external edits.
    if (version) version.value = draft.version;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draft.content } });
    notice.hidden = true;
    pendingDraft = undefined;
    changed(); persist();
    if (pendingDraftKey !== draftKey) {
      try {
        if (localStorage.getItem(draftKey)) localStorage.removeItem(pendingDraftKey);
      } catch { /* Keep the legacy draft if migration could not be saved. */ }
      pendingDraftKey = draftKey;
    }
    view.focus();
  });
  surface.querySelector('[data-discard-draft]')!.addEventListener('click', () => {
    try { localStorage.removeItem(pendingDraftKey); } catch { /* Optional storage. */ }
    pendingDraft = undefined; notice.hidden = true;
    pendingDraftKey = draftKey;
  });
  downloadDraft?.addEventListener('click', () => {
    const blob = new Blob([textarea.value], { type: 'text/markdown;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = (title?.value || 'coral-draft').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-') + '.md';
    link.click();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  });
  window.addEventListener('beforeunload', event => {
    if (dirty()) { persist(); event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && dirty()) persist(); });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    saving = true; saveButton.disabled = true;
    if (!uri) form.inert = true;
    errorBox.hidden = true;
    if (conflictActions) conflictActions.hidden = true;
    status.textContent = '正在保存…';
    clearTimeout(draftTimer);
    const submitted = fingerprint(snapshot());
    try {
      const payload = new URLSearchParams();
      new FormData(form).forEach((value, key) => { if (typeof value === 'string') payload.set(key, value); });
      const response = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, body: payload });
      const data = await response.json();
      if (response.status === 409 && conflictActions) conflictActions.hidden = false;
      if (!response.ok) throw new Error(data.error ?? '保存失败，请重试');
      saving = false;
      baseline = submitted;
      if (version) version.value = data.version;
      if (dirty()) persist();
      else {
        try { localStorage.removeItem(draftKey); } catch { /* Optional storage. */ }
        status.textContent = '已保存';
      }
      if (!uri) location.assign(data.url);
    } catch (error) {
      persist();
      status.textContent = '保存失败';
      errorBox.textContent = error instanceof Error ? error.message : '保存失败，请重试';
      errorBox.hidden = false;
    } finally { saving = false; saveButton.disabled = false; form.inert = false; }
  });
  surface.querySelectorAll<HTMLButtonElement>('.writing-toolbar button[disabled]').forEach(button => { button.disabled = false; });
  changed();
  // Initial rendering is immediate; a second render would reset interactive embeds.
  clearTimeout(previewTimer);
  void render();
}
