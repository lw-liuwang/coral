package coral

import (
	"context"
	"coral/docs"
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofrs/flock"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed data/*
var protocolData embed.FS

const GuideURI = "coral://guide/authoring"

var guideTitles = map[string]string{"workflow": "读写工作流", "languages": "中英文版本", "writing": "文档书写规范", "ci": "写入前 CI：说人话", "links": "链接与附件", "math": "数学公式", "mermaid": "Mermaid 图表", "html": "HTML 交互图", "examples": "可复制示例"}

func writingGuide(topic string) (map[string]any, error) {
	if topic == "" {
		topic = "all"
	}
	guide := docs.Guide
	if topic != "all" {
		title, ok := guideTitles[topic]
		if !ok {
			return nil, fail(400, "写作指南主题无效")
		}
		outline := headings(guide)
		for i, h := range outline {
			if h.Level == 2 && h.Title == title {
				lines := strings.SplitAfter(guide, "\n")
				start, end := 0, len(lines)
				start = h.Line - 1
				for _, next := range outline[i+1:] {
					if next.Level == 2 {
						end = next.Line - 1
						break
					}
				}
				guide = strings.TrimRight(strings.Join(lines[start:end], ""), "\r\n") + "\n"
				break
			}
		}
	}
	return map[string]any{"uri": GuideURI, "topic": topic, "markdown": guide}, nil
}
func (r *Registry) access(ctx context.Context, write bool, fn func() error) error {
	if write {
		r.cache.gate.Lock()
		defer r.cache.gate.Unlock()
	} else {
		r.cache.gate.RLock()
		defer r.cache.gate.RUnlock()
	}
	if !write {
		return fn()
	}
	dir := filepath.Join(r.Config.DataDir, ".coral")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fail(400, "Coral 状态目录不可用")
	}
	lock := flock.New(filepath.Join(dir, "write.lock"))
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	locked, err := lock.TryLockContext(wait, 25*time.Millisecond)
	if err != nil || !locked {
		return fail(409, "知识库正在被其他 Coral 进程修改，请重试")
	}
	defer lock.Unlock()
	return fn()
}
func boolArg(m map[string]any, key string) bool { b, _ := m[key].(bool); return b }
func numberArg(m map[string]any, key string, fallback int) int {
	if n, ok := m[key].(float64); ok {
		return int(n)
	}
	if n, ok := m[key].(int); ok {
		return n
	}
	return fallback
}
func (r *Registry) callTool(name string, a map[string]any) (map[string]any, error) {
	s := func(k string) string { return stringValue(a[k]) }
	uri, id := s("uri"), s("vault_id")
	version := s("version")
	switch name {
	case "get_writing_guide":
		return writingGuide(s("topic"))
	case "list_vaults":
		return r.ListVaults()
	case "list_documents":
		return r.ListDocuments(id, s("directory"), numberArg(a, "cursor", 0), numberArg(a, "limit", 50))
	case "search_documents":
		return r.Search(s("query"), id, numberArg(a, "limit", 20), numberArg(a, "cursor", 0))
	case "read_document":
		o := ReadOptions{Offset: numberArg(a, "offset", 0), MaxChars: numberArg(a, "max_chars", 16000), Version: version}
		if heading, ok := a["heading"].(string); ok {
			o.Heading = &heading
		}
		return r.Read(uri, o)
	case "browse_directory":
		b, err := r.Browse(id, s("directory"))
		if err != nil {
			return nil, err
		}
		entries := []any{}
		add := func(d Document) { m := d.Public(); m["kind"] = "document"; entries = append(entries, m) }
		for _, d := range b.Documents {
			if isIndex(d.Relative) {
				add(d)
			}
		}
		for _, f := range b.Directories {
			var m map[string]any
			_ = jsonUnmarshal(f, &m)
			m["kind"] = "directory"
			entries = append(entries, m)
		}
		for _, d := range b.Documents {
			if !isIndex(d.Relative) {
				add(d)
			}
		}
		cursor, limit := numberArg(a, "cursor", 0), numberArg(a, "limit", 50)
		var next any
		if cursor+limit < len(entries) {
			next = cursor + limit
		}
		return map[string]any{"vault_uri": ResourceURI(id, ""), "directory": s("directory"), "entries": entries[min(cursor, len(entries)):min(cursor+limit, len(entries))], "total": len(entries), "next_cursor": next, "skipped_documents": b.Skipped}, nil
	case "create_vault":
		v, err := r.CreateVaultWithDisplayName(s("name"), s("description"), s("display_name"))
		return map[string]any{"vault_id": v.ID, "name": v.Name, "description": v.Description, "uri": ResourceURI(v.ID, "")}, err
	case "delete_vault":
		err := r.DeleteVault(id, version)
		return map[string]any{"uri": ResourceURI(id, ""), "trashed": true}, err
	case "create_directory":
		err := r.CreateDirectory(id, s("directory"), s("name"))
		rel := path.Join(s("directory"), s("name"))
		return map[string]any{"vault_id": id, "path": rel, "uri": ResourceURI(id, rel), "created": true}, err
	case "create_document":
		meta, body, err := parseMarkdown(s("content"))
		if err != nil {
			return nil, err
		}
		d, err := r.Create(id, s("title"), body, meta, s("filename"), s("directory"))
		return d.Public(), err
	case "create_language_version":
		d, err := r.CreateLanguage(uri, s("language"), s("content"), version, s("source_language"), s("title"))
		return d.Public(), err
	case "update_document":
		d, err := r.Update(uri, s("content"), version)
		return d.Public(), err
	case "rename_document", "rename_directory", "move_document":
		entry, err := r.Entry(uri)
		if err != nil {
			return nil, err
		}
		if name == "rename_document" && entry.Kind != "document" || name == "rename_directory" && entry.Kind != "directory" || name == "move_document" && entry.Kind != "document" {
			return nil, fail(400, "资源类型不匹配")
		}
		destination := ""
		if name == "move_document" {
			destination = path.Join(s("directory"), entry.Name)
			if _, err := safeParts(s("directory"), true); err != nil {
				return nil, err
			}
		} else {
			if err := validName(s("name"), entry.Kind == "document"); err != nil {
				return nil, err
			}
			destination = path.Join(parent(entry.Relative), s("name"))
		}
		var result RelocationResult
		if name == "move_document" {
			result, err = r.Relocate(uri, destination, version, s("note_version"), boolArg(a, "update_links"))
		} else {
			result, err = r.Rename(uri, s("name"), version, s("note_version"), boolArg(a, "update_links"))
		}
		return result.Public(), err
	case "delete_document", "delete_directory":
		err := r.Delete(uri, version, s("note_version"), name == "delete_directory")
		return map[string]any{"uri": uri, "trashed": true}, err
	case "list_trash":
		return r.ListTrash(id)
	case "restore_trash":
		err := r.RestoreTrash(id, s("entry_id"), version, false)
		return map[string]any{"vault_id": id, "entry_id": s("entry_id"), "restored": true}, err
	case "restore_vault":
		err := r.RestoreVault(id, version, false)
		return map[string]any{"uri": ResourceURI(id, ""), "restored": true}, err
	}
	return nil, fail(400, "未知的 MCP 工具")
}
func NewMCP(r *Registry) (*mcp.Server, error) {
	instructions, err := protocolData.ReadFile("data/mcp-instructions.txt")
	if err != nil {
		return nil, err
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "coral", Version: Version}, &mcp.ServerOptions{Instructions: string(instructions)})
	b, err := protocolData.ReadFile("data/mcp-tools.json")
	if err != nil {
		return nil, err
	}
	var tools []*mcp.Tool
	if err = json.Unmarshal(b, &tools); err != nil {
		return nil, err
	}
	for _, tool := range tools {
		var schema jsonschema.Schema
		if err = json.Unmarshal(jsonBytes(tool.InputSchema), &schema); err != nil {
			return nil, err
		}
		resolved, err := schema.Resolve(nil)
		if err != nil {
			return nil, fmt.Errorf("tool schema %s: %w", tool.Name, err)
		}
		name := tool.Name
		server.AddTool(tool, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			r := r.scoped(tool.Annotations != nil && tool.Annotations.ReadOnlyHint)
			args := map[string]any{}
			if len(request.Params.Arguments) > 0 {
				if err := json.Unmarshal(request.Params.Arguments, &args); err != nil {
					return nil, err
				}
			}
			if err := resolved.Validate(args); err != nil {
				return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "请求参数无效：" + err.Error()}}}, nil
			}
			var value map[string]any
			var output *mcp.CallToolResult
			write := tool.Annotations != nil && !tool.Annotations.ReadOnlyHint
			err := r.access(ctx, write, func() error {
				if name == "download_document" {
					bytes, meta, err := r.Download(stringValue(args["uri"]))
					if err != nil {
						return err
					}
					structured := cloneMap(meta)
					structured["encoding"] = "base64"
					output = &mcp.CallToolResult{StructuredContent: structured, Content: []mcp.Content{&mcp.TextContent{Text: string(jsonBytes(meta))}, &mcp.EmbeddedResource{Resource: &mcp.ResourceContents{URI: stringValue(meta["uri"]), MIMEType: "text/markdown", Blob: bytes}}}}
					return nil
				}
				var err error
				value, err = r.callTool(name, args)
				return err
			})
			if err != nil {
				e := appError(err)
				result := &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: e.Message}}}
				if e.Details != nil {
					m := cloneMap(e.Details)
					m["error"] = e.Message
					result.StructuredContent = m
				}
				return result, nil
			}
			if output != nil {
				return output, nil
			}
			text := string(jsonBytes(value))
			if name == "get_writing_guide" {
				text = stringValue(value["markdown"])
			}
			return &mcp.CallToolResult{StructuredContent: value, Content: []mcp.Content{&mcp.TextContent{Text: text}}}, nil
		})
	}
	server.AddResource(&mcp.Resource{URI: GuideURI, Name: "authoring-guide", MIMEType: "text/markdown", Description: "Coral authoring guide: workflows, editorial review, Markdown, math, diagrams and bilingual notes."}, func(ctx context.Context, request *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		guide, err := writingGuide("all")
		if err != nil {
			return nil, err
		}
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: GuideURI, MIMEType: "text/markdown", Text: stringValue(guide["markdown"])}}}, nil
	})
	server.AddResourceTemplate(&mcp.ResourceTemplate{URITemplate: "coral://vault/{vault_id}/{+path}", Name: "document", MIMEType: "text/markdown", Description: "Raw Markdown; use read_document pagination or download_document for large files."}, func(ctx context.Context, request *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		r := r.scoped(true)
		var d Document
		err := r.access(ctx, false, func() error {
			var err error
			d, err = r.Document(request.Params.URI)
			if err == nil && d.Size > 1024*1024 {
				return fail(413, "Resource exceeds 1 MiB; use read_document or download_document")
			}
			return err
		})
		if err != nil {
			return nil, fmt.Errorf("%s", appError(err).Message)
		}
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: d.URI, MIMEType: "text/markdown", Text: d.Raw}}}, nil
	})
	return server, nil
}
