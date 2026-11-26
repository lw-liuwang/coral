package coral

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

type Vault struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Root        string `json:"root"`
}
type LanguageVersion struct {
	Language string `json:"language"`
	URI      string `json:"uri"`
	Title    string `json:"title"`
	Version  string `json:"version"`
}
type Document struct {
	URI                    string            `json:"uri"`
	VaultID                string            `json:"vault_id"`
	Relative               string            `json:"path"`
	Title                  string            `json:"title"`
	Version                string            `json:"version"`
	Size                   int               `json:"size_bytes"`
	Raw                    string            `json:"-"`
	Body                   string            `json:"-"`
	Metadata               map[string]any    `json:"-"`
	Warning                string            `json:"warning,omitempty"`
	NoteURI                string            `json:"note_uri,omitempty"`
	Language               string            `json:"language,omitempty"`
	NoteVersion            string            `json:"note_version,omitempty"`
	LanguageVersions       []LanguageVersion `json:"language_versions,omitempty"`
	LanguageInfoIncomplete bool              `json:"language_info_incomplete,omitempty"`
	LanguageInfoError      string            `json:"language_info_error,omitempty"`
}

func (d Document) Public() map[string]any {
	var m map[string]any
	_ = json.Unmarshal(jsonBytes(d), &m)
	m["mime_type"] = "text/markdown"
	return m
}

type Scan struct {
	Documents []Document
	Skipped   int
}
type Folder struct {
	Name          string `json:"name"`
	Relative      string `json:"relative"`
	URI           string `json:"uri"`
	Version       string `json:"version,omitempty"`
	FileCount     int    `json:"file_count"`
	DocumentCount int    `json:"document_count"`
}
type Browse struct {
	Documents   []Document
	Directories []Folder
	Total       int
	Skipped     int
}
type Entry struct {
	URI      string `json:"uri"`
	VaultID  string `json:"vault_id"`
	Relative string `json:"path"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Version  string `json:"version"`
}
type Registry struct {
	Config   Config
	mu       sync.Mutex
	cache    map[string]Document
	testHook func(string) error
}

func NewRegistry(c Config) (*Registry, error) {
	r := &Registry{Config: c, cache: map[string]Document{}}
	dir := filepath.Join(c.DataDir, "obsdian")
	if !exists(dir) && !exists(filepath.Join(c.DataDir, ".coral/vault-trash/default/state.json")) {
		if err := os.MkdirAll(filepath.Join(dir, "default/.obsidian"), 0755); err != nil {
			return nil, err
		}
	}
	return r, nil
}
func exists(p string) bool { _, e := os.Lstat(p); return e == nil }
func fileDigest(filename string) (string, error) {
	f, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func (r *Registry) Vaults() ([]Vault, error) {
	out := []Vault{}
	seen := map[string]bool{}
	add := func(v Vault) {
		if !seen[v.ID] && !exists(filepath.Join(r.Config.DataDir, ".coral/vault-trash", v.ID, "state.json")) {
			out = append(out, v)
			seen[v.ID] = true
		}
	}
	root := filepath.Join(r.Config.DataDir, "obsdian")
	if exists(filepath.Join(root, "default")) {
		add(Vault{"default", "default", "coral 网页知识库", filepath.Join(root, "default")})
	}
	ids := []string{}
	for id := range r.Config.Vaults {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		v := r.Config.Vaults[id]
		name := v.Name
		if name == "" {
			name = id
		}
		add(Vault{id, name, v.Description, v.Path})
	}
	entries, err := os.ReadDir(root)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	for _, e := range entries {
		if !e.IsDir() || !validVaultName.MatchString(e.Name()) || e.Name() == "default" {
			continue
		}
		v := Vault{ID: e.Name(), Name: e.Name(), Root: filepath.Join(root, e.Name())}
		if b, err := os.ReadFile(filepath.Join(v.Root, ".coral-vault.json")); err == nil {
			var manifest map[string]any
			if json.Unmarshal(b, &manifest) != nil {
				continue
			}
			if id, ok := manifest["id"].(string); ok {
				v.ID = id
			}
			v.Description = stringValue(manifest["description"])
		}
		if validID.MatchString(v.ID) {
			add(v)
		}
	}
	return out, nil
}
func (r *Registry) Vault(id string) (Vault, error) {
	vs, err := r.Vaults()
	if err != nil {
		return Vault{}, err
	}
	for _, v := range vs {
		if v.ID == id {
			info, e := os.Stat(v.Root)
			if e != nil || !info.IsDir() {
				return v, fail(404, "知识库暂不可用")
			}
			return v, nil
		}
	}
	return Vault{}, fail(404, "知识库不存在")
}

// Resolve every component before using os.Root, which also contains path races.
func securePath(root, relative string, mustExist bool) (string, error) {
	parts, err := safeParts(relative, true)
	if err != nil {
		return "", err
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fail(404, "知识库暂不可用")
	}
	target := base
	for i, p := range parts {
		target = filepath.Join(target, p)
		info, e := os.Lstat(target)
		if e != nil {
			if os.IsNotExist(e) && !mustExist {
				continue
			}
			return "", fail(404, "文档不存在")
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fail(400, "不允许访问符号链接")
		}
		if i < len(parts)-1 && !info.IsDir() {
			return "", fail(400, "无效的文档路径")
		}
	}
	return target, nil
}
func readBytes(root, relative string) ([]byte, error) {
	target, err := securePath(root, relative, true)
	if err != nil {
		return nil, err
	}
	before, err := os.Lstat(target)
	if err != nil || !before.Mode().IsRegular() {
		return nil, fail(404, "文档不存在")
	}
	if before.Size() > MaxFileBytes {
		return nil, fail(413, "文档超过 16 MiB 大小限制")
	}
	fs, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer fs.Close()
	f, err := fs.Open(filepath.FromSlash(relative))
	if err != nil {
		return nil, fail(404, "无法读取文档")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(before, info) {
		return nil, fail(409, "读取期间文件发生变化，请重试")
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxFileBytes {
		return nil, fail(413, "文档超过 16 MiB 大小限制")
	}
	return b, nil
}
func (r *Registry) documentAt(v Vault, relative string) (Document, error) {
	if !isMarkdown(relative) {
		return Document{}, fail(404, "仅支持 Markdown 文档")
	}
	b, err := readBytes(v.Root, relative)
	if err != nil {
		return Document{}, err
	}
	if !utf8.Valid(b) {
		return Document{}, fail(400, "文档不是 UTF-8 编码，请下载原始文件")
	}
	uri := ResourceURI(v.ID, relative)
	version := digest(b)
	if d, ok := r.cache[uri]; ok && d.Version == version {
		return d, nil
	}
	raw := string(b)
	m, body, err := parseMarkdown(raw)
	warning := ""
	if err != nil {
		m = map[string]any{}
		body = raw
		warning = "YAML 属性格式无效，已显示原文"
	}
	d := Document{URI: uri, VaultID: v.ID, Relative: relative, Title: titleFor(m, strings.TrimSuffix(path.Base(relative), path.Ext(relative))), Version: version, Size: len(b), Raw: raw, Body: body, Metadata: m, Warning: warning}
	r.cache[uri] = d
	return d, nil
}
func (r *Registry) Document(uri string) (Document, error) {
	id, rel, err := parseURI(uri)
	if err != nil {
		return Document{}, err
	}
	v, err := r.Vault(id)
	if err != nil {
		return Document{}, err
	}
	return r.documentAt(v, rel)
}
func naturalLess(a, b string) bool {
	ar, br := []rune(a), []rune(b)
	i, j := 0, 0
	for i < len(ar) && j < len(br) {
		if unicode.IsDigit(ar[i]) && ar[i] >= '0' && ar[i] <= '9' && br[j] >= '0' && br[j] <= '9' {
			ai, bj := i, j
			for i < len(ar) && ar[i] >= '0' && ar[i] <= '9' {
				i++
			}
			for j < len(br) && br[j] >= '0' && br[j] <= '9' {
				j++
			}
			av, bv := strings.TrimLeft(string(ar[ai:i]), "0"), strings.TrimLeft(string(br[bj:j]), "0")
			if len(av) != len(bv) {
				return len(av) < len(bv)
			}
			if av != bv {
				return av < bv
			}
		} else {
			ac, bc := unicode.ToLower(ar[i]), unicode.ToLower(br[j])
			if ac != bc {
				return ac < bc
			}
			i++
			j++
		}
	}
	if i != len(ar) || j != len(br) {
		return i == len(ar)
	}
	return a < b
}
func (r *Registry) Scan(id string) (Scan, error) {
	v, err := r.Vault(id)
	if err != nil {
		return Scan{}, err
	}
	scan := Scan{Documents: []Document{}}
	var walk func(string) error
	walk = func(dir string) error {
		p, err := securePath(v.Root, dir, true)
		if err != nil {
			return err
		}
		es, err := os.ReadDir(p)
		if err != nil {
			return fail(404, "无法读取知识库目录")
		}
		sort.Slice(es, func(i, j int) bool {
			a, b := es[i], es[j]
			if isIndex(a.Name()) != isIndex(b.Name()) {
				return isIndex(a.Name())
			}
			return naturalLess(a.Name(), b.Name())
		})
		for _, e := range es {
			if strings.HasPrefix(e.Name(), ".") || e.Type()&os.ModeSymlink != 0 {
				continue
			}
			rel := path.Join(dir, e.Name())
			if e.IsDir() {
				if err := walk(rel); err != nil {
					return err
				}
			} else if isMarkdown(rel) {
				d, err := r.documentAt(v, rel)
				if err != nil {
					scan.Skipped++
				} else {
					scan.Documents = append(scan.Documents, d)
				}
			}
		}
		return nil
	}
	err = walk("")
	if err == nil {
		seen := map[string]bool{}
		for _, doc := range scan.Documents {
			seen[doc.URI] = true
		}
		for uri := range r.cache {
			if strings.HasPrefix(uri, ResourceURI(id, "")) && !seen[uri] {
				delete(r.cache, uri)
			}
		}
	}
	return scan, err
}
func (r *Registry) Notes(id string) ([]Document, error) {
	scan, err := r.Scan(id)
	if err != nil {
		return nil, err
	}
	groups := groupNotes(scan.Documents)
	out := []Document{}
	for _, d := range scan.Documents {
		f := groups[d.URI]
		if f.Primary.URI == d.URI {
			out = append(out, withLanguages(f.Primary, f))
		}
	}
	return out, nil
}
func (r *Registry) ListVaults() (map[string]any, error) {
	vs, err := r.Vaults()
	if err != nil {
		return nil, err
	}
	out := []any{}
	for _, v := range vs {
		_, external := r.Config.Vaults[v.ID]
		m := map[string]any{"id": v.ID, "name": v.Name, "description": v.Description, "uri": ResourceURI(v.ID, ""), "version": digest(jsonBytes(v)), "external": external, "available": false, "document_count": 0, "skipped_documents": 0}
		scan, e := r.Scan(v.ID)
		if e == nil {
			seen := map[string]bool{}
			for _, f := range groupNotes(scan.Documents) {
				seen[f.Primary.URI] = true
			}
			m["available"] = true
			m["document_count"] = len(seen)
			m["skipped_documents"] = scan.Skipped
		}
		out = append(out, m)
	}
	return map[string]any{"vaults": out}, nil
}
func (r *Registry) ListDocuments(id, dir string, cursor, limit int) (map[string]any, error) {
	if _, err := safeParts(dir, true); err != nil {
		return nil, err
	}
	if cursor < 0 || limit < 1 || limit > 100 {
		return nil, fail(400, "分页参数无效")
	}
	scan, err := r.Scan(id)
	if err != nil {
		return nil, err
	}
	groups := groupNotes(scan.Documents)
	docs := []any{}
	for _, d := range scan.Documents {
		f := groups[d.URI]
		if f.Primary.URI == d.URI && (dir == "" || strings.HasPrefix(d.Relative, dir+"/")) {
			docs = append(docs, withLanguages(d, f).Public())
		}
	}
	total := len(docs)
	var next any
	if cursor+limit < total {
		next = cursor + limit
	}
	begin := min(cursor, total)
	end := min(cursor+limit, total)
	return map[string]any{"vault_uri": ResourceURI(id, ""), "documents": docs[begin:end], "total": total, "skipped_documents": scan.Skipped, "next_cursor": next}, nil
}
func (r *Registry) Browse(id, dir string) (Browse, error) {
	v, err := r.Vault(id)
	if err != nil {
		return Browse{}, err
	}
	p, err := securePath(v.Root, dir, true)
	if err != nil {
		return Browse{}, err
	}
	es, err := os.ReadDir(p)
	if err != nil {
		return Browse{}, fail(404, "目录不存在")
	}
	notes, err := r.Notes(id)
	if err != nil {
		return Browse{}, err
	}
	scan, err := r.Scan(id)
	if err != nil {
		return Browse{}, err
	}
	out := Browse{Documents: []Document{}, Directories: []Folder{}, Total: len(notes), Skipped: scan.Skipped}
	for _, d := range notes {
		if parent(d.Relative) == dir {
			out.Documents = append(out.Documents, d)
		}
	}
	for _, e := range es {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") && e.Type()&os.ModeSymlink == 0 {
			rel := path.Join(dir, e.Name())
			version, count, _ := snapshot(filepath.Join(p, e.Name()))
			folder := Folder{Name: e.Name(), Relative: rel, URI: ResourceURI(id, rel), Version: version, FileCount: count}
			for _, d := range notes {
				if strings.HasPrefix(d.Relative, rel+"/") {
					folder.DocumentCount++
				}
			}
			out.Directories = append(out.Directories, folder)
		}
	}
	sort.Slice(out.Directories, func(i, j int) bool { return naturalLess(out.Directories[i].Name, out.Directories[j].Name) })
	return out, nil
}
func (r *Registry) Directories(id string) ([]string, error) {
	v, err := r.Vault(id)
	if err != nil {
		return nil, err
	}
	out := []string{""}
	var walk func(string) error
	walk = func(dir string) error {
		p, err := securePath(v.Root, dir, true)
		if err != nil {
			return err
		}
		es, err := os.ReadDir(p)
		if err != nil {
			return err
		}
		sort.Slice(es, func(i, j int) bool { return naturalLess(es[i].Name(), es[j].Name()) })
		for _, e := range es {
			if e.IsDir() && e.Type()&os.ModeSymlink == 0 && !strings.HasPrefix(e.Name(), ".") {
				rel := path.Join(dir, e.Name())
				out = append(out, rel)
				if err := walk(rel); err != nil {
					return err
				}
			}
		}
		return nil
	}
	err = walk("")
	return out, err
}
func snapshot(root string) (string, int, error) {
	var parts []any
	count := 0
	err := filepath.WalkDir(root, func(p string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := e.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		stamp := []any{filepath.ToSlash(rel), info.Mode().String()}
		if !info.IsDir() {
			stamp = append(stamp, info.Size(), info.ModTime().UnixNano())
		}
		if info.Mode().IsRegular() {
			hash, err := fileDigest(p)
			if err != nil {
				return err
			}
			stamp = append(stamp, hash)
		}
		if !info.IsDir() {
			count++
		}
		parts = append(parts, stamp)
		return nil
	})
	if err != nil {
		return "", 0, err
	}
	return digest(jsonBytes(parts)), count, nil
}
func (r *Registry) Entry(uri string) (Entry, error) {
	id, rel, err := parseURI(uri)
	if err != nil {
		return Entry{}, err
	}
	v, err := r.Vault(id)
	if err != nil {
		return Entry{}, err
	}
	p, err := securePath(v.Root, rel, true)
	if err != nil {
		return Entry{}, err
	}
	info, err := os.Lstat(p)
	if err != nil {
		return Entry{}, err
	}
	out := Entry{URI: ResourceURI(id, rel), VaultID: id, Relative: rel, Name: path.Base(rel)}
	if info.IsDir() {
		out.Kind = "directory"
		out.Version, _, err = snapshot(p)
	} else {
		out.Kind = "document"
		var d Document
		d, err = r.Document(uri)
		out.Version = d.Version
	}
	return out, err
}

func (r *Registry) CreateDirectory(id, dir, name string) error {
	name = strings.TrimSpace(name)
	if err := validName(name, false); err != nil {
		return err
	}
	v, err := r.Vault(id)
	if err != nil {
		return err
	}
	p, err := securePath(v.Root, dir, true)
	if err != nil {
		return err
	}
	if collision(p, name, "") {
		return fail(409, "当前目录已有同名文件或文件夹")
	}
	return os.Mkdir(filepath.Join(p, name), 0755)
}
func validName(name string, markdown bool) error {
	if name == "" || len([]byte(name)) > 255 || strings.TrimSpace(name) != name || strings.HasSuffix(name, ".") || strings.ContainsAny(name, `\/:*?"<>|`) {
		return fail(400, "请输入有效的名称")
	}
	if _, err := safeParts(name, false); err != nil {
		return err
	}
	stem := strings.ToLower(strings.SplitN(name, ".", 2)[0])
	if stem == "con" || stem == "prn" || stem == "aux" || stem == "nul" || len(stem) == 4 && (strings.HasPrefix(stem, "com") || strings.HasPrefix(stem, "lpt")) && stem[3] >= '1' && stem[3] <= '9' {
		return fail(400, "请输入有效的名称")
	}
	if markdown && !isMarkdown(name) {
		return fail(400, "文件名称必须保留 .md 或 .markdown 扩展名")
	}
	return nil
}
func collision(dir, name, except string) bool {
	es, err := os.ReadDir(dir)
	if err != nil {
		return true
	}
	for _, e := range es {
		if e.Name() != except && strings.EqualFold(e.Name(), name) {
			return true
		}
	}
	return false
}
func writeExclusive(filename string, b []byte) error {
	f, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func today() string { return time.Now().Format("2006-01-02") }
func (r *Registry) Create(id, title, body string, metadata map[string]any, filename, dir string) (Document, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return Document{}, fail(400, "标题不能为空")
	}
	v, err := r.Vault(id)
	if err != nil {
		return Document{}, err
	}
	p, err := securePath(v.Root, dir, false)
	if err != nil {
		return Document{}, err
	}
	if err = os.MkdirAll(p, 0755); err != nil {
		return Document{}, err
	}
	stem := filename
	if stem == "" {
		stem = title
	}
	stem = strings.Map(func(c rune) rune {
		if strings.ContainsRune(`\/:*?"<>|`, c) || c < 32 || c == 127 {
			return '-'
		}
		return c
	}, stem)
	stem = strings.TrimSpace(strings.TrimLeft(stem, "."))
	rr := []rune(stem)
	if len(rr) > 160 {
		stem = string(rr[:160])
	}
	for len(stem) > 240 {
		_, n := utf8.DecodeLastRuneInString(stem)
		stem = stem[:len(stem)-n]
	}
	if stem == "" {
		stem = "untitled"
	}
	if err := validName(stem+".md", true); err != nil {
		return Document{}, err
	}
	base := stem
	meta := cloneMap(metadata)
	meta["title"] = title
	meta["updated"] = today()
	if _, ok := meta["created"]; !ok {
		meta["created"] = today()
	}
	b, err := serialize(meta, body)
	if err != nil {
		return Document{}, err
	}
	for n := 2; ; n++ {
		if !collision(p, stem+".md", "") {
			rel := path.Join(dir, stem+".md")
			err = writeExclusive(filepath.Join(p, stem+".md"), b)
			if err == nil {
				r.history(v, []string{rel}, "页面：新建 "+title)
				return r.documentAt(v, rel)
			}
			if !os.IsExist(err) {
				return Document{}, err
			}
		}
		stem = fmt.Sprintf("%s-%d", base, n)
	}
}
func (r *Registry) backupRoot(v Vault) (string, error) {
	p := filepath.Join(v.Root, ".coral-backups")
	if err := os.Mkdir(p, 0755); err != nil && !os.IsExist(err) {
		return "", err
	}
	info, err := os.Lstat(p)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fail(400, "文档备份目录不可用")
	}
	return p, nil
}
func (r *Registry) replaceBytes(v Vault, relative string, b []byte, version, backupDir string) error {
	if len(b) > MaxFileBytes {
		return fail(413, "文档超过 16 MiB 大小限制")
	}
	target, err := securePath(v.Root, relative, true)
	if err != nil {
		return err
	}
	old, err := readBytes(v.Root, relative)
	if err != nil {
		return err
	}
	if version == "" || digest(old) != version {
		return fail(409, "文档已被修改，请重新打开后再保存")
	}
	if backupDir == "" {
		root, err := r.backupRoot(v)
		if err != nil {
			return err
		}
		backupDir = filepath.Join(root, newID())
	}
	if err = os.MkdirAll(backupDir, 0755); err != nil {
		return err
	}
	temp := filepath.Join(filepath.Dir(target), ".coral-"+newID()+".tmp")
	if err = writeExclusive(temp, b); err != nil {
		return err
	}
	defer os.Remove(temp)
	if r.testHook != nil {
		if err = r.testHook("before-replace"); err != nil {
			return err
		}
	}
	check, err := readBytes(v.Root, relative)
	if err != nil {
		return err
	}
	if digest(check) != version {
		return fail(409, "文档已被修改，请重新打开后再保存")
	}
	backup := filepath.Join(backupDir, filepath.Base(target))
	if err = os.Rename(target, backup); err != nil {
		return err
	}
	check, err = os.ReadFile(backup)
	if err == nil && digest(check) != version {
		err = fail(409, "文档已被修改，原文件已保留，请重新打开")
	}
	if err == nil {
		err = os.Link(temp, target)
	}
	if err != nil {
		_ = os.Link(backup, target)
		if os.IsExist(err) {
			return fail(409, "文档已被其他程序写入，原文件备份已保留，请重新打开")
		}
		return err
	}
	return nil
}
func (r *Registry) Update(uri, raw, version string) (Document, error) {
	old, err := r.Document(uri)
	if err != nil {
		return Document{}, err
	}
	if version == "" || version != old.Version {
		return Document{}, fail(409, "文档已被修改，请重新打开后再保存")
	}
	meta, body, err := parseMarkdown(raw)
	if err != nil {
		return Document{}, err
	}
	if !frontStart.MatchString(raw) {
		meta = cloneMap(old.Metadata)
	}
	if validLanguageMetadata(old.Metadata) {
		for _, k := range languageKeys {
			if value, ok := meta[k]; ok && value != old.Metadata[k] {
				return Document{}, fail(400, "语言版本关联字段不能在正文编辑中更改")
			}
			meta[k] = old.Metadata[k]
		}
	}
	meta["updated"] = today()
	b, err := serialize(meta, body)
	if err != nil {
		return Document{}, err
	}
	v, err := r.Vault(old.VaultID)
	if err != nil {
		return Document{}, err
	}
	if err = r.replaceBytes(v, old.Relative, b, version, ""); err != nil {
		return Document{}, err
	}
	r.history(v, []string{old.Relative}, "页面：编辑 "+old.Title)
	d, err := r.Document(uri)
	if err != nil {
		return d, err
	}
	return r.describe(d), nil
}
func (r *Registry) history(v Vault, paths []string, message string) {
	git := func(args ...string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "git", append([]string{"-c", "user.name=coral", "-c", "user.email=coral@local"}, args...)...)
		cmd.Dir = v.Root
		return cmd.Run()
	}
	if !exists(filepath.Join(v.Root, ".git")) {
		if git("init", "-q") != nil {
			return
		}
		if !exists(filepath.Join(v.Root, ".gitignore")) {
			_ = writeExclusive(filepath.Join(v.Root, ".gitignore"), []byte("*.tmp\n.trash/\n.coral-backups/\n.obsidian/workspace*.json\n"))
		}
	}
	if git(append([]string{"add", "-A", "--"}, paths...)...) != nil {
		return
	}
	_ = git(append([]string{"commit", "-q", "--only", "--author", "coral-user <coral-user@coral>", "-m", message, "--"}, paths...)...)
}
func (r *Registry) Download(uri string) ([]byte, map[string]any, error) {
	id, rel, err := parseURI(uri)
	if err != nil {
		return nil, nil, err
	}
	v, err := r.Vault(id)
	if err != nil {
		return nil, nil, err
	}
	if !isMarkdown(rel) {
		return nil, nil, fail(404, "仅支持 Markdown 文档")
	}
	b, err := readBytes(v.Root, rel)
	return b, map[string]any{"uri": ResourceURI(id, rel), "vault_id": id, "filename": path.Base(rel), "mime_type": "text/markdown", "size_bytes": len(b), "version": digest(b)}, err
}
func (r *Registry) Asset(uri string) ([]byte, string, error) {
	id, rel, err := parseURI(uri)
	if err != nil {
		return nil, "", err
	}
	mime := map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif"}[strings.ToLower(path.Ext(rel))]
	if mime == "" {
		return nil, "", fail(404, "附件不存在")
	}
	v, err := r.Vault(id)
	if err != nil {
		return nil, "", err
	}
	var b []byte
	for _, candidate := range decodeCandidates(rel) {
		b, err = readBytes(v.Root, candidate)
		if err == nil {
			return b, mime, nil
		}
		if appError(err).Status != 404 {
			return nil, "", err
		}
	}
	return nil, "", err
}
func appError(err error) *AppError {
	var e *AppError
	if errors.As(err, &e) {
		return e
	}
	return &AppError{Message: "暂时无法完成操作", Status: 500}
}
