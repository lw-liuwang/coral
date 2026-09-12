"""求职跟踪：一次投递 = 一个记录（data/jobs/{slug}.md）。

frontmatter: company/position/status/applied/next(可选)
正文 = 时间线（状态变更 + 复盘，全部带日期小节，追加式沉淀）
"""
import datetime
import os
import re
from typing import Any, Dict, List, Optional, Tuple

from . import paths, slug as slug_mod
from . import frontmatter as fm_mod
from .wiki import WRITE_LOCK

# 状态主流程（推进按钮按此顺序）；挂/放弃为终态
STATUS_FLOW = ("待投", "已投", "笔试", "面试", "offer")
TERMINAL_STATUS = ("offer", "挂", "放弃")
ALL_STATUS = STATUS_FLOW[:4] + ("offer", "挂", "放弃")  # 待投/已投/笔试/面试/offer/挂/放弃

_SLUG_SAFE_RE = re.compile(r"[^0-9A-Za-z_-]+")


class JobRecord:
    __slots__ = ("slug", "company", "position", "status", "applied",
                 "next", "updated", "body", "path")

    def __init__(self, **kw) -> None:
        for k in self.__slots__:
            setattr(self, k, kw.get(k))


class JobsStore:
    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir

    # ---------- 读取 ----------

    def _path(self, slug: str) -> str:
        if not paths.is_safe_slug(slug or ""):
            raise ValueError(f"非法 slug: {slug!r}")
        return os.path.join(paths.jobs_root(self.data_dir), slug + ".md")

    def get_job(self, slug: str) -> Optional[JobRecord]:
        p = self._path(slug)
        if not os.path.isfile(p):
            return None
        with open(p, "r", encoding="utf-8") as f:
            raw = f.read()
        fm, body, _ = fm_mod.parse(raw)
        return JobRecord(
            slug=slug,
            company=str(fm.get("company") or slug),
            position=str(fm.get("position") or ""),
            status=str(fm.get("status") or "待投"),
            applied=str(fm.get("applied") or ""),
            next=str(fm.get("next") or ""),
            updated=str(fm.get("updated") or ""),
            body=body,
            path=p,
        )

    def list_jobs(self) -> List[JobRecord]:
        root = paths.jobs_root(self.data_dir)
        if not os.path.isdir(root):
            return []
        out: List[JobRecord] = []
        for fname in sorted(os.listdir(root)):
            if not fname.endswith(".md"):
                continue
            job = self.get_job(fname[:-3])
            if job is not None:
                out.append(job)
        return out

    def sorted_jobs(self) -> Tuple[List[JobRecord], List[JobRecord]]:
        """表格排序：(活跃, 已结束)。

        活跃规则（越接近面试时间的排越前面）：
        1. 有 next（下一步时间，如约好的面试）→ 按 next 升序，最快到来的在前
        2. 其余按 updated 倒序（最近有动态的在前）
        已结束（offer/挂/放弃）沉底，按 updated 倒序。
        """
        active, ended = [], []
        for j in self.list_jobs():
            (ended if j.status in TERMINAL_STATUS else active).append(j)
        active.sort(key=lambda j: (
            0 if j.next else 1,
            j.next or "9999",
        ))
        # 无 next 的部分按 updated 倒序：分两段排
        with_next = [j for j in active if j.next]
        without = sorted((j for j in active if not j.next),
                         key=lambda j: j.updated, reverse=True)
        ended.sort(key=lambda j: j.updated, reverse=True)
        return with_next + without, ended

    # ---------- 写入 ----------

    def unique_slug(self, company: str, position: str) -> str:
        base = slug_mod.make_slug(f"{company}-{position}") if position \
            else slug_mod.make_slug(company)
        existing = {os.path.splitext(f)[0] for f in os.listdir(paths.jobs_root(self.data_dir))
                    if f.endswith(".md")} if os.path.isdir(paths.jobs_root(self.data_dir)) else set()
        return slug_mod.unique_slug(base, existing)

    def add_job(self, company: str, position: str, applied: str,
                status: str = "已投", note: str = "") -> str:
        """新增一次投递，返回 slug。"""
        company = (company or "").strip()
        if not company:
            raise ValueError("公司不能为空")
        if status not in ALL_STATUS:
            status = "已投"
        if not applied or not paths.is_valid_date(applied):
            applied = datetime.date.today().isoformat()
        slug = self.unique_slug(company, position)
        today = datetime.date.today().isoformat()
        fm: Dict[str, Any] = {
            "company": company, "position": (position or "").strip(),
            "status": status, "applied": applied,
            "created": today, "updated": today,
        }
        body = f"\n# {company}" + (f" · {position}" if position else "") + "\n"
        if status != "待投":
            body += f"\n## [{applied}] 状态: {status}\n"
            if note.strip():
                body += f"\n{note.strip()}\n"
        elif note.strip():
            body += f"\n## [{applied}] 备注\n\n{note.strip()}\n"
        self._write(slug, fm, body)
        return slug

    def advance(self, slug: str, new_status: str, note: str = "",
                next_date: str = "") -> Optional[JobRecord]:
        """推进状态：改 frontmatter + 正文追加日期小节（时间线沉淀）。"""
        job = self.get_job(slug)
        if job is None:
            return None
        if new_status not in ALL_STATUS:
            raise ValueError(f"未知状态: {new_status!r}")
        today = datetime.date.today().isoformat()
        with open(job.path, "r", encoding="utf-8") as f:
            raw = f.read()
        fm, body, _ = fm_mod.parse(raw)
        old_status = str(fm.get("status") or "待投")
        fm["status"] = new_status
        fm["updated"] = today
        if next_date and paths.is_valid_date(next_date):
            fm["next"] = next_date
        else:
            fm.pop("next", None)
        section = f"\n## [{today}] 状态: {old_status} → {new_status}\n"
        if next_date and paths.is_valid_date(next_date):
            section += f"\n- 下一步: {next_date}\n"
        if note.strip():
            section += f"\n{note.strip()}\n"
        body = body.rstrip("\n") + "\n" + section
        self._write(slug, fm, body)
        return self.get_job(slug)

    def append_retro(self, slug: str, text: str) -> Optional[JobRecord]:
        """追加复盘（带日期小节）。"""
        job = self.get_job(slug)
        if job is None:
            return None
        text = (text or "").strip()
        if not text:
            raise ValueError("复盘内容为空")
        today = datetime.date.today().isoformat()
        with open(job.path, "r", encoding="utf-8") as f:
            raw = f.read()
        fm, body, _ = fm_mod.parse(raw)
        fm["updated"] = today
        body = body.rstrip("\n") + f"\n\n## [{today}] 复盘\n\n{text}\n"
        self._write(slug, fm, body)
        return self.get_job(slug)

    def delete_job(self, slug: str) -> bool:
        p = self._path(slug)
        if not os.path.isfile(p):
            return False
        with WRITE_LOCK:
            os.remove(p)
        return True

    def _write(self, slug: str, fm: Dict[str, Any], body: str) -> None:
        p = self._path(slug)
        with WRITE_LOCK:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(fm_mod.serialize(fm, body))
