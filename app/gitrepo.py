"""data/ 目录的 git 留痕：用户与 LLM 的每次写操作各成一个 commit。

- 作者区分：coral-user（网页上的用户操作）/ coral-llm（ingest 管线）
- git 不可用时静默降级为 no-op（功能不受影响，只是不留痕）
- coral.db / WAL 等（可重建的索引）不进版本库
"""
import os
import subprocess
import threading
from typing import Iterable, List

USER_AUTHOR = "coral-user <coral-user@coral>"
LLM_AUTHOR = "coral-llm <coral-llm@coral>"

IGNORE_RULES = "coral.db\ncoral.db-wal\ncoral.db-shm\n*.tmp\n"


class GitRepo:
    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir
        self._lock = threading.Lock()
        self._ok = True  # git 不可用 → False，之后全部 no-op

    # ---------- 基础 ----------

    def _git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=self.data_dir,
                              capture_output=True, text=True, timeout=60)

    def available(self) -> bool:
        return self._ok and self.ensure()

    def ensure(self) -> bool:
        """初始化仓库（幂等）：git init + 身份 + .gitignore + 首次基线提交。"""
        if not self._ok:
            return False
        if self._git("--version").returncode != 0:
            self._ok = False
            return False
        if not os.path.isdir(os.path.join(self.data_dir, ".git")):
            if self._git("init", "-q").returncode != 0:
                self._ok = False
                return False
            self._git("config", "user.name", "coral")
            self._git("config", "user.email", "coral@local")
            gi = os.path.join(self.data_dir, ".gitignore")
            if not os.path.exists(gi):
                with open(gi, "w", encoding="utf-8") as f:
                    f.write(IGNORE_RULES)
            # 首次：已有数据做一次基线提交（皆视为用户数据）
            if self._git("rev-parse", "--verify", "-q", "HEAD").returncode != 0:
                self._git("add", "-A", ".")
                self._git("commit", "-q", "-m", "coral 数据基线", "--author", USER_AUTHOR)
        return True

    # ---------- 提交 ----------

    def commit(self, paths: Iterable[str], author: str, message: str) -> bool:
        """提交指定路径的变更（含删除）。无可提交内容返回 False。"""
        rels: List[str] = []
        for p in paths:
            rel = p if not os.path.isabs(p) else os.path.relpath(p, self.data_dir)
            if rel and not rel.startswith("..") and rel not in rels:
                rels.append(rel)
        if not rels or not self.ensure():
            return False
        with self._lock:
            if self._git("add", "-A", "--", *rels).returncode != 0:
                return False
            r = self._git("commit", "-q", "-m", message, "--author", author)
            return r.returncode == 0

    # ---------- 查询（UI/调试用） ----------

    def log(self, limit: int = 30) -> List[dict]:
        """最近提交：[{hash, author, date, message}]。"""
        if not self.ensure():
            return []
        r = self._git("log", f"-{limit}", "--format=%h%x09%an%x09%ad%x09%s",
                      "--date=short")
        out = []
        for line in r.stdout.splitlines():
            parts = line.split("\t", 3)
            if len(parts) == 4:
                out.append({"hash": parts[0], "author": parts[1],
                            "date": parts[2], "message": parts[3]})
        return out
