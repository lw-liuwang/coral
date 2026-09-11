"""运行时共享状态：config / WikiStore / SearchIndex / IngestManager。

单项目单进程：模块级单例，startup 时初始化，测试中用 init_runtime 注入临时目录。
"""
import threading
from typing import Optional

from .config import Config
from .wiki import WikiStore


class Runtime:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.store = WikiStore(config.data_dir)
        self.search = None          # SearchIndex（main startup 注入）
        self.ingest = None          # IngestManager（main startup 注入）
        self.search_lock = threading.Lock()


_RUNTIME: Optional[Runtime] = None


def init_runtime(config: Config) -> Runtime:
    global _RUNTIME
    _RUNTIME = Runtime(config)
    return _RUNTIME


def get_runtime() -> Runtime:
    assert _RUNTIME is not None, "runtime 未初始化（init_runtime 未调用）"
    return _RUNTIME
