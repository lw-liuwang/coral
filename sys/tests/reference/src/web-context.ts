/** Only a local search page can be carried across reading and editing. */
export function searchReturn(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 5000 || !/^\/search(?:\?|$)/.test(value)) return;
  const url = new URL(value, 'http://coral.local');
  if (url.origin !== 'http://coral.local' || url.pathname !== '/search') return;
  const query = url.searchParams.get('q') ?? '';
  const vault = url.searchParams.get('vault') ?? '';
  const cursor = url.searchParams.get('cursor') ?? '0';
  if (query.length > 500 || !/^[a-zA-Z0-9_-]*$/.test(vault) || !/^\d{1,9}$/.test(cursor)) return;
  const hash = /^#doc-[a-f0-9]{16}$/.test(url.hash) ? url.hash : '';
  return '/search?' + new URLSearchParams({ q: query, vault, cursor }) + hash;
}

export function withSearchReturn(url: string, returnTo: string | undefined): string {
  const valid = searchReturn(returnTo);
  return valid ? url + (url.includes('?') ? '&' : '?') + new URLSearchParams({ return_to: valid }) : url;
}
