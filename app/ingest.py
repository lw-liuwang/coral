"""Ingest 管线：队列线程 + 两步 LLM 编排 + 合并落盘 + index/log/FTS 维护。

原则（借鉴 llm_wiki 验证过的模式）：
- 「LLM 提议、应用裁决」：union 字段并集、locked 字段回写、updated 盖当天
- LLM 输出一律视为不可信输入：路径闸门、frontmatter 容错、坏块拒不拒任务
- 严格串行（单队列单线程），与网页编辑共用全局写锁
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
from .llm import LLMClient, LLMError
from .prompts import build_analysis_prompts, build_generation_prompts
from .wiki import WikiStore, WRITE_LOCK

STATES = ("queued", "analyzing", "generating", "writing", "done", "error")
STEP_LABELS = {"analyzing": "正在分析", "generating": "正在生成", "writing": "正在落盘"}


class IngestManager:
    def __init__(self, config: Config, store: WikiStore,
                 llm: Optional[LLMClient] = None,
                 search: Optional[Any] = None) -> None:
        self.config = config
        self.store = store
        self.llm = llm or LLMClient(config)
        self.search = search
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
        source_path = paths.find_source_file(self.store.data_dir, source_name)
        if not os.path.isfile(source_path):
            self._finish_run(source_name, "error", {"error": f"源文件不存在: {source_name}"})
            return
        with open(source_path, "r", encoding="utf-8") as f:
            source_content = f.read()
        truncated_note = ""
        if len(source_content) > self.config.source_max_chars:
            truncated_note = f"（源文档超长，已截断至 {self.config.source_max_chars} 字符）"
            source_content = source_content[:self.config.source_max_chars]

        self._set_active(source_name, "analyzing", "调用 LLM 分析源文档" + truncated_note)
        index_text = index_log.read_index(self.store)
        sys1, user1 = build_analysis_prompts(index_text, source_name, source_content)
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
            source_content[:4000])
        try:
            generation = self.llm.chat(sys2, user2)
        except LLMError as e:
            self._finish_run(source_name, "error", {"error": f"生成失败: {e}"}, started)
            return

        blocks, parse_warnings = fileblocks.parse_file_blocks(generation)
        if not blocks:
            self._finish_run(source_name, "error", {
                "error": "LLM 输出中没有可解析的 FILE 块",
                "raw_head": generation[:500],
            }, started)
            return

        self._set_active(source_name, "writing", f"写入 {len(blocks)} 个页面")
        created: List[str] = []
        updated: List[str] = []
        warnings = list(parse_warnings)
        with WRITE_LOCK:
            for block in blocks:
                slug, action, warn = self._apply_block(block, source_name)
                if warn:
                    warnings.append(warn)
                if action == "create" and slug:
                    created.append(slug)
                elif action == "update" and slug:
                    updated.append(slug)

            index_log.rebuild_index(self.store)
            detail = []
            if created:
                detail.append("新建: " + ", ".join(created))
            if updated:
                detail.append("更新: " + ", ".join(updated))
            index_log.append_log(self.store, "ingest", source_name, detail)

        if self.search:
            for slug in created + updated:
                page = self.store.get_page(slug)
                if page:
                    _, fm, body = page
                    self.search.index_page(slug, "wiki", str(fm.get("title") or slug), body)
            self.search.index_page(source_name, "source", source_name, source_content)

        summary = {"created": created, "updated": updated, "warnings": warnings}
        if not created and not updated:
            summary["note"] = "没有任何页面写入"
        self._finish_run(source_name, "done", summary, started)

    # ---------- 块落盘（合并裁决） ----------

    def _apply_block(self, block: fileblocks.FileBlock,
                     source_name: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """处理单个 FILE 块。返回 (slug, action, warning)。"""
        # 路径 → 目录路由（目录是权威的 type 来源）
        rel = block.path[len("wiki/"):]
        parts = rel.split("/")
        if len(parts) != 2 or not parts[1].endswith(".md"):
            return None, None, f"路径格式异常，已跳过: {block.path}"
        sub, filename = parts
        dir_type = {v: k for k, v in paths.WIKI_DIRS.items()}.get(sub)
        if dir_type is None:
            return None, None, f"未知目录，已跳过: {block.path}"
        slug = filename[:-3]
        if not paths.is_safe_slug(slug):
            return None, None, f"非法 slug，已跳过: {slug!r}"

        fm, body, fm_warnings = fm_mod.parse(block.content)
        if not fm:
            return None, None, f"frontmatter 无法解析，已跳过: {block.path}"
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
            return slug, "create", warning

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
            return slug, "update", warning
        if set(old_sources) <= {source_name}:
            # 该页由当前源独占 → 直接替换（幂等重跑）
            self.store.save_page(slug, merged, body)
            return slug, "update", warning
        # 多源页面：追加补充小节，不覆盖其他来源的内容
        extra = (f"\n\n## 来自《{source_name}》的补充\n\n{body.strip()}\n")
        self.store.save_page(slug, merged, old_body.rstrip("\n") + extra + "\n")
        w = f"页面 {slug} 有多个来源，已追加补充小节（建议手动整理）"
        if warning:
            w = warning + "; " + w
        return slug, "update", w

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
