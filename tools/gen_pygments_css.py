"""生成 static/pygments.css（一次性，产物提交进仓库，运行时零依赖计算）。"""
import os

from pygments.formatters import HtmlFormatter

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "static", "pygments.css")

css = HtmlFormatter(style="friendly").get_style_defs(".highlight")
with open(OUT, "w", encoding="utf-8") as f:
    f.write("/* 由 tools/gen_pygments_css.py 生成，请勿手改 */\n" + css)
print(f"written: {OUT}")
