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
    const update = document.querySelector<HTMLElement>('[data-reading-update]');
    const topbar = document.querySelector<HTMLElement>('.topbar');
    const updateHeadingOffset = () => {
      if (topbar) document.documentElement.style.setProperty('--reading-heading-offset', Math.ceil(topbar.getBoundingClientRect().height + 16) + 'px');
    };
    updateHeadingOffset();
    if (topbar) new ResizeObserver(updateHeadingOffset).observe(topbar);
    const headings = Array.from(article.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'));
    const toc = document.querySelector<HTMLElement>('[data-article-toc]');
    const tocScroll = toc?.querySelector<HTMLElement>('.article-toc-scroll') ?? toc;
    const tocLinks = Array.from(toc?.querySelectorAll<HTMLAnchorElement>('a[href^="#"]') ?? []);
    const tocEntries = headings.flatMap(heading => {
      const link = tocLinks.find(link => {
        try { return decodeURIComponent(link.hash.slice(1)) === heading.id; }
        catch { return false; }
      });
      return link ? [{ heading, link }] : [];
    });
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
    const readPosition = (): ReadingPosition => {
      const line = Math.ceil(Math.max(0, topbar?.getBoundingClientRect().bottom ?? 0) + 16) + 1;
      const heading = headings.filter(item => item.getBoundingClientRect().top <= line).at(-1);
      return { y: window.scrollY, offset: heading ? -heading.getBoundingClientRect().top : 0, heading: heading?.id };
    };
    const updateToc = (position = readPosition()) => {
      if (!tocScroll || !tocEntries.length) return;
      const bottom = document.documentElement.scrollHeight - innerHeight;
      const current = bottom > 0 && window.scrollY >= bottom - 1 ? tocEntries.at(-1)!
        : tocEntries.find(entry => entry.heading.id === position.heading) ?? tocEntries[0];
      tocLinks.forEach(link => {
        if (link === current.link) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
      if (!tocScroll.clientHeight) return;
      const bounds = tocScroll.getBoundingClientRect(), item = current.link.getBoundingClientRect();
      const top = bounds.top + tocScroll.clientTop, bottomEdge = top + tocScroll.clientHeight;
      if (item.top < top || item.bottom > bottomEdge) tocScroll.scrollTop += (item.top + item.bottom - top - bottomEdge) / 2;
    };
    const savePosition = (position = readPosition()) => {
      if (restoring || reloading) return;
      try { localStorage.setItem(positionKey, JSON.stringify(position)); } catch { /* Reading works without storage. */ }
    };
    const restorePosition = () => {
      if (!location.hash) {
        const heading = saved?.heading ? document.getElementById(saved.heading) : null;
        const y = start ? 0 : heading && article.contains(heading) ? window.scrollY + heading.getBoundingClientRect().top + saved!.offset : saved?.y;
        if (y !== undefined) window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
      }
      requestAnimationFrame(() => { restoring = false; updateToc(); });
    };
    requestAnimationFrame(restorePosition);
    let restoreAfterMath = true;
    const userNavigated = () => { restoreAfterMath = false; };
    window.addEventListener('wheel', userNavigated, { passive: true });
    window.addEventListener('touchstart', userNavigated, { passive: true });
    window.addEventListener('pointerdown', userNavigated, { passive: true });
    window.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) userNavigated();
    });
    document.addEventListener('coral:math-ready', event => {
      if (!restoreAfterMath || (event as CustomEvent<{ root: ParentNode }>).detail.root !== document) return;
      if (location.hash) {
        try { document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView(); }
        catch { /* Malformed anchors cannot prevent reading. */ }
      } else restorePosition();
    });
    const schedulePosition = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (restoring) return;
        const position = readPosition();
        updateToc(position);
        savePosition(position);
      });
    };
    window.addEventListener('scroll', schedulePosition, { passive: true });
    window.addEventListener('hashchange', schedulePosition);
    window.addEventListener('popstate', schedulePosition);
    window.addEventListener('resize', schedulePosition);
    toc?.closest('details')?.addEventListener('toggle', schedulePosition);
    window.addEventListener('pagehide', () => savePosition());
    const checkVersion = async () => {
      if (checking || reloading || document.hidden || !article.dataset.readingVersion) return;
      checking = true;
      let errorMessage = '无法检查笔记更新，请重试。';
      try {
        const response = await fetch('/api/document?' + new URLSearchParams({ uri, max_chars: '1' }), { cache: 'no-store', headers: { Accept: 'application/json' } });
        const latest = await response.json() as { version?: string; note_version?: string; error?: string };
        if (!response.ok) {
          if (typeof latest.error === 'string') errorMessage = latest.error;
          throw new Error(errorMessage);
        }
        if (updateError) updateError.hidden = true;
        const changed = latest.version && latest.version !== article.dataset.readingVersion
          || latest.note_version && article.dataset.readingNoteVersion && latest.note_version !== article.dataset.readingNoteVersion;
        if (update) update.hidden = !changed;
      } catch {
        if (updateError) {
          updateError.textContent = errorMessage;
          updateError.hidden = false;
        }
      } finally { checking = false; }
    };
    update?.querySelector('[data-load-update]')?.addEventListener('click', () => {
      savePosition();
      reloading = true;
      location.reload();
    });
    window.addEventListener('focus', () => { void checkVersion(); });
    window.addEventListener('pageshow', () => { schedulePosition(); void checkVersion(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) savePosition();
      else void checkVersion();
    });
  }

  const remember = () => {
    if (!article) return;
    try { localStorage.setItem(readingKey(article.dataset.readingDirectory!), article.dataset.readingNote ?? article.dataset.readingDocument!); }
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
