"""日记：每日一文件、追加小节、时间线、路径安全。"""
import pytest

from app import paths
from app.config import Config
from app.journal import JournalStore


@pytest.fixture()
def store(tmp_path):
    config = Config({"data_dir": str(tmp_path), "llm": {"base_url": "http://x/v1", "model": "m"}})
    paths.init_data_dirs(config.data_dir)
    return JournalStore(config.data_dir)


def test_append_creates_day_file(store):
    date, count = store.append_entry("今天心情不错", date="2026-09-12")
    assert date == "2026-09-12" and count == 1
    text = store.get_day("2026-09-12")
    assert text.startswith("# 2026-09-12")
    assert "## " in text and "今天心情不错" in text


def test_append_twice_same_day(store):
    store.append_entry("第一条", date="2026-09-12")
    date, count = store.append_entry("第二条", date="2026-09-12")
    assert date == "2026-09-12"
    assert count == 2
    text = store.get_day("2026-09-12")
    assert "第一条" in text and "第二条" in text
    assert text.count("# 2026-09-12") == 1  # 文件头只有一个


def test_list_days_desc(store):
    for d in ("2026-09-10", "2026-09-12", "2026-09-11"):
        store.append_entry(f"写于 {d}", date=d)
    days = store.list_days()
    assert [x.date for x in days] == ["2026-09-12", "2026-09-11", "2026-09-10"]
    assert days[0].entries == 1
    assert days[0].weekday == "周六"  # 2026-09-12 是周六


def test_empty_content_rejected(store):
    with pytest.raises(ValueError):
        store.append_entry("   ")


def test_bad_date_rejected(store):
    with pytest.raises(ValueError):
        store.append_entry("x", date="2026-13-45")
    with pytest.raises(ValueError):
        store.get_day("../../etc/passwd")


def test_save_day_overwrites(store):
    store.append_entry("旧", date="2026-09-12")
    store.save_day("2026-09-12", "# 2026-09-12 周六\n\n## 10:00\n\n新\n")
    assert "旧" not in store.get_day("2026-09-12")
    assert "新" in store.get_day("2026-09-12")


def test_fts_index_and_rebuild(tmp_path):
    """日记进 FTS；重启对账（全量重建）不会清掉日记索引。"""
    from app.search import SearchIndex
    from app.wiki import WikiStore

    config = Config({"data_dir": str(tmp_path), "llm": {"base_url": "http://x/v1", "model": "m"}})
    store = JournalStore(config.data_dir)
    store.append_entry("今晚吃了一碗热汤面", date="2026-09-12")
    wiki = WikiStore(config.data_dir)

    idx = SearchIndex(config)
    idx.reconcile(wiki)
    assert any(r["slug"] == "2026-09-12" and r["kind"] == "journal"
               for r in idx.query("热汤面"))
    # 模拟重启：行数与磁盘一致 → 不重建，journal 行保留
    idx2 = SearchIndex(config)
    idx2.reconcile(wiki)
    assert any(r["kind"] == "journal" for r in idx2.query("热汤面"))
    idx.close()
    idx2.close()
