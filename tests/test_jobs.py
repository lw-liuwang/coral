"""求职跟踪：记录增删、状态推进、复盘追加、表格排序。"""
import pytest

from app import paths
from app.config import Config
from app.jobs import JobsStore


@pytest.fixture()
def store(tmp_path):
    config = Config({"data_dir": str(tmp_path), "llm": {"base_url": "http://x/v1", "model": "m"}})
    paths.init_data_dirs(config.data_dir)
    return JobsStore(config.data_dir)


def test_add_job(store):
    slug = store.add_job("示例公司", "算法工程师", "2026-09-10", "已投", "官网投递")
    job = store.get_job(slug)
    assert job.company == "示例公司" and job.position == "算法工程师"
    assert job.status == "已投" and job.applied == "2026-09-10"
    assert "官网投递" in job.body


def test_advance_appends_timeline(store):
    slug = store.add_job("示例公司", "算法", "2026-09-10")
    job = store.advance(slug, "笔试", next_date="2026-09-15")
    assert job.status == "笔试"
    assert job.next == "2026-09-15"
    assert "已投 → 笔试" in job.body
    # 再推进一次：时间线累积
    job = store.advance(slug, "面试", note="一面，聊了 40 分钟")
    assert job.status == "面试"
    assert "笔试 → 面试" in job.body
    assert "一面，聊了 40 分钟" in job.body
    assert "已投 → 笔试" in job.body  # 旧记录还在


def test_advance_to_terminal_clears_next(store):
    slug = store.add_job("示例公司", "算法", "2026-09-10")
    store.advance(slug, "面试", next_date="2026-09-15")
    job = store.advance(slug, "挂")
    assert job.status == "挂"
    assert job.next == ""


def test_append_retro(store):
    slug = store.add_job("示例公司", "算法", "2026-09-10")
    job = store.append_retro(slug, "算法题没写完，下次先写暴力解")
    assert "## [" in job.body and "复盘" in job.body
    assert "算法题没写完" in job.body


def test_sort_next_date_first(store):
    """越接近面试时间的排在越前面；无 next 按 updated 倒序；终态沉底。"""
    store.add_job("A 公司", "", "2026-09-01")           # 活跃无 next
    store.add_job("B 公司", "", "2026-09-02")
    slug_c = store.add_job("C 公司", "", "2026-09-03")
    store.add_job("D 公司", "", "2026-09-04")
    slug_e = store.add_job("E 公司", "", "2026-09-05")
    # C 有最早的未来面试；E 结束
    store.advance(slug_c, "面试", next_date="2026-09-13")
    store.advance(slug_e, "挂")
    active, ended = store.sorted_jobs()
    assert [j.company for j in active][0] == "C 公司"
    assert [j.company for j in ended] == ["E 公司"]
    assert "A 公司" in [j.company for j in active]


def test_bad_status_rejected(store):
    slug = store.add_job("示例公司", "算法", "2026-09-10")
    with pytest.raises(ValueError):
        store.advance(slug, "玄学")


def test_path_safety(store):
    with pytest.raises(ValueError):
        store.get_job("../../etc/passwd")
