"""服务端 Markdown 渲染：wikilink 转换 + markdown 库 + Pygments 高亮。

[[slug]] 和 [[slug|别名]] 转为站内链接；断链加 broken 样式（服务端判断）。
跳过代码块内的 wikilink。![[图片嵌入]] v1 原样保留。
"""
import re
from typing import Iterable, Optional, Set
from urllib.parse import quote

import markdown as md_lib

WIKILINK_RE = re.compile(r"(?<!!)\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]")

_MD = md_lib.Markdown(
    extensions=["fenced_code", "tables", "codehilite"],
    extension_configs={"codehilite": {"css_class": "highlight", "guess_lang": False}},
)


def transform_wikilinks(body: str, existing_slugs: Optional[Set[str]] = None) -> str:
    """把 body 中的 wikilink 转成 markdown 链接/HTML（跳过代码块）。"""
    if "[[" not in body:
        return body
    parts = re.split(r"(```[\s\S]*?```|~~~[\s\S]*?~~~)", body)
    out = []
    for i, part in enumerate(parts):
        if i % 2 == 1:  # 代码块内
            out.append(part)
        else:
            out.append(_replace_outside_code(part, existing_slugs))
    return "".join(out)


def _replace_outside_code(text: str, existing_slugs: Optional[Set[str]]) -> str:
    def repl(m: "re.Match") -> str:
        target = m.group(1).strip()
        alias = (m.group(2) or "").strip()
        label = alias or target
        # related 约定里可能出现 [[wiki/xxx.md]] 形式，归一成 slug
        slug = target
        if slug.startswith("wiki/"):
            slug = slug[len("wiki/"):]
        slug = re.sub(r"\.md$", "", slug).split("/")[-1]
        escaped = label.replace("[", "\\[").replace("]", "\\]")
        exists = existing_slugs is None or slug in existing_slugs
        if exists:
            return f"[{escaped}](/pages/{quote(slug)})"
        return (f'<a href="/pages/new?title={quote(slug)}" class="broken" '
                f'title="页面不存在，点击新建">{escaped}</a>')

    # 先按行内代码切分，避免把反引号里的示例改掉
    segs = re.split(r"(`[^`\n]+`)", text)
    result = []
    for i, seg in enumerate(segs):
        result.append(seg if i % 2 == 1 else WIKILINK_RE.sub(repl, seg))
    return "".join(result)


def extract_wikilinks(body: str) -> Iterable[str]:
    """提取 body 中的全部 wikilink 目标 slug（lint 用，含代码块内）。"""
    seen = []
    for m in WIKILINK_RE.finditer(body):
        target = m.group(1).strip()
        if target.startswith("wiki/"):
            target = target[len("wiki/"):]
        target = re.sub(r"\.md$", "", target).split("/")[-1]
        if target not in seen:
            seen.append(target)
    return seen


def render_markdown(body: str, existing_slugs: Optional[Set[str]] = None) -> str:
    """body（不含 frontmatter）-> HTML。"""
    text = transform_wikilinks(body, existing_slugs)
    _MD.reset()
    return _MD.convert(text)
