"""Jinja2 模板实例（独立模块，避免 routes <-> main 循环导入）。"""
import os
from urllib.parse import quote

from fastapi.templating import Jinja2Templates

from .index_log import TYPE_LABELS

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
templates.env.filters["urlquote"] = lambda s: quote(str(s), safe="")
templates.env.globals["TYPE_LABELS"] = TYPE_LABELS

# 置顶模板 → 顶栏导航（create_app 时注入 data_dir）
_pin_store = None


def init_pins(data_dir: str) -> None:
    global _pin_store
    from .pins import PinStore
    _pin_store = PinStore(data_dir)


def nav_pins():
    """顶栏与「随手记/知识库」并列的置顶模板。"""
    if _pin_store is None:
        return []
    from .kbtemplates import KB_TEMPLATES
    pinned = set(_pin_store.pinned())
    return [t for t in KB_TEMPLATES if t["key"] in pinned]


templates.env.globals["nav_pins"] = nav_pins


def _asset_version() -> str:
    """静态资源版本号 = coral.css/coral.js 的 mtime（内容变了 URL 就变，破浏览器缓存）。"""
    try:
        return str(max(
            int(os.path.getmtime(os.path.join(BASE_DIR, "static", f)))
            for f in ("coral.css", "coral.js")))
    except OSError:
        return "0"


templates.env.globals["asset_ver"] = _asset_version()
