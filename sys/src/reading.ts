const readingKey = (directory: string) => 'coral:reading:' + directory;
interface ReadingPosition { heading?: string; offset: number; y: number }

export function mountReading() {
  const article = document.querySelector<HTMLElement>('[data-reading-document]');
  const list = document.querySelector<HTMLElement>('[data-reading-list]');
  const resume = document.querySelector<HTMLElement>('[data-reading-resume]');

  if (article) {
    const uri = article.dataset.readingDocument!;
    const positionKey = 'coral:reading-position:' + uri;
    const updateError = document.querySelector<HTMLElement>('[data-document-update-error]');
    const url = new URL(location.href);
    const start = url.searchParams.get('reading') === 'start';
    if (start) {
      try { localStorage.removeItem(positionKey); } catch { /* Position storage is optional. */ }
      url.searchParams.delete('reading');
      history.replaceState(history.state, '', url);
    }
    let restoring = true;
    let pending = false;
    let checking = false;
    let reloading = false;
    let saved: ReadingPosition | undefined;
    try {
      const value: unknown = JSON.parse(localStorage.getItem(positionKey) ?? 'null');
      if (value && typeof value === 'object' && 'y' in value && typeof value.y === 'number' && Number.isFinite(value.y)
        && 'offset' in value && typeof value.offset === 'number' && Number.isFinite(value.offset)) {
        saved = { y: Math.max(0, value.y), offset: value.offset,
          heading: 'heading' in value && typeof value.heading === 'string' ? value.heading : undefined };
      }
    } catch { /* Position storage is optional. */ }
    const savePosition = () => {
      if (restoring || reloading) return;
      const line = Math.max(0, document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) + 16;
      const headings = Array.from(article.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'));
      const heading = headings.filter(item => item.getBoundingClientRect().top <= line).at(-1);
      const y = window.scrollY;
      const position: ReadingPosition = { y, offset: heading ? -heading.getBoundingClientRect().top : 0, heading: heading?.id };
      try { localStorage.setItem(positionKey, JSON.stringify(position)); } catch { /* Reading works without storage. */ }
    };
    const restorePosition = () => {
      if (!location.hash) {
        const heading = saved?.heading ? document.getElementById(saved.heading) : null;
        const y = start ? 0 : heading && article.contains(heading) ? window.scrollY + heading.getBoundingClientRect().top + saved!.offset : saved?.y;
        if (y !== undefined) window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
      }
      requestAnimationFrame(() => { restoring = false; });
    };
    requestAnimationFrame(restorePosition);
    window.addEventListener('scroll', () => {
      if (pending || restoring) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; savePosition(); });
    }, { passive: true });
    window.addEventListener('pagehide', savePosition);
    const checkVersion = async () => {
      if (checking || reloading || document.hidden || !article.dataset.readingVersion) return;
      checking = true;
      let errorMessage = '无法检查笔记更新，请重试。';
      try {
        const response = await fetch('/api/document?' + new URLSearchParams({ uri, max_chars: '1' }), { cache: 'no-store', headers: { Accept: 'application/json' } });
        const latest = await response.json() as { version?: string; error?: string };
        if (!response.ok) {
          if (typeof latest.error === 'string') errorMessage = latest.error;
          throw new Error(errorMessage);
        }
        if (updateError) updateError.hidden = true;
        if (latest.version && latest.version !== article.dataset.readingVersion) {
          savePosition();
          reloading = true;
          location.reload();
        }
      } catch {
        if (updateError) {
          updateError.textContent = errorMessage;
          updateError.hidden = false;
        }
      } finally { checking = false; }
    };
    window.addEventListener('focus', () => { void checkVersion(); });
    window.addEventListener('pageshow', () => { void checkVersion(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) savePosition();
      else void checkVersion();
    });
  }

  const remember = () => {
    if (!article) return;
    try { localStorage.setItem(readingKey(article.dataset.readingDirectory!), article.dataset.readingDocument!); }
    catch { /* Reading navigation also works when browser storage is unavailable. */ }
  };
  const refresh = () => {
    if (!list || !resume) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-document-uri]'));
    let uri: string | null = null;
    try { uri = localStorage.getItem(readingKey(list.dataset.readingList!)); }
    catch { /* Directory anchors still locate the document without storage. */ }
    const index = rows.findIndex(row => row.dataset.documentUri === uri);
    rows.forEach((row, i) => {
      row.classList.toggle('is-last-read', i === index);
      row.querySelector<HTMLElement>('.reading-marker')!.hidden = i !== index;
    });
    resume.hidden = index < 0;
    if (index < 0) return; // Renamed or deleted documents cannot leave stale resume links.
    const current = rows[index].querySelector<HTMLAnchorElement>('a.page-link')!;
    const title = resume.querySelector<HTMLAnchorElement>('[data-resume-title]')!;
    title.textContent = current.textContent;
    title.href = current.href;
    resume.querySelector<HTMLAnchorElement>('[data-resume-open]')!.href = current.href;
    const next = rows[index + 1]?.querySelector<HTMLAnchorElement>('a.page-link');
    const nextLink = resume.querySelector<HTMLAnchorElement>('[data-resume-next]')!;
    nextLink.hidden = !next;
    if (next) {
      const nextUrl = new URL(next.href);
      nextUrl.searchParams.set('reading', 'start');
      nextLink.href = nextUrl.href;
      nextLink.title = '下一篇：' + next.textContent;
    } else nextLink.removeAttribute('href');
  };
  remember();
  refresh();
  // Back/forward may restore a page without executing its scripts again.
  window.addEventListener('pageshow', () => { remember(); refresh(); });
  window.addEventListener('storage', event => {
    if (list && (event.key === null || event.key === readingKey(list.dataset.readingList!))) refresh();
  });
}
