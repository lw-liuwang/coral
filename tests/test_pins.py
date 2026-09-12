"""知识库置顶：持久化、切换、坏文件容错。"""
import json
import os

from app.config import Config
from app.paths import init_data_dirs
from app.pins import PinStore


def _store(tmp_path):
    config = Config({"data_dir": str(tmp_path), "llm": {"base_url": "http://x/v1", "model": "m"}})
    init_data_dirs(config.data_dir)
    return PinStore(config.data_dir)


def test_default_empty(tmp_path):
    assert _store(tmp_path).pinned() == []


def test_toggle_and_persist(tmp_path):
    store = _store(tmp_path)
    assert store.toggle("jobs") is True
    assert store.pinned() == ["jobs"]
    assert store.is_pinned("jobs")
    assert store.toggle("jobs") is False
    assert store.pinned() == []


def test_toggle_keeps_order_and_multi(tmp_path):
    store = _store(tmp_path)
    store.toggle("jobs")
    store.toggle("reading")
    assert store.pinned() == ["jobs", "reading"]
    store.toggle("jobs")
    assert store.pinned() == ["reading"]


def test_corrupt_file_tolerated(tmp_path):
    store = _store(tmp_path)
    with open(store.path, "w", encoding="utf-8") as f:
        f.write("not json{")
    assert store.pinned() == []
    assert store.toggle("jobs") is True  # 坏文件不挡住写入
    assert store.pinned() == ["jobs"]


def test_non_list_json_tolerated(tmp_path):
    store = _store(tmp_path)
    with open(store.path, "w", encoding="utf-8") as f:
        json.dump({"jobs": True}, f)
    assert store.pinned() == []
