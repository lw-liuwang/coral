"""随手记路由：首页大写作框 + 记录流；按条查看/编辑/删除。"""
from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from urllib.parse import quote, unquote

from app import runtime
from app.journal import JournalStore
from app.render import render_markdown
from app.views import templates

router = APIRouter()


def _rt(request: Request):
    return request.app.state.runtime


def _journal(request: Request) -> JournalStore:
    return JournalStore(_rt(request).store.data_dir)


def _after_write(request: Request, entry_id: str) -> None:
    rt = _rt(request)
    if rt.search:
        text = _journal(request).get_entry(entry_id)
        if text is not None:
            date, tm = entry_id[:10], entry_id[11:19]
            rt.search.index_page(entry_id, "journal", f"随手记 {date} {tm}", text)


@router.get("/")
def journal_home(request: Request):
    store = _journal(request)
    entries = store.list_entries(limit=50)
    return templates.TemplateResponse("journal_home.html", {
        "request": request, "entries": entries,
    })


@router.post("/journal/write")
def journal_write(request: Request, content: str = Form("")):
    """空内容也保存（落一条只有时间戳的记录）。"""
    entry_id = _journal(request).add_entry(content)
    _after_write(request, entry_id)
    return RedirectResponse("/", status_code=302)


@router.get("/journal/{entry_id}")
def journal_entry(request: Request, entry_id: str):
    store = _journal(request)
    entry_id = unquote(entry_id)
    try:
        text = store.get_entry(entry_id)
    except ValueError:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"记录不存在: {entry_id}"}, status_code=404)
    if text is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"记录不存在: {entry_id}"}, status_code=404)
    existing = set(_rt(request).store.all_slugs())
    html = render_markdown(text, existing)
    return templates.TemplateResponse("journal_entry.html", {
        "request": request, "entry_id": entry_id,
        "date": entry_id[:10], "time": entry_id[11:19],
        "html": html, "empty": not text.strip(),
    })


@router.get("/journal/{entry_id}/edit")
def journal_edit_form(request: Request, entry_id: str):
    store = _journal(request)
    entry_id = unquote(entry_id)
    try:
        text = store.get_entry(entry_id)
    except ValueError:
        text = None
    if text is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"记录不存在: {entry_id}"}, status_code=404)
    return templates.TemplateResponse("journal_edit.html", {
        "request": request, "entry_id": entry_id, "raw": text, "error": None,
    })


@router.post("/journal/{entry_id}/edit")
def journal_edit_save(request: Request, entry_id: str, content: str = Form(...)):
    store = _journal(request)
    entry_id = unquote(entry_id)
    try:
        store.save_entry(entry_id, content)
    except ValueError as e:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": str(e)}, status_code=404)
    _after_write(request, entry_id)
    return RedirectResponse(f"/journal/{quote(entry_id)}", status_code=302)


@router.post("/journal/{entry_id}/delete")
def journal_delete(request: Request, entry_id: str):
    store = _journal(request)
    entry_id = unquote(entry_id)
    if store.delete_entry(entry_id):
        rt = _rt(request)
        if rt.search:
            rt.search.remove_page(entry_id)
    return RedirectResponse("/", status_code=302)
