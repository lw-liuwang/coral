"""data/ git 留痕：初始化、用户/LLM 作者区分、删除提交、db 不入库。"""
import os
import shutil
import subprocess

import pytest

from app import paths
from app.config import Config
from app.gitrepo import IGNORE_RULES, GitRepo, LLM_AUTHOR, USER_AUTHOR
from app.journal import JournalStore
from app.wiki import WikiStore

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git 不可用")


def _data_dir(tmp_path):
    config = Config({"data_dir": str(tmp_path), "llm": {"base_url": "http://x/v1", "model": "m"}})
    paths.init_data_dirs(config.data_dir)
    return config.data_dir


def _git(data_dir, *args):
    return subprocess.run(["git", *args], cwd=data_dir, capture_output=True, text=True)


def test_ensure_creates_repo_and_baseline(tmp_path):
    data = _data_dir(tmp_path)
    repo = GitRepo(data)
    assert repo.ensure() is True
    assert os.path.isdir(os.path.join(data, ".git"))
    with open(os.path.join(data, ".gitignore"), encoding="utf-8") as f:
        assert f.read() == IGNORE_RULES
    # 幂等
    assert repo.ensure() is True
    # 基线提交存在
    r = _git(data, "log", "--format=%an")
    assert "coral-user" in r.stdout.splitlines()


def test_commit_distinguishes_authors(tmp_path):
    data = _data_dir(tmp_path)
    repo = GitRepo(data)
    repo.ensure()
    store = WikiStore(data)
    store.save_page("概念", {"type": "concept", "title": "概念",
                             "created": "2026-01-01", "updated": "2026-01-01"}, "\n正文\n")
    assert repo.commit(["wiki/concepts/概念.md"], USER_AUTHOR, "用户：新建 概念") is True

    jstore = JournalStore(data)
    eid = jstore.add_entry("晚上跑了三公里")
    assert repo.commit([f"journal/{eid}.md"], LLM_AUTHOR, "LLM：修订随手记") is True

    authors = [e["author"] for e in repo.log()]
    assert authors[0] == "coral-llm"
    assert authors[1] == "coral-user"
    messages = [e["message"] for e in repo.log()]
    assert any("修订随手记" in m for m in messages)


def test_commit_stages_deletion(tmp_path):
    data = _data_dir(tmp_path)
    repo = GitRepo(data)
    repo.ensure()
    store = WikiStore(data)
    store.save_page("待删", {"type": "concept", "title": "待删",
                             "created": "d", "updated": "d"}, "\nx\n")
    repo.commit(["wiki/concepts/待删.md"], USER_AUTHOR, "新增")
    store.delete_page("待删")
    assert repo.commit(["wiki/concepts/待删.md"], USER_AUTHOR, "删除") is True
    # quotepath=false：非 ASCII 路径不转义成八进制
    r = _git(data, "-c", "core.quotepath=false", "show", "--stat=200", "HEAD")
    assert "待删.md" in r.stdout


def test_db_not_tracked(tmp_path):
    data = _data_dir(tmp_path)
    repo = GitRepo(data)
    repo.ensure()
    # 伪造一个 coral.db
    with open(os.path.join(data, "coral.db"), "w", encoding="utf-8") as f:
        f.write("x")
    assert repo.commit(["coral.db"], USER_AUTHOR, "不应提交") is False
    r = _git(data, "ls-files")
    assert "coral.db" not in r.stdout.splitlines()


def test_commit_no_changes_returns_false(tmp_path):
    data = _data_dir(tmp_path)
    repo = GitRepo(data)
    repo.ensure()
    store = WikiStore(data)
    store.save_page("页", {"type": "concept", "title": "页",
                           "created": "d", "updated": "d"}, "\nx\n")
    repo.commit(["wiki/concepts/页.md"], USER_AUTHOR, "第一次")
    assert repo.commit(["wiki/concepts/页.md"], USER_AUTHOR, "无变化") is False


def test_commit_normalizes_abs_path(tmp_path):
    data = _data_dir(tmp_path)
    repo = GitRepo(data)
    repo.ensure()
    jstore = JournalStore(data)
    eid = jstore.add_entry("hi")
    abs_p = jstore.entry_path(eid)
    assert repo.commit([abs_p], USER_AUTHOR, "绝对路径") is True
    r = _git(data, "show", "--name-only", "--format=", "HEAD")
    assert f"journal/{eid}.md" in r.stdout.splitlines()
