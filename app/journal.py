"""日记：每天一个文件（journal/YYYY-MM-DD.md），追加式写入。

用户只管写（心情、今天发生的事），时间整理交给应用：
- 首次写入当天自动创建当日文件
- 每次保存追加一个 `## HH:MM` 小节
- 无 frontmatter、无类型选择，纯 Markdown
"""
import datetime
import os
import re
from typing import List, Optional, Tuple

from . import paths
from .wiki import WRITE_LOCK

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
WEEKDAYS = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")


class DaySummary:
    __slots__ = ("date", "weekday", "entries", "preview", "path")

    def __init__(self, date: str, weekday: str, entries: int,
                 preview: str, path: str) -> None:
        self.date = date
        self.weekday = weekday
        self.entries = entries
        self.preview = preview
        self.path = path


class JournalStore:
    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir

    # ---------- 路径 ----------

    def day_path(self, date: str) -> str:
        if not _DATE_RE.match(date or "") or not paths.is_valid_date(date):
            raise ValueError(f"非法日期: {date!r}")
        return os.path.join(paths.journal_root(self.data_dir), date + ".md")

    @staticmethod
    def today() -> str:
        return datetime.date.today().isoformat()

    # ---------- 读取 ----------

    def get_day(self, date: str) -> Optional[str]:
        """返回当天文件原文；不存在返回 None。"""
        p = self.day_path(date)
        if not os.path.isfile(p):
            return None
        with open(p, "r", encoding="utf-8") as f:
            return f.read()

    def list_days(self, limit: int = 30) -> List[DaySummary]:
        """按日期倒序的日记概览（条数 = ## 小节数，预览 = 首个非标题行）。"""
        root = paths.journal_root(self.data_dir)
        if not os.path.isdir(root):
            return []
        out: List[DaySummary] = []
        for fname in sorted(os.listdir(root), reverse=True):
            if not fname.endswith(".md"):
                continue
            date = fname[:-3]
            if not _DATE_RE.match(date):
                continue
            p = os.path.join(root, fname)
            try:
                with open(p, "r", encoding="utf-8") as f:
                    text = f.read()
            except OSError:
                continue
            entries = sum(1 for line in text.split("\n")
                          if line.startswith("## "))
            preview = next((l.strip() for l in text.split("\n")
                            if l.strip() and not l.startswith("#")), "")
            d = datetime.date.fromisoformat(date)
            out.append(DaySummary(date, WEEKDAYS[d.weekday()], entries,
                                  preview[:60], p))
            if len(out) >= limit:
                break
        return out

    # ---------- 写入 ----------

    def append_entry(self, content: str, date: Optional[str] = None) -> Tuple[str, int]:
        """追加一条日记（## HH:MM 小节）。返回 (日期, 当天条数)。"""
        content = (content or "").strip()
        if not content:
            raise ValueError("内容为空")
        date = date or self.today()
        p = self.day_path(date)
        now = datetime.datetime.now()
        entry = f"## {now.strftime('%H:%M')}\n\n{content}\n"
        with WRITE_LOCK:
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    existing = f.read()
                text = existing.rstrip("\n") + "\n\n" + entry
            else:
                d = datetime.date.fromisoformat(date)
                text = f"# {date} {WEEKDAYS[d.weekday()]}\n\n{entry}"
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(text)
            count = sum(1 for line in text.split("\n") if line.startswith("## "))
        return date, count

    def save_day(self, date: str, text: str) -> None:
        """整天编辑保存（原文直写）。"""
        p = self.day_path(date)
        with WRITE_LOCK:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(text)

    def delete_day(self, date: str) -> bool:
        p = self.day_path(date)
        if not os.path.isfile(p):
            return False
        with WRITE_LOCK:
            os.remove(p)
        return True
