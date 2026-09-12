"""随手记：一条记录 = 一个文件（journal/YYYY-MM-DD_HH-MM-SS.md）。

用户只负责写；时间完全由系统后台记录（文件名即时间戳）。
没有「天」「文件」概念暴露给用户——界面上只有一条条记录。
空内容也允许保存（落一条只有时间戳的记录）。
"""
import os
import re
import threading
from typing import List, Optional

from . import paths
from .wiki import WRITE_LOCK

# entry_id 形如 2026-09-12_16-34-45（同秒冲突追加 -1、-2…）
ENTRY_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?$")
_TIMESTAMP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})")


class EntrySummary:
    __slots__ = ("entry_id", "date", "time", "preview", "empty")

    def __init__(self, entry_id: str, date: str, time: str,
                 preview: str, empty: bool) -> None:
        self.entry_id = entry_id
        self.date = date
        self.time = time
        self.preview = preview
        self.empty = empty


class JournalStore:
    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir

    # ---------- 路径 ----------

    def entry_path(self, entry_id: str) -> str:
        if not ENTRY_ID_RE.match(entry_id or ""):
            raise ValueError(f"非法记录 id: {entry_id!r}")
        return os.path.join(paths.journal_root(self.data_dir), entry_id + ".md")

    # ---------- 读取 ----------

    def get_entry(self, entry_id: str) -> Optional[str]:
        """返回记录原文；不存在返回 None。空内容记录返回 ''。"""
        p = self.entry_path(entry_id)
        if not os.path.isfile(p):
            return None
        with open(p, "r", encoding="utf-8") as f:
            return f.read()

    def list_entries(self, limit: int = 50) -> List[EntrySummary]:
        """按时间倒序的记录流（文件名字典序 = 时间序）。"""
        root = paths.journal_root(self.data_dir)
        if not os.path.isdir(root):
            return []
        names = sorted((f for f in os.listdir(root) if f.endswith(".md")),
                       reverse=True)
        out: List[EntrySummary] = []
        for fname in names:
            entry_id = fname[:-3]
            if not ENTRY_ID_RE.match(entry_id):
                continue
            try:
                with open(os.path.join(root, fname), "r", encoding="utf-8") as f:
                    text = f.read()
            except OSError:
                continue
            preview = next((l.strip() for l in text.split("\n") if l.strip()), "")
            out.append(EntrySummary(
                entry_id=entry_id,
                date=entry_id[:10],
                time=entry_id[11:19],
                preview=preview[:80],
                empty=not preview,
            ))
            if len(out) >= limit:
                break
        return out

    # ---------- 写入 ----------

    def add_entry(self, content: str) -> str:
        """新增一条记录（content 可为空 → 只有时间戳的记录）。返回 entry_id。"""
        import datetime
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
            with open(p, "w", encoding="utf-8") as f:
                f.write(text)

    def delete_entry(self, entry_id: str) -> bool:
        p = self.entry_path(entry_id)
        if not os.path.isfile(p):
            return False
        with WRITE_LOCK:
            os.remove(p)
        return True
