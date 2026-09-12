"""知识库置顶：把常用模板钉在知识库页顶部（data/kb_pins.json 持久化）。"""
import json
import os
from typing import List

from .wiki import WRITE_LOCK

FILENAME = "kb_pins.json"


class PinStore:
    def __init__(self, data_dir: str) -> None:
        self.path = os.path.join(data_dir, FILENAME)

    def pinned(self) -> List[str]:
        """已置顶的模板 key 列表（保持置顶先后顺序）。"""
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return []
        if isinstance(data, list):
            return [str(k) for k in data if isinstance(k, str)]
        return []

    def is_pinned(self, key: str) -> bool:
        return key in self.pinned()

    def toggle(self, key: str) -> bool:
        """切换置顶状态，返回切换后是否置顶。"""
        with WRITE_LOCK:
            keys = self.pinned()
            if key in keys:
                keys.remove(key)
                pinned = False
            else:
                keys.append(key)
                pinned = True
            self._save(keys)
        return pinned

    def _save(self, keys: List[str]) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(keys, f, ensure_ascii=False)
        os.replace(tmp, self.path)
