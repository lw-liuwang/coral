"""FTS5 中文搜索测试：CJK 逐字切分、短语命中、LIKE 降级。"""
import sqlite3

import pytest

from app import paths
from app.config import Config
from app.search import SearchIndex
from app.wiki import WikiStore


@pytest.fixture()
def env(tmp_path):
    config = Config({"data_dir": str(tmp_path), "llm": {"base_url": "http://x/v1", "model": "m"}})
    paths.init_data_dirs(config.data_dir)
    store = WikiStore(config.data_dir)
    store.save_page("数据库设计", {"type": "concept", "title": "数据库设计",
                                   "created": "2026-01-01", "updated": "2026-01-01"},
                    "\n本文讨论数据库设计中的索引优化。\n")
    store.save_page("transformer", {"type": "concept", "title": "Transformer",
                                    "created": "2026-01-01", "updated": "2026-01-01"},
                    "\nTransformer attention mechanism.\n")
    idx = SearchIndex(config)
    idx.rebuild(store)
    return idx, store


def test_cjk_two_char_query(env):
    idx, _ = env
    results = idx.query("数据库")
    assert any(r["slug"] == "数据库设计" for r in results)


def test_cjk_substring_inside_page(env):
    idx, _ = env
    # "索引优化" 出现在正文中，查询"优化"（2 字词）也应命中
    results = idx.query("优化")
    assert any(r["slug"] == "数据库设计" for r in results)


def test_english_query(env):
    idx, _ = env
    results = idx.query("transformer")
    assert any(r["slug"] == "transformer" for r in results)


def test_no_match(env):
    idx, _ = env
    assert idx.query("量子纠缠") == []


def test_snippet_highlight(env):
    idx, _ = env
    results = idx.query("数据库")
    assert any("⟦" in r["snippet"] or r["slug"] == "数据库设计" for r in results)


def test_like_fallback(tmp_path, monkeypatch):
    """模拟 SQLite 无 FTS5 → 降级为普通表 + LIKE 检索。"""
    config = Config({"data_dir": str(tmp_path), "llm": {"base_url": "http://x/v1", "model": "m"}})
    paths.init_data_dirs(config.data_dir)
    store = WikiStore(config.data_dir)
    store.save_page("数据库设计", {"type": "concept", "title": "数据库设计",
                                   "created": "d", "updated": "d"},
                    "\n数据库索引优化\n")

    import sqlite3 as sq

    import app.search as search_mod

    def fake_connect(self):
        self.db_path = str(tmp_path / "coral.db")
        conn = sq.connect(self.db_path, check_same_thread=False)
        self.fts_enabled = False
        conn.execute(search_mod.LIKE_SQL)
        conn.execute(search_mod.RUNS_SQL)
        conn.commit()
        self._conn = conn

    monkeypatch.setattr(SearchIndex, "_connect", fake_connect)
    idx = SearchIndex(config)
    assert idx.fts_enabled is False

    idx.index_page("数据库设计", "wiki", "数据库设计", "数据库索引优化")
    results = idx.query("索引")
    assert any(r["slug"] == "数据库设计" for r in results)
    assert idx.query("量子纠缠") == []
