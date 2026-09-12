"""随手记：一条一文件（时间戳命名）、记录流、空内容兜底、路径安全。"""
import pytest

from app import paths
from app.config import Config
from app.journal import JournalStore


@pytest.fixture()
def store(tmp_path):
    config = Config({"data_dir": str(tmp_path), "llm": {"base_url": "http://x/v1", "model": "m"}})
    paths.init_data_dirs(config.data_dir)
    return JournalStore(config.data_dir)


def test_add_entry(store):
    eid = store.add_entry("今天心情不错")
    assert store.get_entry(eid) == "今天心情不错"
    assert eid[:10] == store_today_date()  # 日期是今天
    assert len(eid[11:19]) == 8  # HH-MM-SS


def store_today_date():
    import datetime
    return datetime.date.today().isoformat()


def test_two_entries_two_files(store):
    e1 = store.add_entry("第一条")
    e2 = store.add_entry("第二条")
    assert e1 != e2
    assert store.get_entry(e1) == "第一条"
    assert store.get_entry(e2) == "第二条"


def test_same_second_collision(store):
    e1 = store.add_entry("a")
    # 手动把第二条的文件名撞到同一秒：直接写一个同名文件再 add
    import os
    p = store.entry_path(e1)
    os.remove(p)
    with open(p, "w", encoding="utf-8") as f:
        f.write("a")
    e2 = store.add_entry("b")  # 同秒 → 追加 -1
    assert e2 != e1
    assert store.get_entry(e2) == "b"


def test_empty_entry_allowed(store):
    """空内容也落一条只有时间戳的记录。"""
    eid = store.add_entry("   ")
    assert store.get_entry(eid) == ""
    entries = store.list_entries()
    assert entries[0].empty is True
    assert entries[0].entry_id == eid


def test_list_entries_desc(store):
    a = store.add_entry("较早")
    b = store.add_entry("较晚")
    # 文件名字典序 = 时间序；手工把 a 改到更早的时间
    import os
    os.rename(store.entry_path(a), store.entry_path("2026-01-01_00-00-01"))
    os.rename(store.entry_path(b), store.entry_path("2026-01-01_00-00-02"))
    entries = store.list_entries()
    assert [e.entry_id for e in entries] == ["2026-01-01_00-00-02", "2026-01-01_00-00-01"]
    assert entries[0].preview == "较晚"


def test_save_entry(store):
    eid = store.add_entry("旧")
    store.save_entry(eid, "新")
    assert store.get_entry(eid) == "新"


def test_delete_entry(store):
    eid = store.add_entry("x")
    assert store.delete_entry(eid) is True
    assert store.get_entry(eid) is None
    assert store.delete_entry(eid) is False


def test_path_safety(store):
    with pytest.raises(ValueError):
        store.get_entry("../../etc/passwd")
    with pytest.raises(ValueError):
        store.get_entry("2026-09-12")  # 不带时间戳也不行


def test_fts_index_and_rebuild(tmp_path):
    """随手记进 FTS；重启对账（全量重建）不清掉索引。"""
    from app.search import SearchIndex
    from app.wiki import WikiStore

    config = Config({"data_dir": str(tmp_path), "llm": {"base_url": "http://x/v1", "model": "m"}})
    store = JournalStore(config.data_dir)
    eid = store.add_entry("今晚吃了一碗热汤面")
    wiki = WikiStore(config.data_dir)

    idx = SearchIndex(config)
    idx.reconcile(wiki)
    assert any(r["slug"] == eid and r["kind"] == "journal"
               for r in idx.query("热汤面"))
    # 模拟重启：行数与磁盘一致 → 不重建，随手记录保留
    idx2 = SearchIndex(config)
    idx2.reconcile(wiki)
    assert any(r["kind"] == "journal" for r in idx2.query("热汤面"))
    idx.close()
    idx2.close()
