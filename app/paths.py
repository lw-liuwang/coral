"""数据目录初始化与路径解析。所有文件操作都经过这里的安全检查。"""
import os
from typing import List

WIKI_DIRS = {"entity": "entities", "concept": "concepts", "source": "sources",
             "note": "notes"}
PAGE_TYPES = ("entity", "concept", "source", "note")
# LLM ingest 只允许提议这三种；note 纯人工创建（随手记，不想分类时用）
INGEST_TYPES = ("entity", "concept", "source")


def init_data_dirs(data_dir: str) -> None:
    """启动时创建目录骨架（幂等）。"""
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(os.path.join(data_dir, "sources"), exist_ok=True)
    wiki = os.path.join(data_dir, "wiki")
    os.makedirs(wiki, exist_ok=True)
    for sub in WIKI_DIRS.values():
        os.makedirs(os.path.join(wiki, sub), exist_ok=True)


def wiki_root(data_dir: str) -> str:
    return os.path.join(data_dir, "wiki")


def sources_root(data_dir: str) -> str:
    return os.path.join(data_dir, "sources")


def page_path(data_dir: str, page_type: str, slug: str) -> str:
    """页面路径（不检查存在性）。page_type 必须合法。"""
    if page_type not in WIKI_DIRS:
        raise ValueError(f"未知页面类型: {page_type}")
    return os.path.join(wiki_root(data_dir), WIKI_DIRS[page_type], slug + ".md")


def is_safe_slug(slug: str) -> bool:
    """URL/文件名 slug 白名单：Unicode 字母数字、-、_（与 make_slug 产出一致）。"""
    if not slug or len(slug) > 200:
        return False
    return all(c.isalnum() or c in "-_" for c in slug)


def is_safe_ingest_path(path: str) -> bool:
    """LLM 输出的 FILE 块路径闸门：必须 wiki/ 下、无 .. 段、非绝对路径、无控制字符。"""
    if not path:
        return False
    if any(ord(c) < 32 for c in path):
        return False
    p = path.replace("\\", "/").strip("/")
    if not p.startswith("wiki/"):
        return False
    parts = p.split("/")
    for part in parts:
        if part in ("", ".", ".."):
            return False
    return True


def normalize_ingest_path(path: str) -> str:
    """规范化 FILE 块路径（已通过 is_safe_ingest_path 检查后调用）。"""
    p = path.replace("\\", "/").strip()
    while p.startswith("./"):
        p = p[2:]
    return p


def find_source_file(data_dir: str, name: str) -> str:
    """sources/ 下的安全文件路径（basename 化，防穿越）。"""
    base = os.path.basename(name).strip()
    return os.path.join(sources_root(data_dir), base)


def list_source_files(data_dir: str) -> List[str]:
    root = sources_root(data_dir)
    if not os.path.isdir(root):
        return []
    return sorted(
        f for f in os.listdir(root)
        if os.path.isfile(os.path.join(root, f)) and not f.startswith(".")
    )


def allowed_source_name(name: str) -> bool:
    """上传文件名白名单：扩展名 .md/.markdown/.txt，无危险字符。"""
    base = os.path.basename(name).strip()
    if not base or base.startswith("."):
        return False
    if any(ord(c) < 32 for c in base):
        return False
    ext = os.path.splitext(base)[1].lower()
    return ext in (".md", ".markdown", ".txt")
