package coral

import (
	"fmt"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
)

func icon(name string) string { return `<i data-lucide="` + escape(name) + `" aria-hidden="true"></i>` }
func button(href, label, symbol string, primary bool) string {
	class := "btn"
	if primary {
		class += " primary"
	}
	symbolHTML := ""
	if symbol != "" {
		symbolHTML = icon(symbol)
	}
	return `<a class="` + class + `" href="` + escape(href) + `">` + symbolHTML + `<span>` + escape(label) + `</span></a>`
}
func copyButton(uri, label string) string {
	if label == "" {
		label = "复制 Coral 链接"
	}
	return `<button class="btn" type="button" data-copy="` + escape(uri) + `" title="` + escape(label) + `" aria-label="` + escape(label) + `">` + icon("copy") + `<span>复制链接</span></button>`
}
func menu(label, content, text, symbol string) string {
	if text == "" {
		text = "更多"
	}
	if symbol == "" {
		symbol = "ellipsis"
	}
	return `<details class="tools-menu"><summary class="btn" aria-label="` + escape(label) + `" title="` + escape(label) + `">` + icon(symbol) + `<span>` + escape(text) + `</span></summary><div class="menu-content">` + content + `</div></details>`
}
func alert(message string) string {
	if message == "" {
		return ""
	}
	return `<div class="alert" role="alert">` + escape(message) + `</div>`
}
func hidden(name, value string) string {
	return `<input type="hidden" name="` + name + `" value="` + escape(value) + `">`
}
func drawerButton(name, label, id string) string {
	return `<button type="button" data-drawer-toggle="` + name + `" aria-label="收起` + label + `" title="收起` + label + `" aria-controls="` + id + `" aria-expanded="true">` + label + `</button>`
}
func directoryURL(vault, dir string) string {
	return "/?" + url.Values{"vault": {vault}, "directory": {dir}}.Encode()
}
func documentAnchor(uri string) string { return "doc-" + digest([]byte(uri))[:16] }
func actionLink(action, uri, label, from, returnTo string) string {
	return `<a class="btn" href="` + escape(withReturn("/"+action+"?"+url.Values{"uri": {uri}, "from": {from}}.Encode(), returnTo)) + `" title="` + escape(label) + `" aria-label="` + escape(label) + `">` + icon(map[string]string{"rename": "text-cursor-input", "move": "folder-input"}[action]) + `<span>` + map[string]string{"rename": "重命名", "move": "移动"}[action] + `</span></a>`
}
func deleteForm(action, uri, version, noteVersion, message, label string) string {
	return `<form class="row-delete" action="` + action + `" method="post" data-confirm="` + escape(message) + `">` + hidden("uri", uri) + hidden("version", version) + hidden("note_version", noteVersion) + `<button type="submit" class="btn danger" title="` + escape(label) + `" aria-label="` + escape(label) + `">` + icon("trash-2") + `<span>删除</span></button></form>`
}

type pageOptions struct {
	VaultID, Directory, Filename, Query, Header string
	HasDirectory, SearchScope                   bool
	DocumentCount                               *int
	Outline                                     []RenderedHeading
	Notes                                       []Document
	CurrentNote, ReturnTo                       string
}

func (r *Registry) layout(title, content, nonce string, o pageOptions) (string, error) {
	vs, err := r.Vaults()
	if err != nil {
		return "", err
	}
	name := "知识库"
	for _, v := range vs {
		if v.ID == o.VaultID {
			name = v.Name
		}
	}
	var search strings.Builder
	search.WriteString(`<form class="search-form" role="search" action="/search" method="get"><div class="search-query"><input type="search" name="q" aria-label="搜索知识库" placeholder="搜索笔记…" maxlength="500" value="` + escape(o.Query) + `"><button class="icon-btn" type="submit" aria-label="搜索" title="搜索">` + icon("search") + `</button></div>`)
	if o.SearchScope {
		search.WriteString(`<select name="vault" aria-label="搜索范围"><option value="">全部知识库</option>`)
		for _, v := range vs {
			selected := ""
			if v.ID == o.VaultID {
				selected = " selected"
			}
			search.WriteString(`<option value="` + escape(v.ID) + `"` + selected + `>` + escape(v.Name) + `</option>`)
		}
		search.WriteString(`</select>`)
	}
	search.WriteString(`</form>`)
	vaultLinks := `<nav class="sidebar-nav" aria-label="知识库列表"><a href="/" aria-label="管理知识库">` + icon("library") + `<span>全部知识库</span></a>`
	for _, v := range vs {
		current := ""
		if v.ID == o.VaultID {
			current = ` aria-current="true"`
		}
		vaultLinks += `<a href="` + escape(directoryURL(v.ID, "")) + `" aria-label="打开知识库：` + escape(v.Name) + `"` + current + `>` + icon("folder") + `<span>` + escape(v.Name) + `</span></a>`
	}
	vaultLinks += `</nav>`
	tree := ""
	if o.VaultID != "" && o.HasDirectory {
		tree, err = r.folderTree(o.VaultID, o.Directory)
		if err != nil {
			return "", err
		}
	}
	trashURL := "/trash"
	if o.VaultID != "" {
		trashURL += "?vault=" + encodeURI(o.VaultID)
	}
	sidebar := `<aside class="sidebar" id="folder-drawer" data-drawer="folders" aria-label="知识库导航"><a class="brand" href="/" aria-label="coral · 全部知识库">` + icon("library") + ` coral</a>` + search.String() + menu("切换知识库", vaultLinks, name, "library") + `<div class="sidebar-scroll">` + tree + `</div><a class="sidebar-trash" href="` + escape(trashURL) + `">` + icon("trash-2") + `回收站</a></aside>`
	crumbs := ""
	if o.VaultID != "" {
		type crumb struct{ label, href string }
		cc := []crumb{{"全部知识库", "/"}, {name, directoryURL(o.VaultID, "")}}
		parts, _ := safeParts(o.Directory, true)
		for i, p := range parts {
			cc = append(cc, crumb{p, directoryURL(o.VaultID, strings.Join(parts[:i+1], "/"))})
		}
		if o.Filename != "" {
			cc = append(cc, crumb{o.Filename, ""})
		}
		crumbs = `<nav class="breadcrumbs" aria-label="当前位置">`
		for i, c := range cc {
			if i > 0 {
				crumbs += `<span aria-hidden="true">/</span>`
			}
			current := ""
			if i == len(cc)-1 {
				current = ` aria-current="page"`
			}
			label := `<span` + current + `>` + escape(c.label) + `</span>`
			if c.href != "" {
				label = `<a href="` + escape(c.href) + `"` + current + `>` + escape(c.label) + `</a>`
			}
			if i == len(cc)-1 && o.DocumentCount != nil {
				label = `<h1>` + label + `<span class="muted">` + strconv.Itoa(*o.DocumentCount) + ` 个文档</span></h1>`
			}
			crumbs += label
		}
		crumbs += `</nav>`
	}
	outline := ""
	noteList := ""
	class := "app-shell"
	if o.Notes != nil {
		class += " has-note-list"
		var links strings.Builder
		links.WriteString(`<aside class="reading-notes" id="note-drawer" data-drawer="notes" aria-label="笔记导航"><nav class="note-list-scroll" aria-label="当前文件夹笔记"><ul>`)
		titles := map[string]int{}
		for _, d := range o.Notes {
			titles[d.Title]++
		}
		for _, d := range o.Notes {
			current := ""
			label := "打开笔记：" + d.Title
			if titles[d.Title] > 1 {
				label += "（" + path.Base(d.Relative) + "）"
			}
			if d.URI == o.CurrentNote {
				current = ` aria-current="page"`
			}
			links.WriteString(`<li><a href="` + escape(withReturn(viewURL(d.URI), o.ReturnTo)) + `" aria-label="` + escape(label) + `" title="` + escape(path.Base(d.Relative)) + `"` + current + `><span>` + escape(d.Title) + `</span>`)
			if titles[d.Title] > 1 {
				links.WriteString(`<small>` + escape(path.Base(d.Relative)) + `</small>`)
			}
			links.WriteString(`</a></li>`)
		}
		links.WriteString(`</ul></nav></aside>`)
		noteList = links.String()
	}
	if len(o.Outline) > 0 || o.Notes != nil {
		class += " has-article-outline"
		outline = `<aside class="reading-outline" id="chapter-drawer" data-drawer="chapters" aria-label="文章导航"><nav class="article-toc-scroll" data-article-toc aria-label="文章目录"><ol>`
		levels := []int{}
		for _, h := range o.Outline {
			for len(levels) > 0 && levels[len(levels)-1] >= h.Level {
				levels = levels[:len(levels)-1]
			}
			outline += fmt.Sprintf(`<li class="toc-depth-%d"><a href="#%s">%s</a></li>`, len(levels), escape(encodeURI(h.ID)), escape(h.Title))
			levels = append(levels, h.Level)
		}
		outline += `</ol></nav></aside>`
	}
	controls := drawerButton("folders", "目录", "folder-drawer")
	if noteList != "" {
		controls += drawerButton("notes", "笔记", "note-drawer")
	}
	if outline != "" {
		controls += drawerButton("chapters", "章节", "chapter-drawer")
	}
	navigation := `<div class="drawer-controls" role="group" aria-label="侧栏" hidden>` + controls + `</div>`
	header := `<div class="workspace-header">` + navigation + `<div class="header-content">` + crumbs + `</div></div>` + o.Header
	if crumbs == "" {
		header = `<div class="workspace-header">` + navigation + `<div class="header-content">` + o.Header + `</div></div>`
	}
	topClass := "topbar"
	if o.DocumentCount != nil {
		header = `<div class="page-head">` + header + `</div>`
		topClass += " directory-header"
	}
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="editor-style-nonce" content="` + escape(nonce) + `"><title>` + escape(title) + ` · coral</title><script src="/static/drawers.js"></script><link rel="stylesheet" href="/static/coral.css"><link rel="stylesheet" href="/static/highlight.css"><link rel="stylesheet" href="/static/katex/katex.min.css"></head><body class="` + class + `">` + sidebar + noteList + outline + `<main class="workspace"><header class="` + topClass + `">` + header + `</header><div class="page-content">` + content + `</div></main><script type="module" src="/static/client.js"></script></body></html>`, nil
}
func (r *Registry) folderTree(id, dir string) (string, error) {
	dirs, err := r.Directories(id)
	if err != nil {
		return "", err
	}
	children := map[string][]string{}
	for _, d := range dirs {
		if d != "" {
			children[parent(d)] = append(children[parent(d)], d)
		}
	}
	link := func(p, label string) string {
		current := ""
		if p == dir {
			current = ` aria-current="page"`
		}
		accessible := p
		if accessible == "" {
			accessible = "根目录"
		}
		return `<a href="` + escape(directoryURL(id, p)) + `" aria-label="打开文件夹：` + escape(accessible) + `" title="` + escape(accessible) + `"` + current + `>` + icon("folder") + `<span>` + escape(label) + `</span></a>`
	}
	var branch func(string) string
	branch = func(p string) string {
		entry := link(p, path.Base(p))
		if len(children[p]) > 0 {
			open := ""
			if p == dir || strings.HasPrefix(dir, p+"/") {
				open = " open"
			}
			entry = `<details` + open + `><summary aria-label="展开或收起文件夹：` + escape(p) + `">` + entry + `</summary><ul>`
			for _, child := range children[p] {
				entry += branch(child)
			}
			entry += `</ul></details>`
		}
		return `<li>` + entry + `</li>`
	}
	out := `<nav class="folder-tree" aria-label="目录树">` + link("", "根目录") + `<ul>`
	for _, d := range children[""] {
		out += branch(d)
	}
	return out + `</ul></nav>`, nil
}
func (r *Registry) catalog(nonce string, trashed bool, result ...string) (string, error) {
	listing, err := r.ListVaults()
	if err != nil {
		return "", err
	}
	vaults := listing["vaults"].([]any)
	header := fmt.Sprintf(`<div class="page-head"><h1>知识库 <span class="muted">%d 个</span></h1><div class="btns">`, len(vaults)) + button("/", "刷新知识库", "refresh-cw", false) + button("/vaults/new", "创建知识库", "folder-plus", true) + `</div></div>`
	content := `<ul class="vault-list">`
	if len(result) > 0 {
		content = r.webResultNotice(result[0]) + content
	}
	if trashed {
		content = `<div class="alert ok" role="status">知识库已移入回收站。</div>` + content
	}
	for _, item := range vaults {
		v := item.(map[string]any)
		name := stringValue(v["name"])
		title := escape(name)
		count := "暂不可用"
		if v["available"] == true {
			title = `<a href="/?vault=` + encodeURI(stringValue(v["id"])) + `">` + title + `</a>`
			count = fmt.Sprint(v["document_count"]) + " 个文档"
		}
		content += `<li><div class="vault-description"><h2>` + title + `</h2>`
		if description := stringValue(v["description"]); description != "" {
			content += `<p>` + escape(description) + `</p>`
		}
		content += `</div><span class="muted">` + count + `</span><div class="row-actions">`
		actions := copyButton(stringValue(v["uri"]), "复制 Coral 链接："+name)
		if v["available"] == true || v["external"] == true {
			message := "将知识库「" + name + "」及全部内容移入回收站？"
			if v["external"] == true {
				message = "移除外部知识库「" + name + "」的注册？原文件保留。"
			}
			actions += `<form action="/vaults/delete" method="post" data-confirm="` + escape(message) + `">` + hidden("vault", stringValue(v["id"])) + hidden("version", stringValue(v["version"])) + `<button class="btn danger" aria-label="删除知识库：` + escape(name) + `">` + icon("trash-2") + `<span>删除</span></button></form>`
		}
		content += menu("知识库操作："+name, actions, "", "") + `</div></li>`
	}
	return r.layout("知识库", content+`</ul>`, nonce, pageOptions{Header: header})
}
func (r *Registry) home(id, dir, nonce string, q url.Values) (string, error) {
	v, err := r.Vault(id)
	if err != nil {
		return "", err
	}
	listing, err := r.Browse(id, dir)
	if err != nil {
		return "", err
	}
	content := r.webResultNotice(q.Get("result")) + operationNotice(r.optionalReport(id, q.Get("operation"))) + `<section data-directory-drafts data-vault="` + escape(id) + `" data-directory="` + escape(dir) + `" hidden></section><section class="reading-resume" data-reading-resume hidden aria-label="阅读进度"><div><a data-resume-title></a></div><div class="btns"><a class="btn" data-resume-open>继续阅读</a><a class="btn primary" data-resume-next>下一篇</a></div></section>`
	if q.Get("deleted") == "1" {
		content += `<div class="alert ok" role="status">已移入知识库回收站。</div>`
	}
	if value := q.Get("upload"); value != "" && value != "0" {
		content += `<div class="alert ok">已导入 ` + escape(value) + ` 个 Markdown 文档。</div>`
	}
	if value := q.Get("rejected"); value != "" && value != "0" {
		content += alert(value + " 个文件无法导入，仅支持有效的 UTF-8 Markdown 文档。")
	}
	if listing.Skipped > 0 {
		content += alert(fmt.Sprintf("%d 个文档无法读取或超过大小限制。", listing.Skipped))
	}
	row := func(d Document) string {
		filename := path.Base(d.Relative)
		label := ""
		if stripExtension(filename) != d.Title {
			label = `<span class="muted">` + escape(filename) + `</span>`
		}
		actions := copyButton(d.URI, "复制文档 URI："+d.Title) + actionLink("rename", d.URI, "重命名文档："+d.Title, "", "") + actionLink("move", d.URI, "移动文档："+d.Title, "", "") + deleteForm("/delete", d.URI, d.Version, d.NoteVersion, "将笔记「"+d.Relative+"」及全部语言版本移入知识库回收站？", "删除文档："+d.Title)
		updated := ""
		if value := d.Metadata["updated"]; value != nil {
			updated = fmt.Sprint(value)
		}
		return `<li id="` + documentAnchor(d.URI) + `" data-document-uri="` + escape(d.URI) + `"><div class="file-entry"><a class="page-link" href="` + escape(viewURL(d.URI)) + `">` + icon("file-text") + escape(d.Title) + `</a><span class="reading-marker" hidden>上次阅读</span>` + label + `</div><span class="muted file-updated">` + escape(updated) + `</span><div class="row-actions">` + menu("文档操作："+d.Title, actions, "", "") + `</div></li>`
	}
	content += `<ul class="page-list file-list" data-reading-list="` + escape(ResourceURI(id, dir)) + `">`
	if dir != "" {
		content += `<li><a href="` + escape(directoryURL(id, parent(dir))) + `">` + icon("corner-left-up") + `上级目录</a></li>`
	}
	for _, d := range listing.Documents {
		if isIndex(d.Relative) {
			content += row(d)
		}
	}
	for _, f := range listing.Directories {
		actions := copyButton(f.URI, "复制文件夹 URI："+f.Name)
		if f.Version != "" {
			actions += actionLink("rename", f.URI, "重命名文件夹："+f.Name, "", "") + deleteForm("/delete-directory", f.URI, f.Version, "", fmt.Sprintf("删除文件夹「%s」？其中全部 %d 个文件（含附件）和子目录将一起移入知识库回收站。", f.Relative, f.FileCount), "删除文件夹："+f.Name)
		}
		content += `<li><div class="file-entry"><a class="page-link" href="` + escape(directoryURL(id, f.Relative)) + `">` + icon("folder") + escape(f.Name) + `</a><span class="muted">` + strconv.Itoa(f.DocumentCount) + ` 个文档</span></div><div class="row-actions">` + menu("文件夹操作："+f.Name, actions, "", "") + `</div></li>`
	}
	for _, d := range listing.Documents {
		if !isIndex(d.Relative) {
			content += row(d)
		}
	}
	content += `</ul>`
	if len(listing.Documents)+len(listing.Directories) == 0 {
		content += `<div class="empty"><p>此目录暂无文档。</p></div>`
	}
	importForm := `<form class="kb-upload" action="/upload" method="post" enctype="multipart/form-data">` + hidden("vault", id) + hidden("directory", dir) + `<input type="file" name="files" accept=".md,.markdown" multiple required aria-label="Markdown 文档"><button class="btn" type="submit">` + icon("upload") + `上传 Markdown</button></form>`
	tools := button("/directories/new?"+url.Values{"vault": {id}, "directory": {dir}}.Encode(), "创建文件夹", "folder-plus", false)
	if dir != "" {
		tools += actionLink("rename", ResourceURI(id, dir), "重命名当前文件夹", "directory", "")
	}
	tools += copyButton(ResourceURI(id, dir), "") + button("/lint?vault="+encodeURI(id), "结构检查", "scan-search", false)
	header := `<div class="btns">` + button("/new?"+url.Values{"vault": {id}, "directory": {dir}}.Encode(), "创建文档", "file-plus", true) + menu("导入文档", importForm, "导入", "upload") + menu("知识库工具", tools, "", "") + `</div>`
	count := len(listing.Documents)
	if dir == "" {
		count = listing.Total
	}
	return r.layout(v.Name, content, nonce, pageOptions{VaultID: id, Directory: dir, HasDirectory: true, Header: header, DocumentCount: &count})
}
func operationNotice(report *RelocationReport) string {
	if report == nil {
		return ""
	}
	out := `<section class="operation-result" aria-label="整理结果">`
	if len(report.UpdatedDocuments) > 0 {
		out += fmt.Sprintf(`<details><summary>已更新 %d 篇笔记的链接</summary><ul>`, len(report.UpdatedDocuments))
		for _, d := range report.UpdatedDocuments {
			id, rel, _ := parseURI(d.URI)
			out += `<li><a href="` + escape(viewURL(d.URI)) + `">` + escape(id+"/"+rel) + `</a></li>`
		}
		out += `</ul></details>`
	}
	if len(report.UnresolvedLinks) > 0 {
		out += fmt.Sprintf(`<details><summary>有 %d 处引用未处理</summary><ul>`, len(report.UnresolvedLinks))
		for _, link := range report.UnresolvedLinks {
			out += `<li><a href="` + escape(viewURL(link.URI)) + `">` + escape(link.URI) + `</a>：` + escape(link.Target) + ` · ` + escape(link.Reason) + `</li>`
		}
		out += `</ul></details>`
	}
	return out + `</section>`
}
func (r *Registry) optionalReport(id, op string) *RelocationReport {
	if op == "" {
		return nil
	}
	report, _ := r.Report(id, op)
	return report
}
func (r *Registry) documentPage(d Document, nonce, returnTo, op string) (string, error) {
	f, err := r.Family(d.URI)
	if err != nil {
		return "", err
	}
	d = f.Current
	dir := parent(f.Primary.Relative)
	scan, err := r.Scan(d.VaultID)
	if err != nil {
		return "", err
	}
	notes, err := r.Notes(d.VaultID)
	if err != nil {
		return "", err
	}
	rendered, err := RenderMarkdown(d.Body, scan.Documents, &d, d.Metadata, scan.index.links)
	if err != nil {
		return "", err
	}
	body := rendered.HTML
	titleAnchor := ""
	if strings.HasPrefix(body, "<h1 ") {
		if end := strings.Index(body, "</h1>"); end >= 0 {
			if len(rendered.Headings) > 0 {
				titleAnchor = ` id="` + escape(rendered.Headings[0].ID) + `"`
				rendered.Headings = rendered.Headings[1:]
			}
			body = strings.TrimPrefix(body[end+5:], "\n")
		}
	}
	other := "en"
	if docLanguage(d) == "en" {
		other = "zh"
	}
	otherLabel := "英文"
	buttonLabel := "English"
	if other == "zh" {
		otherLabel = "中文"
		buttonLabel = "中文"
	}
	addLanguage := button(withReturn("/languages/new?"+url.Values{"uri": {d.URI}, "language": {other}}.Encode(), returnTo), "添加"+otherLabel+"版", "", false)
	if !f.Grouped {
		addLanguage = button(withReturn("/languages/new?"+url.Values{"uri": {d.URI}}.Encode(), returnTo), "添加语言版本", "", false)
	}
	languageLink := ""
	for _, version := range f.Versions {
		if docLanguage(version) == other {
			languageLink = `<a class="btn" href="` + escape(withReturn(viewURL(version.URI), returnTo)) + `" aria-label="切换到` + otherLabel + `"><span lang="` + other + `">` + buttonLabel + `</span></a>`
		}
	}
	returnURL := directoryURL(d.VaultID, dir) + "#" + documentAnchor(f.Primary.URI)
	actions := button(returnURL, "所在目录", "folder", false)
	if languageLink == "" {
		actions += addLanguage
	}
	actions += copyButton(d.URI, "") + actionLink("rename", f.Primary.URI, "重命名", "document", returnTo) + actionLink("move", f.Primary.URI, "移动", "document", returnTo) + button("/download?uri="+encodeURI(d.URI), "下载", "download", false) + deleteForm("/delete", f.Primary.URI, f.Primary.Version, f.Signature, "将这篇笔记的全部语言版本移入知识库回收站？", "删除")
	header := `<div class="page-head"><h1` + titleAnchor + `>` + escape(d.Title) + `</h1><div class="btns">`
	if returnTo != "" {
		header += button(returnTo, "返回搜索", "arrow-left", false)
	}
	header += languageLink + button(withReturn(editURL(d.URI), returnTo), "编辑", "pencil", true) + menu("文档操作", actions, "", "") + `</div></div>`
	content := operationNotice(r.optionalReport(d.VaultID, op)) + alert(d.Warning) + `<div class="alert" role="alert" data-document-update-error hidden></div><div class="update-notice" data-reading-update hidden role="status"><span>笔记已更新</span><button class="btn" type="button" data-load-update>加载更新</button></div><article class="md-body" lang="` + docLanguage(d) + `" data-reading-version="` + d.Version + `" data-reading-note-version="` + f.Signature + `" data-reading-note="` + escape(f.Primary.URI) + `" data-reading-document="` + escape(d.URI) + `" data-reading-directory="` + escape(ResourceURI(d.VaultID, dir)) + `">` + body + `</article>`
	siblings := []Document{}
	index := -1
	for _, other := range notes {
		if parent(other.Relative) == dir {
			if other.URI == f.Primary.URI {
				index = len(siblings)
			}
			siblings = append(siblings, other)
		}
	}
	neighbor := func(i int, next bool) string {
		label, rel, symbol, extra := "上一篇", "prev", "chevron-left", ""
		if next {
			label, rel, symbol, extra = "下一篇", "next", "chevron-right", " reading-next"
		}
		if i < 0 || i >= len(siblings) {
			return `<div aria-hidden="true"></div>`
		}
		other := siblings[i]
		return `<a class="reading-neighbor` + extra + `" rel="` + rel + `" href="` + escape(withReturn(viewURL(other.URI)+"&reading=start", returnTo)) + `"><span class="reading-direction">` + icon(symbol) + label + `</span><span class="reading-title">` + escape(other.Title) + `</span></a>`
	}
	if index >= 0 {
		content += `<nav class="reading-nav reading-nav-bottom" aria-label="文末阅读导航">` + neighbor(index-1, false) + fmt.Sprintf(`<div class="reading-position"><span>第 %d / %d 篇</span><a href="%s">返回目录</a></div>`, index+1, len(siblings), escape(returnURL)) + neighbor(index+1, true) + `</nav>`
	}
	backlinks := []Document{}
	seen := map[string]bool{}
	linked := map[string]bool{}
	for _, version := range f.Versions {
		for _, other := range scan.index.linkedFrom(version.URI) {
			linked[other.URI] = true
		}
	}
	for _, other := range scan.Documents {
		primary := scan.index.groups[other.URI].Primary
		if linked[other.URI] && primary.URI != f.Primary.URI && !seen[primary.URI] {
			backlinks = append(backlinks, primary)
			seen[primary.URI] = true
		}
	}

	if len(backlinks) > 0 {
		content += fmt.Sprintf(`<section class="backlinks"><h2>反向链接 <span class="muted">%d</span></h2><ul>`, len(backlinks))
		for _, other := range backlinks {
			content += `<li><a href="` + escape(viewURL(other.URI)) + `">` + escape(other.Title) + `</a></li>`
		}
		content += `</ul></section>`
	}
	keys := []string{}
	for k := range d.Metadata {
		if k != "title" && k != "coral_note_id" && k != "coral_language" && k != "coral_primary" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if len(keys) > 0 {
		content += `<details class="meta"><summary>文档属性</summary><dl>`
		for _, k := range keys {
			content += `<dt>` + escape(k) + `</dt><dd>` + escape(fmt.Sprint(d.Metadata[k])) + `</dd>`
		}
		content += `</dl></details>`
	}
	return r.layout(d.Title, content, nonce, pageOptions{VaultID: d.VaultID, Directory: dir, Filename: path.Base(f.Primary.Relative), HasDirectory: true, Header: header, Outline: rendered.Headings, Query: returnQuery(returnTo), Notes: siblings, CurrentNote: f.Primary.URI, ReturnTo: returnTo})
}
func highlight(s, query string) string {
	out := ""
	offset := 0
	for _, h := range hits(searchTokens(s), strings.Fields(query)) {
		if h.End <= offset {
			continue
		}
		if h.Start < offset {
			h.Start = offset
		}
		out += escape(s[offset:h.Start]) + "<mark>" + escape(s[h.Start:h.End]) + "</mark>"
		offset = h.End
	}
	return out + escape(s[offset:])
}
func (r *Registry) searchPage(id, query string, cursor int, nonce string) (string, error) {
	results := []any{}
	total := 0
	var next any
	unavailable := []string{}
	skipped := 0
	if strings.TrimSpace(query) != "" {
		found, err := r.Search(query, id, r.Config.Search.ResultsPerPage, cursor)
		if err != nil {
			return "", err
		}
		results = found["results"].([]any)
		total = found["total"].(int)
		next = found["next_cursor"]
		unavailable = found["unavailable_vaults"].([]string)
		skipped = found["skipped_documents"].(int)
	}
	pageURL := func(offset int) string {
		return "/search?" + url.Values{"q": {query}, "vault": {id}, "cursor": {strconv.Itoa(offset)}}.Encode()
	}
	content := ""
	if len(unavailable) > 0 {
		content += alert("部分知识库暂不可用，未包含在搜索结果中。")
	}
	if skipped > 0 {
		content += alert(fmt.Sprintf("%d 个文档无法读取或超过大小限制，未包含在搜索结果中。", skipped))
	}
	vs, _ := r.Vaults()
	names := map[string]string{}
	for _, v := range vs {
		names[v.ID] = v.Name
	}
	for _, item := range results {
		d := item.(map[string]any)
		uri := stringValue(d["uri"])
		noteURI := stringValue(d["note_uri"])
		if noteURI == "" {
			noteURI = uri
		}
		_, rel, _ := parseURI(noteURI)
		vault := stringValue(d["vault_id"])
		content += `<div class="result-item" id="` + documentAnchor(noteURI) + `" data-document-uri="` + escape(noteURI) + `"><a href="` + escape(withReturn(viewURL(uri), pageURL(cursor)+"#"+documentAnchor(noteURI))) + `">` + highlight(stringValue(d["title"]), query) + `</a>` + copyButton(uri, "复制 Coral 链接："+stringValue(d["title"])) + `<a class="result-location" href="` + escape(directoryURL(vault, parent(rel))+"#"+documentAnchor(noteURI)) + `" aria-label="打开结果目录：` + escape(rel) + `">` + escape(names[vault]) + ` / ` + highlight(rel, query) + `</a><p class="snippet">` + highlight(stringValue(d["snippet"]), query) + `</p></div>`
	}
	if len(results) == 0 {
		message := "没有找到匹配的内容。"
		if query == "" {
			message = "输入标题、正文或路径关键词搜索笔记。"
		}
		content += `<div class="empty">` + message + `</div>`
	}
	content += `<nav class="pagination" aria-label="搜索分页">`
	if cursor > 0 {
		content += button(pageURL(max(0, cursor-r.Config.Search.ResultsPerPage)), "上一页", "chevron-left", false)
	}
	if next != nil {
		content += button(pageURL(next.(int)), "下一页", "chevron-right", false)
	}
	content += `</nav>`
	header := fmt.Sprintf(`<div class="page-head"><h1>搜索 <span class="muted">%d 条结果</span></h1></div>`, total)
	return r.layout("搜索", content, nonce, pageOptions{VaultID: id, Query: query, SearchScope: true, Header: header})
}
func searchReturn(value string) string {
	if len(value) > 5000 || !(value == "/search" || strings.HasPrefix(value, "/search?")) {
		return ""
	}
	u, err := url.Parse(value)
	if err != nil || u.IsAbs() || u.Host != "" || u.Path != "/search" {
		return ""
	}
	q := u.Query()
	if utf16Len(q.Get("q")) > 500 || q.Get("vault") != "" && !validID.MatchString(q.Get("vault")) {
		return ""
	}
	cursor := q.Get("cursor")
	if cursor == "" {
		cursor = "0"
	}
	if len(cursor) > 9 {
		return ""
	}
	if n, err := strconv.Atoi(cursor); err != nil || n < 0 {
		return ""
	}
	fragment := ""
	if len(u.Fragment) == 20 && strings.HasPrefix(u.Fragment, "doc-") {
		fragment = "#" + u.Fragment
	}
	return "/search?" + url.Values{"q": {q.Get("q")}, "vault": {q.Get("vault")}, "cursor": {cursor}}.Encode() + fragment
}
func withReturn(target, returnTo string) string {
	valid := searchReturn(returnTo)
	if valid == "" {
		return target
	}
	separator := "?"
	if strings.Contains(target, "?") {
		separator = "&"
	}
	return target + separator + "return_to=" + encodeURI(valid)
}
func returnQuery(returnTo string) string {
	u, _ := url.Parse(returnTo)
	if u == nil {
		return ""
	}
	return u.Query().Get("q")
}
