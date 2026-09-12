"""note（随手记）类型：创建、retype 移动、lint 跳过。"""
import os

from app import paths
from app.config import Config
from app.lint import run_lint
from app.wiki import WikiStore


def _store(tmp_path):
    config = Config({"data_dir": str(tmp_path), "llm": {"base_url": "http://x/v1", "model": "m"}})
    paths.init_data_dirs(config.data_dir)
    return WikiStore(config.data_dir)


def test_note_dir_created(tmp_path):
    _store(tmp_path)
    assert os.path.isdir(os.path.join(str(tmp_path), "wiki", "notes"))


def test_save_and_find_note(tmp_path):
    store = _store(tmp_path)
    store.save_page("随手记一", {"type": "note", "title": "随手记一",
                                 "created": "2026-01-01", "updated": "2026-01-01"}, "\n写点什么\n")
    page = store.get_page("随手记一")
    assert page is not None
    assert page[0] == "note"
    # find_page 跨目录（含 notes/）能找到
    assert store.find_page("随手记一").endswith(os.path.join("wiki", "notes", "随手记一.md"))


def test_move_page_note_to_concept(tmp_path):
    store = _store(tmp_path)
    store.save_page("想法", {"type": "note", "title": "想法",
                             "created": "2026-01-01", "updated": "2026-01-01"}, "\n一个想法\n")
    assert store.move_page("想法", "concept") is True
    # 新目录有、旧目录没有
    assert os.path.isfile(os.path.join(str(tmp_path), "wiki", "concepts", "想法.md"))
    assert not os.path.isfile(os.path.join(str(tmp_path), "wiki", "notes", "想法.md"))
    t, fm, body = store.get_page("想法")
    assert t == "concept" and fm["type"] == "concept"
    assert body.strip() == "一个想法"


def test_move_page_same_type_noop(tmp_path):
    store = _store(tmp_path)
    store.save_page("想法", {"type": "note", "title": "想法",
                             "created": "d", "updated": "d"}, "\nx\n")
    assert store.move_page("想法", "note") is True
    assert os.path.isfile(os.path.join(str(tmp_path), "wiki", "notes", "想法.md"))


def test_lint_skips_notes(tmp_path):
    store = _store(tmp_path)
    store.save_page("孤note", {"type": "note", "title": "孤note",
                               "created": "d", "updated": "d"}, "\n没有链接的随手记\n")
    store.save_page("孤concept", {"type": "concept", "title": "孤concept",
                                  "created": "d", "updated": "d"}, "\n没有链接的概念\n")
    result = run_lint(store)
    orphan_slugs = [p.slug for p in result["orphans"]]
    assert "孤note" not in orphan_slugs
    assert "孤concept" in orphan_slugs
    assert "孤note" not in result["no_outlinks"]
    assert "孤concept" in result["no_outlinks"]


def test_ingest_rejects_notes_dir(tmp_path):
    """LLM 提议 wiki/notes/ 路径 → 拒绝（note 只属于人工）。"""
    from app import fileblocks
    from app.ingest import IngestManager

    text = ("---FILE: wiki/notes/越权.md---\n"
            "---\ntype: note\ntitle: 越权\n---\n\n内容\n"
            "\n---END FILE---\n")
    blocks, _ = fileblocks.parse_file_blocks(text)
    assert len(blocks) == 1

    mgr = IngestManager.__new__(IngestManager)  # 不走 __init__（不建线程/LLM）
    slug, action, warning = mgr._apply_block(blocks[0], "src.md")
    assert slug is None and action is None
    assert "不对 LLM 开放" in warning
