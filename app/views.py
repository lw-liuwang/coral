"""Jinja2 模板实例（独立模块，避免 routes <-> main 循环导入）。"""
import os
from urllib.parse import quote

from fastapi.templating import Jinja2Templates

from .index_log import TYPE_LABELS

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
templates.env.filters["urlquote"] = lambda s: quote(str(s), safe="")
templates.env.globals["TYPE_LABELS"] = TYPE_LABELS
