package coral

import (
	"math"
	"path"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

type searchToken struct {
	Value      string
	Start, End int
}

func searchTokens(text string) []searchToken {
	out := []searchToken{}
	word := ""
	start := 0
	flush := func(end int) {
		if word != "" {
			out = append(out, searchToken{word, start, end})
			word = ""
		}
	}
	for i, c := range text {
		cjk := c >= 0x3000 && c <= 0x9fff || c >= 0xff00 && c <= 0xffef
		if cjk {
			flush(i)
			out = append(out, searchToken{strings.ToLower(string(c)), i, i + len(string(c))})
			continue
		}
		if unicode.IsLetter(c) || unicode.IsDigit(c) || unicode.Is(unicode.Co, c) {
			if word == "" {
				start = i
			}
			letter := strings.ToLower(string(c))
			if unicode.In(c, unicode.Latin) {
				decomposed := []rune(norm.NFD.String(letter))
				if len(decomposed) == 2 && decomposed[0] >= 'a' && decomposed[0] <= 'z' && unicode.IsMark(decomposed[1]) {
					letter = string(decomposed[0])
				}
				if letter == "ſ" {
					letter = "s"
				}
			}
			word += letter
		} else if c >= 0x300 && c <= 0x304 || c >= 0x306 && c <= 0x30c || c == 0x30f || c == 0x311 || c == 0x31b || c >= 0x323 && c <= 0x328 || c == 0x32d || c == 0x32e || c == 0x330 || c == 0x331 {
			continue
		} else {
			flush(i)
		}
	}
	flush(len(text))
	return out
}

type searchHit struct{ Start, End, Term int }

func hits(tokens []searchToken, terms []string) []searchHit {
	phrases := make([][]searchToken, len(terms))
	for n, term := range terms {
		phrases[n] = searchTokens(term)
	}
	return queryHits(tokens, phrases)
}

func matches(text string, terms []string) bool {
	if len(terms) == 0 {
		return false
	}
	found := map[int]bool{}
	for _, h := range hits(searchTokens(text), terms) {
		found[h.Term] = true
	}
	return len(found) == len(terms)
}

func queryHits(tokens []searchToken, phrases [][]searchToken) []searchHit {
	out := []searchHit{}
	for t, phrase := range phrases {
		if len(phrase) == 0 {
			continue
		}
		for i := range tokens {
			if i+len(phrase) > len(tokens) {
				break
			}
			matched := true
			for j := range phrase {
				if tokens[i+j].Value != phrase[j].Value {
					matched = false
					break
				}
			}
			if matched {
				out = append(out, searchHit{tokens[i].Start, tokens[i+len(phrase)-1].End, t})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Start == out[j].Start {
			return out[i].End < out[j].End
		}
		return out[i].Start < out[j].Start
	})
	return out
}
func searchRankMatched(d Document, terms []string, titleMatched bool) int {
	normalize := func(s string) string { return strings.ToLower(strings.Join(strings.Fields(s), " ")) }
	query := normalize(strings.Join(terms, " "))
	filename := path.Base(d.Relative)
	for _, s := range []string{d.Title, filename, strings.TrimSuffix(filename, path.Ext(filename))} {
		if query != "" && normalize(s) == query {
			return 0
		}
	}
	if titleMatched {
		return 1
	}
	return 2
}
func snippetHits(d Document, all []searchHit) (string, int) {
	bestStart, bestCount, bestSpan := 0, 0, math.MaxInt
	left := 0
	counts := map[int]int{}
	for right, h := range all {
		counts[h.Term]++
		for left < right && utf16Len(d.Body[all[left].Start:h.End]) > 250 {
			t := all[left].Term
			counts[t]--
			if counts[t] == 0 {
				delete(counts, t)
			}
			left++
		}
		span := h.End - all[left].Start
		if len(counts) > bestCount || len(counts) == bestCount && span < bestSpan {
			bestStart = all[left].Start
			bestCount = len(counts)
			bestSpan = span
		}
	}
	runes := []rune(d.Body)
	hit := len([]rune(d.Body[:bestStart]))
	begin := max(0, hit-80)
	end := min(len(runes), begin+360)
	prefix := string(runes[:begin])
	bodyOffset := len(d.Raw) - len(d.Body)
	if bodyOffset < 0 {
		bodyOffset = 0
	}
	return string(runes[begin:end]), strings.Count(d.Raw[:bodyOffset]+prefix, "\n") + 1
}
func (r *Registry) Search(query, vaultID string, limit, cursor int) (map[string]any, error) {
	query = strings.TrimSpace(query)
	if query == "" || utf16Len(query) > 500 || limit < 1 || limit > 100 || cursor < 0 {
		return nil, fail(400, "搜索参数无效")
	}
	vs, err := r.Vaults()
	if err != nil {
		return nil, err
	}
	if vaultID != "" {
		v, e := r.Vault(vaultID)
		if e != nil {
			return nil, e
		}
		vs = []Vault{v}
	}
	terms := strings.Fields(query)
	phrases := make([][]searchToken, len(terms))
	for n, term := range terms {
		phrases[n] = searchTokens(term)
	}
	type candidate struct {
		Doc   Document
		Rank  int
		Score float64
		Hits  []searchHit
	}
	candidates := []candidate{}
	unavailable := []string{}
	skipped := 0
	for _, v := range vs {
		scan, e := r.Scan(v.ID)
		if e != nil {
			if vaultID != "" {
				return nil, e
			}
			unavailable = append(unavailable, ResourceURI(v.ID, ""))
			continue
		}
		skipped += scan.Skipped
		groups := scan.index.groups
		for _, d := range scan.Documents {
			f := groups[d.URI]
			if f.Primary.URI != d.URI {
				continue
			}
			index := d.searchIndex()
			bodyHits, titleHits := queryHits(index.body, phrases), queryHits(index.title, phrases)
			found, titleFound := map[int]bool{}, map[int]bool{}
			for _, h := range bodyHits {
				found[h.Term] = true
			}
			for _, h := range titleHits {
				found[h.Term] = true
				titleFound[h.Term] = true
			}
			if len(found) != len(terms) {
				continue
			}
			score := float64(len(bodyHits)) / (1 + 0.75*float64(len(index.body))/500)
			candidates = append(candidates, candidate{withLanguages(d, f), searchRankMatched(d, terms, len(titleFound) == len(terms)), score, bodyHits})
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.Rank != b.Rank {
			return a.Rank < b.Rank
		}
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		return a.Doc.URI < b.Doc.URI
	})
	results := []any{}
	for _, c := range candidates[min(cursor, len(candidates)):min(cursor+limit, len(candidates))] {
		m := c.Doc.Public()
		m["snippet"], m["start_line"] = snippetHits(c.Doc, c.Hits)
		results = append(results, m)
	}
	var next any
	if cursor+limit < len(candidates) {
		next = cursor + limit
	}
	return map[string]any{"results": results, "total": len(candidates), "next_cursor": next, "unavailable_vaults": unavailable, "skipped_documents": skipped}, nil
}
