import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting, indentOnInput, syntaxTree } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { renderDiagrams } from './diagrams.js';
import { renderHtmlBlocks } from './html.js';
import { renderMath } from './math-client.js';
import { DraftStore, draftId, draftFingerprint, draftResolved, readDraft, listDrafts, recoveryDrafts, type Draft, type DraftRecord } from './drafts.js';

export function mountEditor() {
  const fallbackTextarea = document.querySelector<HTMLTextAreaElement>('#editor');
  const host = document.querySelector<HTMLElement>('#markdown-editor');
  const surface = document.querySelector<HTMLElement>('.writing-surface');
  const preview = document.querySelector<HTMLElement>('#preview');
  if (!fallbackTextarea || !host || !surface || !preview || !fallbackTextarea.form) return;
  const form = fallbackTextarea.form;
  let textarea: HTMLTextAreaElement | HTMLInputElement = fallbackTextarea;
  const title = form.querySelector<HTMLInputElement>('[name="title"]');
  const directory = form.querySelector<HTMLInputElement | HTMLSelectElement>('[name="directory"]');
  const version = form.querySelector<HTMLInputElement>('[name="version"]');
  const language = form.querySelector<HTMLInputElement | HTMLSelectElement>('[name="language"]');
  const sourceLanguage = form.querySelector<HTMLInputElement | HTMLSelectElement>('[name="source_language"]');
  const vault = document.querySelector<HTMLInputElement>('#preview-vault')!.value;
  const uri = document.querySelector<HTMLInputElement>('#preview-uri')?.value;
  const previewContextUri = document.querySelector<HTMLInputElement>('#preview-context-uri')?.value;
  const draftUrl = new URL(location.href);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(draftUrl.searchParams.get('draft') ?? '')) {
    draftUrl.searchParams.set('draft', draftId());
    window.history.replaceState(window.history.state, '', draftUrl);
  }
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
  const fingerprint = draftFingerprint;
  const defaultLanguage = (field: HTMLInputElement | HTMLSelectElement | null) => field instanceof HTMLSelectElement
    ? Array.from(field.options).find(option => option.defaultSelected)?.value ?? field.options[0]?.value
    : field?.defaultValue;
  const initial: Draft = { ...snapshot(), content: fallbackTextarea.defaultValue,
    title: title?.defaultValue ?? '', directory: defaultLanguage(directory) ?? '',
    language: defaultLanguage(language), sourceLanguage: defaultLanguage(sourceLanguage) };
  let baseline = fingerprint(initial);
  let savedBaseline = initial;
  const dirty = () => fingerprint(snapshot()) !== baseline;
  let store: DraftStore | undefined;
  let pending: DraftRecord[] = [];
  let consumed = new Set<string>();
  let undoDiscard: DraftRecord | undefined;
  let recovered = false;
  const noticeMessage = notice.querySelector<HTMLElement>('[data-draft-message]')!;
  const restoreButton = notice.querySelector<HTMLButtonElement>('[data-restore-draft]')!;
  const discardButton = notice.querySelector<HTMLButtonElement>('[data-discard-draft]')!;
  const choices = document.createElement('select');
  choices.setAttribute('aria-label', '选择本地草稿');
  noticeMessage.after(choices);
  const undoDiscardButton = document.createElement('button');
  undoDiscardButton.type = 'button'; undoDiscardButton.className = 'btn small';
  undoDiscardButton.textContent = '撤销丢弃';
  discardButton.after(undoDiscardButton);
  function updateNotice() {
    choices.replaceChildren();
    for (const record of pending) {
      const option = document.createElement('option');
      option.value = record.id;
      option.textContent = (record.title || record.content.slice(0, 45) || '未命名草稿') + ' · ' + new Date(record.updated).toLocaleString();
      choices.append(option);
    }
    choices.hidden = pending.length < 2;
    restoreButton.hidden = !pending.length;
    discardButton.hidden = !pending.length && !recovered;
    undoDiscardButton.hidden = !undoDiscard;
    noticeMessage.textContent = pending.length ? '有未恢复的本地草稿' : undoDiscard ? '草稿已丢弃' : '已恢复本地草稿';
    notice.hidden = !pending.length && !recovered && !undoDiscard;
  }
  function pointTo(record: DraftRecord) {
    const url = new URL(location.href);
    url.searchParams.set('draft', record.editor);
    window.history.replaceState(window.history.state, '', url);
  }
  try {
    const operation = new URL(form.action).pathname;
    const editor = draftUrl.searchParams.get('draft')!;
    const explicit = readDraft(localStorage, draftUrl.searchParams.get('recover') ?? '');
    const inherited = listDrafts(localStorage).find(record => record.editor === editor
      && (!uri || record.resource === uri) && new URL(record.url, location.origin).pathname === operation);
    const inheritedMatches = inherited?.vault === vault && (!uri || inherited.resource === uri)
      && new URL(inherited.url, location.origin).pathname === operation;
    const source = new URL(uri || previewContextUri || 'coral://vault/' + vault + '/');
    const folder = source.pathname.split('/').slice(2, -1).map(decodeURIComponent).join('/');
    const cleanUrl = new URL(location.href); cleanUrl.searchParams.delete('draft'); cleanUrl.searchParams.delete('recover');
    const resource = uri || (inheritedMatches ? inherited!.resource : `${operation}:${vault}:${draftUrl.searchParams.get('draft')}`);
    store = new DraftStore(localStorage, { editor, resource, vault, folder, url: cleanUrl.pathname + cleanUrl.search });
    store.migrate(`coral:draft:${uri ?? `new:${vault}:${draftUrl.searchParams.get('draft')}`}`);
    if (!uri && !previewContextUri) store.migrate(`coral:draft:new:${vault}`);
    if (inheritedMatches && inherited?.undo) undoDiscard = readDraft(localStorage, inherited.undo);
    if (inheritedMatches && inherited?.state === 'discarded') undoDiscard = inherited;
    if (inheritedMatches && inherited?.state === 'active') consumed = new Set(inherited.consumed);
    const hidden = new Set([...consumed, ...(undoDiscard?.consumed ?? [])]);
    const seen = new Set<string>();
    pending = recoveryDrafts(store.list()).filter(record => {
      const requested = explicit?.resource === resource && record.id === explicit.id;
      if (!requested && (hidden.has(record.id) || fingerprint(record) === baseline || draftResolved(localStorage, record.id))) return false;
      const identity = fingerprint(record) + ':' + record.version;
      if (seen.has(identity)) return false;
      seen.add(identity); return true;
    });
    if (inheritedMatches && inherited?.state === 'active') {
      pending.sort((a, b) => Number(b.id === explicit?.id || b.id === inherited.id) - Number(a.id === explicit?.id || a.id === inherited.id));
    }
  } catch { /* Storage can be disabled by the browser. */ }
  updateNotice();

  async function render() {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    try {
      const response = await fetch('/api/preview', { method: 'POST', signal: request.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: textarea!.value, vault, uri, context_uri: previewContextUri, language: language?.value }) });
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
      if (!store) throw new Error('Local drafts unavailable');
      pointTo(store.write(snapshot(), [...consumed], undoDiscard?.id));
      status.textContent = saving ? '正在保存…' : '草稿已存于本机';
    } catch { status.textContent = '未保存 · 本地草稿不可用'; }
  }

  function changed() {
    if (form.querySelector('[name="derive_language"]') && language && sourceLanguage) {
      language.value = sourceLanguage.value === 'en' ? 'zh' : 'en';
      const target = form.querySelector<HTMLElement>('[data-target-language]');
      if (target) target.textContent = language.value === 'en' ? '新增英文版' : '新增中文版';
    }
    const saveLocation = form.querySelector<HTMLElement>('[data-save-location]');
    if (saveLocation) saveLocation.textContent = directory?.value || '知识库根目录';
    count.textContent = `${Array.from(textarea!.value).length.toLocaleString()} 字符 · ${textarea!.value.split('\n').length} 行`;
    clearTimeout(previewTimer);
    // Abort immediately so an older response cannot replace the latest preview.
    controller?.abort();
    previewTimer = setTimeout(() => void render(), 250);
    clearTimeout(draftTimer);
    status.textContent = saving ? '正在保存…' : dirty() ? '未保存' : '未修改';
    if (dirty()) {
      draftTimer = setTimeout(persist, 400);
    } else {
      try { store?.clearOwn(); } catch { /* Optional storage. */ }
    }
  }

  const markupTypes: Record<string, string> = { bold: 'StrongEmphasis', italic: 'Emphasis', link: 'Link', code: 'FencedCode' };
  function activeMarkup(command: string, from = view.state.selection.main.from, to = view.state.selection.main.to) {
    for (let node = syntaxTree(view.state).resolveInner(from, 1); node; node = node.parent!) {
      if (node.name === markupTypes[command] && node.to >= to) return node;
    }
  }
  function updateFormatState() {
    surface!.querySelectorAll<HTMLButtonElement>('[data-editor-command]').forEach(button => {
      const command = button.dataset.editorCommand!;
      if (markupTypes[command]) button.setAttribute('aria-pressed', String(Boolean(activeMarkup(command))));
    });
  }
  let lastWrap: { command: string; doc: EditorState['doc']; from: number; to: number; original: string;
    selection: { from: number; to: number }; previous: { from: number; to: number } } | undefined;
  function wrap(command: string, before: string, after: string, fallback: string) {
    let { from, to } = view.state.selection.main;
    const previousSelection = { from, to };
    if (lastWrap?.command === command && lastWrap.doc === view.state.doc
      && lastWrap.selection.from === from && lastWrap.selection.to === to) {
      const previous = lastWrap; lastWrap = undefined;
      view.dispatch({ changes: { from: previous.from, to: previous.to, insert: previous.original },
        selection: EditorSelection.range(previous.previous.from, previous.previous.to), scrollIntoView: true });
      view.focus(); return;
    }
    // A selection cutting through Markdown delimiters expands to the complete construct.
    let expanded = from !== to;
    while (expanded) {
      expanded = false;
      syntaxTree(view.state).iterate({ enter(node) {
        if (!['EmphasisMark', 'LinkMark', 'CodeMark'].includes(node.name) || node.from >= to || node.to <= from) return;
        const parent = node.node.parent;
        if (!parent || !Object.values(markupTypes).includes(parent.name) || from <= parent.from && to >= parent.to) return;
        from = Math.min(from, parent.from); to = Math.max(to, parent.to); expanded = true;
      } });
    }
    const selected = view.state.sliceDoc(from, to) || fallback;
    const marked = activeMarkup(command, from, to);
    const surrounded = from >= before.length && view.state.sliceDoc(from - before.length, from) === before
      && view.state.sliceDoc(to, to + after.length) === after
      && marked?.from === from - before.length && marked.to === to + after.length;
    const contained = marked?.from === from && marked.to === to
      && selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length;
    const start = surrounded ? from - before.length : from;
    const end = surrounded ? to + after.length : to;
    const text = contained ? selected.slice(before.length, -after.length) : selected;
    const remove = surrounded || contained;
    const original = view.state.sliceDoc(start, end);
    const insert = remove ? text : before + text + after;
    view.dispatch({ changes: { from: start, to: end, insert },
      selection: EditorSelection.range(start + (remove ? 0 : before.length), start + (remove ? 0 : before.length) + text.length), scrollIntoView: true });
    lastWrap = { command, doc: view.state.doc, from: start, to: start + insert.length, original,
      previous: previousSelection, selection: { from: view.state.selection.main.from, to: view.state.selection.main.to } };
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
    bold: () => wrap('bold', '**', '**', '加粗文字'), italic: () => wrap('italic', '*', '*', '斜体文字'),
    link: () => wrap('link', '[', '](https://)', '链接文字'), code: () => wrap('code', '```\n', '\n```', '代码'),
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
    EditorView.updateListener.of(update => {
      if (update.docChanged) { textarea!.value = update.state.doc.toString(); changed(); }
      if (update.docChanged || update.selectionSet) updateFormatState();
    }),
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
  directory?.addEventListener('change', changed);
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
  function applyDraft(draft: Draft) {
    if (title) title.value = draft.title;
    if (directory) {
      if (directory instanceof HTMLSelectElement && !Array.from(directory.options).some(option => option.value === draft.directory)) {
        const option = document.createElement('option'); option.value = draft.directory;
        option.textContent = draft.directory + '（目录不可用）'; directory.append(option);
      }
      directory.value = draft.directory;
    }
    if (language && (draft.language === 'zh' || draft.language === 'en')) language.value = draft.language;
    if (sourceLanguage && (draft.sourceLanguage === 'zh' || draft.sourceLanguage === 'en')) sourceLanguage.value = draft.sourceLanguage;
    // Keep the original version so restoring an old draft never overwrites external edits.
    if (version) version.value = draft.version;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draft.content } });
    changed();
  }
  function restoreDraft(record: DraftRecord, focus: boolean) {
    // Preserve work typed before choosing a different recovery candidate.
    if (dirty() && fingerprint(snapshot()) !== fingerprint(record)) {
      try {
        if (!store) throw new Error('Local drafts unavailable');
        pending.unshift(store.write(snapshot(), [...consumed], undoDiscard?.id, 'active', false));
      } catch {
        status.textContent = '未保存 · 本地草稿不可用';
        return;
      }
    }
    consumed = new Set([...consumed, record.id, ...record.consumed]);
    pending = pending.filter(candidate => candidate.id !== record.id && !consumed.has(candidate.id));
    recovered = true;
    applyDraft(record); persist(); updateNotice();
    if (focus) view.focus();
  }
  restoreButton.addEventListener('click', () => {
    const record = pending.find(candidate => candidate.id === choices.value) ?? pending[0];
    if (record) restoreDraft(record, true);
  });
  discardButton.addEventListener('click', () => {
    const record = pending.find(candidate => candidate.id === choices.value) ?? pending[0];
    try {
      if (!store) throw new Error('Local drafts unavailable');
      const discarded = store.write(record ?? snapshot(), record ? [record.id, ...record.consumed] : [...consumed], undefined, 'discarded');
      store.remove(discarded.consumed);
      undoDiscard = discarded;
      if (record) pending = pending.filter(candidate => !discarded.consumed.includes(candidate.id));
      else {
        store.clearOwn(); consumed.clear(); recovered = false; applyDraft(savedBaseline);
      }
      pointTo(discarded);
      if (dirty()) persist();
      updateNotice();
    } catch { status.textContent = '未保存 · 本地草稿不可用'; }
  });
  undoDiscardButton.addEventListener('click', () => {
    if (!undoDiscard) return;
    try {
      if (!store) throw new Error('Local drafts unavailable');
      const discarded = undoDiscard;
      // Restoring the recovery option never replaces text typed since the discard.
      const restored = store.write(discarded, discarded.consumed, undefined, 'active', false);
      store.remove([discarded.id]);
      pending.unshift(restored); undoDiscard = undefined;
      pointTo(restored);
      if (dirty()) persist();
      updateNotice();
    } catch { status.textContent = '未保存 · 本地草稿不可用'; }
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
    const submittedSnapshot = snapshot();
    const submitted = fingerprint(submittedSnapshot);
    try {
      const payload = new URLSearchParams();
      new FormData(form).forEach((value, key) => { if (typeof value === 'string') payload.set(key, value); });
      const response = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, body: payload });
      const data = await response.json();
      if (response.status === 409 && conflictActions) conflictActions.hidden = false;
      if (!response.ok) throw new Error(data.error ?? '保存失败，请重试');
      saving = false;
      baseline = submitted;
      savedBaseline = { ...submittedSnapshot, version: data.version };
      if (version) version.value = data.version;
      try { store?.markSaved(submittedSnapshot); } catch { /* Preserved snapshots remain recoverable if marking fails. */ }
      if (dirty()) persist();
      else {
        try {
          store?.clearOwn(); store?.remove(consumed);
          if (undoDiscard) store?.remove([undoDiscard.id]);
          consumed.clear(); undoDiscard = undefined; recovered = false;
          const url = new URL(location.href); url.searchParams.delete('draft'); url.searchParams.delete('recover');
          window.history.replaceState(window.history.state, '', url);
          updateNotice();
        } catch { /* The saved file remains authoritative if local cleanup is unavailable. */ }
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
  updateFormatState();
  changed();
  if (pending.length === 1 && pending[0].version === (version?.value ?? '') && !dirty()) restoreDraft(pending[0], false);
  // Initial rendering is immediate; a second render would reset interactive embeds.
  clearTimeout(previewTimer);
  void render();
}
