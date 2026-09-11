"""frontmatter 容错解析 / 序列化 / union/lock 字段操作。

LLM 输出一律视为不可信输入：允许 ```yaml 包裹、frontmatter: 前缀、
缺起始 ---、related: [[a]], [[b]] 等常见损坏，逐层修复。
"""
import re
from typing import Any, Dict, List, Optional, Tuple

import yaml

UNION_FIELDS = ("tags", "related", "sources")
LOCKED_FIELDS = ("type", "title", "created")

_FM_DELIM_RE = re.compile(r"^---\s*$")
_YAML_FENCE_RE = re.compile(r"^```(?:ya?ml|md)?\s*$", re.IGNORECASE)
_STRAY_PREFIX_RE = re.compile(r"^(?:frontmatter:|metadata:)\s*$", re.IGNORECASE)
_RELATED_WIKILINK_RE = re.compile(r"^(related|sources|tags):\s*(.+)$", re.IGNORECASE)


def parse(text: str) -> Tuple[Dict[str, Any], str, List[str]]:
    """解析页面文本 -> (frontmatter dict, body)。失败返回 ({}, 原文, warnings)。

    容错顺序：
    1. 严格锚定：首行 ---，找闭合 ---
    2. 剥掉杂前缀（代码围栏标记 / frontmatter: 行）后重试
    3. 补缺失的起始 ---（首行是 frontmatter 键时）
    """
    warnings: List[str] = []
    text = text.replace("\r\n", "\n").lstrip("\n")
    if not text:
        return {}, text, ["空文件"]

    fm, body = _try_strict(text)
    if fm is not None:
        return _finalize(fm, body, warnings)

    stripped, w1, had_fence = _strip_stray_prefixes(text)
    warnings.extend(w1)
    fm, body = _try_strict(stripped)
    if fm is not None:
        if had_fence:
            body = _strip_fence_markers(body)
        return _finalize(fm, body, warnings)

    patched = _patch_missing_open(stripped)
    if patched is not None:
        fm, body = _try_strict(patched)
        if fm is not None:
            warnings.append("已自动补上缺失的起始 ---")
            return _finalize(fm, body, warnings)

    return {}, text, ["无法解析 frontmatter"] + warnings


def _try_strict(text: str) -> Tuple[Optional[Dict[str, Any]], str]:
    lines = text.split("\n")
    if not lines or not _FM_DELIM_RE.match(lines[0]):
        return None, text
    for i in range(1, len(lines)):
        if _FM_DELIM_RE.match(lines[i]):
            yaml_text = "\n".join(lines[1:i])
            body = "\n".join(lines[i + 1:])
            try:
                fm = yaml.safe_load(_repair_related(yaml_text))
            except yaml.YAMLError:
                return None, text
            if not isinstance(fm, dict):
                return None, text
            return fm, body
    return None, text


def _strip_stray_prefixes(text: str) -> Tuple[str, List[str], bool]:
    """剥掉 frontmatter 前的杂前缀：代码围栏标记行 / frontmatter: 行。

    只删除标记行本身（LLM 常把整个文件或 frontmatter 包进 ```yaml 围栏），
    围栏内的 frontmatter 内容保留。返回 (处理后文本, warnings, 是否剥了围栏)。
    """
    warnings: List[str] = []
    lines = text.split("\n")
    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    had_fence = False
    if idx < len(lines) and _YAML_FENCE_RE.match(lines[idx]):
        lines.pop(idx)
        had_fence = True
        warnings.append("已剥掉包裹 frontmatter 的代码围栏")
    while idx < len(lines) and _STRAY_PREFIX_RE.match(lines[idx]):
        lines.pop(idx)
        warnings.append("已剥掉多余的 frontmatter: 前缀行")
    return "\n".join(lines), warnings, had_fence


def _strip_fence_markers(body: str) -> str:
    """剥掉围栏包裹遗留的首/尾孤立围栏标记行。"""
    lines = body.split("\n")
    last = max((i for i, l in enumerate(lines) if l.strip()), default=-1)
    if last >= 0 and _YAML_FENCE_RE.match(lines[last]):
        lines.pop(last)
    first = next((i for i, l in enumerate(lines) if l.strip()), -1)
    if first >= 0 and _YAML_FENCE_RE.match(lines[first]):
        lines.pop(first)
    return "\n".join(lines)


def _patch_missing_open(text: str) -> Optional[str]:
    """首行形如 frontmatter 键（type: xxx）时，尝试补起始 ---。"""
    lines = text.split("\n")
    if not lines:
        return None
    if not re.match(r"^(type|title|tags|related|sources|created|updated)\s*:", lines[0]):
        return None
    for i in range(1, min(len(lines), 32)):
        if _FM_DELIM_RE.match(lines[i]):
            return "---\n" + text
    return None


def _repair_related(yaml_text: str) -> str:
    """修复 related: [[a]], [[b]] 这类非法 YAML 行（键在 union 列表上时）。"""
    out = []
    for line in yaml_text.split("\n"):
        m = _RELATED_WIKILINK_RE.match(line)
        if m and "[[" in m.group(2):
            key = m.group(1).lower()
            val = m.group(2)
            items = [x.strip().strip(",") for x in val.split(",") if x.strip()]
            cleaned = []
            for item in items:
                item = re.sub(r"^\[\[\s*([^\]|]+?)\s*(?:\|[^\]]*)?\]\]$", r"\1", item)
                cleaned.append(item)
            out.append(f"{key}: [{', '.join(repr(c) for c in cleaned)}]")
        else:
            out.append(line)
    return "\n".join(out)


def _finalize(fm: Dict[str, Any], body: str, warnings: List[str]) -> Tuple[Dict[str, Any], str, List[str]]:
    # 数组字段归一：None -> []，单个字符串 -> [str]
    for key in UNION_FIELDS:
        if key in fm and fm[key] is not None and not isinstance(fm[key], list):
            fm[key] = [str(fm[key])]
    # 标量字段归一为字符串
    for key in ("type", "title", "created", "updated"):
        if key in fm and fm[key] is not None:
            fm[key] = str(fm[key])
    return fm, body, warnings


def serialize(fm: Dict[str, Any], body: str) -> str:
    """页面文本序列化：frontmatter + body。数组字段始终写成 YAML 流式列表。"""
    ordered: Dict[str, Any] = {}
    for key in ("type", "title", "created", "updated"):
        if fm.get(key) is not None:
            ordered[key] = fm[key]
    for key in UNION_FIELDS:
        val = fm.get(key)
        if val:
            ordered[key] = _as_list(val)
    for key, val in fm.items():
        if key not in ordered and val is not None:
            ordered[key] = _as_list(val) if isinstance(val, list) else val

    yaml_lines = []
    for key, val in ordered.items():
        if isinstance(val, list):
            items = ", ".join(_yaml_item(v) for v in val)
            yaml_lines.append(f"{key}: [{items}]")
        elif isinstance(val, str) and _needs_quote(val):
            yaml_lines.append(f'{key}: "{val}"')
        else:
            yaml_lines.append(f"{key}: {val}")
    yaml_text = "\n".join(yaml_lines)
    if body and not body.startswith("\n"):
        body = "\n" + body
    return f"---\n{yaml_text}\n---{body}"


def _as_list(val) -> List[str]:
    if isinstance(val, list):
        return [str(v) for v in val if str(v).strip()]
    return [str(val)]


def _yaml_item(v: str) -> str:
    v = str(v)
    return f'"{v}"' if _needs_quote(v) else v


def _needs_quote(v: str) -> bool:
    if v == "" or v != v.strip():
        return True
    return bool(re.search(r"[:#\[\]{},&*!|>'\"%@`]", v)) or v.startswith("-") or v.lower() in (
        "true", "false", "null", "yes", "no", "on", "off",
    )


def merge_union(old: Dict[str, Any], new: Dict[str, Any]) -> Dict[str, Any]:
    """union 字段（tags/related/sources）并集，保留旧顺序在前。"""
    merged = dict(new)
    for key in UNION_FIELDS:
        old_list = _as_list(old.get(key) or [])
        new_list = _as_list(new.get(key) or [])
        combined = list(old_list)
        for item in new_list:
            if item not in combined:
                combined.append(item)
        if combined:
            merged[key] = combined
        elif key in old:
            merged[key] = old_list
    return merged


def apply_locked(old: Dict[str, Any], new: Dict[str, Any]) -> Dict[str, Any]:
    """locked 字段（type/title/created）强制写回旧值。"""
    merged = dict(new)
    for key in LOCKED_FIELDS:
        if old.get(key) is not None:
            merged[key] = old[key]
    return merged


def normalize_union_items(fm: Dict[str, Any]) -> Dict[str, Any]:
    """related/sources 里的 [[x]] 形式剥成 bare slug。"""
    out = dict(fm)
    for key in ("related", "sources"):
        if key in out and out[key] is not None:
            items = _as_list(out[key])
            out[key] = [
                re.sub(r"^\[\[\s*([^\]|]+?)\s*(?:\|[^\]]*)?\]\]$", r"\1", item)
                for item in items
            ]
    return out
