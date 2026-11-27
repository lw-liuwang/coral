package coral

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"

	"coral/internal/assets"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type App struct {
	Registry   *Registry
	MCP        *mcp.Server
	nonce      string
	static     http.Handler
	mcpHandler http.Handler
	assetTags  map[string]string
}

func NewApp(config Config) (*App, error) {
	r, err := NewRegistry(config)
	if err != nil {
		return nil, err
	}
	server, err := NewMCP(r)
	if err != nil {
		return nil, err
	}
	var b [24]byte
	if _, err = rand.Read(b[:]); err != nil {
		return nil, err
	}
	web := assets.Web()
	app := &App{Registry: r, MCP: server, nonce: base64.StdEncoding.EncodeToString(b[:]), static: http.StripPrefix("/static/", http.FileServer(http.FS(web)))}
	if _, err = fs.Stat(web, "client.js"); err != nil {
		return nil, fmt.Errorf("web assets missing: run npm run build:assets before go build")
	}
	app.assetTags = map[string]string{"/static/highlight.css": `"` + digest([]byte(syntaxCSS)) + `"`}
	if err := fs.WalkDir(web, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		content, err := fs.ReadFile(web, name)
		if err != nil {
			return err
		}
		app.assetTags["/static/"+name] = `"` + digest(content) + `"`
		return nil
	}); err != nil {
		return nil, err
	}
	app.mcpHandler = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	return app, nil
}
func (a *App) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-`+a.nonce+`'; img-src 'self' https: http: data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`)
	defer func() {
		if err := recover(); err != nil {
			log.Printf("request panic: %v", err)
			a.writeError(w, req, fail(500, "暂时无法完成操作"))
		}
	}()
	if origin := req.Header.Get("Origin"); origin != "" && req.Method != "GET" && req.Method != "HEAD" && req.Method != "OPTIONS" {
		u, err := url.Parse(origin)
		if err != nil || u.Host != req.Host {
			a.writeError(w, req, fail(403, "请求来源无效"))
			return
		}
	}
	maxRequest := int64(18 * 1024 * 1024)
	if req.URL.Path == "/upload" {
		maxRequest = 20*(MaxFileBytes+256*1024) + 1024*1024
	}
	req.Body = http.MaxBytesReader(w, req.Body, maxRequest)
	if req.URL.Path == "/mcp" {
		if req.Method != "POST" {
			w.Header().Set("Allow", "POST")
			writeJSON(w, 405, map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32000, "message": "Use Streamable HTTP POST"}})
			return
		}
		a.mcpHandler.ServeHTTP(w, req)
		return
	}
	if strings.HasPrefix(req.URL.Path, "/static/") {
		if req.URL.Path == "/static/mermaid.html" {
			w.Header().Set("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`)
		}
		if req.URL.Path == "/static/html-frame.html" {
			w.Header().Set("Content-Security-Policy", `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`)
		}
		if tag := a.assetTags[req.URL.Path]; tag != "" {
			w.Header().Set("ETag", tag)
			w.Header().Set("Cache-Control", "no-cache")
			if strings.HasPrefix(req.URL.Path, "/static/chunks/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			if req.Method == "GET" || req.Method == "HEAD" {
				for _, candidate := range strings.Split(req.Header.Get("If-None-Match"), ",") {
					if candidate = strings.TrimSpace(candidate); candidate == "*" || strings.TrimPrefix(candidate, "W/") == tag {
						w.WriteHeader(http.StatusNotModified)
						return
					}
				}
			}
		}
		if req.URL.Path == "/static/highlight.css" {
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
			_, _ = io.WriteString(w, syntaxCSS)
			return
		}

		a.static.ServeHTTP(w, req)
		return
	}
	readOnly := req.Method != "POST" || req.URL.Path == "/api/preview"
	scoped := *a
	scoped.Registry = a.Registry.scoped(readOnly)
	if err := scoped.Registry.access(req.Context(), !readOnly, func() error { return scoped.route(w, req) }); err != nil {
		a.writeError(w, req, err)
	}
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeHTML(w http.ResponseWriter, status int, html string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, html)
}
func (a *App) writeError(w http.ResponseWriter, req *http.Request, err error) {
	e := appError(err)
	var size *http.MaxBytesError
	if errors.As(err, &size) {
		e = &AppError{Message: "请求内容超过大小限制", Status: 413}
	}
	if e.Status == 500 {
		log.Printf("%s %s: %v", req.Method, req.URL.Path, err)
	}
	if strings.HasPrefix(req.URL.Path, "/api/") || req.URL.Path == "/download" || req.URL.Path == "/asset" || req.Header.Get("Accept") == "application/json" {
		m := cloneMap(e.Details)
		m["error"] = e.Message
		writeJSON(w, e.Status, m)
		return
	}
	page, renderErr := a.Registry.layout("无法完成操作", alert(e.Message)+recoveryNotice(e.Details)+button("/", "返回知识库", "arrow-left", false), a.nonce, pageOptions{Header: `<div class="page-head"><h1>无法完成操作</h1></div>`})
	if renderErr != nil {
		http.Error(w, e.Message, e.Status)
		return
	}
	writeHTML(w, e.Status, page)
}
func numberParam(q url.Values, key string, fallback int) (int, error) {
	value, ok := q[key]
	if !ok {
		return fallback, nil
	}
	if len(value) != 1 {
		return 0, fail(400, "请求参数无效")
	}
	n, err := strconv.Atoi(value[0])
	if err != nil || n < 0 {
		return 0, fail(400, "请求参数无效")
	}
	return n, nil
}
func jsonOrForm(req *http.Request) (url.Values, error) {
	if strings.HasPrefix(req.Header.Get("Content-Type"), "application/json") {
		var data map[string]any
		decoder := json.NewDecoder(req.Body)
		if err := decoder.Decode(&data); err != nil {
			return nil, fail(400, "请求参数无效")
		}
		q := url.Values{}
		for k, v := range data {
			if s, ok := v.(string); ok {
				q.Set(k, s)
			}
		}
		return q, nil
	}
	if err := req.ParseForm(); err != nil {
		return nil, err
	}
	return req.PostForm, nil
}
func (a *App) route(w http.ResponseWriter, req *http.Request) error {
	r := a.Registry
	q := req.URL.Query()
	s := q.Get
	uri := s("uri")
	id := s("vault")
	if id == "" {
		id = "default"
	}
	send := func(html string, err error) error {
		if err != nil {
			return err
		}
		writeHTML(w, 200, html)
		return nil
	}
	redirect := func(target string) { http.Redirect(w, req, target, 303) }
	if req.Method == "GET" || req.Method == "HEAD" {
		switch req.URL.Path {
		case "/":
			if _, ok := q["vault"]; !ok {
				return send(r.catalog(a.nonce, s("trashed") == "1", s("result")))
			}
			return send(r.home(id, s("directory"), a.nonce, q))
		case "/vaults/new":
			return send(r.simpleForm("vault", "", "", a.nonce, q, ""))
		case "/directories/new":
			return send(r.simpleForm("directory", id, s("directory"), a.nonce, q, ""))
		case "/new":
			return send(r.writePage("new", id, "", a.nonce, q, "", false))
		case "/edit":
			return send(r.writePage("edit", id, uri, a.nonce, q, "", false))
		case "/languages/new":
			f, err := r.Family(uri)
			if err != nil {
				return err
			}
			language := s("language")
			if language == "" {
				language = "en"
				if docLanguage(f.Current) == "en" {
					language = "zh"
				}
			}
			if !validLanguage(language) {
				return fail(400, "语言仅支持中文或英文")
			}
			for _, d := range f.Versions {
				if f.Grouped && docLanguage(d) == language {
					redirect(withReturn(viewURL(d.URI), s("return_to")))
					return nil
				}
			}
			return send(r.writePage("language", id, uri, a.nonce, q, "", false))
		case "/document":
			d, err := r.Document(uri)
			if err != nil {
				return err
			}
			return send(r.documentPage(d, a.nonce, searchReturn(s("return_to")), s("operation")))
		case "/rename", "/move":
			return send(r.organizePage(strings.TrimPrefix(req.URL.Path, "/"), uri, a.nonce, q, "", nil))
		case "/search":
			cursor, err := numberParam(q, "cursor", 0)
			if err != nil {
				return err
			}
			return send(r.searchPage(s("vault"), s("q"), cursor, a.nonce))
		case "/trash":
			return send(r.trashPage(s("vault"), s("done"), a.nonce))
		case "/lint":
			return send(r.lintPage(id, a.nonce))
		case "/api/vaults":
			value, err := r.ListVaults()
			if err != nil {
				return err
			}
			writeJSON(w, 200, value)
			return nil
		case "/api/documents":
			cursor, err := numberParam(q, "cursor", 0)
			if err != nil {
				return err
			}
			limit, err := numberParam(q, "limit", 50)
			if err != nil {
				return err
			}
			value, err := r.ListDocuments(id, s("directory"), cursor, limit)
			if err != nil {
				return err
			}
			writeJSON(w, 200, value)
			return nil
		case "/api/search":
			cursor, err := numberParam(q, "cursor", 0)
			if err != nil {
				return err
			}
			limit, err := numberParam(q, "limit", 20)
			if err != nil {
				return err
			}
			value, err := r.Search(s("q"), s("vault"), limit, cursor)
			if err != nil {
				return err
			}
			writeJSON(w, 200, value)
			return nil
		case "/api/document":
			offset, err := numberParam(q, "offset", 0)
			if err != nil {
				return err
			}
			limit, err := numberParam(q, "max_chars", 16000)
			if err != nil {
				return err
			}
			options := ReadOptions{Offset: offset, MaxChars: limit, Version: s("version")}
			if _, ok := q["heading"]; ok {
				heading := s("heading")
				options.Heading = &heading
			}
			value, err := r.Read(uri, options)
			if err != nil {
				return err
			}
			w.Header().Set("Cache-Control", "no-store")
			writeJSON(w, 200, value)
			return nil
		case "/download":
			b, meta, err := r.Download(uri)
			if err != nil {
				return err
			}
			w.Header().Set("ETag", `"`+stringValue(meta["version"])+`"`)
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="document.md"; filename*=UTF-8''`+encodeURI(stringValue(meta["filename"])))
			_, err = w.Write(b)
			return err
		case "/asset":
			b, mime, err := r.Asset(uri)
			if err != nil {
				return err
			}
			w.Header().Set("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; sandbox`)
			w.Header().Set("Content-Type", mime)
			_, err = w.Write(b)
			return err
		}
		return fail(404, "页面不存在")
	}
	if req.Method != "POST" {
		return fail(405, "不支持此请求方法")
	}
	if req.URL.Path == "/upload" {
		return a.upload(w, req)
	}
	fields, err := jsonOrForm(req)
	if err != nil {
		return err
	}
	s = fields.Get
	id = s("vault")
	if id == "" {
		id = "default"
	}
	uri = s("uri")
	returnTo := searchReturn(s("return_to"))
	jsonResponse := req.Header.Get("Accept") == "application/json"
	if !jsonResponse && s("confirmed") != "1" {
		switch req.URL.Path {
		case "/delete", "/delete-directory", "/vaults/delete", "/trash/purge", "/trash/empty":
			return send(r.confirmationPage(req.URL.Path, a.nonce, fields))
		}
	}
	formFailure := func(err error, render func() (string, error)) error {
		if jsonResponse {
			return err
		}
		e := appError(err)
		html, renderErr := render()
		if renderErr != nil {
			return err
		}
		writeHTML(w, e.Status, html)
		return nil
	}
	saved := func(d Document) {
		target := withReturn(viewURL(d.URI), returnTo)
		if jsonResponse {
			writeJSON(w, 200, map[string]any{"uri": d.URI, "version": d.Version, "url": target})
		} else {
			redirect(target)
		}
	}
	switch req.URL.Path {
	case "/vaults/new":
		v, err := r.CreateNamedVault(s("name"), s("description"))
		if err != nil {
			return formFailure(err, func() (string, error) { return r.simpleForm("vault", "", "", a.nonce, fields, appError(err).Message) })
		}
		redirect("/?vault=" + encodeURI(v.ID))
		return nil
	case "/vaults/delete":
		receipt, err := r.DeleteVaultWithReceipt(s("vault"), s("version"))
		if err != nil {
			return err
		}
		return a.finishWebResult(w, req, WebResult{Trash: &receipt}, "/")
	case "/directories/new":
		if err = r.CreateDirectory(id, s("directory"), s("name")); err != nil {
			return formFailure(err, func() (string, error) {
				return r.simpleForm("directory", id, s("directory"), a.nonce, fields, appError(err).Message)
			})
		}
		redirect(directoryURL(id, s("directory")))
		return nil
	case "/new":
		meta, body, err := parseMarkdown(s("content"))
		var d Document
		if err == nil {
			d, err = r.Create(id, s("title"), body, meta, "", s("directory"))
		}
		if err != nil {
			return formFailure(err, func() (string, error) {
				return r.writePage("new", id, "", a.nonce, fields, appError(err).Message, false)
			})
		}
		saved(d)
		return nil
	case "/edit":
		if s("version") == "" {
			return fail(400, "缺少文档版本，请重新打开编辑页")
		}
		d, err := r.Update(uri, s("content"), s("version"))
		if err != nil {
			return formFailure(err, func() (string, error) {
				return r.writePage("edit", id, uri, a.nonce, fields, appError(err).Message, appError(err).Status == 409)
			})
		}
		saved(d)
		return nil
	case "/languages/new":
		if s("derive_language") == "1" && validLanguage(s("source_language")) {
			language := "en"
			if s("source_language") == "en" {
				language = "zh"
			}
			fields.Set("language", language)
		}
		d, err := r.CreateLanguage(uri, s("language"), s("content"), s("version"), s("source_language"), s("title"))
		if err != nil {
			return formFailure(err, func() (string, error) {
				return r.writePage("language", id, uri, a.nonce, fields, appError(err).Message, appError(err).Status == 409)
			})
		}
		saved(d)
		return nil
	case "/rename", "/move":
		organizeFailure := func(err error) error {
			return formFailure(err, func() (string, error) {
				return r.organizePage(strings.TrimPrefix(req.URL.Path, "/"), uri, a.nonce, fields, appError(err).Message, appError(err).Details)
			})
		}
		entry, err := r.Entry(uri)
		if err != nil {
			return err
		}
		destination := path.Join(parent(entry.Relative), s("name"))
		if req.URL.Path == "/move" {
			if entry.Kind != "document" {
				return fail(400, "仅支持移动笔记")
			}
			if _, err := safeParts(s("directory"), true); err != nil {
				return organizeFailure(err)
			}
			destination = path.Join(s("directory"), entry.Name)
		} else if err := validName(s("name"), entry.Kind == "document"); err != nil {
			return organizeFailure(err)
		}
		var result RelocationResult
		if req.URL.Path == "/rename" {
			result, err = r.Rename(uri, s("name"), s("version"), s("note_version"), true)
		} else {
			result, err = r.Relocate(uri, destination, s("version"), s("note_version"), true)
		}
		if err != nil {
			return organizeFailure(err)
		}
		target := directoryURL(result.VaultID, parent(result.Relative)) + "#" + documentAnchor(result.URI)
		if s("from") == "document" && entry.Kind == "document" {
			if strings.Contains(returnTo, "#"+documentAnchor(uri)) {
				returnTo = strings.ReplaceAll(returnTo, "#"+documentAnchor(uri), "#"+documentAnchor(result.URI))
			}
			target = withReturn(viewURL(result.URI), returnTo)
		} else if s("from") == "directory" && entry.Kind == "directory" {
			target = directoryURL(result.VaultID, result.Relative)
		}
		if result.Report != nil && (len(result.Report.UpdatedDocuments) > 0 || len(result.Report.UnresolvedLinks) > 0) {
			u, _ := url.Parse(target)
			qq := u.Query()
			qq.Set("operation", result.Report.OperationID)
			u.RawQuery = qq.Encode()
			target = u.String()
		}
		if jsonResponse {
			out := result.Public()
			out["url"] = target
			writeJSON(w, 200, out)
		} else {
			redirect(target)
		}
		return nil
	case "/delete", "/delete-directory":
		entry, err := r.Entry(uri)
		if err != nil {
			return err
		}
		receipt, err := r.DeleteWithReceipt(uri, s("version"), s("note_version"), req.URL.Path == "/delete-directory")
		if err != nil {
			return err
		}
		return a.finishWebResult(w, req, WebResult{VaultID: entry.VaultID, Trash: &receipt}, directoryURL(entry.VaultID, parent(entry.Relative)))
	case "/trash/restore", "/trash/purge":
		purge := req.URL.Path == "/trash/purge"
		if s("scope") == "vault" {
			err = r.RestoreVault(s("vault"), s("version"), purge)
		} else if s("scope") == "item" {
			err = r.RestoreTrash(s("vault"), s("entry"), s("version"), purge)
		} else {
			err = fail(400, "回收内容类型无效")
		}
		if err != nil {
			return err
		}
		done := "restored"
		if purge {
			done = "purged"
		}
		redirect("/trash?" + url.Values{"vault": {s("filter")}, "done": {done}}.Encode())
		return nil
	case "/trash/empty":
		if err = r.EmptyTrash(s("filter"), s("version")); err != nil {
			return err
		}
		redirect("/trash?" + url.Values{"vault": {s("filter")}, "done": {"emptied"}}.Encode())
		return nil
	case "/api/preview":
		scan, err := r.Scan(id)
		if err != nil {
			return err
		}
		contextURI := s("uri")
		if contextURI == "" {
			contextURI = s("context_uri")
		}
		var current *Document
		if contextURI != "" {
			d, err := r.Document(contextURI)
			if err != nil {
				return err
			}
			current = &d
		}
		meta, body, err := parseMarkdown(s("markdown"))
		if err != nil {
			return err
		}
		if !frontStart.MatchString(s("markdown")) && s("uri") != "" && current != nil {
			meta = current.Metadata
		}
		language := s("language")
		if language == "" && s("uri") != "" && current != nil && validLanguageMetadata(current.Metadata) {
			language = docLanguage(*current)
		}
		if language != "" {
			if !validLanguage(language) {
				return fail(400, "语言仅支持中文或英文")
			}
			meta = cloneMap(meta)
			meta["coral_language"] = language
		}
		rendered, err := RenderMarkdown(body, scan.Documents, current, meta, scan.index.links)
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"html": rendered.HTML})
		return nil
	}
	return fail(404, "页面不存在")
}
func (a *App) upload(w http.ResponseWriter, req *http.Request) error {
	// Each upload is bounded independently; avoid buffering twenty 16 MiB files in memory.
	if err := req.ParseMultipartForm(MaxFileBytes); err != nil {
		return err
	}
	defer req.MultipartForm.RemoveAll()
	if len(req.MultipartForm.File["files"]) > 20 {
		return fail(413, "上传文件过多或超过 16 MiB 限制")
	}
	id := req.FormValue("vault")
	if id == "" {
		id = "default"
	}
	dir := req.FormValue("directory")
	if _, err := safeParts(dir, true); err != nil {
		return err
	}
	if _, err := a.Registry.Vault(id); err != nil {
		return err
	}
	result := WebResult{VaultID: id, Directory: dir, Imports: []ImportOutcome{}}
	for _, header := range req.MultipartForm.File["files"] {
		name := header.Filename
		item := ImportOutcome{Name: name}
		if !validUploadName(name) || strings.HasPrefix(name, ".") {
			item.Reason = "文件名称无效"
		} else if !isMarkdown(name) {
			item.Reason = "仅支持 .md 或 .markdown 文件"
		} else if header.Size > MaxFileBytes {
			item.Reason = "文件超过 16 MiB 大小限制"
		}
		if item.Reason != "" {
			result.Imports = append(result.Imports, item)
			continue
		}
		f, err := header.Open()
		if err != nil {
			item.Reason = "文件无法读取，请重试"
			result.Imports = append(result.Imports, item)
			continue
		}
		b, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
		_ = f.Close()
		if err != nil {
			item.Reason = "文件无法读取，请重试"
			result.Imports = append(result.Imports, item)
			continue
		}
		if len(b) > MaxFileBytes {
			item.Reason = "文件超过 16 MiB 大小限制"
		} else if !utf8.Valid(b) {
			item.Reason = "文件不是有效的 UTF-8 文本"
		}
		if item.Reason != "" {
			result.Imports = append(result.Imports, item)
			continue
		}
		meta, body, err := parseMarkdown(string(b))
		if err != nil {
			item.Reason = "YAML 属性无效：" + importFailure(err)
			result.Imports = append(result.Imports, item)
			continue
		}
		stem := stripExtension(name)
		d, err := a.Registry.Create(id, titleFor(meta, stem), body, meta, stem, dir)
		if err != nil {
			item.Reason = importFailure(err)
		} else {
			item.URI, item.Path = d.URI, d.Relative
		}
		result.Imports = append(result.Imports, item)
	}
	return a.finishWebResult(w, req, result, directoryURL(id, dir))
}
func (a *App) RunStdio(ctx context.Context) error { return a.MCP.Run(ctx, &mcp.StdioTransport{}) }
