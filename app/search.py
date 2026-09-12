"""SQLite FTS5 全文检索：CJK 逐字切分 + 短语匹配 = 中文子串搜索（零额外依赖）。

- 索引时：文本中每个 CJK 字符用空格隔开（ASCII 词保持原样，小写化）
- 查询时：对 query 做同样变换，FTS5 短语 "字 字 字"（相邻 token = 原文子串）
- 启动对账：FTS 行数与磁盘不一致 → 全量重建（吸收用户在磁盘上手改的文件）
- 降级：SQLite 无 FTS5 时退化为 LIKE 全表扫
"""
import os
import re
import sqlite3
import threading
from typing import Dict, List, Optional, Tuple

from .config import Config
from . import paths
from .wiki import WikiStore

CJK_RE = re.compile(r"[\u3000-\u9fff\uff00-\uffef]")
CJK_SPACE_RE = re.compile(r"(?<=[\u3000-\u9fff\uff00-\uffef]) (?=[\u3000-\u9fff\uff00-\uffef])")

FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    slug UNINDEXED, kind UNINDEXED, title, body, tokenize='unicode61'
);
"""
LIKE_SQL = """
CREATE TABLE IF NOT EXISTS pages_fts (slug TEXT, kind TEXT, title TEXT, body TEXT);
"""
RUNS_SQL = """
CREATE TABLE IF NOT EXISTS ingest_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    state TEXT NOT NULL,
    started TEXT NOT NULL,
    finished TEXT,
    summary TEXT
);
"""


class SearchIndex:
    def __init__(self, config: Config) -> None:
        self.db_path = os.path.join(config.data_dir, "coral.db")
        self._lock = threading.Lock()
        self._conn: Optional[sqlite3.Connection] = None
        self.fts_enabled = True
        self._connect()

    def _connect(self) -> None:
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        self.fts_enabled = True
        try:
            conn.execute(FTS_SQL)
        except sqlite3.OperationalError:
            # 降级：SQLite 无 FTS5 → 普通表 + LIKE 检索
            self.fts_enabled = False
            conn.execute(LIKE_SQL)
        conn.execute(RUNS_SQL)
        conn.commit()
        self._conn = conn

    # ---------- 索引维护 ----------

    def index_page(self, slug: str, kind: str, title: str, body: str) -> None:
        """kind: 'wiki' 或 'source'。幂等：先删旧行再插入。
        FTS 模式存 CJK 切分文本；LIKE 降级模式存原文。"""
        with self._lock:
            assert self._conn is not None
            self._remove(self._conn, slug, kind)
            if self.fts_enabled:
                self._conn.execute(
                    "INSERT INTO pages_fts (slug, kind, title, body) VALUES (?, ?, ?, ?)",
                    (slug, kind, self._cjk_split(title), self._cjk_split(body)))
            else:
                self._conn.execute(
                    "INSERT INTO pages_fts (slug, kind, title, body) VALUES (?, ?, ?, ?)",
                    (slug, kind, title, body))
            self._conn.commit()

    def remove_page(self, slug: str, kind: Optional[str] = None) -> None:
        with self._lock:
            assert self._conn is not None
            self._remove(self._conn, slug, kind)
            self._conn.commit()

    def _remove(self, conn: sqlite3.Connection, slug: str, kind: Optional[str]) -> None:
        if kind:
            conn.execute("DELETE FROM pages_fts WHERE slug = ? AND kind = ?", (slug, kind))
        else:
            conn.execute("DELETE FROM pages_fts WHERE slug = ?", (slug,))

    def reconcile(self, store: WikiStore) -> None:
        """启动对账：行数不一致 → 全量重建（吸收用户在磁盘上手改的文件）。"""
        with self._lock:
            assert self._conn is not None
            row = self._conn.execute("SELECT COUNT(*) FROM pages_fts").fetchone()
            disk_count = len(store.list_pages()) + len(paths.list_source_files(store.data_dir))
            disk_count += self._count_dir(paths.journal_root(store.data_dir))
            disk_count += self._count_dir(paths.jobs_root(store.data_dir))
            if row and row[0] == disk_count:
                return
            self._rebuild_locked(store)

    @staticmethod
    def _count_dir(root: str) -> int:
        if not os.path.isdir(root):
            return 0
        return sum(1 for f in os.listdir(root) if f.endswith(".md"))

    def rebuild(self, store: WikiStore) -> None:
        with self._lock:
            assert self._conn is not None
            self._rebuild_locked(store)

    def _rebuild_locked(self, store: WikiStore) -> None:
        self._conn.execute("DELETE FROM pages_fts")
        for m in store.list_pages():
            page = store.get_page(m.slug)
            if page is None:
                continue
            _, fm, body = page
            self._insert_row(m.slug, "wiki", m.title, body)
        for name in paths.list_source_files(store.data_dir):
            path = paths.find_source_file(store.data_dir, name)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    content = f.read()
            except OSError:
                continue
            self._insert_row(name, "source", name, content)
        # 随手记
        from .journal import JournalStore
        journal = JournalStore(store.data_dir)
        for day in journal.list_days(limit=100000):
            text = journal.get_day(day.date)
            if text is not None:
                self._insert_row(day.date, "journal", f"随手记 {day.date}", text)
        # 求职记录
        from .jobs import JobsStore
        for job in JobsStore(store.data_dir).list_jobs():
            title = job.company + (f" · {job.position}" if job.position else "")
            self._insert_row(job.slug, "job", title,
                             f"{job.company} {job.position} {job.status}\n{job.body}")
        self._conn.commit()

    def _insert_row(self, slug: str, kind: str, title: str, body: str) -> None:
        if self.fts_enabled:
            self._conn.execute(
                "INSERT INTO pages_fts (slug, kind, title, body) VALUES (?, ?, ?, ?)",
                (slug, kind, self._cjk_split(title), self._cjk_split(body)))
        else:
            self._conn.execute(
                "INSERT INTO pages_fts (slug, kind, title, body) VALUES (?, ?, ?, ?)",
                (slug, kind, title, body))

    # ---------- 检索 ----------

    def query(self, q: str, limit: int = 50) -> List[Dict]:
        q = q.strip()
        if not q:
            return []
        if self.fts_enabled:
            return self._query_fts(q, limit)
        return self._query_like(q, limit)

    def _query_fts(self, q: str, limit: int) -> List[Dict]:
        assert self._conn is not None
        phrase = self._cjk_split(q).strip()
        if not phrase:
            return []
        match = '"' + phrase.replace('"', '""') + '"'
        try:
            rows = self._conn.execute(
                "SELECT slug, kind, title, highlight(pages_fts, 3, '⟦', '⟧') "
                "FROM pages_fts WHERE pages_fts MATCH ? "
                "ORDER BY bm25(pages_fts) LIMIT ?",
                (match, limit)).fetchall()
        except sqlite3.OperationalError:
            return []
        return [
            {"slug": r[0], "kind": r[1], "title": self._unsplit(r[2]),
             "snippet": self._unsplit(r[3])}
            for r in rows
        ]

    def _query_like(self, q: str, limit: int) -> List[Dict]:
        """LIKE 降级检索（FTS 不可用时的全文匹配，原文存储）。"""
        assert self._conn is not None
        rows = self._conn.execute(
            "SELECT slug, kind, title, body FROM pages_fts "
            "WHERE title LIKE ? OR body LIKE ? LIMIT ?",
            (f"%{q}%", f"%{q}%", limit)).fetchall()
        results = []
        for slug, kind, title, body in rows:
            snippet = self._make_snippet(body, q)
            results.append({"slug": slug, "kind": kind,
                            "title": title, "snippet": snippet})
        return results

    # ---------- CJK 逐字切分 ----------

    @staticmethod
    def _cjk_split(text: str) -> str:
        out = []
        buf = ""
        for ch in text:
            if CJK_RE.match(ch):
                if buf:
                    out.append(buf.lower())
                    buf = ""
                out.append(ch)
            else:
                buf += ch
        if buf:
            out.append(buf.lower())
        return " ".join(out)

    @staticmethod
    def _unsplit(text: str) -> str:
        """只折叠 CJK 字符之间的切分空格，保留英文词间距。"""
        return CJK_SPACE_RE.sub("", text)

    @staticmethod
    def _make_snippet(body: str, q: str, width: int = 120) -> str:
        pos = body.find(q)
        if pos < 0:
            return body[:width] + ("…" if len(body) > width else "")
        start = max(0, pos - width // 3)
        snippet = body[start:start + width]
        return ("…" if start > 0 else "") + snippet.replace(q, "⟦" + q + "⟧")

    # ---------- ingest 历史（同库存储） ----------

    def record_run(self, source: str, state: str, started: str,
                   finished: Optional[str], summary: Optional[str]) -> None:
        with self._lock:
            assert self._conn is not None
            self._conn.execute(
                "INSERT INTO ingest_runs (source, state, started, finished, summary) "
                "VALUES (?, ?, ?, ?, ?)",
                (source, state, started, finished, summary))
            self._conn.commit()

    def list_runs(self, limit: int = 50) -> List[Dict]:
        with self._lock:
            assert self._conn is not None
            rows = self._conn.execute(
                "SELECT id, source, state, started, finished, summary FROM ingest_runs "
                "ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        import json
        out = []
        for r in rows:
            summary = None
            if r[5]:
                try:
                    summary = json.loads(r[5])
                except ValueError:
                    summary = None
            out.append({"id": r[0], "source": r[1], "state": r[2], "started": r[3],
                        "finished": r[4], "summary": summary})
        return out

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None
