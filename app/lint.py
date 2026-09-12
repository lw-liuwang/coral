"""结构性 Lint（纯算法，不用 LLM）：断链检测 + 孤儿页发现。"""
from typing import Dict, List, Set, Tuple

from .render import extract_wikilinks
from .wiki import WikiStore


def run_lint(store: WikiStore) -> Dict[str, List]:
    """返回 {"broken": [(页面slug, 目标)], "orphans": [PageMeta], "no_outlinks": [slug]}。"""
    pages = store.list_pages()
    existing: Set[str] = set(p.slug for p in pages)

    inbound: Dict[str, List[str]] = {}
    outbound: Dict[str, List[str]] = {}
    broken: List[Tuple[str, str]] = []

    for m in pages:
        page = store.get_page(m.slug)
        if page is None:
            continue
        _, _, body = page
        links = list(extract_wikilinks(body))
        outbound[m.slug] = links
        for target in links:
            if target in existing:
                inbound.setdefault(target, []).append(m.slug)
            else:
                broken.append((m.slug, target))

    orphans = [p for p in pages if p.type != "note" and not inbound.get(p.slug)]
    no_outlinks = [m.slug for m in pages if m.type != "note" and not outbound.get(m.slug)]
    return {"broken": broken, "orphans": orphans, "no_outlinks": no_outlinks}
