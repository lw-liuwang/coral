"""Jinja2 模板实例（独立模块，避免 routes <-> main 循环导入）。"""
import os
from urllib.parse import quote

from fastapi.templating import Jinja2Templates

from .index_log import TYPE_LABELS

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
templates.env.filters["urlquote"] = lambda s: quote(str(s), safe="")
templates.env.globals["TYPE_LABELS"] = TYPE_LABELS


def _asset_version() -> str:
    """静态资源版本号 = coral.css/coral.js 的 mtime（内容变了 URL 就变，破浏览器缓存）。"""
    try:
        return str(max(
            int(os.path.getmtime(os.path.join(BASE_DIR, "static", f)))
            for f in ("coral.css", "coral.js")))
    except OSError:
        return "0"


templates.env.globals["asset_ver"] = _asset_version()
