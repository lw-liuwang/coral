export const cjkSplit = (text: string) => text.toLowerCase().replace(/([\u3000-\u9fff\uff00-\uffef])/g, ' $1 ');

export function splitSearchQuery(query: string): string[] {
  return query.trim().split(/\s+/u).filter(Boolean);
}

export function ftsQuery(query: string): string {
  return splitSearchQuery(query).map(term => '"' + cjkSplit(term).replaceAll('"', '""') + '"').join(' AND ');
}

interface Token { value: string; start: number; end: number }

function tokens(text: string): Token[] {
  const result: Token[] = [];
  // unicode61 removes these combining marks and single Latin accents by default.
  for (const word of text.matchAll(/[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{Co}\u0300-\u0304\u0306-\u030c\u030f\u0311\u031b\u0323-\u0328\u032d\u032e\u0330\u0331]*/gu)) {
    for (const part of word[0].matchAll(/[\u3000-\u9fff\uff00-\uffef]|[^\u3000-\u9fff\uff00-\uffef]+/gu)) {
      const value = part[0].toLowerCase().replace(/\p{Script=Latin}/gu, letter => {
        const decomposed = letter.normalize('NFD').replace(/ſ/g, 's');
        return /^[a-z]\p{M}$/u.test(decomposed) ? decomposed[0] : letter === 'ſ' ? 's' : letter;
      }).replace(/\p{M}/gu, '');
      if (value) result.push({ value, start: word.index + part.index, end: word.index + part.index + part[0].length });
    }
  }
  return result;
}

function matchesAt(source: Token[], phrase: Token[], index: number) {
  return phrase.length > 0 && phrase.every((token, offset) => source[index + offset]?.value === token.value);
}

function findHits(source: Token[], terms: readonly string[]) {
  const hits: { start: number; end: number; term: number }[] = [];
  terms.forEach((term, termIndex) => {
    const phrase = tokens(term);
    source.forEach((token, index) => {
      if (matchesAt(source, phrase, index)) hits.push({ start: token.start, end: source[index + phrase.length - 1].end, term: termIndex });
    });
  });
  return hits.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function searchMatchRanges(text: string, terms: readonly string[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const hit of findHits(tokens(text), terms)) {
    const previous = ranges.at(-1);
    if (previous && hit.start <= previous.end) previous.end = Math.max(previous.end, hit.end);
    else ranges.push({ start: hit.start, end: hit.end });
  }
  return ranges;
}

export function matchesSearchText(text: string, terms: readonly string[]): boolean {
  const source = tokens(text);
  return terms.length > 0 && terms.every(term => {
    const phrase = tokens(term);
    return source.some((_, index) => matchesAt(source, phrase, index));
  });
}

export function rankSearchDocument(doc: { title: string; relative: string }, terms: readonly string[]): number {
  const normalize = (text: string) => text.trim().replace(/\s+/gu, ' ').toLowerCase();
  const query = normalize(terms.join(' '));
  const filename = doc.relative.split('/').at(-1) ?? '';
  const stem = filename.replace(/\.(md|markdown)$/i, '');
  if (query && [doc.title, filename, stem].some(value => normalize(value) === query)) return 0;
  return matchesSearchText(doc.title + '\n' + doc.relative, terms) ? 1 : 2;
}

export function searchSnippet(raw: string, body: string, terms: readonly string[]): { snippet: string; start_line: number } {
  const hits = findHits(tokens(body), terms);
  const counts = new Map<number, number>();
  let left = 0, bestCount = 0, bestSpan = Infinity, bestStart = 0;
  hits.forEach((hit, right) => {
    counts.set(hit.term, (counts.get(hit.term) ?? 0) + 1);
    while (left < right && hit.end - hits[left].start > 250) {
      const term = hits[left++].term;
      const count = counts.get(term)! - 1;
      if (count) counts.set(term, count); else counts.delete(term);
    }
    const span = hit.end - hits[left].start;
    if (counts.size > bestCount || counts.size === bestCount && span < bestSpan) {
      bestCount = counts.size;
      bestSpan = span;
      bestStart = hits[left].start;
    }
  });
  let begin = Math.max(0, bestStart - 80), end = Math.min(body.length, begin + 360);
  if (begin > 0 && /[\uDC00-\uDFFF]/.test(body[begin] ?? '')) begin--;
  if (/[\uDC00-\uDFFF]/.test(body[end] ?? '')) end--;
  const bodyOffset = raw.endsWith(body) ? raw.length - body.length : Math.max(0, raw.indexOf(body));
  return { snippet: body.slice(begin, end), start_line: raw.slice(0, bodyOffset + begin).split('\n').length };
}
