"""随手记：一条记录 = 一个文件。

用户只负责写；时间由系统后台记录。默认文件名是时间戳
（journal/YYYY-MM-DD_HH-MM-SS.md，同秒冲突追加 -1、-2…），
记录时间取文件 mtime，因此**文件名可以随意改名而时间不丢**。
空内容也允许保存（落一条只有时间戳的记录）。
"""
import datetime
import os
import re
from typing import List, Optional, Tuple

from . import paths
from .wiki import WRITE_LOCK

# 默认时间戳命名（同秒冲突追加 -1、-2…）；改名后不再是这个形态
ENTRY_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?$")
_WS_RE = re.compile(r"\s+")


def entry_title(entry_id: str, date: str, time: str) -> str:
    """搜索/列表标题：默认记录只显示时间，改过名的带上名字。"""
    if ENTRY_ID_RE.match(entry_id):
        return f"随手记 {date} {time}"
    return f"随手记 {date} {time} · {entry_id}"


class EntrySummary:
    __slots__ = ("entry_id", "name", "date", "time", "preview", "empty")

    def __init__(self, entry_id: str, name: Optional[str], date: str, time: str,
                 preview: str, empty: bool) -> None:
        self.entry_id = entry_id
        self.name = name          # 自定义名字；时间戳命名的为 None
        self.date = date
        self.time = time
        self.preview = preview
        self.empty = empty


class JournalStore:
    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir

    # ---------- 路径 ----------

    def entry_path(self, entry_id: str) -> str:
        # 允许时间戳名与任意安全 slug（改过名的记录）
        if not paths.is_safe_slug(entry_id or ""):
            raise ValueError(f"非法记录名: {entry_id!r}")
        return os.path.join(paths.journal_root(self.data_dir), entry_id + ".md")

    # ---------- 读取 ----------

    def get_entry(self, entry_id: str) -> Optional[str]:
        """返回记录原文；不存在返回 None。空内容记录返回 ''。"""
        p = self.entry_path(entry_id)
        if not os.path.isfile(p):
            return None
        with open(p, "r", encoding="utf-8") as f:
            return f.read()

    def entry_datetime(self, entry_id: str) -> Tuple[str, str]:
        """记录时间 = 文件 mtime（改名/编辑都不动它）→ (date, time)。"""
        p = self.entry_path(entry_id)
        dt = datetime.datetime.fromtimestamp(os.stat(p).st_mtime)
        return dt.strftime("%Y-%m-%d"), dt.strftime("%H-%M-%S")

    def entry_name(self, entry_id: str) -> Optional[str]:
        """自定义名字；时间戳命名的记录返回 None。"""
        return None if ENTRY_ID_RE.match(entry_id) else entry_id

    def list_entries(self, limit: int = 50) -> List[EntrySummary]:
        """按记录时间（mtime）倒序的记录流。"""
        root = paths.journal_root(self.data_dir)
        if not os.path.isdir(root):
            return []
        items = []
        for fname in os.listdir(root):
            if not fname.endswith(".md"):
                continue
            entry_id = fname[:-3]
            if not paths.is_safe_slug(entry_id):
                continue
            p = os.path.join(root, fname)
            try:
                mtime = os.stat(p).st_mtime
                with open(p, "r", encoding="utf-8") as f:
                    text = f.read()
            except OSError:
                continue
            preview = next((l.strip() for l in text.split("\n") if l.strip()), "")
            items.append((mtime, entry_id, preview))
        items.sort(key=lambda it: (it[0], it[1]), reverse=True)
        out: List[EntrySummary] = []
        for mtime, entry_id, preview in items[:limit]:
            dt = datetime.datetime.fromtimestamp(mtime)
            out.append(EntrySummary(
                entry_id=entry_id,
                name=self.entry_name(entry_id),
                date=dt.strftime("%Y-%m-%d"),
                time=dt.strftime("%H-%M-%S"),
                preview=preview[:80],
                empty=not preview,
            ))
        return out

    # ---------- 写入 ----------

    def add_entry(self, content: str) -> str:
        """新增一条记录（content 可为空 → 只有时间戳的记录）。返回 entry_id。"""
        now = datetime.datetime.now()
        base = now.strftime("%Y-%m-%d_%H-%M-%S")
        root = paths.journal_root(self.data_dir)
        entry_id = base
        i = 1
        with WRITE_LOCK:
            os.makedirs(root, exist_ok=True)
            while os.path.exists(os.path.join(root, entry_id + ".md")):
                entry_id = f"{base}-{i}"
                i += 1
            with open(os.path.join(root, entry_id + ".md"), "w", encoding="utf-8") as f:
                f.write((content or "").strip())
        return entry_id

    def save_entry(self, entry_id: str, text: str) -> None:
        p = self.entry_path(entry_id)
        with WRITE_LOCK:
            if not os.path.isfile(p):
                raise ValueError(f"记录不存在: {entry_id}")
            st = os.stat(p)
            with open(p, "w", encoding="utf-8") as f:
                f.write(text)
            # 编辑内容不改记录时间（列表顺序保持原时间）
            os.utime(p, (st.st_atime, st.st_mtime))

    def rename_entry(self, entry_id: str, new_name: str) -> str:
        """给记录改名：内容与时间（mtime）都不变。返回新 entry_id。

        空白折叠成 -（「夜跑 记录」→「夜跑-记录」），.md 后缀自动剥掉。
        """
        new_name = _WS_RE.sub("-", (new_name or "").strip())
        if new_name.lower().endswith(".md"):
            new_name = new_name[:-3].strip()
        if not paths.is_safe_slug(new_name):
            raise ValueError(f"名字只能用中文/字母/数字和 - _：{new_name!r}")
        old_p = self.entry_path(entry_id)
        new_p = self.entry_path(new_name)
        with WRITE_LOCK:
            if not os.path.isfile(old_p):
                raise ValueError(f"记录不存在: {entry_id}")
            if new_name == entry_id:
                return entry_id
            if os.path.exists(new_p):
                raise ValueError(f"已有同名记录: {new_name}")
            os.rename(old_p, new_p)  # mtime 保持
        return new_name

    def source_text(self, max_chars: int = 24000) -> str:
        """把全部随手记拼成给 LLM 的源文本（时间正序；超长截断）。"""
        parts: List[str] = []
        total = 0
        for e in reversed(self.list_entries(limit=100000)):  # 时间正序
            text = self.get_entry(e.entry_id) or ""
            if not text.strip():
                continue
            head = f"## {e.date} {e.time}" + (f"（{e.name}）" if e.name else "")
            block = f"{head}\n\n{text.strip()}"
            if total + len(block) > max_chars:
                parts.append("（更早的记录已截断）")
                break
            total += len(block)
            parts.append(block)
        return "\n\n".join(parts)

    def delete_entry(self, entry_id: str) -> bool:
        p = self.entry_path(entry_id)
        if not os.path.isfile(p):
            return False
        with WRITE_LOCK:
            os.remove(p)
        return True
