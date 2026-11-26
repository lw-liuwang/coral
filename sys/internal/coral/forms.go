package coral

import (
	"fmt"
	"net/url"
	"path"
	"strings"
)

func writingSurface(content, label string) string {
	tools := []struct{ command, label, icon string }{{"undo", "撤销", "undo-2"}, {"redo", "重做", "redo-2"}, {"heading", "二级标题", "heading-2"}, {"bold", "加粗", "bold"}, {"italic", "斜体", "italic"}, {"link", "插入链接", "link"}, {"list", "无序列表", "list"}, {"task", "任务列表", "list-todo"}, {"quote", "引用", "quote"}, {"code", "代码块", "code"}}
	out := `<section class="writing-surface" data-mode="split"><div class="draft-notice" hidden role="status"><span data-draft-message>有未保存的本地草稿</span><div class="btns"><button type="button" class="btn small" data-restore-draft>恢复草稿</button><button type="button" class="btn small" data-discard-draft>丢弃草稿</button></div></div><div class="writing-toolbar"><div class="format-tools" role="toolbar" aria-label="Markdown 格式">`
	for _, t := range tools {
		out += `<button type="button" class="icon-btn" disabled data-editor-command="` + t.command + `" aria-label="` + t.label + `" title="` + t.label + `">` + icon(t.icon) + `</button>`
	}
	out += `</div><div class="writing-modes" role="group" aria-label="编辑视图"><button type="button" disabled data-mode="write" aria-pressed="false">书写</button><button type="button" disabled data-mode="split" aria-pressed="true">分栏</button><button type="button" disabled data-mode="preview" aria-pressed="false">预览</button></div><button type="button" class="icon-btn" disabled data-focus-editor aria-pressed="false" aria-label="专注模式" title="专注模式">` + icon("maximize-2") + `</button></div><div class="editor-grid"><div class="source-pane"><textarea id="editor" name="content" aria-label="` + escape(label) + `" spellcheck="false">` + escape(content) + `</textarea><div id="markdown-editor"></div></div><div id="preview" class="preview md-body" aria-label="文档预览"></div></div><footer class="writing-status"><span id="save-status" role="status" aria-live="polite">未修改</span><span id="word-count"></span></footer><div id="save-error" class="alert" role="alert" hidden></div></section>`
	return out
}
func conflictActions(target string, conflict bool) string {
	hide := " hidden"
	if conflict {
		hide = ""
	}
	return `<div id="conflict-actions" class="btns"` + hide + `><a class="btn" data-latest-document href="` + escape(target) + `" target="_blank" rel="noopener">查看最新版本</a><button class="btn" type="button" data-download-draft hidden>下载我的草稿</button></div>`
}
func (r *Registry) writePage(kind, id, uri, nonce string, fields url.Values, message string, conflict bool) (string, error) {
	returnTo := searchReturn(fields.Get("return_to"))
	title, content, dir := fields.Get("title"), fields.Get("content"), fields.Get("directory")
	o := pageOptions{VaultID: id, HasDirectory: true, Query: returnQuery(returnTo)}
	back := directoryURL(id, dir)
	heading, formID, submit, label := "创建文档", "write-form", "创建", "正文"
	action := "/new"
	inputs := hidden("vault", id)
	preview := `<input type="hidden" id="preview-vault" value="` + escape(id) + `">`
	documentFields := `<div class="document-fields"><label>标题<input name="title" placeholder="文档标题" value="` + escape(title) + `" required maxlength="200"></label><label>保存目录<input name="directory" placeholder="根目录" value="` + escape(dir) + `" maxlength="1000"></label></div>`
	if kind != "new" {
		d, err := r.Document(uri)
		if err != nil {
			return "", err
		}
		id = d.VaultID
		o.VaultID = id
		dir = parent(d.Relative)
		o.Filename = path.Base(d.Relative)
		back = withReturn(viewURL(uri), returnTo)
		version := fields.Get("version")
		if version == "" {
			version = d.Version
		}
		inputs = hidden("uri", uri) + hidden("version", version) + hidden("return_to", returnTo)
		preview = `<input type="hidden" id="preview-vault" value="` + escape(id) + `">`
		if kind == "edit" {
			heading = d.Title
			formID = "edit-form"
			submit = "保存"
			label = "Markdown 正文"
			action = "/edit"
			if _, ok := fields["content"]; !ok {
				content = d.Raw
			}
			documentFields = ""
			preview += `<input type="hidden" id="preview-uri" value="` + escape(uri) + `">`
		} else {
			f, err := r.Family(uri)
			if err != nil {
				return "", err
			}
			source := fields.Get("source_language")
			if source == "" {
				source = docLanguage(d)
			}
			language := fields.Get("language")
			if language == "" {
				language = "en"
				if source == "en" {
					language = "zh"
				}
			}
			if !validLanguage(source) || !validLanguage(language) {
				return "", fail(400, "语言仅支持中文或英文")
			}
			heading = "添加语言版本"
			formID = "language-form"
			submit = "保存版本"
			label = "新版本正文"
			action = "/languages/new"
			if title == "" {
				title = d.Title
			}
			languageOptions := func(selected string) string {
				zh, en := "", ""
				if selected == "zh" {
					zh = " selected"
				} else {
					en = " selected"
				}
				return `<option value="zh"` + zh + `>中文</option><option value="en"` + en + `>English</option>`
			}
			languages := hidden("source_language", source) + hidden("language", language)
			if !f.Grouped {
				languages = `<label>原文语言<select name="source_language">` + languageOptions(source) + `</select></label><label>新增语言<select name="language">` + languageOptions(language) + `</select></label>`
			}
			documentFields = `<div class="document-fields language-fields"><label>标题<input name="title" value="` + escape(title) + `" required maxlength="200"></label>` + languages + `</div>`
			preview += `<input type="hidden" id="preview-context-uri" value="` + escape(uri) + `">`
			dir = parent(f.Primary.Relative)
			o.Filename = path.Base(f.Primary.Relative)
		}
	}
	o.Directory = dir
	if _, err := safeParts(dir, true); err != nil {
		o.Directory = ""
	}
	if _, err := r.Vault(id); err != nil {
		return "", err
	}
	backLabel := "返回"
	if kind != "new" {
		backLabel = "返回阅读"
	}
	o.Header = `<div class="page-head"><h1>` + escape(heading) + `</h1><div class="btns">` + button(back, backLabel, "arrow-left", false) + `<button class="btn primary" form="` + formID + `" type="submit">` + icon("save") + submit + `</button></div></div>`
	out := alert(message) + `<form id="` + formID + `" class="writing-form" action="` + action + `" method="post">` + inputs + documentFields + preview + writingSurface(content, label)
	if kind != "new" {
		out += conflictActions(back, conflict)
	}
	return r.layout(heading, out+`</form>`, nonce, o)
}
func (r *Registry) organizePage(kind, uri, nonce string, fields url.Values, message string, details map[string]any) (string, error) {
	e, err := r.Entry(uri)
	if err != nil {
		return "", err
	}
	version := fields.Get("version")
	if version == "" {
		version = e.Version
	}
	noteVersion := fields.Get("note_version")
	if e.Kind == "document" {
		f, err := r.Family(uri)
		if err != nil {
			return "", err
		}
		if noteVersion == "" && f.Grouped {
			noteVersion = f.Signature
		}
	}
	dir := parent(e.Relative)
	from := fields.Get("from")
	returnTo := searchReturn(fields.Get("return_to"))
	back := directoryURL(e.VaultID, dir)
	if from == "document" {
		back = withReturn(viewURL(uri), returnTo)
	} else if from == "directory" {
		back = directoryURL(e.VaultID, e.Relative)
	}
	heading := "重命名文件"
	if e.Kind == "directory" {
		heading = "重命名文件夹"
	}
	submit := "保存名称"
	field := ""
	if kind == "move" {
		heading = "移动笔记"
		submit = "确认移动"
		dirs, err := r.Directories(e.VaultID)
		if err != nil {
			return "", err
		}
		selected := dir
		if _, ok := fields["directory"]; ok {
			selected = fields.Get("directory")
		}
		field = `<label>目标文件夹<select name="directory">`
		for _, p := range dirs {
			label := p
			if label == "" {
				label = "知识库根目录"
			}
			sel := ""
			if p == selected {
				sel = " selected"
			}
			field += `<option value="` + escape(p) + `"` + sel + `>` + escape(label) + `</option>`
		}
		field += `</select></label>`
	} else {
		name := fields.Get("name")
		if _, ok := fields["name"]; !ok {
			name = e.Name
		}
		label := "文件名称（含扩展名）"
		if e.Kind == "directory" {
			label = "文件夹名称"
		}
		field = `<label>` + label + `<input name="name" required maxlength="255" value="` + escape(name) + `" autofocus></label>`
	}
	header := `<div class="page-head"><h1>` + heading + `</h1><div class="btns">` + button(back, "取消", "arrow-left", false) + copyButton(uri, "") + `</div></div>`
	content := alert(message) + recoveryNotice(details) + `<form class="form" action="/` + kind + `" method="post">` + hidden("uri", uri) + hidden("version", version) + hidden("note_version", noteVersion) + hidden("from", from) + hidden("return_to", returnTo) + field + `<button class="btn primary" type="submit">` + icon("save") + submit + `</button></form>`
	return r.layout(heading, content, nonce, pageOptions{VaultID: e.VaultID, Directory: dir, Filename: e.Name, HasDirectory: true, Header: header})
}
func recoveryNotice(details map[string]any) string {
	if details == nil {
		return ""
	}
	recovery, ok := details["recovery"].(map[string]any)
	if !ok {
		return ""
	}
	out := `<section class="recovery-result"><p>恢复编号：<code>` + escape(stringValue(recovery["operation_id"])) + `</code></p>`
	if conflicts, ok := recovery["conflicts"].([]map[string]string); ok {
		out += `<ul>`
		for _, c := range conflicts {
			out += `<li>` + escape(c["uri"]) + `：` + escape(c["reason"]) + `</li>`
		}
		out += `</ul>`
	}
	return out + `</section>`
}
func (r *Registry) simpleForm(kind, id, dir, nonce string, fields url.Values, message string) (string, error) {
	heading := "创建知识库"
	back := "/"
	action := "/vaults/new"
	inputs := ""
	fieldsHTML := `<label>仓库名称（英文）<input name="name" required maxlength="64" pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" value="` + escape(fields.Get("name")) + `"></label><label>简介<textarea name="description" rows="3" maxlength="2000">` + escape(fields.Get("description")) + `</textarea></label>`
	o := pageOptions{}
	if kind == "directory" {
		if _, err := r.Browse(id, dir); err != nil {
			return "", err
		}
		heading = "创建文件夹"
		action = "/directories/new"
		back = directoryURL(id, dir)
		inputs = hidden("vault", id) + hidden("directory", dir)
		fieldsHTML = `<label>文件夹名称<input name="name" required maxlength="255" value="` + escape(fields.Get("name")) + `" autofocus></label>`
		o.VaultID = id
		o.Directory = dir
		o.HasDirectory = true
	}
	o.Header = `<div class="page-head"><h1>` + heading + `</h1>` + button(back, "返回", "arrow-left", false) + `</div>`
	return r.layout(heading, alert(message)+`<form class="form" action="`+action+`" method="post">`+inputs+fieldsHTML+`<button class="btn primary" type="submit">`+icon("folder-plus")+heading+`</button></form>`, nonce, o)
}
func (r *Registry) trashPage(id, done, nonce string) (string, error) {
	listing, err := r.ListTrash(id)
	if err != nil {
		return "", err
	}
	items := listing["items"].([]map[string]any)
	vaults := listing["vaults"].([]map[string]any)
	form := func(action, scope, vault, entry, version, label string, purge bool) string {
		confirm := ""
		class := "btn"
		text := "恢复"
		symbol := "rotate-ccw"
		if purge {
			confirm = ` data-confirm="彻底删除这些回收内容？此操作无法撤销。"`
			class += " danger"
			text = "彻底删除"
			symbol = "trash-2"
		}
		return `<form action="/trash/` + action + `" method="post"` + confirm + `>` + hidden("scope", scope) + hidden("vault", vault) + hidden("entry", entry) + hidden("version", version) + hidden("filter", id) + `<button class="` + class + `" aria-label="` + escape(label) + `" title="` + escape(label) + `">` + icon(symbol) + `<span>` + text + `</span></button></form>`
	}
	content := ""
	notice := map[string]string{"restored": "已恢复。", "purged": "已彻底删除回收内容。", "emptied": "回收站已清空。"}[done]
	if notice != "" {
		content += `<div class="alert ok" role="status">` + notice + `</div>`
	}
	rows := ""
	for _, v := range vaults {
		name := stringValue(v["name"])
		vid := stringValue(v["id"])
		version := stringValue(v["version"])
		rows += `<li><div class="trash-description"><h2>` + icon("library") + escape(name) + `</h2><p class="muted">知识库</p><time class="muted">` + escape(stringValue(v["deleted_at"])) + `</time></div><div class="btns">` + form("restore", "vault", vid, "", version, "恢复知识库："+name, false) + form("purge", "vault", vid, "", version, "彻底删除知识库："+name, true) + `</div></li>`
	}
	for _, v := range items {
		rel := stringValue(v["path"])
		name := path.Base(rel)
		vault := stringValue(v["vault_id"])
		entry := stringValue(v["id"])
		version := stringValue(v["version"])
		rows += `<li><div class="trash-description"><h2>` + icon("file-text") + escape(name) + `</h2><p class="muted">` + escape(stringValue(v["vault_name"])) + ` · ` + escape(rel) + `</p><time class="muted">` + escape(stringValue(v["deleted_at"])) + `</time></div><div class="btns">` + form("restore", "item", vault, entry, version, "恢复："+rel, false) + form("purge", "item", vault, entry, version, "彻底删除："+rel, true) + `</div></li>`
	}
	if rows == "" {
		content += `<div class="empty">回收站为空。</div>`
	} else {
		content += `<ul class="trash-list">` + rows + `</ul>`
	}
	if skipped := listing["skipped"].(int); skipped > 0 {
		content += alert(fmt.Sprintf("%d 项回收内容无法读取，未被清空；原文件仍保留在磁盘。", skipped))
	}
	back := "/"
	if id != "" {
		back = directoryURL(id, "")
	}
	header := fmt.Sprintf(`<div class="page-head"><h1>回收站 <span class="muted">%d 项</span></h1><div class="btns">`, len(items)+len(vaults)) + button(back, "返回知识库", "arrow-left", false)
	if rows != "" {
		header += `<form action="/trash/empty" method="post" data-confirm="清空当前回收站中的全部内容？此操作无法撤销。">` + hidden("filter", id) + hidden("version", stringValue(listing["version"])) + `<button class="btn danger">` + icon("trash-2") + `清空回收站</button></form>`
	}
	header += `</div></div>`
	return r.layout("回收站", content, nonce, pageOptions{VaultID: id, Header: header})
}
func (r *Registry) lintPage(id, nonce string) (string, error) {
	scan, err := r.Scan(id)
	if err != nil {
		return "", err
	}
	inbound, outbound := map[string]bool{}, map[string]bool{}
	broken := []string{}
	for _, d := range scan.Documents {
		for _, target := range wikiTargets(d.Body) {
			outbound[d.URI] = true
			other := resolveLink(target, scan.Documents, &d, false)
			if other == nil {
				broken = append(broken, `<li><a href="`+escape(viewURL(d.URI))+`">`+escape(d.Title)+`</a>：`+escape(target)+`</li>`)
			} else {
				inbound[other.URI] = true
			}
		}
	}
	content := fmt.Sprintf(`<section class="lint-section"><h2>断链 · %d</h2><ul>`, len(broken)) + strings.Join(broken, "")
	if len(broken) == 0 {
		content += `<li>没有断链。</li>`
	}
	content += `</ul></section>`
	for _, item := range []struct {
		label string
		set   map[string]bool
	}{{"孤立文档", inbound}, {"无出链文档", outbound}} {
		content += `<section class="lint-section"><h2>` + item.label + `</h2><ul>`
		for _, d := range scan.Documents {
			if !item.set[d.URI] {
				content += `<li><a href="` + escape(viewURL(d.URI)) + `">` + escape(d.Title) + `</a></li>`
			}
		}
		content += `</ul></section>`
	}
	return r.layout("结构检查", content, nonce, pageOptions{VaultID: id, Header: `<div class="page-head"><h1>结构检查</h1></div>`})
}
