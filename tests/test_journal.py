"""随手记：一条一文件、记录流、空内容兜底、路径安全、改名（时间不丢）。"""
import os
import time

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
    # 记录时间来自 mtime：手工设定先后
    old = time.mktime(time.strptime("2026-01-01 00:00:01", "%Y-%m-%d %H:%M:%S"))
    _set_mtime(store, a, old)
    _set_mtime(store, b, old + 1)
    entries = store.list_entries()
    assert [e.entry_id for e in entries] == [b, a]
    assert entries[0].preview == "较晚"


def _set_mtime(store, entry_id, ts):
    os.utime(store.entry_path(entry_id), (ts, ts))


def test_save_entry(store):
    eid = store.add_entry("旧")
    store.save_entry(eid, "新")
    assert store.get_entry(eid) == "新"


def test_save_entry_keeps_mtime(store):
    """编辑内容不改记录时间（记录流顺序不被打乱）。"""
    eid = store.add_entry("旧")
    old = store.entry_path(eid)
    _set_mtime(store, eid, time.mktime(time.strptime("2026-01-01 08:00:00", "%Y-%m-%d %H:%M:%S")))
    store.save_entry(eid, "新")
    d, t = store.entry_datetime(eid)
    assert (d, t) == ("2026-01-01", "08-00-00")


def test_delete_entry(store):
    eid = store.add_entry("x")
    assert store.delete_entry(eid) is True
    assert store.get_entry(eid) is None
    assert store.delete_entry(eid) is False


def test_path_safety(store):
    with pytest.raises(ValueError):
        store.get_entry("../../etc/passwd")
    with pytest.raises(ValueError):
        store.get_entry("a/b")
    # 时间戳之外的安全名字现在是合法的（改名功能）
    assert store.get_entry("2026-09-12") is None  # 不存在但不报错


# ---------- 改名 ----------

def test_rename_entry(store):
    eid = store.add_entry("晚上跑了三公里")
    old_ts = os.stat(store.entry_path(eid)).st_mtime
    new_id = store.rename_entry(eid, "夜跑记录")
    assert new_id == "夜跑记录"
    assert store.get_entry("夜跑记录") == "晚上跑了三公里"
    assert store.get_entry(eid) is None
    # 时间不丢
    assert os.stat(store.entry_path(new_id)).st_mtime == old_ts
    d, t = store.entry_datetime(new_id)
    assert d == store_today_date()


def test_rename_space_to_dash_and_md_suffix(store):
    eid = store.add_entry("x")
    assert store.rename_entry(eid, "夜跑 记录.md") == "夜跑-记录"


def test_rename_invalid_name(store):
    eid = store.add_entry("x")
    with pytest.raises(ValueError):
        store.rename_entry(eid, "../etc")
    with pytest.raises(ValueError):
        store.rename_entry(eid, "")
    with pytest.raises(ValueError):
        store.rename_entry(eid, "a/b/c")


def test_rename_collision(store):
    a = store.add_entry("a")
    b = store.add_entry("b")
    with pytest.raises(ValueError):
        store.rename_entry(a, b)
    with pytest.raises(ValueError):
        store.rename_entry("不存在的记录", "新名字")


def test_rename_same_name_noop(store):
    eid = store.add_entry("x")
    assert store.rename_entry(eid, eid) == eid
    assert store.get_entry(eid) == "x"


def test_named_entry_in_stream(store):
    eid = store.add_entry("改完名还在流里")
    other = store.add_entry("更新的记录")
    ts = time.mktime(time.strptime("2026-01-01 08:00:00", "%Y-%m-%d %H:%M:%S"))
    new_id = store.rename_entry(eid, "重点记录")
    _set_mtime(store, new_id, ts)        # 原时间较旧
    _set_mtime(store, other, ts + 60)    # 另一条较新
    entries = store.list_entries()
    assert entries[0].entry_id == other  # 时间更晚的那条在前
    named = next(e for e in entries if e.entry_id == new_id)
    assert named.name == "重点记录"
    assert named.preview == "改完名还在流里"
    assert entries[0].name is None  # 时间戳命名的没有名字


def test_fts_index_and_rebuild(tmp_path):
    """随手记进 FTS；重启对账（全量重建）不清掉索引；改名后重建标题带名字。"""
    from app.search import SearchIndex
    from app.wiki import WikiStore

    config = Config({"data_dir": str(tmp_path), "llm": {"base_url": "http://x/v1", "model": "m"}})
    store = JournalStore(config.data_dir)
    eid = store.add_entry("今晚吃了一碗热汤面")
    store.rename_entry(eid, "晚餐记录")
    wiki = WikiStore(config.data_dir)

    idx = SearchIndex(config)
    idx.reconcile(wiki)
    hits = idx.query("热汤面")
    assert any(r["slug"] == "晚餐记录" and r["kind"] == "journal" for r in hits)
    assert any("晚餐记录" in r["title"] for r in hits)
    # 模拟重启：行数与磁盘一致 → 不重建，随手记录保留
    idx2 = SearchIndex(config)
    idx2.reconcile(wiki)
    assert any(r["kind"] == "journal" for r in idx2.query("热汤面"))
    idx.close()
    idx2.close()
