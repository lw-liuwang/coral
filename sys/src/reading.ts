const readingKey = (directory: string) => 'coral:reading:' + directory;

export function mountReading() {
  const article = document.querySelector<HTMLElement>('[data-reading-document]');
  const list = document.querySelector<HTMLElement>('[data-reading-list]');
  const resume = document.querySelector<HTMLElement>('[data-reading-resume]');

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
      nextLink.href = next.href;
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
