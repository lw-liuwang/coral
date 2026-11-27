package coral

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func uxApp(t *testing.T) *App {
	t.Helper()
	a, err := NewApp(DefaultConfig(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func webForm(a *App, target string, fields url.Values) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(fields.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	a.ServeHTTP(w, req)
	return w
}

func TestWebConfirmationAndExactRestoreReceipt(t *testing.T) {
	a := uxApp(t)
	d := createTest(t, a.Registry, "Safe", "Original", "")
	fields := url.Values{"uri": {d.URI}, "version": {d.Version}}
	w := webForm(a, "/delete", fields)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `name="confirmed" value="1"`) {
		t.Fatalf("confirmation missing: %d %s", w.Code, w.Body.String())
	}
	if _, err := a.Registry.Document(d.URI); err != nil {
		t.Fatal("unconfirmed form removed the note", err)
	}
	fields.Set("confirmed", "1")
	w = webForm(a, "/delete", fields)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	u, _ := url.Parse(w.Header().Get("Location"))
	result, err := a.Registry.readWebResult(u.Query().Get("result"))
	if err != nil || result.Trash == nil || result.Trash.EntryID == "" || result.Trash.Version == "" {
		t.Fatalf("missing exact receipt: %#v %v", result, err)
	}
	// A later deletion must never replace the first operation's recovery target.
	other := createTest(t, a.Registry, "Later", "Later", "")
	if err := a.Registry.Delete(other.URI, other.Version, "", false); err != nil {
		t.Fatal(err)
	}
	receipt := result.Trash
	w = webForm(a, "/trash/restore", url.Values{"scope": {receipt.Scope}, "vault": {receipt.VaultID}, "entry": {receipt.EntryID}, "version": {receipt.Version}})
	if w.Code != http.StatusSeeOther {
		t.Fatalf("restore: %d %s", w.Code, w.Body.String())
	}
	if _, err := a.Registry.Document(d.URI); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Registry.Document(other.URI); err == nil {
		t.Fatal("restored a different deletion")
	}
}

func TestWebConfirmationRetainsVersionProtectionAndPermanentDeleteSafety(t *testing.T) {
	a := uxApp(t)
	d := createTest(t, a.Registry, "Concurrent", "Before", "")
	fields := url.Values{"uri": {d.URI}, "version": {d.Version}}
	webForm(a, "/delete", fields)
	updated, err := a.Registry.Update(d.URI, "After", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	fields.Set("confirmed", "1")
	if w := webForm(a, "/delete", fields); w.Code != http.StatusConflict {
		t.Fatalf("stale confirmation: %d %s", w.Code, w.Body.String())
	}
	receipt, err := a.Registry.DeleteWithReceipt(updated.URI, updated.Version, "", false)
	if err != nil {
		t.Fatal(err)
	}
	purge := url.Values{"scope": {"item"}, "vault": {receipt.VaultID}, "entry": {receipt.EntryID}, "version": {receipt.Version}}
	if w := webForm(a, "/trash/purge", purge); w.Code != 200 || !strings.Contains(w.Body.String(), "无法恢复") {
		t.Fatalf("purge confirmation: %d %s", w.Code, w.Body.String())
	}
	listing, _ := a.Registry.ListTrash("default")
	if len(listing["items"].([]map[string]any)) != 1 {
		t.Fatal("unconfirmed purge removed content")
	}
	empty := url.Values{"filter": {"default"}, "version": {stringValue(listing["version"])}}
	if w := webForm(a, "/trash/empty", empty); w.Code != 200 {
		t.Fatalf("empty confirmation: %d", w.Code)
	}
	listing, _ = a.Registry.ListTrash("default")
	if len(listing["items"].([]map[string]any)) != 1 {
		t.Fatal("unconfirmed empty removed content")
	}
	purge.Set("confirmed", "1")
	if w := webForm(a, "/trash/purge", purge); w.Code != http.StatusSeeOther {
		t.Fatalf("confirmed purge: %d %s", w.Code, w.Body.String())
	}
}

func TestWebContextFormsAndValidationRetainInput(t *testing.T) {
	a := uxApp(t)
	d := createTest(t, a.Registry, "Forms", "# Source", "docs")
	html, err := a.Registry.writePage("new", "default", "", a.nonce, url.Values{"directory": {"docs"}}, "", false)
	if err != nil || !strings.Contains(html, `<option value="docs" selected>`) || !strings.Contains(html, "更改位置") || strings.Contains(html, `<input name="directory"`) {
		t.Fatalf("location picker: %v %s", err, html)
	}
	html, err = a.Registry.writePage("language", "", d.URI, a.nonce, url.Values{}, "", false)
	if err != nil || !strings.Contains(html, `name="source_language"`) || strings.Contains(html, `<select name="language"`) {
		t.Fatalf("language form: %v %s", err, html)
	}
	w := webForm(a, "/languages/new", url.Values{"uri": {d.URI}, "version": {d.Version}, "source_language": {"en"}, "language": {"en"}, "derive_language": {"1"}, "content": {"# 中文译文"}, "title": {"中文译文"}})
	if w.Code != http.StatusSeeOther {
		t.Fatalf("native derived language: %d %s", w.Code, w.Body.String())
	}
	u, _ := url.Parse(w.Header().Get("Location"))
	translated, err := a.Registry.Document(u.Query().Get("uri"))
	if err != nil || docLanguage(translated) != "zh" {
		t.Fatalf("wrong target language: %#v %v", translated, err)
	}
	w = webForm(a, "/rename", url.Values{"uri": {translated.URI}, "version": {translated.Version}, "name": {"invalid.txt"}, "from": {"document"}})
	if w.Code != 400 || !strings.Contains(w.Body.String(), `value="invalid.txt"`) || !strings.Contains(w.Body.String(), `action="/rename"`) {
		t.Fatalf("rename lost context: %d %s", w.Code, w.Body.String())
	}
}

func TestWebImportsReportEveryOutcomeAndPreserveSuccesses(t *testing.T) {
	a := uxApp(t)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("vault", "default")
	files := []struct {
		name    string
		content []byte
	}{
		{"valid.md", []byte("# Valid")},
		{"valid.md", []byte("# Duplicate")},
		{"broken.md", []byte("---\nbad: [\n---\n# Broken")},
		{"encoding.md", []byte{0xff, 0xfe}},
		{"plain.txt", []byte("Unsupported")},
		{"large.md", bytes.Repeat([]byte("a"), MaxFileBytes+1)},
	}
	for _, file := range files {
		part, err := writer.CreateFormFile("files", file.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(file.content); err != nil {
			t.Fatal(err)
		}
	}
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost, "/upload", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	a.ServeHTTP(w, req)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	u, _ := url.Parse(w.Header().Get("Location"))
	if strings.Contains(u.RawQuery, "broken") {
		t.Fatal("report contents leaked into URL")
	}
	result, err := a.Registry.readWebResult(u.Query().Get("result"))
	if err != nil || len(result.Imports) != len(files) {
		t.Fatalf("missing outcomes: %#v %v", result, err)
	}
	if result.Imports[0].Path != "valid.md" || result.Imports[1].Path != "valid-2.md" {
		t.Fatal(result.Imports)
	}
	for i, reason := range []string{"YAML", "UTF-8", ".md", "16 MiB"} {
		if !strings.Contains(result.Imports[i+2].Reason, reason) {
			t.Fatalf("wrong reason: %#v", result.Imports[i+2])
		}
	}
	for _, outcome := range result.Imports[:2] {
		if _, err := a.Registry.Document(outcome.URI); err != nil {
			t.Fatal("successful import was lost", err)
		}
	}
	page := a.Registry.webResultNotice(result.ID)
	if !strings.Contains(page, "已导入 2 个文档，4 个文件未导入") || !strings.Contains(page, "查看逐文件结果") {
		t.Fatal(page)
	}
}

func TestWebResultWriteFailureKeepsCompletedDeleteRecoverable(t *testing.T) {
	a := uxApp(t)
	d := createTest(t, a.Registry, "Receipt", "Keep recovery", "")
	if err := os.MkdirAll(filepath.Join(a.Registry.Config.DataDir, ".coral"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.Registry.Config.DataDir, ".coral/web-results"), []byte("blocked"), 0644); err != nil {
		t.Fatal(err)
	}
	w := webForm(a, "/delete", url.Values{"uri": {d.URI}, "version": {d.Version}, "confirmed": {"1"}})
	response, _ := io.ReadAll(w.Result().Body)
	if w.Code != 200 || !strings.Contains(string(response), `action="/trash/restore"`) || !strings.Contains(string(response), "操作已完成") {
		t.Fatalf("completed operation hidden: %d %s", w.Code, response)
	}
}
