"""Ingest 管线：队列线程 + 两步 LLM 编排 + 合并落盘 + index/log/FTS 维护。

原则（借鉴 llm_wiki 验证过的模式）：
- 「LLM 提议、应用裁决」：union 字段并集、locked 字段回写、updated 盖当天
- LLM 输出一律视为不可信输入：路径闸门、frontmatter 容错、坏块拒不拒任务
- 严格串行（单队列单线程），与网页编辑共用全局写锁
- 每次落盘由 GitRepo 以 coral-llm 身份提交，与用户操作（coral-user）区分留痕
"""
import datetime
import json
import os
import queue
import threading
from typing import Any, Dict, List, Optional, Tuple

from . import fileblocks, index_log, paths
from . import frontmatter as fm_mod
from .config import Config
from .gitrepo import LLM_AUTHOR
from .llm import LLMClient, LLMError
from .prompts import build_analysis_prompts, build_generation_prompts
from .wiki import WikiStore, WRITE_LOCK

STATES = ("queued", "analyzing", "generating", "writing", "done", "error")
STEP_LABELS = {"analyzing": "正在分析", "generating": "正在生成", "writing": "正在落盘"}
INGEST_TYPES_ALLOWED = {"entity", "concept", "source"}  # 常规 ingest LLM 可写的目录
JOURNAL_SOURCE = "随手记"                                # 虚拟源：整理随手记
JOURNAL_TYPES_ALLOWED = INGEST_TYPES_ALLOWED | {"note"}  # 随手记整理额外可写 notes/


class IngestManager:
    def __init__(self, config: Config, store: WikiStore,
                 llm: Optional[LLMClient] = None,
                 search: Optional[Any] = None,
                 git: Optional[Any] = None) -> None:
        self.config = config
        self.store = store
        self.llm = llm or LLMClient(config)
        self.search = search
        self.git = git
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self.active: Optional[Dict[str, Any]] = None

    # ---------- 生命周期 ----------

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._worker, daemon=True, name="coral-ingest")
            self._thread.start()

    def enqueue(self, source_name: str) -> bool:
        """入队。已在队列或正在运行 → False。"""
        with self._lock:
            queued = list(self._queue.queue)
            if source_name in queued:
                return False
            if self.active and self.active.get("source") == source_name:
                return False
        self._queue.put(source_name)
        return True

    def queued_items(self) -> List[str]:
        with self._lock:
            return list(self._queue.queue)

    def status(self) -> Dict[str, Any]:
        return {"active": self.active, "queued": self.queued_items()}

    def _worker(self) -> None:
        while True:
            source_name = self._queue.get()
            try:
                self._run(source_name)
            except Exception as e:  # 兜底：worker 线程不能死
                self._finish_run(source_name, "error", {"error": str(e)})
            finally:
                self._queue.task_done()

    # ---------- 单次 ingest ----------

    def _run(self, source_name: str) -> None:
        started = datetime.datetime.now().isoformat(timespec="seconds")
        journal_run = source_name == JOURNAL_SOURCE
        if journal_run:
            from .journal import JournalStore
            source_content = JournalStore(self.store.data_dir).source_text(
                self.config.source_max_chars)
            if not source_content:
                self._finish_run(source_name, "error",
                                 {"error": "随手记还没有内容，先写几条再来整理"}, started)
                return
            truncated_note = ""
        else:
            source_path = paths.find_source_file(self.store.data_dir, source_name)
            if not os.path.isfile(source_path):
                self._finish_run(source_name, "error", {"error": f"源文件不存在: {source_name}"}, started)
                return
            with open(source_path, "r", encoding="utf-8") as f:
                source_content = f.read()
            truncated_note = ""
            if len(source_content) > self.config.source_max_chars:
                truncated_note = f"（源文档超长，已截断至 {self.config.source_max_chars} 字符）"
                source_content = source_content[:self.config.source_max_chars]

        self._set_active(source_name, "analyzing", "调用 LLM 分析" +
                         ("随手记" if journal_run else "源文档") + truncated_note)
        index_text = index_log.read_index(self.store)
        sys1, user1 = build_analysis_prompts(index_text, source_name, source_content,
                                             journal=journal_run)
        try:
            analysis = self.llm.chat(sys1, user1, temperature=0.2, max_tokens=4096)
        except LLMError as e:
            self._finish_run(source_name, "error", {"error": f"分析失败: {e}"}, started)
            return
        if not analysis.strip():
            self._finish_run(source_name, "error", {"error": "分析结果为空"}, started)
            return

        self._set_active(source_name, "generating", "LLM 生成 wiki 页面")
        sys2, user2 = build_generation_prompts(
            source_name, analysis[: self.config.analysis_max_chars],
            source_content[:4000], journal=journal_run)
        try:
            generation = self.llm.chat(sys2, user2)
        except LLMError as e:
            self._finish_run(source_name, "error", {"error": f"生成失败: {e}"}, started)
            return

        roots = ("wiki", "journal") if journal_run else ("wiki",)
        blocks, parse_warnings = fileblocks.parse_file_blocks(generation, roots)
        if not blocks:
            self._finish_run(source_name, "error", {
                "error": "LLM 输出中没有可解析的 FILE 块",
                "raw_head": generation[:500],
            }, started)
            return

        self._set_active(source_name, "writing", f"写入 {len(blocks)} 个页面")
        created: List[str] = []
        updated: List[str] = []
        entries_updated: List[str] = []
        warnings = list(parse_warnings)
        with WRITE_LOCK:
            for block in blocks:
                key, kind, action, warn = self._apply_block(block, source_name, journal_run)
                if warn:
                    warnings.append(warn)
                if kind == "journal":
                    if action == "update" and key:
                        entries_updated.append(key)
                elif action == "create" and key:
                    created.append(key)
                elif action == "update" and key:
                    updated.append(key)

            index_log.rebuild_index(self.store)
            detail = []
            if created:
                detail.append("新建: " + ", ".join(created))
            if updated:
                detail.append("更新: " + ", ".join(updated))
            if entries_updated:
                detail.append("修订随手记: " + ", ".join(entries_updated))
            index_log.append_log(self.store, "ingest", source_name, detail)

        if self.search:
            for slug in created + updated:
                page = self.store.get_page(slug)
                if page:
                    _, fm, body = page
                    self.search.index_page(slug, "wiki", str(fm.get("title") or slug), body)
            if entries_updated:
                from .journal import JournalStore, entry_title
                jstore = JournalStore(self.store.data_dir)
                for eid in entries_updated:
                    text = jstore.get_entry(eid)
                    if text is not None:
                        date, tm = jstore.entry_datetime(eid)
                        self.search.index_page(eid, "journal",
                                               entry_title(eid, date, tm), text)
            if not journal_run:
                self.search.index_page(source_name, "source", source_name, source_content)

        # git 留痕：本次 LLM 写到的文件
        if self.git and (created or updated or entries_updated):
            rels = []
            for slug in created + updated:
                page = self.store.get_page(slug)
                if page:
                    rels.append(os.path.relpath(
                        paths.page_path(self.store.data_dir, page[0], slug),
                        self.store.data_dir))
            rels += ["wiki/index.md", "wiki/log.md"]
            rels += [f"journal/{eid}.md" for eid in entries_updated]
            self.git.commit(rels, LLM_AUTHOR,
                            f"LLM 整理《{source_name}》：新建 {len(created)}、"
                            f"更新 {len(updated)}、修订随手记 {len(entries_updated)}")

        summary = {"created": created, "updated": updated,
                   "entries_updated": entries_updated, "warnings": warnings}
        if not created and not updated and not entries_updated:
            summary["note"] = "没有任何页面写入"
        self._finish_run(source_name, "done", summary, started)

    # ---------- 块落盘（合并裁决） ----------

    def _apply_block(self, block: fileblocks.FileBlock, source_name: str,
                     journal_run: bool
                     ) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
        """处理单个 FILE 块。返回 (key, kind, action, warning)；kind ∈ wiki/journal。"""
        if block.path.startswith("journal/"):
            if not journal_run:
                return None, "journal", None, f"常规整理不允许写 journal/，已跳过: {block.path}"
            return self._apply_journal_block(block)

        # 路径 → 目录路由（目录是权威的 type 来源）
        rel = block.path[len("wiki/"):]
        parts = rel.split("/")
        if len(parts) != 2 or not parts[1].endswith(".md"):
            return None, "wiki", None, f"路径格式异常，已跳过: {block.path}"
        sub, filename = parts
        dir_type = {v: k for k, v in paths.WIKI_DIRS.items()}.get(sub)
        if dir_type is None:
            return None, "wiki", None, f"未知目录，已跳过: {block.path}"
        allowed = JOURNAL_TYPES_ALLOWED if journal_run else INGEST_TYPES_ALLOWED
        if dir_type not in allowed:
            return None, "wiki", None, f"目录 {sub}/ 不对 LLM 开放，已跳过: {block.path}"
        slug = filename[:-3]
        if not paths.is_safe_slug(slug):
            return None, "wiki", None, f"非法 slug，已跳过: {slug!r}"

        fm, body, fm_warnings = fm_mod.parse(block.content)
        if not fm:
            return None, "wiki", None, f"frontmatter 无法解析，已跳过: {block.path}"
        if str(fm.get("type", "")) not in paths.PAGE_TYPES:
            fm["type"] = dir_type
        if str(fm.get("type")) != dir_type:
            # frontmatter type 与目录不一致 → 目录为准
            warning = f"type 与目录不一致，已按目录 {dir_type} 处理: {block.path}"
            fm["type"] = dir_type
        else:
            warning = "; ".join(fm_warnings) if fm_warnings else None
        fm = fm_mod.normalize_union_items(fm)

        today = datetime.date.today().isoformat()
        existing = self.store.get_page(slug)
        if existing is None:
            fm.setdefault("created", today)
            fm["updated"] = today
            fm = _ensure_source(fm, source_name)
            self.store.save_page(slug, fm, body)
            return slug, "wiki", "create", warning

        old_type, old_fm, old_body = existing
        merged = fm_mod.merge_union(old_fm, fm)
        merged = fm_mod.apply_locked(old_fm, merged)
        merged["updated"] = today
        merged["type"] = old_type  # 目录/type 均以旧页面为准
        merged = _ensure_source(merged, source_name)  # 应用强制记录溯源
        warning = warning or None

        old_sources = fm_mod._as_list(old_fm.get("sources") or [])
        if body.strip() == old_body.strip():
            self.store.save_page(slug, merged, old_body)
            return slug, "wiki", "update", warning
        if set(old_sources) <= {source_name}:
            # 该页由当前源独占 → 直接替换（幂等重跑）
            self.store.save_page(slug, merged, body)
            return slug, "wiki", "update", warning
        # 多源页面：追加补充小节，不覆盖其他来源的内容
        extra = (f"\n\n## 来自《{source_name}》的补充\n\n{body.strip()}\n")
        self.store.save_page(slug, merged, old_body.rstrip("\n") + extra + "\n")
        w = f"页面 {slug} 有多个来源，已追加补充小节（建议手动整理）"
        if warning:
            w = warning + "; " + w
        return slug, "wiki", "update", w

    def _apply_journal_block(self, block: fileblocks.FileBlock
                             ) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
        """LLM 修订随手记原文：只能改已存在的条目，内容为纯文本（无 frontmatter）。"""
        from .journal import JournalStore
        rel = block.path[len("journal/"):]
        if "/" in rel or not rel.endswith(".md"):
            return None, "journal", None, f"journal 路径格式异常，已跳过: {block.path}"
        entry_id = rel[:-3]
        jstore = JournalStore(self.store.data_dir)
        if not paths.is_safe_slug(entry_id):
            return None, "journal", None, f"非法记录名，已跳过: {entry_id!r}"
        if jstore.get_entry(entry_id) is None:
            return None, "journal", None, f"只能修订已存在的随手记，已跳过: {entry_id}"
        # save_entry 保持 mtime：修订不改变记录时间
        jstore.save_entry(entry_id, block.content.strip("\n"))
        return entry_id, "journal", "update", None

    # ---------- 状态记录 ----------

    def _set_active(self, source: str, state: str, message: str) -> None:
        with self._lock:
            self.active = {
                "source": source, "state": state, "message": message,
                "step_label": STEP_LABELS.get(state, state),
                "started": datetime.datetime.now().isoformat(timespec="seconds"),
            }

    def _finish_run(self, source: str, state: str, payload: Dict[str, Any],
                    started: Optional[str] = None) -> None:
        finished = datetime.datetime.now().isoformat(timespec="seconds")
        with self._lock:
            self.active = None
        if self.search:
            self.search.record_run(
                source, state, started or finished, finished, json.dumps(payload, ensure_ascii=False))


def _ensure_source(fm: Dict[str, Any], source_name: str) -> Dict[str, Any]:
    """应用强制把当前源文件名写进 sources（溯源不由 LLM 决定）。"""
    out = dict(fm)
    sources = fm_mod._as_list(out.get("sources") or [])
    if source_name not in sources:
        sources.append(source_name)
    out["sources"] = sources
    return out
