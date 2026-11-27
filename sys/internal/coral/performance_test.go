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
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestIncrementalScansObserveExternalChanges(t *testing.T) {
	r := fixture(t)
	v, _ := r.Vault("default")
	put(t, v.Root, "a.md", "---\ntitle: Alpha\n---\n[[b]]")
	put(t, v.Root, "b.md", "---\ntitle: Beta\n---\nOld text")
	var reads atomic.Int32
	r.testHook = func(phase string) error {
		if phase == "scan-read" {
			reads.Add(1)
		}
		return nil
	}
	first, err := r.Scan("default")
	if err != nil {
		t.Fatal(err)
	}
	if reads.Load() != 2 {
		t.Fatal(reads.Load())
	}
	if len(first.index.linkedFrom(ResourceURI("default", "b.md"))) != 1 {
		t.Fatal("missing backlink")
	}
	_, _ = r.Search("Old", "default", 20, 0)
	reads.Store(0)
	second, err := r.Scan("default")
	if err != nil {
		t.Fatal(err)
	}
	if reads.Load() != 0 || first.index != second.index {
		t.Fatal("unchanged inventory was reread or rebuilt")
	}
	filename := filepath.Join(v.Root, "b.md")
	info, _ := os.Stat(filename)
	time.Sleep(time.Millisecond)
	put(t, v.Root, "b.md", "---\ntitle: Beta\n---\nNew text")
	if err = os.Chtimes(filename, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	third, err := r.Scan("default")
	if err != nil {
		t.Fatal(err)
	}
	if reads.Load() != 1 || third.Documents[1].Body == first.Documents[1].Body {
		t.Fatal("same-size restored-mtime edit was missed", reads.Load())
	}
	if third.Documents[0].index != first.Documents[0].index {
		t.Fatal("unrelated document reparsed")
	}
	if third.Documents[1].index == first.Documents[1].index {
		t.Fatal("changed search data reused")
	}
	results, _ := r.Search("New", "default", 20, 0)
	if results["total"] != 1 {
		t.Fatal(results)
	}
	results, _ = r.Search("Old", "default", 20, 0)
	if results["total"] != 0 {
		t.Fatal("stale search result")
	}
	if err = os.Remove(filename); err != nil {
		t.Fatal(err)
	}
	put(t, v.Root, "nested/new.md", "---\ntitle: Added\n---\nNew")
	after, err := r.Scan("default")
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Documents) != 2 || after.index.links.resolve("b", nil, false) != nil {
		t.Fatal("deleted document remains indexed")
	}
	if after.index.links.resolve("nested/new", nil, false) == nil {
		t.Fatal("new path not indexed")
	}
	if first.Documents[1].Body != "Old text" {
		t.Fatal("published snapshot was mutated")
	}
}

func TestReadScopeSharesInventoryOnlyWithinRequest(t *testing.T) {
	r := fixture(t)
	v, _ := r.Vault("default")
	put(t, v.Root, "a.md", "Original")
	scope := r.scoped(true)
	a, _ := scope.Scan("default")
	put(t, v.Root, "b.md", "External addition")
	b, _ := scope.Scan("default")
	if a.index != b.index || len(b.Documents) != 1 {
		t.Fatal("request did not reuse inventory")
	}
	c, err := r.scoped(true).Scan("default")
	if err != nil || len(c.Documents) != 2 {
		t.Fatal("next request missed external addition", err)
	}
	writeScope := r.scoped(false)
	before, _ := writeScope.Scan("default")
	put(t, v.Root, "c.md", "Added during mutation")
	after, _ := writeScope.Scan("default")
	if len(before.Documents) != 2 || len(after.Documents) != 3 {
		t.Fatal("write reused preflight inventory")
	}
}

func TestLinkIndexesFollowAliasAmbiguityAndExternalRenames(t *testing.T) {
	r := fixture(t)
	v, _ := r.Vault("default")
	put(t, v.Root, "docs/a.md", "---\naliases: [shared, 中文]\n---\nBody")
	put(t, v.Root, "ref.md", "[[shared]]\n\n```text\n[[ghost]]\n```")
	first, err := r.Scan("default")
	if err != nil {
		t.Fatal(err)
	}
	target := ResourceURI("default", "docs/a.md")
	if d := first.index.links.resolve("shared", nil, false); d == nil || d.URI != target {
		t.Fatal("alias not resolved")
	}
	if len(first.index.linkedFrom(target)) != 1 {
		t.Fatal("alias backlink missing")
	}
	put(t, v.Root, "other/b.md", "---\naliases: [shared]\n---\nOther")
	ambiguous, err := r.Scan("default")
	if err != nil {
		t.Fatal(err)
	}
	if ambiguous.index.links.resolve("shared", nil, false) != nil || len(ambiguous.index.linkedFrom(target)) != 0 {
		t.Fatal("ambiguous alias still resolves")
	}
	if d := ambiguous.index.links.resolve("%E4%B8%AD%E6%96%87", nil, false); d == nil || d.URI != target {
		t.Fatal("encoded alias changed meaning")
	}
	if err = os.Rename(filepath.Join(v.Root, "docs/a.md"), filepath.Join(v.Root, "docs/renamed.md")); err != nil {
		t.Fatal(err)
	}
	renamed, err := r.Scan("default")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.index.links.resolve("docs/a", nil, false) != nil || renamed.index.links.resolve("docs/renamed", nil, false) == nil {
		t.Fatal("renamed path not refreshed")
	}
	if first.index.links.resolve("docs/a", nil, false) == nil {
		t.Fatal("old link snapshot mutated")
	}
}

func TestAttachmentFingerprintsAndFreshMutationPreflight(t *testing.T) {
	r := fixture(t)
	v, _ := r.Vault("default")
	put(t, v.Root, "folder/note.md", "Note")
	put(t, v.Root, "folder/image.svg", "<svg>old</svg>")
	dir := filepath.Join(v.Root, "folder")
	a, _, err := r.browseSnapshot(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := snapshot(dir)
	if err != nil || a != b {
		t.Fatal("cached fingerprint changed version contract", err)
	}
	info, _ := os.Stat(filepath.Join(dir, "image.svg"))
	time.Sleep(time.Millisecond)
	put(t, v.Root, "folder/image.svg", "<svg>new</svg>")
	_ = os.Chtimes(filepath.Join(dir, "image.svg"), info.ModTime(), info.ModTime())
	c, _, err := r.browseSnapshot(dir)
	if err != nil || c == a {
		t.Fatal("attachment edit missed", err)
	}
	if err = r.Delete(ResourceURI("default", "folder"), a, "", true); err == nil {
		t.Fatal("stale directory deletion accepted")
	}
	if readTest(t, v.Root, "folder/image.svg") != "<svg>new</svg>" {
		t.Fatal("external content changed")
	}
}

func TestReadsRunConcurrentlyAndPreviewDoesNotLockForWriting(t *testing.T) {
	r := fixture(t)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		done <- r.access(context.Background(), false, func() error { close(entered); <-release; return nil })
	}()
	<-entered
	second := make(chan error, 1)
	go func() { second <- r.access(context.Background(), false, func() error { return nil }) }()
	select {
	case err := <-second:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		close(release)
		<-done
		t.Fatal("read waited for unrelated read")
	}
	close(release)
	<-done
	app, err := NewApp(DefaultConfig(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "/api/preview", strings.NewReader(`{"vault":"default","markdown":"# Preview"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	if exists(filepath.Join(app.Registry.Config.DataDir, ".coral/write.lock")) {
		t.Fatal("preview acquired write lock")
	}
}

func TestEmbeddedAssetsSupportConditionalRequests(t *testing.T) {
	app, err := NewApp(DefaultConfig(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	for _, url := range []string{"/static/client.js", "/static/drawers.js", "/static/highlight.css", "/static/coral.css", "/static/html-frame.html", "/static/mermaid.html"} {
		a := httptest.NewRecorder()
		app.ServeHTTP(a, httptest.NewRequest("GET", url, nil))
		tag := a.Header().Get("ETag")
		if a.Code != 200 || tag == "" || a.Header().Get("Cache-Control") != "no-cache" {
			t.Fatal(url, a.Code, a.Header())
		}
		for _, method := range []string{"GET", "HEAD"} {
			request := httptest.NewRequest(method, url, nil)
			request.Header.Set("If-None-Match", "W/"+tag)
			b := httptest.NewRecorder()
			app.ServeHTTP(b, request)
			if b.Code != http.StatusNotModified || b.Body.Len() != 0 {
				t.Fatal(url, b.Code, b.Body.Len())
			}
			if b.Header().Get("Content-Security-Policy") != a.Header().Get("Content-Security-Policy") {
				t.Fatal("revalidation changed sandbox policy", url)
			}
		}
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/static/client.js", nil)
	request.Header.Set("If-None-Match", `"old-build"`)
	app.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal("new build was not returned")
	}
}

func TestConcurrentWebMCPReadsDuringVersionedWrite(t *testing.T) {
	app, err := NewApp(DefaultConfig(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	d := createTest(t, app.Registry, "Concurrent", "Original body", "")
	server := httptest.NewServer(app)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "concurrency-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	start := make(chan struct{})
	results := make(chan error, 9)
	verify := func(value map[string]any) error {
		if digest([]byte(stringValue(value["content"]))) != stringValue(value["version"]) {
			return fmt.Errorf("content and version came from different snapshots")
		}
		return nil
	}
	for n := 0; n < 4; n++ {
		go func() {
			<-start
			response, err := http.Get(server.URL + "/api/document?" + url.Values{"uri": {d.URI}, "max_chars": {"64000"}}.Encode())
			if err != nil {
				results <- err
				return
			}
			defer response.Body.Close()
			var value map[string]any
			err = json.NewDecoder(response.Body).Decode(&value)
			if err == nil && response.StatusCode != 200 {
				err = fmt.Errorf("read: %s", response.Status)
			}
			if err == nil {
				err = verify(value)
			}
			results <- err
		}()
		go func() {
			<-start
			result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "read_document", Arguments: map[string]any{"uri": d.URI, "max_chars": 64000}})
			if err != nil {
				results <- err
				return
			}
			if result.IsError {
				results <- fmt.Errorf("MCP read failed: %v", result.Content)
				return
			}
			var value map[string]any
			err = json.Unmarshal(jsonBytes(result.StructuredContent), &value)
			if err == nil {
				err = verify(value)
			}
			results <- err
		}()
	}
	go func() {
		<-start
		request, _ := http.NewRequest("POST", server.URL+"/edit", strings.NewReader(url.Values{"uri": {d.URI}, "version": {d.Version}, "content": {"Updated body"}}.Encode()))
		request.Header.Set("Accept", "application/json")
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		response, err := http.DefaultClient.Do(request)
		if err == nil {
			defer response.Body.Close()
			body, _ := io.ReadAll(response.Body)
			if response.StatusCode != 200 {
				err = fmt.Errorf("write: %s %s", response.Status, body)
			}
		}
		results <- err
	}()
	close(start)
	for n := 0; n < 9; n++ {
		if err = <-results; err != nil {
			t.Error(err)
		}
	}
	current, err := app.Registry.Document(d.URI)
	if err != nil || !strings.Contains(current.Body, "Updated body") {
		t.Fatal("write missing", err)
	}
	if _, err = app.Registry.Update(d.URI, "Stale overwrite", d.Version); err == nil {
		t.Fatal("stale version accepted after concurrent reads")
	}
}
