"""frontmatter 容错解析测试。"""
from app.frontmatter import (
    apply_locked, merge_union, normalize_union_items, parse, serialize,
)


def test_strict_parse():
    text = "---\ntype: entity\ntitle: 张三\ntags: [a, b]\n---\n\n# 正文\n"
    fm, body, warns = parse(text)
    assert fm["type"] == "entity"
    assert fm["title"] == "张三"
    assert fm["tags"] == ["a", "b"]
    assert body.strip() == "# 正文"
    assert not warns


def test_yaml_fence_wrapped():
    text = "```yaml\n---\ntype: entity\ntitle: 张三\n---\n\n正文\n```"
    fm, body, _ = parse(text)
    assert fm["type"] == "entity"
    assert "正文" in body


def test_stray_frontmatter_prefix():
    text = "frontmatter:\n---\ntype: concept\ntitle: x\n---\n\nbody"
    fm, _, _ = parse(text)
    assert fm["type"] == "concept"


def test_missing_open_delimiter():
    text = "type: concept\ntitle: x\n---\n\nbody"
    fm, body, warns = parse(text)
    assert fm["type"] == "concept"
    assert any("补上" in w for w in warns)


def test_related_wikilink_repair():
    text = "---\ntype: entity\ntitle: x\nrelated: [[a]], [[b|别名]]\n---\nbody"
    fm, _, _ = parse(text)
    assert fm["related"] == ["a", "b"]


def test_garbage_returns_empty():
    fm, body, _ = parse("完全没有 frontmatter 的文本")
    assert fm == {}
    assert "完全没有" in body


def test_union_merge():
    old = {"tags": ["a", "b"], "related": ["x"], "sources": ["s1.md"]}
    new = {"tags": ["b", "c"], "related": ["y"], "sources": ["s1.md", "s2.md"]}
    merged = merge_union(old, new)
    assert merged["tags"] == ["a", "b", "c"]
    assert merged["related"] == ["x", "y"]
    assert merged["sources"] == ["s1.md", "s2.md"]


def test_locked_apply():
    old = {"type": "entity", "title": "旧名", "created": "2020-01-01"}
    new = {"type": "concept", "title": "新名"}
    merged = apply_locked(old, new)
    assert merged["type"] == "entity"
    assert merged["title"] == "旧名"
    assert merged["created"] == "2020-01-01"


def test_roundtrip_serialize():
    fm = {"type": "entity", "title": "张三", "created": "2026-01-01",
          "updated": "2026-01-01", "tags": ["a"], "sources": ["x.md"]}
    text = serialize(fm, "\n# 张三\n")
    fm2, body, _ = parse(text)
    assert fm2["type"] == "entity"
    assert fm2["title"] == "张三"
    assert fm2["tags"] == ["a"]
    assert fm2["sources"] == ["x.md"]
    assert body.strip() == "# 张三"


def test_normalize_union_items_strips_wikilinks():
    fm = {"related": ["[[a]]", "b"], "sources": ["[[c]]"]}
    out = normalize_union_items(fm)
    assert out["related"] == ["a", "b"]
    assert out["sources"] == ["c"]
