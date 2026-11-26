package coral

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func fixture(t *testing.T) *Registry {
	t.Helper()
	r, err := NewRegistry(DefaultConfig(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func createTest(t *testing.T, r *Registry, title, body, dir string) Document {
	t.Helper()
	d, err := r.Create("default", title, body, map[string]any{}, "", dir)
	if err != nil {
		t.Fatal(err)
	}
	return d
}
func put(t *testing.T, root, rel, raw string) {
	t.Helper()
	target := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(raw), 0644); err != nil {
		t.Fatal(err)
	}
}
func readTest(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
func TestPathsAndUTF16Pagination(t *testing.T) {
	r := fixture(t)
	d := createTest(t, r, "中文 # 100%", "# Header\n\n😀中文段落\n\n## Part\n\nMore", "目录 空格")
	if !strings.Contains(d.URI, "%E4") || !strings.Contains(d.URI, "%23") {
		t.Fatal(d.URI)
	}
	for _, uri := range []string{"coral://vault/default/../secret.md", "coral://vault/default/%2e%2e/secret.md", "coral://vault/default/a%2fb.md", "coral://vault/default/C%3A/x.md", "coral://vault/default/a%5cb.md"} {
		if _, err := r.Document(uri); err == nil {
			t.Errorf("accepted unsafe URI: %s", uri)
		}
	}
	got := ""
	offset := 0
	for {
		chunk, err := r.Read(d.URI, ReadOptions{Offset: offset, MaxChars: 1, Version: d.Version})
		if err != nil {
			t.Fatal(err)
		}
		got += chunk["content"].(string)
		if chunk["next_offset"] == nil {
			break
		}
		offset = chunk["next_offset"].(int)
	}
	if got != d.Raw {
		t.Fatalf("pagination changed bytes: %q", got)
	}
	heading := "Part"
	chunk, err := r.Read(d.URI, ReadOptions{Heading: &heading})
	if err != nil || !strings.HasPrefix(stringValue(chunk["content"]), "## Part") {
		t.Fatalf("%v %#v", err, chunk)
	}
}
func TestVersionedUpdatesAndExternalWrites(t *testing.T) {
	r := fixture(t)
	d := createTest(t, r, "Version", "Old", "")
	updated, err := r.Update(d.URI, "New", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = r.Update(d.URI, "Stale", d.Version); err == nil {
		t.Fatal("stale write succeeded")
	}
	v, _ := r.Vault("default")
	r.testHook = func(phase string) error {
		if phase == "before-replace" {
			put(t, v.Root, d.Relative, "External")
		}
		return nil
	}
	if _, err = r.Update(d.URI, "Overwrite", updated.Version); err == nil {
		t.Fatal("concurrent write succeeded")
	}
	if raw := readTest(t, v.Root, d.Relative); raw != "External" {
		t.Fatal(raw)
	}
}
func TestNaturalSortAndIndexFirst(t *testing.T) {
	r := fixture(t)
	v, _ := r.Vault("default")
	for _, name := range []string{"100.md", "11.md", "10.md", "9.md", "index.md"} {
		put(t, v.Root, name, "# Note")
	}
	b, err := r.Browse("default", "")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"index.md", "9.md", "10.md", "11.md", "100.md"}
	for i, d := range b.Documents {
		if d.Relative != want[i] {
			t.Fatalf("%d: %s", i, d.Relative)
		}
	}
}
func TestSearchChinesePrimaryAndContext(t *testing.T) {
	r := fixture(t)
	d := createTest(t, r, "KV 带宽", "内容。", "")
	contextDoc := createTest(t, r, "KV Cache 容量与带宽", strings.Repeat("前文\n", 100)+"KV 和 带宽\n后文", "")
	en, err := r.CreateLanguage(d.URI, "en", "# English\n\nuniquelyenglish", d.Version, "zh", "Bandwidth")
	if err != nil {
		t.Fatal(err)
	}
	if en.Language != "en" {
		t.Fatal(en)
	}
	found, err := r.Search("KV 带宽", "", 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	results := found["results"].([]any)
	if len(results) != 2 || results[0].(map[string]any)["title"] != "KV 带宽" {
		t.Fatalf("%#v", found)
	}
	second := results[1].(map[string]any)
	snippet := second["snippet"].(string)
	at := strings.Index(contextDoc.Raw, snippet)
	if !strings.Contains(snippet, "带宽") || at < 0 || second["start_line"].(int) != strings.Count(contextDoc.Raw[:at], "\n")+1 {
		t.Fatal(second)
	}
	found, err = r.Search("uniquelyenglish", "", 20, 0)
	if err != nil || found["total"] != 0 {
		t.Fatalf("English version was searched: %#v %v", found, err)
	}
}
func TestLanguageLifecycle(t *testing.T) {
	r := fixture(t)
	d := createTest(t, r, "Original", "Chinese", "")
	en, err := r.CreateLanguage(d.URI, "en", "---\nparagraph_indent: 2em\n---\n# English\n\nEnglish text", d.Version, "zh", "English")
	if err != nil {
		t.Fatal(err)
	}
	f, err := r.Family(d.URI)
	if err != nil || len(f.Versions) != 2 {
		t.Fatal(err, f)
	}
	if f.Primary.URI != d.URI || en.Metadata["paragraph_indent"] != "2em" {
		t.Fatal(f, en)
	}
	if _, err = r.Update(en.URI, "---\ncoral_language: zh\n---\nWrong", en.Version); err == nil {
		t.Fatal("group metadata mutated")
	}
	_ = r.CreateDirectory("default", "", "archive")
	if _, err = r.Relocate(d.URI, "archive/Original.md", f.Current.Version, "stale", true); err == nil {
		t.Fatal("stale group version accepted")
	}
	moved, err := r.Relocate(d.URI, "archive/Original.md", f.Current.Version, f.Signature, true)
	if err != nil {
		t.Fatal(err)
	}
	f, err = r.Family(moved.URI)
	if err != nil || len(f.Versions) != 2 {
		t.Fatal(err, f)
	}
	for _, member := range f.Versions {
		if !strings.HasPrefix(member.Relative, "archive/") {
			t.Fatal(member.Relative)
		}
	}
	if err = r.Delete(f.Primary.URI, f.Primary.Version, f.Signature, false); err != nil {
		t.Fatal(err)
	}
	trash, err := r.ListTrash("default")
	if err != nil {
		t.Fatal(err)
	}
	items := trash["items"].([]map[string]any)
	if len(items) != 1 {
		t.Fatal(items)
	}
	item := items[0]
	if err = r.RestoreTrash("default", stringValue(item["id"]), stringValue(item["version"]), false); err != nil {
		t.Fatal(err)
	}
	f, err = r.Family(moved.URI)
	if err != nil || len(f.Versions) != 2 {
		t.Fatal(err, f)
	}
}
func TestRelocationPreservesBytesAndReferences(t *testing.T) {
	r := fixture(t)
	v, _ := r.Vault("default")
	raw := "\ufeff---\r\ntitle: Note\r\n---\r\n# Note\r\n![image](assets/pixel.png)\r\n![[assets/pixel.png|300]]\r\n"
	put(t, v.Root, "docs/note.md", raw)
	put(t, v.Root, "docs/assets/pixel.png", "pixel")
	put(t, v.Root, "source.md", "[note](docs/note.md#part)\n[[docs/note|Shown]]\n[reference][n]\n\n[n]: docs/note.md \"Title\"\n\n`[code](docs/note.md)`\n\n```html\n<a href=\"docs/note.md\">[same](docs/note.md)</a>\n```\n")
	_ = r.CreateDirectory("default", "", "archive")
	d, err := r.Document(ResourceURI("default", "docs/note.md"))
	if err != nil {
		t.Fatal(err)
	}
	moved, err := r.Relocate(d.URI, "archive/note.md", d.Version, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if readTest(t, v.Root, "archive/note.md") != raw {
		t.Fatal("byte-preserving move changed Markdown")
	}
	if _, err = r.Relocate(moved.URI, "docs/note.md", moved.Version, "", false); err != nil {
		t.Fatal(err)
	}
	d, err = r.Document(d.URI)
	if err != nil {
		t.Fatal(err)
	}
	result, err := r.Relocate(d.URI, "archive/note.md", d.Version, "", true)
	if err != nil {
		t.Fatal(err)
	}
	expected := strings.ReplaceAll(raw, "assets/pixel.png", "../docs/assets/pixel.png")
	if actual := readTest(t, v.Root, "archive/note.md"); actual != expected {
		t.Fatalf("wanted %q, got %q", expected, actual)
	}
	ref := readTest(t, v.Root, "source.md")
	for _, target := range []string{"[note](archive/note.md#part)", "[[archive/note|Shown]]", "[n]: archive/note.md", "`[code](docs/note.md)`", `href="docs/note.md"`} {
		if !strings.Contains(ref, target) {
			t.Fatalf("missing %q: %s", target, ref)
		}
	}
	if result.Report == nil || len(result.Report.UpdatedDocuments) != 2 {
		t.Fatal(result.Report)
	}
}
func TestRelocationRollbackAndExternalConflict(t *testing.T) {
	for _, external := range []bool{false, true} {
		t.Run(fmt.Sprint(external), func(t *testing.T) {
			r := fixture(t)
			v, _ := r.Vault("default")
			put(t, v.Root, "docs/note.md", "# Note")
			put(t, v.Root, "a.md", "[note](docs/note.md)")
			put(t, v.Root, "b.md", "[note](docs/note.md)")
			_ = r.CreateDirectory("default", "", "archive")
			d, _ := r.Document(ResourceURI("default", "docs/note.md"))
			count := 0
			r.testHook = func(phase string) error {
				if phase == "before-replace" {
					count++
					if count == 2 {
						if external {
							put(t, v.Root, "a.md", "External writer")
						}
						return fail(500, "injected write failure")
					}
				}
				return nil
			}
			_, err := r.Relocate(d.URI, "archive/note.md", d.Version, "", true)
			if err == nil {
				t.Fatal("failure not reported")
			}
			e := appError(err)
			if e.Details == nil {
				t.Fatal("missing recovery")
			}
			if external {
				if readTest(t, v.Root, "a.md") != "External writer" {
					t.Fatal("external write overwritten")
				}
			} else {
				if readTest(t, v.Root, "a.md") != "[note](docs/note.md)" || readTest(t, v.Root, "docs/note.md") != "# Note" {
					t.Fatal("rollback incomplete")
				}
			}
		})
	}
}
func TestMarkdownSafetyOutlineAndIndentation(t *testing.T) {
	r := fixture(t)
	d := createTest(t, r, "Document", "", "")
	body := "# Title\n\n## Part\n\n**参考答案：**内容。\n\nEnglish paragraph.\n\n![pixel](assets/pixel.png)\n\n```html\n<button>Run</button>\n```\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n$$\nx^2\n$$\n\n<script>alert('x')</script>\n"
	rendered, err := RenderMarkdown(body, []Document{d}, &d, map[string]any{"paragraph_indent": "2em"})
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{`<strong>参考答案：</strong>`, `class="paragraph-indent"`, `data-html`, `data-mermaid`, `data-math-display`, `&lt;script&gt;`} {
		if !strings.Contains(rendered.HTML, text) {
			t.Errorf("missing %s in %s", text, rendered.HTML)
		}
	}
	if len(rendered.Headings) != 2 || strings.Contains(rendered.HTML, "<script>") {
		t.Fatal(rendered)
	}
	rendered, err = RenderMarkdown("## Same\n## Same\n## Same-1", nil, nil, nil)
	if err != nil || rendered.Headings[1].ID != "same-1" || rendered.Headings[2].ID != "same-1-1" {
		t.Fatal(err, rendered)
	}
}
func TestVaultTrashExternalRegistration(t *testing.T) {
	r := fixture(t)
	external := t.TempDir()
	put(t, external, "note.md", "External")
	r.Config.Vaults["external"] = VaultConfig{Path: external}
	listing, _ := r.ListVaults()
	var version string
	for _, item := range listing["vaults"].([]any) {
		m := item.(map[string]any)
		if m["id"] == "external" {
			version = stringValue(m["version"])
		}
	}
	if err := r.DeleteVault("external", version); err != nil {
		t.Fatal(err)
	}
	if readTest(t, external, "note.md") != "External" {
		t.Fatal("deleted external file")
	}
	listing, _ = r.ListTrash("")
	v := listing["vaults"].([]map[string]any)[0]
	if err := r.RestoreVault("external", stringValue(v["version"]), false); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Vault("external"); err != nil {
		t.Fatal(err)
	}
}
func TestNativeWebAndMCPShareData(t *testing.T) {
	r := fixture(t)
	app, err := NewApp(r.Config)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app)
	defer server.Close()
	ctx := context.Background()
	client := mcp.NewClient(&mcp.Implementation{Name: "native-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	tools, err := session.ListTools(ctx, nil)
	if err != nil || len(tools.Tools) < 20 {
		t.Fatal(err, tools)
	}
	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil || result.IsError {
			t.Fatalf("%s: %v %#v", name, err, result)
		}
		var value map[string]any
		if err = json.Unmarshal(jsonBytes(result.StructuredContent), &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	guide := call("get_writing_guide", map[string]any{"topic": "languages"})
	if !strings.Contains(stringValue(guide["markdown"]), "create_language_version") {
		t.Fatal(guide)
	}
	created := call("create_document", map[string]any{"vault_id": "default", "title": "中文文档", "content": "# 中文文档\n\nMCP written"})
	uri := stringValue(created["uri"])
	response, err := http.Get(server.URL + viewURL(uri))
	if err != nil {
		t.Fatal(err)
	}
	html, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(string(html), "MCP written") {
		t.Fatal(response.Status, string(html))
	}
	form := url.Values{"uri": {uri}, "version": {stringValue(created["version"])}, "content": {"Web written"}}
	response, err = http.PostForm(server.URL+"/edit", form)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	read := call("read_document", map[string]any{"uri": uri, "max_chars": 64000})
	if !strings.Contains(stringValue(read["content"]), "Web written") {
		t.Fatal(read)
	}
	request, _ := http.NewRequest("POST", server.URL+"/edit", strings.NewReader(form.Encode()))
	request.Header.Set("Origin", "https://evil.invalid")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal(response.Status)
	}
}
