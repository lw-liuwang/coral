"""页面浏览 / 编辑 / 新建 / 删除 + 预览 API。"""
import datetime
import re
from typing import Optional
from urllib.parse import quote, unquote

from fastapi import APIRouter, Form, Request
from fastapi.responses import JSONResponse, RedirectResponse

from app import frontmatter as fm_mod
from app import index_log, paths, runtime
from app.render import render_markdown
from app.views import templates

router = APIRouter()

BACKLINK_RE_CACHE: dict = {}


def _rt(request: Request):
    return request.app.state.runtime


def _today() -> str:
    return datetime.date.today().isoformat()


def _after_write(request: Request, slug: str) -> None:
    """写操作后的确定性维护：index 重建 + FTS 增量。log 由调用方追加。"""
    rt = _rt(request)
    index_log.rebuild_index(rt.store)
    if rt.search:
        page = rt.store.get_page(slug)
        if page:
            _, fm, body = page
            rt.search.index_page(slug, "wiki", str(fm.get("title") or slug), body)
        else:
            rt.search.remove_page(slug)


@router.get("/kb")
def kb_home(request: Request, upload: int = 0, rejected: int = 0):
    """知识库首页：模板区（求职跟踪等）+ 导入文档 + 整理的知识（wiki 分组摘要）。"""
    rt = _rt(request)
    from app.jobs import JobsStore
    active, ended = JobsStore(rt.store.data_dir).sorted_jobs()
    pages = rt.store.list_pages()
    groups = []
    for t in index_log.TYPE_ORDER:
        group = [p for p in pages if p.type == t]
        if group:
            groups.append((t, index_log.TYPE_LABELS[t], group[:5], len(group)))
    ingest_active = rt.ingest.status()["active"] if rt.ingest else None
    return templates.TemplateResponse("kb.html", {
        "request": request, "groups": groups, "total": len(pages),
        "jobs_active": len(active), "jobs_ended": len(ended),
        "upload": upload, "rejected": rejected, "ingest_active": ingest_active,
    })


@router.get("/pages")
def page_list(request: Request, type: Optional[str] = None):
    rt = _rt(request)
    pages = rt.store.list_pages()
    if type:
        pages = [p for p in pages if p.type == type]
    groups = []
    for t in index_log.TYPE_ORDER:
        group = [p for p in pages if p.type == t]
        if group:
            groups.append((t, index_log.TYPE_LABELS[t], group))
    return templates.TemplateResponse("page_list.html", {
        "request": request, "groups": groups, "total": len(pages),
        "filter_type": type or "",
    })


@router.get("/pages/new")
def page_new_form(request: Request, title: str = "", type: str = "concept"):
    return templates.TemplateResponse("page_new.html", {
        "request": request, "title": title, "type": type, "error": None,
    })


@router.post("/pages/new")
def page_new_create(request: Request, title: str = Form(...), type: str = Form(...),
                    content: str = Form("")):
    rt = _rt(request)
    title = title.strip()
    if not title:
        return templates.TemplateResponse("page_new.html", {
            "request": request, "title": "", "type": type, "error": "标题不能为空"}, status_code=400)
    if type not in paths.PAGE_TYPES:
        type = "concept"
    slug = rt.store.unique_slug(title)
    today = _today()
    body = content
    if body and not body.startswith("\n"):
        body = "\n" + body
    fm = {"type": type, "title": title, "created": today, "updated": today}
    rt.store.save_page(slug, fm, body)
    index_log.append_log(rt.store, "create", title)
    _after_write(request, slug)
    return RedirectResponse(f"/pages/{quote(slug)}", status_code=302)


@router.get("/pages/{slug}")
def page_view(request: Request, slug: str):
    rt = _rt(request)
    slug = unquote(slug)
    page = rt.store.get_page(slug)
    if page is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"页面不存在: {slug}"}, status_code=404)
    page_type, fm, body = page
    existing = set(rt.store.all_slugs())
    html = render_markdown(body, existing)
    meta_warnings = []
    if not fm:
        meta_warnings.append("页面缺少有效的 frontmatter")
    return templates.TemplateResponse("page_view.html", {
        "request": request, "slug": slug, "type": page_type,
        "fm": fm, "html": html, "warnings": meta_warnings,
        "backlinks": _backlinks(rt, slug), "existing": existing,
    })


def _backlink_re(slug: str) -> "re.Pattern":
    if slug not in BACKLINK_RE_CACHE:
        BACKLINK_RE_CACHE[slug] = re.compile(
            r"\[\[\s*" + re.escape(slug) + r"\s*(?:\||\]\])")
    return BACKLINK_RE_CACHE[slug]


def _backlinks(rt, slug: str):
    """链接到本页的页面列表（入链）。"""
    pat = _backlink_re(slug)
    links = []
    for m in rt.store.list_pages():
        p = rt.store.get_page(m.slug)
        if p is None:
            continue
        if pat.search(p[2]):
            links.append(m)
    return links


@router.get("/pages/{slug}/edit")
def page_edit_form(request: Request, slug: str, error: Optional[str] = None,
                   content: Optional[str] = None):
    rt = _rt(request)
    slug = unquote(slug)
    page = rt.store.get_page(slug)
    if page is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"页面不存在: {slug}"}, status_code=404)
    _, fm, body = page
    raw = content if content is not None else fm_mod.serialize(fm, body)
    return templates.TemplateResponse("page_edit.html", {
        "request": request, "slug": slug, "raw": raw, "error": error,
    })


@router.post("/pages/{slug}/edit")
def page_edit_save(request: Request, slug: str, content: str = Form(...)):
    rt = _rt(request)
    slug = unquote(slug)
    page = rt.store.get_page(slug)
    if page is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"页面不存在: {slug}"}, status_code=404)
    old_type, old_fm, old_body = page

    new_fm, new_body, _ = fm_mod.parse(content)
    if not new_fm:
        # frontmatter 全损：保留旧 frontmatter，整个文本当作 body
        new_fm, new_body = dict(old_fm), content
    else:
        if not new_fm.get("type"):
            new_fm["type"] = old_type
        if not new_fm.get("title"):
            new_fm["title"] = old_fm.get("title") or slug
        if not new_fm.get("created") and old_fm.get("created"):
            new_fm["created"] = old_fm["created"]
    new_fm["updated"] = _today()
    new_fm = fm_mod.normalize_union_items(new_fm)

    # type 改动会换目录：先删旧文件再写新文件
    rt.store.delete_page(slug)
    try:
        rt.store.save_page(slug, new_fm, new_body)
    except ValueError as e:
        rt.store.save_page(slug, old_fm, old_body)  # 回滚
        return templates.TemplateResponse("page_edit.html", {
            "request": request, "slug": slug, "raw": content,
            "error": f"保存失败：{e}"}, status_code=400)
    index_log.append_log(rt.store, "edit", str(new_fm.get("title") or slug))
    _after_write(request, slug)
    return RedirectResponse(f"/pages/{quote(slug)}", status_code=302)


@router.post("/pages/{slug}/retype")
def page_retype(request: Request, slug: str, new_type: str = Form(...)):
    """转换页面类型（随手记 → 概念/实体等）：移动文件 + 更新 frontmatter。"""
    rt = _rt(request)
    slug = unquote(slug)
    if new_type not in paths.PAGE_TYPES:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"未知类型: {new_type}"}, status_code=400)
    page = rt.store.get_page(slug)
    if page is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"页面不存在: {slug}"}, status_code=404)
    old_type, fm, _ = page
    if old_type == new_type:
        return RedirectResponse(f"/pages/{quote(slug)}", status_code=302)
    rt.store.move_page(slug, new_type)
    index_log.append_log(rt.store, "retype",
                         str(fm.get("title") or slug),
                         [f"{old_type} → {new_type}"])
    _after_write(request, slug)
    return RedirectResponse(f"/pages/{quote(slug)}", status_code=302)


@router.post("/pages/{slug}/delete")
def page_delete(request: Request, slug: str):
    rt = _rt(request)
    slug = unquote(slug)
    page = rt.store.get_page(slug)
    if page is not None:
        _, fm, _ = page
        rt.store.delete_page(slug)
        index_log.append_log(rt.store, "delete", str(fm.get("title") or slug))
        index_log.rebuild_index(rt.store)
        if rt.search:
            rt.search.remove_page(slug)
    return RedirectResponse("/pages", status_code=302)


@router.post("/api/preview")
async def preview(request: Request):
    try:
        payload = await request.json()
        md = str(payload.get("markdown") or "")
    except Exception:
        return JSONResponse({"html": ""}, status_code=400)
    rt = _rt(request)
    existing = set(rt.store.all_slugs())
    return JSONResponse({"html": render_markdown(md, existing)})
