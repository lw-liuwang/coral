package coral

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
	"unicode/utf16"

	"gopkg.in/yaml.v3"
)

const MaxFileBytes = 16 * 1024 * 1024

func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func safeParts(relative string, empty bool) ([]string, error) {
	if relative == "" && empty {
		return []string{}, nil
	}
	parts := strings.Split(relative, "/")
	for _, part := range parts {
		if part == "" || strings.HasPrefix(part, ".") || strings.ContainsAny(part, `\:`) {
			return nil, fail(400, "无效的知识库相对路径")
		}
		for _, c := range part {
			if c < 32 || c == 127 {
				return nil, fail(400, "无效的知识库相对路径")
			}
		}
	}
	return parts, nil
}
func encodeURI(s string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*").Replace(url.QueryEscape(s))
}
func ResourceURI(id, relative string) string {
	parts := strings.Split(relative, "/")
	for i := range parts {
		parts[i] = encodeURI(parts[i])
	}
	return "coral://vault/" + id + "/" + strings.Join(parts, "/")
}
func parseURI(uri string) (string, string, error) {
	if !strings.HasPrefix(uri, "coral://vault/") {
		return "", "", fail(400, "需要 coral://vault/<知识库ID>/<文档> 资源 URI")
	}
	parts := strings.SplitN(strings.TrimPrefix(uri, "coral://vault/"), "/", 2)
	if len(parts) != 2 || !validID.MatchString(parts[0]) || strings.ContainsAny(parts[1], "?#") {
		return "", "", fail(400, "资源 URI 无效")
	}
	segments := strings.Split(parts[1], "/")
	for i, p := range segments {
		v, err := url.PathUnescape(p)
		if err != nil || strings.Contains(v, "/") {
			return "", "", fail(400, "资源 URI 编码无效")
		}
		segments[i] = v
	}
	rel := strings.Join(segments, "/")
	_, err := safeParts(rel, false)
	return parts[0], rel, err
}

var frontStart = regexp.MustCompile(`^(?:\x{FEFF})?---[ \t]*\r?\n`)
var frontEnd = regexp.MustCompile(`(?m)^---[ \t]*(?:\r?\n|$)`)

func parseMarkdown(raw string) (map[string]any, string, error) {
	raw = strings.TrimPrefix(raw, "\ufeff")
	meta := map[string]any{}
	start := frontStart.FindStringIndex(raw)
	if start == nil {
		return meta, raw, nil
	}
	end := frontEnd.FindStringIndex(raw[start[1]:])
	if end == nil {
		return nil, "", fail(400, "Markdown 的 YAML 属性格式无效")
	}
	var node yaml.Node
	if err := yaml.Unmarshal([]byte(raw[start[1]:start[1]+end[0]]), &node); err != nil {
		return nil, "", fail(400, "Markdown 的 YAML 属性格式无效")
	}
	var preserveDates func(*yaml.Node)
	preserveDates = func(n *yaml.Node) {
		if n.Tag == "!!timestamp" {
			n.Tag = "!!str"
		}
		for _, child := range n.Content {
			preserveDates(child)
		}
	}
	preserveDates(&node)
	if err := node.Decode(&meta); err != nil {
		return nil, "", fail(400, "Markdown 的 YAML 属性格式无效")
	}
	if meta == nil {
		meta = map[string]any{}
	}
	return meta, raw[start[1]+end[1]:], nil
}
func serialize(meta map[string]any, body string) ([]byte, error) {
	b, err := yaml.Marshal(meta)
	if err != nil {
		return nil, err
	}
	raw := []byte("---\n" + string(b) + "---\n" + strings.TrimPrefix(body, "\n"))
	if len(raw) > MaxFileBytes {
		return nil, fail(413, "文档超过 16 MiB 大小限制")
	}
	return raw, nil
}
func titleFor(meta map[string]any, fallback string) string {
	if t, ok := meta["title"].(string); ok && strings.TrimSpace(t) != "" {
		return t
	}
	return fallback
}
func isMarkdown(p string) bool {
	e := strings.ToLower(path.Ext(p))
	return e == ".md" || e == ".markdown"
}
func isIndex(p string) bool {
	return strings.EqualFold(path.Base(p), "index.md") || strings.EqualFold(path.Base(p), "index.markdown")
}
func parent(p string) string {
	d := path.Dir(p)
	if d == "." {
		return ""
	}
	return d
}
func stringValue(v any) string { s, _ := v.(string); return s }
func cloneMap(m map[string]any) map[string]any {
	n := map[string]any{}
	for k, v := range m {
		n[k] = v
	}
	return n
}
func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

type Heading struct {
	Title  string `json:"title"`
	Level  int    `json:"level"`
	Offset int    `json:"offset"`
	Line   int    `json:"line"`
}

var atx = regexp.MustCompile(`^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$`)
var fenceStart = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})(.*)")

func headings(raw string) []Heading {
	out := []Heading{}
	offset, lineNum := 0, 1
	fence := ""
	front := frontStart.MatchString(raw)
	for _, line := range strings.SplitAfter(raw, "\n") {
		text := strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if front {
			if lineNum > 1 && strings.TrimSpace(text) == "---" {
				front = false
			}
		} else if marker := fenceStart.FindStringSubmatch(text); marker != nil {
			if fence == "" {
				fence = marker[1]
			} else if marker[1][0] == fence[0] && len(marker[1]) >= len(fence) && strings.TrimSpace(marker[2]) == "" {
				fence = ""
			}
		} else if fence == "" {
			if m := atx.FindStringSubmatch(text); m != nil {
				out = append(out, Heading{m[2], len(m[1]), offset, lineNum})
			}
		}
		offset += utf16Len(line)
		lineNum++
	}
	return out
}
