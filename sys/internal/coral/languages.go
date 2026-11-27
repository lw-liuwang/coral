package coral

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf16"
)

var languageKeys = []string{"coral_note_id", "coral_language", "coral_primary"}

func validLanguage(s string) bool { return s == "zh" || s == "en" }
func docLanguage(d Document) string {
	if s := stringValue(d.Metadata["coral_language"]); validLanguage(s) {
		return s
	}
	return "zh"
}
func validLanguageMetadata(m map[string]any) bool {
	_, ok := m["coral_primary"].(bool)
	return ok && uuidPattern.MatchString(stringValue(m["coral_note_id"])) && validLanguage(stringValue(m["coral_language"]))
}

type Family struct {
	Primary   Document
	Versions  []Document
	Grouped   bool
	Issue     string
	Current   Document
	Signature string
}

func groupNotes(documents []Document) map[string]Family {
	out := map[string]Family{}
	declared := map[string][]Document{}
	single := func(d Document, issue string) {
		if issue != "" {
			if d.Warning != "" {
				d.Warning += "；"
			}
			d.Warning += issue
		}
		out[d.URI] = Family{Primary: d, Versions: []Document{d}, Issue: issue}
	}
	for _, d := range documents {
		if !uuidPattern.MatchString(stringValue(d.Metadata["coral_note_id"])) {
			issue := ""
			_, hasID := d.Metadata["coral_note_id"]
			_, hasPrimary := d.Metadata["coral_primary"]
			language, hasLanguage := d.Metadata["coral_language"]
			if hasID || hasPrimary || hasLanguage && !validLanguage(stringValue(language)) {
				issue = "语言版本信息无效，当前文件单独显示"
			}
			single(d, issue)
			continue
		}
		key := d.VaultID + ":" + strings.ToLower(stringValue(d.Metadata["coral_note_id"]))
		declared[key] = append(declared[key], d)
	}
	for _, members := range declared {
		valid := len(members) <= 2
		primaries := 0
		languages := map[string]bool{}
		for _, d := range members {
			lang := docLanguage(d)
			if !validLanguageMetadata(d.Metadata) || d.Warning != "" || languages[lang] {
				valid = false
			}
			languages[lang] = true
			if d.Metadata["coral_primary"] == true {
				primaries++
			}
		}
		valid = valid && (primaries == 1 || len(members) == 1 && primaries == 0)
		if !valid {
			for _, d := range members {
				single(d, "语言版本关联有歧义，相关文件分别显示；请检查分组 ID、语言和主版本标记")
			}
			continue
		}
		primary := members[0]
		for _, d := range members {
			if docLanguage(d) == "zh" {
				primary = d
				break
			}
		}
		f := Family{Primary: primary, Versions: members, Grouped: true}
		for _, d := range members {
			out[d.URI] = f
		}
	}
	return out
}
func signature(f Family) string {
	versions := append([]Document{}, f.Versions...)
	sort.Slice(versions, func(i, j int) bool { return docLanguage(versions[i]) < docLanguage(versions[j]) })
	parts := []any{f.Primary.URI}
	for _, d := range versions {
		parts = append(parts, []any{docLanguage(d), d.URI, d.Version})
	}
	return digest(jsonBytes(parts))
}
func withLanguages(d Document, f Family) Document {
	d.NoteURI = f.Primary.URI
	d.Language = docLanguage(d)
	d.NoteVersion = signature(f)
	d.LanguageVersions = []LanguageVersion{}
	for _, v := range f.Versions {
		d.LanguageVersions = append(d.LanguageVersions, LanguageVersion{docLanguage(v), v.URI, v.Title, v.Version})
	}
	return d
}
func (r *Registry) Family(uri string) (Family, error) {
	d, err := r.Document(uri)
	if err != nil {
		return Family{}, err
	}
	uri = d.URI
	groups := groupNotes([]Document{d})
	if uuidPattern.MatchString(stringValue(d.Metadata["coral_note_id"])) {
		scan, err := r.Scan(d.VaultID)
		if err != nil {
			return Family{}, err
		}
		if scan.Skipped > 0 {
			return Family{}, fail(409, "部分笔记无法读取，不能确认完整的语言版本关联，请修复后重试")
		}
		groups = scan.index.groups
	}
	f, ok := groups[uri]
	if !ok {
		return f, fail(409, "读取期间笔记位置发生变化，请重新打开")
	}
	for _, v := range f.Versions {
		if v.URI == uri {
			f.Current = v
			if v.Version != d.Version {
				return f, fail(409, "读取期间笔记内容发生变化，请重新打开")
			}
		}
	}
	f.Signature = signature(f)
	return f, nil
}
func (r *Registry) describe(d Document) Document {
	f, err := r.Family(d.URI)
	if err != nil {
		d.LanguageInfoIncomplete = true
		d.LanguageInfoError = err.Error()
		return d
	}
	return withLanguages(d, f)
}

type ReadOptions struct {
	Offset   int
	MaxChars int
	Heading  *string
	Version  string
}

func (r *Registry) Read(uri string, o ReadOptions) (map[string]any, error) {
	if o.MaxChars == 0 {
		o.MaxChars = 16000
	}
	if o.Offset < 0 || o.MaxChars < 1 || o.MaxChars > 64000 {
		return nil, fail(400, "读取范围无效")
	}
	d, err := r.Document(uri)
	if err != nil {
		return nil, err
	}
	if o.Version != "" && o.Version != d.Version {
		return nil, fail(409, "文档已修改，请从头重新读取")
	}
	units := utf16.Encode([]rune(d.Raw))
	outline := headings(d.Raw)
	begin, end := 0, len(units)
	if o.Heading != nil {
		matches := []Heading{}
		for _, h := range outline {
			if h.Title == *o.Heading {
				matches = append(matches, h)
			}
		}
		if len(matches) != 1 {
			return nil, fail(400, "章节标题不存在或不唯一，请使用 offset 读取")
		}
		h := matches[0]
		begin = h.Offset
		for _, next := range outline {
			if next.Offset > h.Offset && next.Level <= h.Level {
				end = next.Offset
				break
			}
		}
	}
	start := begin + o.Offset
	if start > end {
		return nil, fail(400, "offset 超出文档范围")
	}
	finish := min(start+o.MaxChars, end)
	if finish < end && finish > start && units[finish-1] >= 0xd800 && units[finish-1] <= 0xdbff && units[finish] >= 0xdc00 && units[finish] <= 0xdfff {
		if finish-start == 1 {
			finish++
		} else {
			finish--
		}
	}
	out := r.describe(d).Public()
	out["content"] = string(utf16.Decode(units[start:finish]))
	out["offset"] = o.Offset
	out["next_offset"] = nil
	if finish < end {
		out["next_offset"] = finish - begin
	}
	out["total_chars"] = end - begin
	out["truncated"] = finish < end
	out["start_line"] = strings.Count(string(utf16.Decode(units[:start])), "\n") + 1
	out["headings"] = []Heading{}
	if o.Offset == 0 && o.Heading == nil {
		out["headings"] = outline[:min(100, len(outline))]
	}
	out["headings_truncated"] = len(outline) > 100
	return out, nil
}

func (r *Registry) CreateLanguage(uri, language, content, version, sourceLanguage, title string) (Document, error) {
	if !validLanguage(language) || sourceLanguage != "" && !validLanguage(sourceLanguage) {
		return Document{}, fail(400, "语言必须是 zh 或 en")
	}
	f, err := r.Family(uri)
	if err != nil {
		return Document{}, err
	}
	source := f.Current
	if version == "" || version != source.Version {
		return Document{}, fail(409, "原文已被修改，请重新打开后再添加语言版本")
	}
	if f.Issue != "" || source.Warning != "" {
		return Document{}, fail(409, "原文的语言关联或 YAML 属性无效，请修复后再添加语言版本")
	}
	if sourceLanguage == "" {
		sourceLanguage = docLanguage(source)
	}
	if f.Grouped && sourceLanguage != docLanguage(source) {
		return Document{}, fail(409, "原文语言与已保存的语言版本不一致")
	}
	if language == sourceLanguage {
		return Document{}, fail(400, "新增语言必须与原文语言不同")
	}
	for _, d := range f.Versions {
		if f.Grouped && docLanguage(d) == language {
			return Document{}, fail(409, "该笔记已有此语言版本，请打开后编辑")
		}
	}
	meta, body, err := parseMarkdown(content)
	if err != nil {
		return Document{}, err
	}
	if title == "" {
		title = titleFor(meta, source.Title)
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return Document{}, fail(400, "标题不能为空")
	}
	id := stringValue(source.Metadata["coral_note_id"])
	if !uuidPattern.MatchString(id) {
		id = newID()
	}
	sourceMeta := cloneMap(source.Metadata)
	sourceMeta["coral_note_id"] = id
	sourceMeta["coral_language"] = sourceLanguage
	sourceMeta["coral_primary"] = sourceLanguage == "zh"
	meta["title"] = title
	meta["coral_note_id"] = id
	meta["coral_language"] = language
	meta["coral_primary"] = language == "zh"
	if _, explicit := meta["paragraph_indent"]; language == "en" && !explicit {
		meta["paragraph_indent"] = "2em"
	}
	meta["updated"] = today()
	if _, ok := meta["created"]; !ok {
		meta["created"] = today()
	}
	sourceBytes, err := serialize(sourceMeta, source.Body)
	if err != nil {
		return Document{}, err
	}
	targetBytes, err := serialize(meta, body)
	if err != nil {
		return Document{}, err
	}
	name := strings.TrimSuffix(path.Base(f.Primary.Relative), path.Ext(f.Primary.Relative)) + "." + language + ".md"
	if err = validName(name, true); err != nil {
		return Document{}, err
	}
	relative := path.Join(parent(f.Primary.Relative), name)
	v, err := r.Vault(source.VaultID)
	if err != nil {
		return Document{}, err
	}
	target, err := securePath(v.Root, relative, false)
	if err != nil {
		return Document{}, err
	}
	if collision(filepath.Dir(target), name, "") {
		return Document{}, fail(409, "同名语言版本文件已存在，未覆盖原文件")
	}
	op := newID()
	root, err := r.backupRoot(v)
	if err != nil {
		return Document{}, err
	}
	folder := filepath.Join(root, op)
	if err = os.Mkdir(folder, 0755); err != nil {
		return Document{}, err
	}
	if err = writeExclusive(filepath.Join(folder, "original.md"), []byte(source.Raw)); err != nil {
		return Document{}, err
	}
	created := false
	err = func() error {
		latest, e := r.Document(uri)
		if e != nil {
			return e
		}
		if latest.Version != version {
			return fail(409, "原文已被修改，请重新打开后再添加语言版本")
		}
		if e = writeExclusive(target, targetBytes); e != nil {
			return e
		}
		created = true
		if e = r.replaceBytes(v, source.Relative, sourceBytes, version, filepath.Join(folder, "source")); e != nil {
			return e
		}
		for rel, want := range map[string]string{source.Relative: digest(sourceBytes), relative: digest(targetBytes)} {
			b, e := readBytes(v.Root, rel)
			if e != nil || digest(b) != want {
				return fail(409, "添加语言版本期间文件被其他程序修改")
			}
		}
		return nil
	}()
	if err != nil {
		conflicts := []map[string]string{}
		check, e := readBytes(v.Root, source.Relative)
		if e == nil && digest(check) == digest(sourceBytes) {
			e = r.replaceBytes(v, source.Relative, []byte(source.Raw), digest(sourceBytes), "")
		} else if e == nil && digest(check) != version {
			e = fmt.Errorf("external change")
		}
		if e != nil {
			conflicts = append(conflicts, map[string]string{"uri": uri, "reason": "原文已变化或无法自动恢复，备份已保留"})
		}
		if created {
			check, e = readBytes(v.Root, relative)
			if e == nil && digest(check) == digest(targetBytes) {
				e = os.Remove(target)
			} else {
				e = fmt.Errorf("external change")
			}
			if e != nil {
				conflicts = append(conflicts, map[string]string{"uri": ResourceURI(v.ID, relative), "reason": "新增版本已变化或无法撤回，内容已保留"})
			}
		}
		return Document{}, recoveryError(err, op, conflicts, []string{uri, ResourceURI(v.ID, relative)})
	}
	r.history(v, []string{source.Relative, relative}, "语言版本："+source.Title+" ("+language+")")
	d, err := r.Document(ResourceURI(v.ID, relative))
	if err != nil {
		return d, err
	}
	return r.describe(d), nil
}
func recoveryError(err error, op string, conflicts []map[string]string, affected []string) error {
	e := appError(err)
	suffix := "；本次操作已撤回"
	if len(conflicts) > 0 {
		suffix = "；部分更改未撤回，备份及操作记录已保留"
	}
	return &AppError{Message: e.Message + suffix, Status: e.Status, Details: map[string]any{"recovery": map[string]any{"operation_id": op, "partial": len(conflicts) > 0, "conflicts": conflicts, "affected_uris": affected}}}
}
