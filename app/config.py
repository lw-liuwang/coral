"""coral 配置加载：config.yaml + 默认值合并 + 类型检查。"""
import os
from typing import Any, Dict, Optional

import yaml

DEFAULTS: Dict[str, Any] = {
    "server": {"host": "0.0.0.0", "port": 8300},
    "data_dir": "./data",
    "llm": {
        "base_url": "http://127.0.0.1:8000/v1",
        "api_key": "",
        "model": "qwen2.5-32b-instruct",
        "temperature": 0.3,
        "max_output_tokens": 8192,
        "timeout_seconds": 300,
        "retry": 1,
    },
    "ingest": {"source_max_chars": 24000, "analysis_max_chars": 16000},
    "search": {"results_per_page": 20},
}


class ConfigError(Exception):
    pass


class Config:
    def __init__(self, raw: Dict[str, Any]) -> None:
        merged = _merge(DEFAULTS, raw or {})
        self.host: str = _get(merged, ["server", "host"], str, "server.host")
        self.port: int = _get(merged, ["server", "port"], int, "server.port")
        self.data_dir: str = str(merged.get("data_dir", "./data"))
        llm = merged.get("llm", {})
        self.llm_base_url: str = _get(llm, ["base_url"], str, "llm.base_url").rstrip("/")
        self.llm_api_key: str = _get(llm, ["api_key"], str, "llm.api_key")
        self.llm_model: str = _get(llm, ["model"], str, "llm.model")
        self.llm_temperature: float = _get(llm, ["temperature"], float, "llm.temperature")
        self.llm_max_output_tokens: int = _get(llm, ["max_output_tokens"], int, "llm.max_output_tokens")
        self.llm_timeout_seconds: int = _get(llm, ["timeout_seconds"], int, "llm.timeout_seconds")
        self.llm_retry: int = _get(llm, ["retry"], int, "llm.retry")
        ingest = merged.get("ingest", {})
        self.source_max_chars: int = _get(ingest, ["source_max_chars"], int, "ingest.source_max_chars")
        self.analysis_max_chars: int = _get(ingest, ["analysis_max_chars"], int, "ingest.analysis_max_chars")
        search = merged.get("search", {})
        self.results_per_page: int = _get(search, ["results_per_page"], int, "search.results_per_page")

    @property
    def chat_completions_url(self) -> str:
        url = self.llm_base_url
        # 兼容只给了主机地址、或已含完整路径的写法
        if not url.endswith("/chat/completions"):
            url = url + "/chat/completions"
        return url


def load_config(path: Optional[str] = None) -> Config:
    if path is None:
        path = os.environ.get("CORAL_CONFIG", "config.yaml")
    raw: Dict[str, Any] = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            loaded = yaml.safe_load(f)
        if loaded is not None:
            if not isinstance(loaded, dict):
                raise ConfigError(f"{path}: 顶层必须是映射（key: value）")
            raw = loaded
    # 环境变量优先（容器部署用）
    env_data_dir = os.environ.get("CORAL_DATA_DIR")
    if env_data_dir:
        raw["data_dir"] = env_data_dir
    return Config(raw)


def _merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def _get(d: Dict[str, Any], path, typ, label: str):
    cur: Any = d
    for key in path[:-1]:
        cur = cur.get(key, {}) if isinstance(cur, dict) else {}
    val = cur.get(path[-1]) if isinstance(cur, dict) else None
    if val is None:
        raise ConfigError(f"{label} 缺失或为空")
    if typ is float and isinstance(val, int):
        val = float(val)
    if not isinstance(val, typ):
        raise ConfigError(f"{label} 类型应为 {typ.__name__}，实际为 {type(val).__name__}")
    return val
