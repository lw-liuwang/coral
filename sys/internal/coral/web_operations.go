package coral

import (
	"fmt"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"strings"
)

type ImportOutcome struct {
	Name   string `json:"name"`
	URI    string `json:"uri,omitempty"`
	Path   string `json:"path,omitempty"`
	Reason string `json:"reason,omitempty"`
}

type WebResult struct {
	ID        string          `json:"id"`
	VaultID   string          `json:"vault_id,omitempty"`
	Directory string          `json:"directory,omitempty"`
	Trash     *TrashReceipt   `json:"trash,omitempty"`
	Imports   []ImportOutcome `json:"imports,omitempty"`
}

func (r *Registry) saveWebResult(result WebResult) (string, error) {
	result.ID = newID()
	filename, err := internalPath(r.Config.DataDir, ".coral/web-results/"+result.ID+".json")
	if err != nil {
		return "", err
	}
	if err = saveJSON(filename, result); err != nil {
		return "", err
	}
	return result.ID, nil
}

func (r *Registry) readWebResult(id string) (*WebResult, error) {
	if !uuidPattern.MatchString(id) {
		return nil, fail(400, "操作结果编号无效")
	}
	filename, err := internalPath(r.Config.DataDir, ".coral/web-results/"+id+".json")
	if err != nil {
		return nil, err
	}
	var result WebResult
	if err = readJSON(filename, &result); err != nil || result.ID != id {
		return nil, fail(404, "操作结果不存在")
	}
	return &result, nil
}

func (r *Registry) webResultNotice(id string) string {
	if id == "" {
		return ""
	}
	result, err := r.readWebResult(id)
	if err != nil {
		return alert(appError(err).Message)
	}
	return renderWebResult(result)
}

func renderWebResult(result *WebResult) string {
	if receipt := result.Trash; receipt != nil {
		return `<div class="alert ok operation-feedback" role="status"><span>已移入回收站。</span><form action="/trash/restore" method="post">` + hidden("scope", receipt.Scope) + hidden("vault", receipt.VaultID) + hidden("entry", receipt.EntryID) + hidden("version", receipt.Version) + hidden("filter", result.VaultID) + `<button class="btn" type="submit">` + icon("rotate-ccw") + `恢复</button></form></div>`
	}
	saved := 0
	rows := ""
	for _, item := range result.Imports {
		outcome := escape(item.Reason)
		if item.URI != "" {
			saved++
			outcome = `<a href="` + escape(viewURL(item.URI)) + `">` + escape(item.Path) + `</a>`
		}
		rows += `<li><span>` + escape(item.Name) + `</span>：` + outcome + `</li>`
	}
	return fmt.Sprintf(`<section class="operation-result" aria-label="导入结果"><p role="status">已导入 %d 个文档，%d 个文件未导入。</p><details><summary>查看逐文件结果</summary><ul>`, saved, len(result.Imports)-saved) + rows + `</ul></details></section>`
}

func (a *App) finishWebResult(w http.ResponseWriter, req *http.Request, result WebResult, target string) error {
	id, err := a.Registry.saveWebResult(result)
	if err == nil {
		http.Redirect(w, req, resultURL(target, id), http.StatusSeeOther)
		return nil
	}
	// The domain operation has completed. Keep its exact result and recovery action visible.
	content := renderWebResult(&result) + alert("操作已完成，但结果记录无法保存。请勿重新提交此页面。") + button(target, "返回", "arrow-left", false)
	page, renderErr := a.Registry.layout("操作结果", content, a.nonce, pageOptions{Header: `<div class="page-head"><h1>操作结果</h1></div>`})
	if renderErr != nil {
		return renderErr
	}
	writeHTML(w, http.StatusOK, page)
	return nil
}

func resultURL(target, id string) string {
	u, _ := url.Parse(target)
	q := u.Query()
	q.Set("result", id)
	u.RawQuery = q.Encode()
	return u.String()
}

// HTML forms confirm before mutation even when the enhancement script is unavailable.
func (r *Registry) confirmationPage(action, nonce string, fields url.Values) (string, error) {
	heading, message, label, back := "移入回收站", "", "移入回收站", "/"
	switch action {
	case "/delete", "/delete-directory":
		e, err := r.Entry(fields.Get("uri"))
		if err != nil {
			return "", err
		}
		message = "将「" + e.Relative + "」移入回收站？"
		if action == "/delete-directory" {
			message += "其中全部文档、附件和子文件夹会一起回收。"
		} else {
			message += "这篇笔记的全部语言版本会一起回收。"
		}
		back = directoryURL(e.VaultID, parent(e.Relative))
	case "/vaults/delete":
		vs, err := r.ListVaults()
		if err != nil {
			return "", err
		}
		for _, item := range vs["vaults"].([]any) {
			v := item.(map[string]any)
			if v["id"] == fields.Get("vault") {
				message = "将知识库「" + stringValue(v["name"]) + "」及全部内容移入回收站？"
				if v["external"] == true {
					message = "移除外部知识库「" + stringValue(v["name"]) + "」的注册？原文件保留。"
				}
			}
		}
		if message == "" {
			return "", fail(404, "知识库不存在")
		}
	case "/trash/purge", "/trash/empty":
		heading, label = "彻底删除", "彻底删除"
		back = "/trash?" + url.Values{"vault": {fields.Get("filter")}}.Encode()
		if action == "/trash/empty" {
			message = "清空当前回收站中的全部内容？此操作无法恢复。"
		} else {
			listing, err := r.ListTrash(fields.Get("vault"))
			if err != nil {
				return "", err
			}
			if fields.Get("scope") == "vault" {
				for _, v := range listing["vaults"].([]map[string]any) {
					if v["id"] == fields.Get("vault") {
						message = "彻底删除知识库「" + stringValue(v["name"]) + "」？此操作无法恢复。"
					}
				}
			} else if fields.Get("scope") == "item" {
				for _, item := range listing["items"].([]map[string]any) {
					if item["id"] == fields.Get("entry") {
						message = "彻底删除「" + stringValue(item["path"]) + "」？此操作无法恢复。"
					}
				}
			}
			if message == "" {
				return "", fail(404, "回收内容不存在")
			}
		}
	default:
		return "", fail(400, "操作无效")
	}
	inputs := ""
	for _, key := range []string{"uri", "version", "note_version", "vault", "scope", "entry", "filter"} {
		inputs += hidden(key, fields.Get(key))
	}
	content := `<p>` + escape(message) + `</p><div class="btns">` + button(back, "取消", "arrow-left", false) + `<form action="` + escape(action) + `" method="post">` + inputs + hidden("confirmed", "1") + `<button class="btn danger" type="submit">` + escape(label) + `</button></form></div>`
	return r.layout(heading, content, nonce, pageOptions{Header: `<div class="page-head"><h1>` + heading + `</h1></div>`})
}

func importFailure(err error) string {
	if appError(err).Status < 500 {
		return appError(err).Message
	}
	return "文件无法读取或保存，请重试"
}

func validUploadName(name string) bool {
	return name == path.Base(name) && name == filepath.Base(name) && !strings.ContainsAny(name, `/\`)
}
