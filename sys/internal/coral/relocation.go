package coral

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

type UnresolvedLink struct {
	URI    string `json:"uri"`
	Target string `json:"target"`
	Reason string `json:"reason"`
}
type UpdatedDocument struct {
	URI     string `json:"uri"`
	Version string `json:"version"`
}
type RelocationReport struct {
	OperationID      string            `json:"operation_id"`
	UpdatedDocuments []UpdatedDocument `json:"updated_documents"`
	UnresolvedLinks  []UnresolvedLink  `json:"unresolved_links"`
}
type RelocationResult struct {
	Entry
	Document *Document         `json:"-"`
	Report   *RelocationReport `json:"-"`
}

func (v RelocationResult) Public() map[string]any {
	var m map[string]any
	if v.Document != nil {
		m = v.Document.Public()
		m["name"] = v.Name
		m["kind"] = v.Kind
	} else {
		_ = jsonUnmarshal(v.Entry, &m)
	}
	if v.Report != nil {
		m["operation_id"] = v.Report.OperationID
		m["updated_documents"] = v.Report.UpdatedDocuments
		m["unresolved_links"] = v.Report.UnresolvedLinks
	}
	return m
}
func jsonUnmarshal(v any, target any) error { return json.Unmarshal(jsonBytes(v), target) }

type destination struct {
	Start, End   int
	Target, Kind string
}
type rawChange struct {
	Original      Document
	Relative, Raw string
	Applied       bool
	Attempted     bool
}

var definitionPattern = regexp.MustCompile(`(?m)^[ \t]*(?:>[ \t]*)*(?:[-+*][ \t]+)?\[([^\]\r\n]+)\]:[ \t]*(?:\r?\n[ \t]*)?`)
var htmlOpenPattern = regexp.MustCompile(`(?i)^<([a-z][\w:-]*)(?:\s[^<>]*|\s*)>`)

func protectedSource(raw string) []bool {
	mask := make([]bool, len(raw))
	mark := func(start, end int) {
		for i := max(0, start); i < min(end, len(mask)); i++ {
			mask[i] = true
		}
	}
	_, body, err := parseMarkdown(raw)
	offset := 0
	if err == nil {
		offset = len(raw) - len(body)
		mark(0, offset)
	}
	source := []byte(raw)
	root := goldmark.New().Parser().Parse(text.NewReader(source))
	_ = ast.Walk(root, func(n ast.Node, enter bool) (ast.WalkStatus, error) {
		if !enter {
			return ast.WalkContinue, nil
		}
		switch n.Kind() {
		case ast.KindFencedCodeBlock, ast.KindCodeBlock, ast.KindHTMLBlock:
			lines := n.Lines()
			if lines.Len() > 0 {
				a := lines.At(0).Start
				b := lines.At(lines.Len() - 1).Stop
				if n.Kind() == ast.KindFencedCodeBlock {
					a = strings.LastIndex(raw[:max(0, a-1)], "\n") + 1
					if end := strings.Index(raw[b:], "\n"); end >= 0 {
						b += end + 1
					} else {
						b = len(raw)
					}
				}
				mark(a, b)
			}
			return ast.WalkSkipChildren, nil
		case ast.KindCodeSpan:
			if first, last := n.FirstChild(), n.LastChild(); first != nil && last != nil {
				a := first.(*ast.Text).Segment.Start
				b := last.(*ast.Text).Segment.Stop
				for a > 0 && raw[a-1] == '`' {
					a--
				}
				for b < len(raw) && raw[b] == '`' {
					b++
				}
				mark(a, b)
			}
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	// Inline HTML is opaque, including Markdown-looking contents between its tags.
	for i := offset; i < len(raw); i++ {
		if mask[i] || raw[i] != '<' {
			continue
		}
		if strings.HasPrefix(raw[i:], "<!--") {
			if end := strings.Index(raw[i+4:], "-->"); end >= 0 {
				mark(i, i+4+end+3)
				i += 4 + end + 2
			}
			continue
		}
		m := htmlOpenPattern.FindStringSubmatchIndex(raw[i:])
		if m == nil {
			continue
		}
		tag := raw[i+m[2] : i+m[3]]
		tags := regexp.MustCompile(`(?i)</?` + regexp.QuoteMeta(tag) + `(?:\s[^<>]*|\s*)>`)
		depth := 1
		for _, found := range tags.FindAllStringIndex(raw[i+m[1]:], -1) {
			start, end := i+m[1]+found[0], i+m[1]+found[1]
			if strings.HasPrefix(raw[start:], "</") {
				depth--
			} else if !strings.HasSuffix(raw[start:end], "/>") {
				depth++
			}
			if depth == 0 {
				mark(i, end)
				i = end - 1
				break
			}
		}
	}
	return mask
}
func scanDestination(raw string, start int) (int, int, bool) {
	for start < len(raw) && (raw[start] == ' ' || raw[start] == '\t' || raw[start] == '\r' || raw[start] == '\n') {
		start++
	}
	if start >= len(raw) {
		return 0, 0, false
	}
	if raw[start] == '<' {
		end := strings.IndexByte(raw[start+1:], '>')
		if end < 0 {
			return 0, 0, false
		}
		return start + 1, start + 1 + end, true
	}
	depth := 0
	for i := start; i < len(raw); i++ {
		c := raw[i]
		if c == '\\' && i+1 < len(raw) {
			i++
			continue
		}
		if c == '(' {
			depth++
		}
		if c == ')' {
			if depth == 0 {
				return start, i, true
			}
			depth--
		}
		if c == '\n' || c == '\r' || c == ' ' || c == '\t' {
			return start, i, i > start
		}
	}
	return start, len(raw), len(raw) > start
}
func sourceDestinations(raw string) []destination {
	mask := protectedSource(raw)
	out := []destination{}
	definitions := map[string]destination{}
	definitionRanges := map[int]int{}
	labelKey := func(s string) string { return strings.ToUpper(strings.Join(strings.Fields(s), " ")) }
	for _, m := range definitionPattern.FindAllStringSubmatchIndex(raw, -1) {
		if mask[m[0]] {
			continue
		}
		start, end, ok := scanDestination(raw, m[1])
		if !ok {
			continue
		}
		label := labelKey(raw[m[2]:m[3]])
		if _, exists := definitions[label]; !exists {
			definitions[label] = destination{start, end, raw[start:end], "link"}
		}
		definitionRanges[m[0]] = end
	}
	used := map[string]string{}
	for i := 0; i < len(raw); i++ {
		if mask[i] {
			continue
		}
		if end, ok := definitionRanges[i]; ok {
			i = end - 1
			continue
		}
		if raw[i] == '\\' {
			i++
			continue
		}
		if raw[i] == '<' && strings.HasPrefix(raw[i+1:], "coral://") {
			if end := strings.IndexByte(raw[i+1:], '>'); end >= 0 {
				start := i + 1
				out = append(out, destination{start, start + end, raw[start : start+end], "link"})
				i = start + end
			}
			continue
		}
		start := i
		image := false
		if raw[i] == '!' && i+1 < len(raw) && raw[i+1] == '[' {
			image = true
			i++
		}
		if raw[i] != '[' {
			continue
		}
		kind := "link"
		if image {
			kind = "image"
		}
		if m := wikiPattern.FindStringSubmatchIndex(raw[start:]); m != nil {
			a, b := start+m[4], start+m[5]
			for a < b && (raw[a] == ' ' || raw[a] == '\t') {
				a++
			}
			for b > a && (raw[b-1] == ' ' || raw[b-1] == '\t') {
				b--
			}
			kind = "wiki"
			if image {
				kind = "wiki-image"
			}
			out = append(out, destination{a, b, raw[a:b], kind})
			i = start + m[1] - 1
			continue
		}
		labelStart := i + 1
		depth := 1
		end := labelStart
		for ; end < len(raw); end++ {
			if raw[end] == '\\' {
				end++
				continue
			}
			if raw[end] == '[' {
				depth++
			}
			if raw[end] == ']' {
				depth--
				if depth == 0 {
					break
				}
			}
			if raw[end] == '\n' && end+1 < len(raw) && raw[end+1] == '\n' {
				break
			}
		}
		if end >= len(raw) || depth != 0 {
			continue
		}
		at := end + 1
		if at < len(raw) && raw[at] == '(' {
			a, b, ok := scanDestination(raw, at+1)
			if ok && a < b {
				finish := b
				if a > 0 && raw[a-1] == '<' {
					finish++
				}
				for finish < len(raw) && (raw[finish] == ' ' || raw[finish] == '\t') {
					finish++
				}
				if finish < len(raw) && (raw[finish] == '\'' || raw[finish] == '"') {
					quote := raw[finish]
					finish++
					for finish < len(raw) && raw[finish] != quote {
						if raw[finish] == '\\' {
							finish++
						}
						finish++
					}
					finish++
					for finish < len(raw) && (raw[finish] == ' ' || raw[finish] == '\t') {
						finish++
					}
				}
				if finish < len(raw) && raw[finish] == ')' {
					out = append(out, destination{a, b, raw[a:b], kind})
				}
			}
		} else {
			label := raw[labelStart:end]
			if at < len(raw) && raw[at] == '[' {
				finish := strings.IndexByte(raw[at+1:], ']')
				if finish >= 0 {
					if finish > 0 {
						label = raw[at+1 : at+1+finish]
					}
					i = at + finish + 1
				}
			}
			key := labelKey(label)
			if _, ok := definitions[key]; ok {
				used[key] = kind
			}
		}
	}
	for label, kind := range used {
		d := definitions[label]
		d.Kind = kind
		out = append(out, d)
	}
	_, body, err := parseMarkdown(raw)
	if err == nil {
		root := goldmark.New().Parser().Parse(text.NewReader([]byte(body)))
		_ = ast.Walk(root, func(n ast.Node, enter bool) (ast.WalkStatus, error) {
			if !enter {
				return ast.WalkContinue, nil
			}
			target, kind := "", "link"
			switch node := n.(type) {
			case *ast.Link:
				target = string(node.Destination)
			case *ast.Image:
				target = string(node.Destination)
				kind = "image"
			case *ast.AutoLink:
				target = string(node.URL([]byte(body)))
			}
			if target != "" {
				protected := false
				_ = ast.Walk(n, func(child ast.Node, inside bool) (ast.WalkStatus, error) {
					if inside {
						if textNode, ok := child.(*ast.Text); ok {
							at := len(raw) - len(body) + textNode.Segment.Start
							if at < len(mask) && mask[at] {
								protected = true
							}
							return ast.WalkStop, nil
						}
					}
					return ast.WalkContinue, nil
				})
				if protected {
					return ast.WalkSkipChildren, nil
				}
				located := false
				for _, d := range out {
					decoded, _ := url.PathUnescape(d.Target)
					if target == d.Target || target == decoded || target == string(util.UnescapePunctuations([]byte(d.Target))) {
						located = true
						break
					}
				}
				if !located {
					out = append(out, destination{-1, -1, target, kind})
				}
			}
			return ast.WalkContinue, nil
		})
	}
	return out
}
func encodedPath(p string) string {
	parts := strings.Split(p, "/")
	for i := range parts {
		parts[i] = strings.ReplaceAll(url.QueryEscape(parts[i]), "+", "%20")
	}
	return strings.Join(parts, "/")
}
func wikiPath(p string) string {
	return strings.NewReplacer("%", "%25", "#", "%23", "[", "%5B", "]", "%5D", "|", "%7C").Replace(p)
}
func relativePath(from, to string) string {
	p, err := filepath.Rel(filepath.FromSlash(from), filepath.FromSlash(to))
	if err != nil {
		return to
	}
	return filepath.ToSlash(p)
}
func rewriteLinks(documents []Document, mapping map[string]string, files map[string]bool) ([]rawChange, []UnresolvedLink, error) {
	relocated := append([]Document{}, documents...)
	for i, d := range relocated {
		if next, ok := mapping[d.Relative]; ok {
			relocated[i].Relative = next
			relocated[i].URI = ResourceURI(d.VaultID, next)
		}
	}
	changes := []rawChange{}
	unresolved := []UnresolvedLink{}
	for index, d := range documents {
		after := relocated[index]
		edits := []struct {
			start, end int
			value      string
		}{}
		report := func(target, reason string) {
			item := UnresolvedLink{after.URI, target, reason}
			for _, prior := range unresolved {
				if prior == item {
					return
				}
			}
			unresolved = append(unresolved, item)
		}
		for _, dest := range sourceDestinations(d.Raw) {
			target := dest.Target
			pathname, fragment := target, ""
			if i := strings.Index(target, "#"); i >= 0 && dest.Kind != "wiki-image" {
				pathname, fragment = target[:i], target[i:]
			}
			replacement := ""
			wiki := dest.Kind == "wiki" || dest.Kind == "wiki-image"
			image := dest.Kind == "image" || dest.Kind == "wiki-image"
			if dest.Kind == "wiki" {
				original := resolveLink(target, documents, &d, false)
				if original == nil {
					report(target, "目标不存在或名称不唯一")
					continue
				}
				next := mapping[original.Relative]
				if next == "" {
					next = original.Relative
				}
				current := resolveLink(target, relocated, &after, false)
				if current == nil || current.URI != ResourceURI(d.VaultID, next) {
					replacement = next
					if !isMarkdown(pathname) {
						replacement = stripExtension(next)
					}
					replacement = wikiPath(replacement) + fragment
					check := resolveLink(replacement, relocated, &after, false)
					if check == nil || check.URI != ResourceURI(d.VaultID, next) {
						return nil, nil, fail(409, "无法明确保持 Wiki 链接目标，尚未整理："+d.URI)
					}
				}
			} else if strings.HasPrefix(strings.ToLower(pathname), "coral://") {
				id, rel, err := parseURI(pathname)
				if err != nil {
					report(target, "Coral 链接格式无效")
					continue
				}
				if id != d.VaultID {
					continue
				}
				next, ok := mapping[rel]
				if !ok {
					report(target, "目标不存在")
					continue
				}
				if next != rel {
					replacement = ResourceURI(id, next) + fragment
				}
			} else {
				if pathname == "" || externalTarget(pathname) {
					continue
				}
				decoded := pathname
				if !wiki {
					var err error
					decoded, err = url.PathUnescape(pathname)
					if err != nil {
						report(target, "链接编码无效")
						continue
					}
				}
				if image && imageMIME(decoded) == "" || !image && !isMarkdown(decoded) {
					continue
				}
				originalPath := path.Clean(path.Join(parent(d.Relative), decoded))
				if !image {
					original := resolveLink(pathname, documents, &d, true)
					if original == nil {
						report(target, "目标不存在")
						continue
					}
					originalPath = original.Relative
				} else if wiki {
					for _, candidate := range decodeCandidates(pathname) {
						p := path.Clean(path.Join(parent(d.Relative), candidate))
						if files[p] {
							originalPath = p
							break
						}
					}
				}
				if _, err := safeParts(originalPath, false); err != nil {
					report(target, "目标超出知识库或使用受保护路径")
					continue
				}
				next, ok := mapping[originalPath]
				if !ok || image && !files[originalPath] {
					report(target, "目标不存在")
					continue
				}
				current := path.Clean(path.Join(parent(after.Relative), decoded))
				if current != next {
					rel := relativePath(parent(after.Relative), next)
					if wiki {
						replacement = wikiPath(rel)
					} else {
						replacement = encodedPath(rel)
					}
					replacement += fragment
				}
			}
			if replacement != "" && replacement != target {
				if dest.Start < 0 {
					return nil, nil, fail(409, "无法准确定位受影响的链接，尚未整理："+d.URI)
				}
				edits = append(edits, struct {
					start, end int
					value      string
				}{dest.Start, dest.End, replacement})
			}
		}
		sort.Slice(edits, func(i, j int) bool { return edits[i].start > edits[j].start })
		raw := d.Raw
		last := len(raw) + 1
		for _, edit := range edits {
			if edit.end > last {
				return nil, nil, fail(409, "无法准确定位受影响的链接，尚未整理："+d.URI)
			}
			raw = raw[:edit.start] + edit.value + raw[edit.end:]
			last = edit.start
		}
		if raw != d.Raw {
			if len(raw) > MaxFileBytes {
				return nil, nil, fail(413, "更新链接后文档超过 16 MiB 大小限制")
			}
			changes = append(changes, rawChange{Original: d, Relative: after.Relative, Raw: raw})
		}
	}
	return changes, unresolved, nil
}

type inventoryItem struct {
	Directory, Symbolic bool
	Version             string
}

func inventory(root string) (map[string]inventoryItem, error) {
	out := map[string]inventoryItem{}
	err := filepath.WalkDir(root, func(p string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if (parent(rel) == "" && (e.Name() == ".git" || e.Name() == ".obsidian" || e.Name() == ".coral-backups" || e.Name() == ".trash")) || (strings.HasPrefix(e.Name(), ".coral-") && strings.HasSuffix(e.Name(), ".tmp")) {
			if e.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := e.Info()
		if err != nil {
			return err
		}
		item := inventoryItem{Directory: info.IsDir(), Symbolic: info.Mode()&os.ModeSymlink != 0}
		if info.Mode().IsRegular() {
			hash, err := fileDigest(p)
			if err != nil {
				return err
			}
			item.Version = hash
		} else if item.Symbolic {
			item.Version, err = os.Readlink(p)
			if err != nil {
				return err
			}
		}
		out[rel] = item
		return nil
	})
	return out, err
}
func (r *Registry) Relocate(uri, destination, version, noteVersion string, updateLinks bool) (RelocationResult, error) {
	_, relative, err := parseURI(uri)
	if err != nil {
		return RelocationResult{}, err
	}
	return r.relocate(uri, destination, version, noteVersion, updateLinks, parent(destination) == parent(relative) && path.Base(destination) != path.Base(relative))
}
func (r *Registry) Rename(uri, name, version, noteVersion string, updateLinks bool) (RelocationResult, error) {
	entry, err := r.Entry(uri)
	if err != nil {
		return RelocationResult{}, err
	}
	if err = validName(name, entry.Kind == "document"); err != nil {
		return RelocationResult{}, err
	}
	return r.relocate(uri, path.Join(parent(entry.Relative), name), version, noteVersion, updateLinks, true)
}
func (r *Registry) relocate(uri, destination, version, noteVersion string, updateLinks, rename bool) (RelocationResult, error) {
	e, err := r.Entry(uri)
	if err != nil {
		return RelocationResult{}, err
	}
	if version == "" || version != e.Version {
		return RelocationResult{}, fail(409, "内容已修改，请刷新后重试")
	}
	if _, err = safeParts(destination, false); err != nil {
		return RelocationResult{}, err
	}
	if err = validName(path.Base(destination), e.Kind == "document"); err != nil {
		return RelocationResult{}, err
	}
	if e.Kind == "directory" && strings.HasPrefix(destination, e.Relative+"/") {
		return RelocationResult{}, fail(400, "不能移动到自身目录内")
	}
	v, err := r.Vault(e.VaultID)
	if err != nil {
		return RelocationResult{}, err
	}
	if e.Kind == "directory" {
		target, err := securePath(v.Root, e.Relative, true)
		if err != nil {
			return RelocationResult{}, err
		}
		vaults, err := r.Vaults()
		if err != nil {
			return RelocationResult{}, err
		}
		for _, other := range vaults {
			root, err := filepath.EvalSymlinks(other.Root)
			if err == nil && (root == target || strings.HasPrefix(root, target+string(filepath.Separator))) {
				return RelocationResult{}, fail(400, "不能整理知识库根目录或包含其他知识库的目录")
			}
		}
	}
	moves := map[string]string{e.Relative: destination}
	if e.Kind == "document" {
		f, err := r.Family(uri)
		if err != nil {
			return RelocationResult{}, err
		}
		if noteVersion != "" && noteVersion != f.Signature {
			return RelocationResult{}, fail(409, "笔记的语言版本已变化，请刷新后重试")
		}
		if f.Issue != "" {
			return RelocationResult{}, fail(409, f.Issue)
		}
		if len(f.Versions) > 1 {
			if rename {
				primaryName := path.Base(destination)
				for _, d := range f.Versions {
					name := primaryName
					if d.URI != f.Primary.URI {
						name = stripExtension(primaryName) + "." + docLanguage(d) + path.Ext(primaryName)
					}
					if err := validName(name, true); err != nil {
						return RelocationResult{}, err
					}
					moves[d.Relative] = path.Join(parent(d.Relative), name)
				}
				destination = moves[e.Relative]
			} else {
				for _, d := range f.Versions {
					moves[d.Relative] = path.Join(parent(destination), path.Base(d.Relative))
				}
			}
		}
	}
	if !updateLinks && len(moves) == 1 {
		return r.relocateOnly(e, destination, v)
	}
	all, err := inventory(v.Root)
	if err != nil {
		return RelocationResult{}, err
	}
	mapping := map[string]string{}
	files := map[string]bool{}
	for rel, item := range all {
		next := rel
		if dest, ok := moves[rel]; ok {
			next = dest
		} else if e.Kind == "directory" && strings.HasPrefix(rel, e.Relative+"/") {
			next = destination + strings.TrimPrefix(rel, e.Relative)
		}
		mapping[rel] = next
		if !item.Directory && !item.Symbolic {
			files[rel] = true
		}
	}
	for from, to := range moves {
		p, err := securePath(v.Root, parent(to), true)
		if err != nil {
			return RelocationResult{}, err
		}
		except := ""
		if parent(from) == parent(to) {
			except = path.Base(from)
		}
		if collision(p, path.Base(to), except) {
			return RelocationResult{}, fail(409, "目标位置已有同名文件或文件夹")
		}
	}
	scan, err := r.Scan(v.ID)
	if err != nil {
		return RelocationResult{}, err
	}
	changes := []rawChange{}
	unresolved := []UnresolvedLink{}
	if updateLinks {
		if scan.Skipped > 0 {
			return RelocationResult{}, fail(409, "部分笔记无法完整读取，尚未整理；请先修复后重试")
		}
		for _, d := range scan.Documents {
			if d.Warning != "" {
				return RelocationResult{}, fail(409, "部分笔记的 YAML 属性无效，尚未整理")
			}
		}
		changes, unresolved, err = rewriteLinks(scan.Documents, mapping, files)
		if err != nil {
			return RelocationResult{}, err
		}
	}
	op := newID()
	root, err := r.backupRoot(v)
	if err != nil {
		return RelocationResult{}, err
	}
	folder := filepath.Join(root, op)
	if err = os.MkdirAll(filepath.Join(folder, "originals"), 0755); err != nil {
		return RelocationResult{}, err
	}
	for i, c := range changes {
		if err = writeExclusive(filepath.Join(folder, "originals", fmt.Sprintf("%d.md", i)), []byte(c.Original.Raw)); err != nil {
			return RelocationResult{}, err
		}
	}
	report := RelocationReport{op, []UpdatedDocument{}, unresolved}
	locations := map[string]string{}
	for rel := range mapping {
		locations[rel] = rel
	}
	fileStates := []map[string]any{}
	for _, c := range changes {
		fileStates = append(fileStates, map[string]any{"original": c.Original.Relative, "destination": c.Relative, "before": c.Original.Version, "after": digest([]byte(c.Raw)), "applied": false})
	}
	state := map[string]any{"status": "prepared", "original": e.Relative, "destination": destination, "report": report, "moves": moves, "files": fileStates}
	save := func() error {
		for i, c := range changes {
			fileStates[i]["applied"] = c.Applied
		}
		return saveJSON(filepath.Join(folder, "state.json"), state)
	}
	if err = save(); err != nil {
		return RelocationResult{}, err
	}
	assertState := func() error {
		now, err := inventory(v.Root)
		if err != nil {
			return err
		}
		if len(now) != len(all) {
			return fail(409, "整理期间知识库目录发生变化，请刷新后重试")
		}
		expectedVersions := map[string]string{}
		for _, c := range changes {
			if c.Applied {
				expectedVersions[c.Original.Relative] = digest([]byte(c.Raw))
			}
		}
		for rel, before := range all {
			after, ok := now[locations[rel]]
			expected := before.Version
			if value, ok := expectedVersions[rel]; ok {
				expected = value
			}
			if !ok || before.Directory != after.Directory || before.Symbolic != after.Symbolic || !before.Directory && after.Version != expected {
				return fail(409, "整理期间知识库文件发生变化，请刷新后重试")
			}
		}
		return nil
	}
	completed := []fileMove{}
	err = func() error {
		if err := assertState(); err != nil {
			return err
		}
		keys := []string{}
		for from := range moves {
			keys = append(keys, from)
		}
		sort.Strings(keys)
		for _, from := range keys {
			to := moves[from]
			if from == to {
				continue
			}
			if r.testHook != nil {
				if err := r.testHook("before-relocate"); err != nil {
					return err
				}
			}
			source, err := securePath(v.Root, from, true)
			if err != nil {
				return err
			}
			target, err := securePath(v.Root, to, false)
			if err != nil {
				return err
			}
			if e.Kind == "directory" {
				err = os.Rename(source, target)
			} else {
				err = transferFile(v.Root, from, to, all[from].Version)
			}
			if err != nil {
				return err
			}
			completed = append(completed, fileMove{from, to, all[from].Version})
			for rel := range locations {
				if rel == from || e.Kind == "directory" && strings.HasPrefix(rel, from+"/") {
					locations[rel] = mapping[rel]
				}
			}
		}
		state["status"] = "applying"
		if err := save(); err != nil {
			return err
		}
		if err := assertState(); err != nil {
			return err
		}
		for i := range changes {
			c := &changes[i]
			c.Attempted = true
			if err := r.replaceBytes(v, c.Relative, []byte(c.Raw), c.Original.Version, filepath.Join(folder, "inodes", fmt.Sprint(i))); err != nil {
				if b, e := readBytes(v.Root, c.Relative); e == nil && digest(b) == digest([]byte(c.Raw)) {
					c.Applied = true
				}
				return err
			}
			c.Applied = true
			if err := save(); err != nil {
				return err
			}
		}
		if err := assertState(); err != nil {
			return err
		}
		for _, c := range changes {
			report.UpdatedDocuments = append(report.UpdatedDocuments, UpdatedDocument{ResourceURI(v.ID, c.Relative), digest([]byte(c.Raw))})
		}
		state["status"] = "complete"
		state["report"] = report
		return save()
	}()
	if err != nil {
		conflicts := []map[string]string{}
		affected := []string{}
		for i := len(changes) - 1; i >= 0; i-- {
			c := &changes[i]
			if !c.Applied {
				if c.Attempted {
					b, check := readBytes(v.Root, c.Relative)
					if check != nil || digest(b) != c.Original.Version {
						conflicts = append(conflicts, map[string]string{"uri": ResourceURI(v.ID, c.Relative), "reason": "写入期间文件被外部替换或无法恢复，原文件备份已保留"})
						affected = append(affected, ResourceURI(v.ID, c.Relative))
					}
				}
				continue
			}
			affected = append(affected, ResourceURI(v.ID, c.Relative))
			if undo := r.replaceBytes(v, c.Relative, []byte(c.Original.Raw), digest([]byte(c.Raw)), ""); undo != nil {
				conflicts = append(conflicts, map[string]string{"uri": ResourceURI(v.ID, c.Relative), "reason": "内容已被外部修改或无法恢复，原文件备份已保留"})
			} else {
				c.Applied = false
			}
		}
		if check := assertState(); check == nil {
			for i := len(completed) - 1; i >= 0; i-- {
				move := completed[i]
				var undo error
				if e.Kind == "directory" {
					a, _ := securePath(v.Root, move.To, true)
					b, _ := securePath(v.Root, move.From, false)
					if exists(b) {
						undo = fail(409, "原位置被占用")
					} else {
						undo = os.Rename(a, b)
					}
				} else {
					undo = transferFile(v.Root, move.To, move.From, move.Version)
				}
				if undo != nil {
					conflicts = append(conflicts, map[string]string{"uri": ResourceURI(v.ID, move.To), "reason": "原位置已占用或整理后的文件发生变化，未自动移回"})
				}
			}
		} else {
			for _, m := range completed {
				conflicts = append(conflicts, map[string]string{"uri": ResourceURI(v.ID, m.To), "reason": "整理期间发生外部修改，保留当前位置和备份"})
			}
		}
		state["status"] = "rolled_back"
		if len(conflicts) > 0 {
			state["status"] = "partial"
		}
		_ = save()
		for _, m := range completed {
			affected = append(affected, ResourceURI(v.ID, m.To))
		}
		return RelocationResult{}, recoveryError(err, op, conflicts, affected)
	}
	paths := []string{}
	for from, to := range moves {
		paths = append(paths, from, to)
	}
	for _, c := range changes {
		paths = append(paths, c.Relative)
	}
	r.history(v, paths, "整理："+e.Relative+" → "+destination)
	entry, err := r.Entry(ResourceURI(v.ID, destination))
	if err != nil {
		return RelocationResult{}, err
	}
	result := RelocationResult{Entry: entry}
	if updateLinks {
		result.Report = &report
	}
	if e.Kind == "document" {
		d, err := r.Document(entry.URI)
		if err != nil {
			return result, err
		}
		d = r.describe(d)
		result.Document = &d
	}
	return result, nil
}

func (r *Registry) relocateOnly(e Entry, destination string, v Vault) (RelocationResult, error) {
	parentPath, err := securePath(v.Root, parent(destination), true)
	if err != nil {
		return RelocationResult{}, err
	}
	except := ""
	if parent(e.Relative) == parent(destination) {
		except = e.Name
	}
	if collision(parentPath, path.Base(destination), except) {
		return RelocationResult{}, fail(409, "目标位置已有同名文件或文件夹")
	}
	latest, err := r.Entry(e.URI)
	if err != nil {
		return RelocationResult{}, err
	}
	if latest.Version != e.Version {
		return RelocationResult{}, fail(409, "内容已修改，请刷新后重试")
	}
	if destination != e.Relative {
		if e.Kind == "directory" {
			source, err := securePath(v.Root, e.Relative, true)
			if err != nil {
				return RelocationResult{}, err
			}
			target, err := securePath(v.Root, destination, false)
			if err != nil {
				return RelocationResult{}, err
			}
			if err = os.Rename(source, target); err != nil {
				return RelocationResult{}, err
			}
		} else if err = transferFile(v.Root, e.Relative, destination, e.Version); err != nil {
			return RelocationResult{}, err
		}
		r.history(v, []string{e.Relative, destination}, "整理："+e.Relative+" → "+destination)
	}
	entry, err := r.Entry(ResourceURI(v.ID, destination))
	if err != nil {
		return RelocationResult{}, err
	}
	result := RelocationResult{Entry: entry}
	if e.Kind == "document" {
		d, err := r.Document(entry.URI)
		if err != nil {
			return result, err
		}
		d = r.describe(d)
		result.Document = &d
	}
	return result, nil
}
func (r *Registry) Report(id, op string) (*RelocationReport, error) {
	if !uuidPattern.MatchString(op) {
		return nil, fail(400, "整理操作编号无效")
	}
	v, err := r.Vault(id)
	if err != nil {
		return nil, err
	}
	folder := filepath.Join(v.Root, ".coral-backups", op)
	info, err := os.Lstat(folder)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fail(404, "整理结果不存在或尚未完成")
	}
	var state struct {
		Status string           `json:"status"`
		Report RelocationReport `json:"report"`
	}
	if err = readJSON(filepath.Join(folder, "state.json"), &state); err != nil || state.Status != "complete" || state.Report.OperationID != op {
		return nil, fail(404, "整理结果不存在或尚未完成")
	}
	return &state.Report, nil
}
