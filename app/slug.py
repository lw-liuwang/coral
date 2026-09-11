"""title -> slug 规则：NFKC 归一、空格转连字符、保留 Unicode（中文保字）、截 50 字符。"""
import re
import unicodedata


def make_slug(title: str) -> str:
    s = unicodedata.normalize("NFKC", title).strip()
    s = re.sub(r"\s+", "-", s)
    s = "".join(c for c in s if c.isalnum() or c == "-")
    s = re.sub(r"-+", "-", s).strip("-").lower()
    s = s[:50]
    return s or "untitled"


def unique_slug(base_slug: str, taken) -> str:
    """slug 查重：冲突时追加 -2、-3……taken 是已被占用的 slug 集合。"""
    if base_slug not in taken:
        return base_slug
    i = 2
    while f"{base_slug}-{i}" in taken:
        i += 1
    return f"{base_slug}-{i}"
