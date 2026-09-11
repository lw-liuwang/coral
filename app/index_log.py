"""index.md / log.md 的确定性维护（应用代码维护，LLM 不参与）。"""
import os
from typing import Iterable, List, Optional

from . import paths
from .wiki import PageMeta, WikiStore

TYPE_LABELS = {"entity": "实体", "concept": "概念", "source": "来源"}
TYPE_ORDER = ("entity", "concept", "source")


def rebuild_index(store: WikiStore) -> str:
    """全量重建 wiki/index.md（按 type 分组）。"""
    pages: List[PageMeta] = store.list_pages()
    lines = ["# Wiki 目录", "", "> 本文件由 coral 自动维护，请勿手工编辑。", ""]
    for t in TYPE_ORDER:
        group = [p for p in pages if p.type == t]
        if not group:
            continue
        lines.append(f"## {TYPE_LABELS[t]}（{TYPE_LABELS[t].lower()}/{t}）· {len(group)}")
        lines.append("")
        for p in sorted(group, key=lambda x: x.title):
            date = f" · 更新 {p.updated}" if p.updated else ""
            lines.append(f"- [[{p.slug}]] — {p.title}{date}")
        lines.append("")
    if len(pages) == 0:
        lines.append("（wiki 还没有任何页面，去 /sources 上传第一份笔记吧）")
        lines.append("")
    out = "\n".join(lines)
    path = os.path.join(paths.wiki_root(store.data_dir), "index.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)
    return out


def read_index(store: WikiStore) -> str:
    path = os.path.join(paths.wiki_root(store.data_dir), "index.md")
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    return ""


def append_log(store: WikiStore, action: str, title: str, detail: Optional[Iterable[str]] = None) -> None:
    """追加 log.md 条目：`## [YYYY-MM-DD] 动作 | 标题`（grep 友好格式）。"""
    import datetime
    path = os.path.join(paths.wiki_root(store.data_dir), "log.md")
    today = datetime.date.today().isoformat()
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            existing = f.read()
    else:
        existing = "# 操作日志\n"
    entry = f"\n\n## [{today}] {action} | {title}"
    if detail:
        for line in detail:
            entry += f"\n- {line}"
    with open(path, "w", encoding="utf-8") as f:
        f.write(existing.rstrip("\n") + "\n" + entry.lstrip("\n") + "\n")


def ensure_initialized(store: WikiStore) -> None:
    """启动时保证 index.md/log.md 存在。"""
    wiki = paths.wiki_root(store.data_dir)
    if not os.path.isfile(os.path.join(wiki, "index.md")):
        rebuild_index(store)
    if not os.path.isfile(os.path.join(wiki, "log.md")):
        with open(os.path.join(wiki, "log.md"), "w", encoding="utf-8") as f:
            f.write("# 操作日志\n")
