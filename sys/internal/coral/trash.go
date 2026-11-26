package coral

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type VaultState struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Root        string `json:"root"`
	Source      string `json:"source"`
	State       string `json:"state"`
	DeletedAt   string `json:"deleted_at"`
}

func (r *Registry) stateDir(id string) (string, error) {
	if !validID.MatchString(id) {
		return "", fail(400, "知识库标识无效")
	}
	return filepath.Join(r.Config.DataDir, ".coral/vault-trash", id), nil
}
func readJSON(filename string, value any) error {
	info, err := os.Lstat(filename)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > MaxFileBytes {
		return fail(400, "记录无效")
	}
	b, err := os.ReadFile(filename)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, value)
}
func saveJSON(filename string, value any) error {
	dir := filepath.Dir(filename)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	temp := filepath.Join(dir, newID()+".tmp")
	if err := writeExclusive(temp, append(jsonBytes(value), '\n')); err != nil {
		return err
	}
	defer os.Remove(temp)
	return os.Rename(temp, filename)
}
func (r *Registry) vaultState(id string) (VaultState, error) {
	dir, err := r.stateDir(id)
	if err != nil {
		return VaultState{}, err
	}
	var s VaultState
	if err = readJSON(filepath.Join(dir, "state.json"), &s); err != nil {
		return s, err
	}
	if s.ID != id || (s.Source != "managed" && s.Source != "external") || (s.State != "trash" && s.State != "removed") {
		return s, fail(400, "知识库回收记录无效")
	}
	if s.Source == "managed" {
		name := strings.ToLower(s.Name)
		if !validVaultName.MatchString(name) {
			name = id
		}
		s.Root = filepath.Join(r.Config.DataDir, "obsdian", name)
	}
	return s, nil
}
func (r *Registry) CreateVault(name, description string) (Vault, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	description = strings.TrimSpace(description)
	if !validVaultName.MatchString(name) || name == "default" {
		return Vault{}, fail(400, "仓库名称须以英文字母开头，仅包含英文字母、数字、连字符或下划线，最多 64 字符")
	}
	if utf16Len(description) > 2000 {
		return Vault{}, fail(400, "简介最多 2000 字")
	}
	vs, err := r.Vaults()
	if err != nil {
		return Vault{}, err
	}
	for _, v := range vs {
		if v.ID == name {
			return Vault{}, fail(409, "同名知识库或标识已存在或位于回收站，请使用其他名称")
		}
	}
	if _, ok := r.Config.Vaults[name]; ok {
		return Vault{}, fail(409, "同名知识库标识已存在")
	}
	s, e := r.vaultState(name)
	if e == nil && s.State == "trash" {
		return Vault{}, fail(409, "同名知识库位于回收站")
	}
	if e != nil && !os.IsNotExist(e) {
		return Vault{}, e
	}
	root := filepath.Join(r.Config.DataDir, "obsdian", name)
	if err = os.MkdirAll(filepath.Dir(root), 0755); err != nil {
		return Vault{}, err
	}
	if err = os.Mkdir(root, 0755); err != nil {
		if os.IsExist(err) {
			return Vault{}, fail(409, "同名仓库目录已存在，请使用其他名称")
		}
		return Vault{}, err
	}
	if err = os.Mkdir(filepath.Join(root, ".obsidian"), 0755); err != nil {
		return Vault{}, err
	}
	if err = saveJSON(filepath.Join(root, ".coral-vault.json"), map[string]string{"id": name, "description": description}); err != nil {
		return Vault{}, err
	}
	if dir, e := r.stateDir(name); e == nil {
		_ = os.Remove(filepath.Join(dir, "state.json"))
	}
	return Vault{name, name, description, root}, nil
}
func (r *Registry) DeleteVault(id, version string) error {
	vs, err := r.Vaults()
	if err != nil {
		return err
	}
	var v Vault
	for _, item := range vs {
		if item.ID == id {
			v = item
		}
	}
	if v.ID == "" {
		return fail(404, "知识库不存在")
	}
	if version == "" || digest(jsonBytes(v)) != version {
		return fail(409, "知识库信息已变化，请刷新后重试")
	}
	_, external := r.Config.Vaults[id]
	if !external {
		info, e := os.Lstat(v.Root)
		if e != nil {
			return e
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fail(400, "不能移动符号链接形式的知识库")
		}
		target, e := filepath.EvalSymlinks(v.Root)
		if e != nil {
			return e
		}
		for _, other := range vs {
			if other.ID == id {
				continue
			}
			root, e := filepath.EvalSymlinks(other.Root)
			if e == nil && (root == target || strings.HasPrefix(root, target+string(filepath.Separator))) {
				return fail(400, "该知识库包含其他已注册知识库，请先移除其注册")
			}
		}
	}
	dir, err := r.stateDir(id)
	if err != nil {
		return err
	}
	source := "managed"
	if external {
		source = "external"
	}
	s := VaultState{id, v.Name, v.Description, v.Root, source, "trash", time.Now().UTC().Format(time.RFC3339Nano)}
	if err = saveJSON(filepath.Join(dir, "state.json"), s); err != nil {
		return err
	}
	if !external {
		if err = os.Rename(v.Root, filepath.Join(dir, "content")); err != nil {
			_ = os.Remove(filepath.Join(dir, "state.json"))
			return err
		}
	}
	return nil
}
func (r *Registry) RestoreVault(id, version string, purge bool) error {
	s, err := r.vaultState(id)
	if err != nil {
		return fail(404, "知识库回收记录不存在")
	}
	if s.State != "trash" {
		return fail(404, "知识库回收记录不存在")
	}
	if version == "" || version != digest(jsonBytes(s)) {
		return fail(409, "回收记录已变化，请刷新后重试")
	}
	dir, err := r.stateDir(id)
	if err != nil {
		return err
	}
	if purge {
		if s.Source == "managed" {
			if info, e := os.Lstat(filepath.Join(dir, "content")); e == nil && info.Mode()&os.ModeSymlink != 0 {
				return fail(400, "知识库回收内容无效")
			}
			if err = os.RemoveAll(filepath.Join(dir, "content")); err != nil {
				return err
			}
		}
		s.State = "removed"
		return saveJSON(filepath.Join(dir, "state.json"), s)
	}
	if s.Source == "external" {
		if v, ok := r.Config.Vaults[id]; !ok || v.Path != s.Root {
			return fail(409, "知识库配置已变化，请先恢复原配置")
		}
	} else {
		content := filepath.Join(dir, "content")
		if exists(content) {
			info, e := os.Lstat(content)
			if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return fail(400, "知识库回收内容无效")
			}
			if exists(s.Root) {
				return fail(409, "原知识库目录已存在，请先移走后再恢复")
			}
			if err = os.MkdirAll(filepath.Dir(s.Root), 0755); err != nil {
				return err
			}
			if err = os.Rename(content, s.Root); err != nil {
				return err
			}
		} else if !exists(s.Root) {
			return fail(404, "知识库文件不存在，无法恢复")
		}
	}
	return os.Remove(filepath.Join(dir, "state.json"))
}

type TrashRecord struct {
	Path      string   `json:"path"`
	Kind      string   `json:"kind"`
	DeletedAt string   `json:"deleted_at"`
	Members   []string `json:"members,omitempty"`
}
type TrashBatch struct {
	Vault             Vault
	ID, Root, Version string
	Record            TrashRecord
	Paths             []string
}

func (r *Registry) trashBatch(id, batchID string) (TrashBatch, error) {
	if !uuidPattern.MatchString(batchID) {
		return TrashBatch{}, fail(400, "回收记录无效")
	}
	v, err := r.Vault(id)
	if err != nil {
		return TrashBatch{}, err
	}
	root := filepath.Join(v.Root, ".trash", batchID)
	for _, p := range []string{filepath.Join(v.Root, ".trash"), root} {
		info, e := os.Lstat(p)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return TrashBatch{}, fail(404, "回收记录不存在或无效")
		}
	}
	var record TrashRecord
	if err = readJSON(filepath.Join(root, ".coral-trash.json"), &record); err != nil {
		return TrashBatch{}, err
	}
	if record.Kind != "file" && record.Kind != "directory" {
		return TrashBatch{}, fail(400, "回收记录类型无效")
	}
	paths := record.Members
	if len(paths) == 0 {
		paths = []string{record.Path}
	} else if len(paths) > 2 || record.Kind != "file" {
		return TrashBatch{}, fail(400, "语言版本回收记录无效")
	}
	seen := map[string]bool{}
	primary := false
	for _, rel := range paths {
		key := strings.ToLower(rel)
		if seen[key] {
			return TrashBatch{}, fail(400, "语言版本回收记录无效")
		}
		seen[key] = true
		if rel == record.Path {
			primary = true
		}
		p, e := securePath(root, rel, true)
		if e != nil {
			return TrashBatch{}, e
		}
		info, e := os.Lstat(p)
		if e != nil || record.Kind == "file" && !info.Mode().IsRegular() || record.Kind == "directory" && !info.IsDir() {
			return TrashBatch{}, fail(400, "回收记录类型无效")
		}
	}
	if !primary {
		return TrashBatch{}, fail(400, "语言版本回收记录无效")
	}
	version, _, err := snapshot(root)
	return TrashBatch{v, batchID, root, version, record, paths}, err
}
func (r *Registry) ListTrash(filter string) (map[string]any, error) {
	vs, err := r.Vaults()
	if err != nil {
		return nil, err
	}
	items, vaults := []map[string]any{}, []map[string]any{}
	skipped := 0
	for _, v := range vs {
		if filter != "" && filter != v.ID {
			continue
		}
		trash := filepath.Join(v.Root, ".trash")
		if !exists(trash) {
			continue
		}
		info, e := os.Lstat(trash)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			skipped++
			continue
		}
		es, e := os.ReadDir(trash)
		if e != nil {
			skipped++
			continue
		}
		for _, e := range es {
			batch, err := r.trashBatch(v.ID, e.Name())
			if err != nil {
				skipped++
				continue
			}
			items = append(items, map[string]any{"id": e.Name(), "vault_id": v.ID, "vault_name": v.Name, "path": batch.Record.Path, "uri": ResourceURI(v.ID, batch.Record.Path), "kind": batch.Record.Kind, "deleted_at": batch.Record.DeletedAt, "version": batch.Version})
		}
	}
	es, err := os.ReadDir(filepath.Join(r.Config.DataDir, ".coral/vault-trash"))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	for _, e := range es {
		if filter != "" && filter != e.Name() {
			continue
		}
		s, err := r.vaultState(e.Name())
		if err != nil {
			skipped++
			continue
		}
		if s.State == "trash" {
			vaults = append(vaults, map[string]any{"id": s.ID, "name": s.Name, "uri": ResourceURI(s.ID, ""), "external": s.Source == "external", "deleted_at": s.DeletedAt, "version": digest(jsonBytes(s))})
		}
	}
	sort.Slice(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a["deleted_at"] != b["deleted_at"] {
			return stringValue(a["deleted_at"]) > stringValue(b["deleted_at"])
		}
		return stringValue(a["id"]) < stringValue(b["id"])
	})
	sort.Slice(vaults, func(i, j int) bool {
		return stringValue(vaults[i]["deleted_at"])+stringValue(vaults[i]["id"]) > stringValue(vaults[j]["deleted_at"])+stringValue(vaults[j]["id"])
	})
	return map[string]any{"items": items, "vaults": vaults, "skipped": skipped, "version": digest(jsonBytes(map[string]any{"items": items, "vaults": vaults}))}, nil
}
func transferFile(root, from, to, version string) error {
	b, err := readBytes(root, from)
	if err != nil {
		return err
	}
	if digest(b) != version {
		return fail(409, "文档已被修改，请刷新后重试")
	}
	source, err := securePath(root, from, true)
	if err != nil {
		return err
	}
	target, err := securePath(root, to, false)
	if err != nil {
		return err
	}
	if runtime.GOOS == "windows" && from != to && strings.EqualFold(from, to) {
		before, e := os.Lstat(source)
		if e != nil {
			return e
		}
		after, e := os.Lstat(target)
		if e != nil || !os.SameFile(before, after) {
			return fail(409, "目标位置已变化，请刷新后重试")
		}
		return os.Rename(source, target)
	}
	if err = os.Link(source, target); err != nil {
		return err
	}
	check, e := readBytes(root, from)
	if e != nil || digest(check) != version {
		_ = os.Remove(target)
		return fail(409, "文档已被修改，请刷新后重试")
	}
	if err = os.Remove(source); err != nil {
		_ = os.Remove(target)
		return err
	}
	return nil
}
func (r *Registry) Delete(uri, version, noteVersion string, directory bool) error {
	e, err := r.Entry(uri)
	if err != nil {
		return err
	}
	if directory != (e.Kind == "directory") {
		return fail(400, "资源类型不匹配")
	}
	if version == "" || version != e.Version {
		return fail(409, "内容已修改，请刷新后重试")
	}
	v, err := r.Vault(e.VaultID)
	if err != nil {
		return err
	}
	members := []Document{}
	if directory {
		vs, err := r.Vaults()
		if err != nil {
			return err
		}
		p, err := securePath(v.Root, e.Relative, true)
		if err != nil {
			return err
		}
		for _, other := range vs {
			root, err := filepath.EvalSymlinks(other.Root)
			if err == nil && (root == p || strings.HasPrefix(root, p+string(filepath.Separator))) {
				return fail(400, "不能删除知识库根目录或包含其他知识库的目录")
			}
		}
	} else {
		f, err := r.Family(uri)
		if err != nil {
			return err
		}
		if noteVersion != "" && noteVersion != f.Signature {
			return fail(409, "笔记的语言版本已变化，请刷新后重试")
		}
		if f.Issue != "" {
			return fail(409, f.Issue)
		}
		members = f.Versions
		e.Relative = f.Primary.Relative
	}
	trash := filepath.Join(v.Root, ".trash")
	if err = os.Mkdir(trash, 0755); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(trash)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fail(400, "知识库回收站不可用")
	}
	batchID := newID()
	batch := filepath.Join(trash, batchID)
	if err = os.Mkdir(batch, 0755); err != nil {
		return err
	}
	record := TrashRecord{e.Relative, "file", time.Now().UTC().Format(time.RFC3339Nano), nil}
	if directory {
		record.Kind = "directory"
	} else if len(members) > 1 {
		for _, d := range members {
			record.Members = append(record.Members, d.Relative)
		}
	}
	if err = saveJSON(filepath.Join(batch, ".coral-trash.json"), record); err != nil {
		return err
	}
	if directory {
		source, err := securePath(v.Root, e.Relative, true)
		if err != nil {
			return err
		}
		current, _, err := snapshot(source)
		if err != nil {
			return err
		}
		if current != version {
			return fail(409, "文件夹内容已修改，请刷新后重试")
		}
		target := filepath.Join(batch, filepath.FromSlash(e.Relative))
		if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		if err = os.Rename(source, target); err != nil {
			return err
		}
	} else {
		moves := []fileMove{}
		for _, d := range members {
			moves = append(moves, fileMove{d.Relative, filepath.ToSlash(filepath.Join(".trash", batchID, filepath.FromSlash(d.Relative))), d.Version})
		}
		if err = r.transferBatch(v, moves, batchID); err != nil {
			if cleanup := syncTrashRecord(batch, record); cleanup != nil {
				return addRecoveryConflict(err, ResourceURI(v.ID, record.Path), "无法更新回收记录，请按操作编号检查保留的文件")
			}
			return err
		}
	}
	paths := []string{e.Relative}
	for _, d := range members {
		paths = append(paths, d.Relative)
	}
	r.history(v, paths, "删除："+e.Relative)
	return nil
}

type fileMove struct{ From, To, Version string }

func (r *Registry) transferBatch(v Vault, moves []fileMove, op string) error {
	completed := []fileMove{}
	affected := []string{}
	for _, m := range moves {
		affected = append(affected, ResourceURI(v.ID, m.From))
		target, err := internalPath(v.Root, m.To)
		if err != nil {
			return err
		}
		if exists(target) || collisionIfExists(filepath.Dir(target), filepath.Base(target)) {
			return fail(409, "目标位置已有同名内容，操作未完成")
		}
		if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
	}
	err := func() error {
		for _, m := range moves {
			if r.testHook != nil {
				if err := r.testHook("before-transfer"); err != nil {
					return err
				}
			}
			if err := transferFileInternal(v.Root, m.From, m.To, m.Version); err != nil {
				return err
			}
			completed = append(completed, m)
		}
		if r.testHook != nil {
			if err := r.testHook("after-transfers"); err != nil {
				return err
			}
		}
		for _, m := range moves {
			target, err := internalPath(v.Root, m.To)
			if err != nil {
				return err
			}
			hash, err := fileDigest(target)
			if err != nil || hash != m.Version {
				return fail(409, "操作期间文件被其他程序修改，内容已保留")
			}
		}
		return nil
	}()
	if err == nil {
		return nil
	}
	conflicts := []map[string]string{}
	for i := len(completed) - 1; i >= 0; i-- {
		m := completed[i]
		if e := transferFileInternal(v.Root, m.To, m.From, m.Version); e != nil {
			conflicts = append(conflicts, map[string]string{"uri": ResourceURI(v.ID, m.To), "reason": "文件已变化或原位置被占用，未自动恢复"})
		}
	}
	return recoveryError(err, op, conflicts, affected)
}
func collisionIfExists(dir, name string) bool {
	if !exists(dir) {
		return false
	}
	return collision(dir, name, "")
}

// Internal trash paths are built here rather than accepted from a client URI.
func internalPath(root, rel string) (string, error) {
	parts := strings.Split(rel, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, `\:`) {
			return "", fail(400, "无效的内部路径")
		}
	}
	p := root
	for _, part := range parts {
		p = filepath.Join(p, part)
		info, err := os.Lstat(p)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fail(400, "不允许访问符号链接")
		}
	}
	return p, nil
}
func transferFileInternal(root, from, to, version string) error {
	source, err := internalPath(root, from)
	if err != nil {
		return err
	}
	target, err := internalPath(root, to)
	if err != nil {
		return err
	}
	b, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if digest(b) != version {
		return fail(409, "文档已被修改，请刷新后重试")
	}
	if err = os.Link(source, target); err != nil {
		return err
	}
	b, err = os.ReadFile(source)
	if err != nil || digest(b) != version {
		_ = os.Remove(target)
		return fail(409, "文档已被修改，请刷新后重试")
	}
	if err = os.Remove(source); err != nil {
		_ = os.Remove(target)
	}
	return err
}
func (r *Registry) RestoreTrash(id, batchID, version string, purge bool) error {
	b, err := r.trashBatch(id, batchID)
	if err != nil {
		return err
	}
	if version == "" || version != b.Version {
		return fail(409, "回收内容已变化，请刷新后重试")
	}
	if purge {
		return os.RemoveAll(b.Root)
	}
	for _, rel := range b.Paths {
		p, err := securePath(b.Vault.Root, rel, false)
		if err != nil {
			return err
		}
		if exists(p) || collisionIfExists(filepath.Dir(p), filepath.Base(p)) {
			return fail(409, "原位置已有同名内容，请先重命名或移走后再恢复")
		}
	}
	if b.Record.Kind == "directory" {
		target, err := securePath(b.Vault.Root, b.Record.Path, false)
		if err != nil {
			return err
		}
		if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		if err = os.Rename(filepath.Join(b.Root, filepath.FromSlash(b.Record.Path)), target); err != nil {
			return err
		}
	} else {
		moves := []fileMove{}
		for _, rel := range b.Paths {
			raw, err := readBytes(b.Root, rel)
			if err != nil {
				return err
			}
			moves = append(moves, fileMove{filepath.ToSlash(filepath.Join(".trash", batchID, filepath.FromSlash(rel))), rel, digest(raw)})
		}
		if err = r.transferBatch(b.Vault, moves, batchID); err != nil {
			if cleanup := syncTrashRecord(b.Root, b.Record); cleanup != nil {
				return addRecoveryConflict(err, ResourceURI(b.Vault.ID, b.Record.Path), "无法更新回收记录，请按操作编号检查实际恢复位置")
			}
			return err
		}
	}
	_ = os.Remove(filepath.Join(b.Root, ".coral-trash.json"))
	for _, rel := range b.Paths {
		p := filepath.Dir(filepath.Join(b.Root, filepath.FromSlash(rel)))
		for p == b.Root || strings.HasPrefix(p, b.Root+string(filepath.Separator)) {
			if os.Remove(p) != nil {
				break
			}
			p = filepath.Dir(p)
		}
	}
	r.history(b.Vault, b.Paths, "恢复："+b.Record.Path)
	return nil
}

func syncTrashRecord(batch string, record TrashRecord) error {
	paths := record.Members
	if len(paths) == 0 {
		paths = []string{record.Path}
	}
	remaining := []string{}
	for _, rel := range paths {
		p, err := internalPath(batch, rel)
		if err != nil {
			return err
		}
		if exists(p) {
			remaining = append(remaining, rel)
		}
	}
	if len(remaining) > 0 {
		record.Path = remaining[0]
		if len(record.Members) > 0 {
			record.Members = remaining
		}
		return saveJSON(filepath.Join(batch, ".coral-trash.json"), record)
	}
	if err := os.Remove(filepath.Join(batch, ".coral-trash.json")); err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, rel := range paths {
		p := filepath.Dir(filepath.Join(batch, filepath.FromSlash(rel)))
		for p == batch || strings.HasPrefix(p, batch+string(filepath.Separator)) {
			if os.Remove(p) != nil {
				break
			}
			p = filepath.Dir(p)
		}
	}
	return nil
}
func addRecoveryConflict(err error, uri, reason string) error {
	e := appError(err)
	if e.Details == nil {
		return err
	}
	recovery, ok := e.Details["recovery"].(map[string]any)
	if !ok {
		return err
	}
	conflicts, _ := recovery["conflicts"].([]map[string]string)
	recovery["conflicts"] = append(conflicts, map[string]string{"uri": uri, "reason": reason})
	recovery["partial"] = true
	return e
}
func (r *Registry) EmptyTrash(filter, version string) error {
	listing, err := r.ListTrash(filter)
	if err != nil {
		return err
	}
	if version == "" || version != listing["version"] {
		return fail(409, "回收站已变化，请刷新后重试")
	}
	for _, item := range listing["items"].([]map[string]any) {
		if err = r.RestoreTrash(stringValue(item["vault_id"]), stringValue(item["id"]), stringValue(item["version"]), true); err != nil {
			return err
		}
	}
	for _, item := range listing["vaults"].([]map[string]any) {
		if err = r.RestoreVault(stringValue(item["id"]), stringValue(item["version"]), true); err != nil {
			return err
		}
	}
	return nil
}
