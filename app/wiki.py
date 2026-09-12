"""页面存取核心：list/get/save/delete/exists，type↔目录路由，全局写锁。

Markdown 文件是知识的真源；所有读写经过本模块保证一致性。
"""
import os
import threading
from typing import Any, Dict, List, Optional, Tuple

from . import frontmatter as fm_mod
from . import paths, slug as slug_mod

# 全局写锁：ingest 落盘与网页编辑保存互斥
WRITE_LOCK = threading.RLock()


class PageMeta:
    __slots__ = ("slug", "type", "title", "created", "updated", "tags", "path")

    def __init__(self, slug: str, page_type: str, title: str,
                 created: str, updated: str, tags: List[str], path: str) -> None:
        self.slug = slug
        self.type = page_type
        self.title = title
        self.created = created
        self.updated = updated
        self.tags = tags
        self.path = path


class WikiStore:
    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir

    # ---------- 查询 ----------

    def list_pages(self) -> List[PageMeta]:
        pages: List[PageMeta] = []
        for page_type, sub in paths.WIKI_DIRS.items():
            d = os.path.join(paths.wiki_root(self.data_dir), sub)
            if not os.path.isdir(d):
                continue
            for fname in sorted(os.listdir(d)):
                if not fname.endswith(".md"):
                    continue
                p = os.path.join(d, fname)
                slug = fname[:-3]
                fm, _, _ = self._read_fm(p)
                pages.append(PageMeta(
                    slug=slug,
                    page_type=page_type,
                    title=str(fm.get("title") or slug),
                    created=str(fm.get("created") or ""),
                    updated=str(fm.get("updated") or ""),
                    tags=fm_mod._as_list(fm.get("tags") or []),
                    path=p,
                ))
        return pages

    def all_slugs(self) -> List[str]:
        return [m.slug for m in self.list_pages()]

    def find_page(self, slug: str) -> Optional[str]:
        """按 slug 找到页面绝对路径（跨三个 type 目录）。"""
        if not paths.is_safe_slug(slug):
            return None
        for sub in paths.WIKI_DIRS.values():
            p = os.path.join(paths.wiki_root(self.data_dir), sub, slug + ".md")
            if os.path.isfile(p):
                return p
        return None

    def get_page(self, slug: str) -> Optional[Tuple[str, Dict[str, Any], str]]:
        """返回 (page_type, frontmatter, body)；不存在返回 None。"""
        p = self.find_page(slug)
        if p is None:
            return None
        raw = self._read_raw(p)
        fm, body, _ = fm_mod.parse(raw)
        page_type = p[len(paths.wiki_root(self.data_dir)):].lstrip(os.sep).split(os.sep)[0]
        for t, sub in paths.WIKI_DIRS.items():
            if sub == page_type:
                return t, fm, body
        return None

    def exists(self, slug: str) -> bool:
        return self.find_page(slug) is not None

    # ---------- 写入 ----------

    def save_page(self, slug: str, fm: Dict[str, Any], body: str) -> str:
        """写入页面（frontmatter 由调用方裁决完毕），返回绝对路径。"""
        if not paths.is_safe_slug(slug):
            raise ValueError(f"非法 slug: {slug!r}")
        page_type = str(fm.get("type") or "")
        if page_type not in paths.WIKI_DIRS:
            raise ValueError(f"非法页面类型: {page_type!r}")
        p = paths.page_path(self.data_dir, page_type, slug)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        text = fm_mod.serialize(fm, body)
        with WRITE_LOCK:
            with open(p, "w", encoding="utf-8") as f:
                f.write(text)
        return p

    def delete_page(self, slug: str) -> bool:
        p = self.find_page(slug)
        if p is None:
            return False
        with WRITE_LOCK:
            os.remove(p)
        return True

    def move_page(self, slug: str, new_type: str) -> bool:
        """改变页面类型：改 frontmatter 并移动到新目录。slug 不变。"""
        if new_type not in paths.WIKI_DIRS:
            raise ValueError(f"非法页面类型: {new_type!r}")
        page = self.get_page(slug)
        if page is None:
            return False
        old_type, fm, body = page
        if old_type == new_type:
            return True
        fm["type"] = new_type
        with WRITE_LOCK:
            new_path = self.save_page(slug, fm, body)
            old_file = paths.page_path(self.data_dir, old_type, slug)
            if os.path.isfile(old_file) and os.path.abspath(old_file) != os.path.abspath(new_path):
                os.remove(old_file)
        return True

    def unique_slug(self, title: str) -> str:
        return slug_mod.unique_slug(slug_mod.make_slug(title), set(self.all_slugs()))

    # ---------- 内部 ----------

    def _read_raw(self, path: str) -> str:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def _read_fm(self, path: str) -> Tuple[Dict[str, Any], str, List[str]]:
        try:
            return fm_mod.parse(self._read_raw(path))
        except OSError:
            return {}, "", ["读取失败"]
