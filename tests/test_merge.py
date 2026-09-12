"""合并落盘策略测试：新页 / body 相同 / 单源替换 / 多源追加 / locked 字段。"""
import datetime

import pytest

from app import paths
from app.config import Config
from app.frontmatter import parse
from app.ingest import IngestManager
from app.wiki import WikiStore
from app.fileblocks import FileBlock


@pytest.fixture()
def env(tmp_path):
    config = Config({"data_dir": str(tmp_path), "llm": {"base_url": "http://x/v1", "model": "m", "api_key": ""}})
    paths.init_data_dirs(config.data_dir)
    store = WikiStore(config.data_dir)
    mgr = IngestManager(config, store, llm=_FakeLLM())
    return mgr, store


class _FakeLLM:
    def chat(self, *a, **k):
        return ""


def block(path, fm, body):
    content = "---\n" + "\n".join(f"{k}: {v}" for k, v in fm.items()) + "\n---\n" + body
    return FileBlock(path=path, content=content)


def test_new_page(env):
    mgr, store = env
    slug, _, action, _ = mgr._apply_block(
        block("wiki/entities/张三.md", {"type": "entity", "title": "张三"}, "# 张三\n"),
        "笔记A.md", journal_run=False)
    assert (slug, action) == ("张三", "create")
    page = store.get_page("张三")
    assert page is not None
    _, fm, body = page
    assert fm["title"] == "张三"
    assert fm["sources"] == ["笔记A.md"]  # 缺省自动补
    assert "created" in fm and "updated" in fm


def test_body_identical_only_union(env):
    mgr, store = env
    b = block("wiki/entities/张三.md", {"type": "entity", "title": "张三"}, "# 张三\n")
    mgr._apply_block(b, "笔记A.md", journal_run=False)
    # 第二次：body 相同，tags 增加新值
    b2 = block("wiki/entities/张三.md",
               {"type": "entity", "title": "张三改名", "tags": "[新标签]"}, "# 张三\n")
    slug, _, action, _ = mgr._apply_block(b2, "笔记B.md", journal_run=False)
    _, fm, body = store.get_page("张三")
    assert action == "update"
    assert body.strip() == "# 张三"          # body 未动
    assert fm["title"] == "张三"             # locked
    assert fm["sources"] == ["笔记A.md", "笔记B.md"]  # union


def test_single_source_replace(env):
    mgr, store = env
    mgr._apply_block(
        block("wiki/entities/张三.md", {"type": "entity", "title": "张三"}, "# 旧内容\n"),
        "笔记A.md", journal_run=False)
    # 同一来源重新 ingest → 替换 body
    mgr._apply_block(
        block("wiki/entities/张三.md", {"type": "entity", "title": "张三"}, "# 新内容\n"),
        "笔记A.md", journal_run=False)
    _, fm, body = store.get_page("张三")
    assert "新内容" in body
    assert "旧内容" not in body
    assert fm["sources"] == ["笔记A.md"]


def test_multi_source_append(env):
    mgr, store = env
    mgr._apply_block(
        block("wiki/entities/张三.md", {"type": "entity", "title": "张三"}, "# 旧内容\n"),
        "笔记A.md", journal_run=False)
    slug, _, action, warn = mgr._apply_block(
        block("wiki/entities/张三.md", {"type": "entity", "title": "张三"}, "# 补充内容\n"),
        "笔记B.md", journal_run=False)
    _, fm, body = store.get_page("张三")
    assert "旧内容" in body and "补充内容" in body  # 双方保留
    assert "来自《笔记B.md》的补充" in body
    assert warn and "补充" in warn
    assert fm["sources"] == ["笔记A.md", "笔记B.md"]


def test_type_dir_mismatch_dir_wins(env):
    mgr, store = env
    # frontmatter 说 concept，但路径在 entities/ → 目录为准
    slug, _, action, warn = mgr._apply_block(
        block("wiki/entities/李四.md", {"type": "concept", "title": "李四"}, "# 李四\n"),
        "s.md", journal_run=False)
    _, fm, _ = store.get_page("李四")
    assert fm["type"] == "entity"


def test_bad_frontmatter_rejected(env):
    mgr, store = env
    bad = FileBlock(path="wiki/entities/坏.md", content="没有 frontmatter 的内容\n")
    slug, _, action, warn = mgr._apply_block(bad, "s.md", journal_run=False)
    assert slug is None and action is None
    assert warn and "frontmatter" in warn


def test_unknown_dir_rejected(env):
    mgr, store = env
    slug, _, action, warn = mgr._apply_block(
        FileBlock(path="wiki/queries/问题.md", content="---\ntype: entity\n---\nbody\n"),
        "s.md", journal_run=False)
    assert slug is None
    assert warn and "目录" in warn
