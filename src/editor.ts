import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting, indentOnInput } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';

interface Draft { content: string; title: string; directory: string; version: string; updated: number }

export function mountEditor() {
  const textarea = document.querySelector<HTMLTextAreaElement>('#editor');
  const host = document.querySelector<HTMLElement>('#markdown-editor');
  const surface = document.querySelector<HTMLElement>('.writing-surface');
  const preview = document.querySelector<HTMLElement>('#preview');
  if (!textarea || !host || !surface || !preview || !textarea.form) return;
  const form = textarea.form;
  const title = form.querySelector<HTMLInputElement>('[name="title"]');
  const directory = form.querySelector<HTMLInputElement>('[name="directory"]');
  const version = form.querySelector<HTMLInputElement>('[name="version"]');
  const vault = document.querySelector<HTMLInputElement>('#preview-vault')!.value;
  const uri = document.querySelector<HTMLInputElement>('#preview-uri')?.value;
  const draftKey = `coral:draft:${uri ?? `new:${vault}`}`;
  const status = document.querySelector<HTMLElement>('#save-status')!;
  const count = document.querySelector<HTMLElement>('#word-count')!;
  const errorBox = document.querySelector<HTMLElement>('#save-error')!;
  const notice = surface.querySelector<HTMLElement>('.draft-notice')!;
  const saveButton = document.querySelector<HTMLButtonElement>(`button[form="${form.id}"]`)!;
  let saving = false;
  let previewTimer: ReturnType<typeof setTimeout>;
  let draftTimer: ReturnType<typeof setTimeout>;
  let controller: AbortController | undefined;
  const snapshot = (): Draft => ({ content: textarea.value, title: title?.value ?? '', directory: directory?.value ?? '', version: version?.value ?? '', updated: Date.now() });
  const fingerprint = (draft: Draft) => JSON.stringify([draft.content, draft.title, draft.directory]);
  let baseline = fingerprint(snapshot());
  const dirty = () => fingerprint(snapshot()) !== baseline;
  let pendingDraft: Draft | undefined;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
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
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: textarea!.value, vault, uri }) });
      const data = await response.json();
      if (request.signal.aborted) return;
      if (response.ok) preview!.innerHTML = data.html;
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
    status.textContent = dirty() ? '未保存' : '未修改';
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
  textarea.hidden = true;
  document.body.classList.add('writing-page');
  title?.addEventListener('input', changed);
  directory?.addEventListener('input', changed);
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
    // Keep the original version so restoring an old draft never overwrites external edits.
    if (version) version.value = draft.version;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draft.content } });
    notice.hidden = true;
    pendingDraft = undefined;
    changed(); persist(); view.focus();
  });
  surface.querySelector('[data-discard-draft]')!.addEventListener('click', () => {
    try { localStorage.removeItem(draftKey); } catch { /* Optional storage. */ }
    pendingDraft = undefined; notice.hidden = true;
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
    errorBox.hidden = true; status.textContent = '正在保存…';
    clearTimeout(draftTimer);
    const submitted = fingerprint(snapshot());
    try {
      const payload = new URLSearchParams();
      new FormData(form).forEach((value, key) => { if (typeof value === 'string') payload.set(key, value); });
      const response = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, body: payload });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? '保存失败，请重试');
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
  changed();
  void render();
}
