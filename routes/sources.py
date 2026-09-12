"""来源文件：上传 / 列表 / 查看 / 删除。"""
import os
import time
from typing import List
from urllib.parse import quote, unquote

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import RedirectResponse

from app import paths, runtime
from app.render import render_markdown
from app.views import templates

router = APIRouter()


def _rt(request: Request):
    return request.app.state.runtime


@router.get("/sources")
def sources_list(request: Request):
    rt = _rt(request)
    files = []
    for name in paths.list_source_files(rt.config.data_dir):
        p = paths.find_source_file(rt.config.data_dir, name)
        stat = os.stat(p)
        files.append({
            "name": name,
            "size_kb": round(stat.st_size / 1024, 1),
            "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime)),
        })
    return templates.TemplateResponse("sources.html", {
        "request": request, "files": files,
    })


@router.post("/sources/upload")
async def sources_upload(request: Request, files: List[UploadFile] = File(...),
                         auto_ingest: bool = Form(True)):
    """上传即整理：保存 → 自动入队 LLM 整理 → 回知识库页看进度。"""
    rt = _rt(request)
    saved: List[str] = []
    rejected: List[str] = []
    for f in files:
        name = os.path.basename(f.filename or "")
        if not paths.allowed_source_name(name):
            rejected.append(name)
            continue
        target = _dedup(rt.config.data_dir, name)
        content = await f.read()
        with open(target, "w", encoding="utf-8") as out:
            out.write(_decode(content))
        saved.append(os.path.basename(target))
    if rt.ingest is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": "整理服务尚未启动"}, status_code=503)
    for name in saved:
        rt.ingest.enqueue(name)
    if saved and rt.search:
        for name in saved:
            with open(paths.find_source_file(rt.config.data_dir, name), "r", encoding="utf-8") as fh:
                content = fh.read()
            rt.search.index_page(name, "source", name, content)
    return RedirectResponse(
        f"/kb?upload={len(saved)}" + (f"&rejected={len(rejected)}" if rejected else ""),
        status_code=302)


def _decode(data: bytes) -> str:
    for enc in ("utf-8", "gb18030", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _dedup(data_dir: str, name: str) -> str:
    """文件名冲突时追加 -1、-2……"""
    base, ext = os.path.splitext(name)
    target = paths.find_source_file(data_dir, name)
    i = 1
    while os.path.exists(target):
        target = paths.find_source_file(data_dir, f"{base}-{i}{ext}")
        i += 1
    return target


@router.get("/sources/view/{name}")
def source_view(request: Request, name: str):
    rt = _rt(request)
    name = unquote(name)
    path = paths.find_source_file(rt.config.data_dir, name)
    if not os.path.isfile(path) or os.path.basename(path) != name:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"来源文件不存在: {name}"}, status_code=404)
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    existing = set(rt.store.all_slugs())
    html = render_markdown(content, existing)
    return templates.TemplateResponse("source_view.html", {
        "request": request, "name": name, "html": html,
    })


@router.post("/sources/{name}/delete")
def source_delete(request: Request, name: str):
    rt = _rt(request)
    name = unquote(name)
    path = paths.find_source_file(rt.config.data_dir, name)
    if os.path.isfile(path) and os.path.basename(path) == name:
        os.remove(path)
        if rt.search:
            rt.search.remove_page(name, "source")
    return RedirectResponse("/sources", status_code=302)
