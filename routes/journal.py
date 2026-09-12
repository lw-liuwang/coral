"""随手记路由：首页大写作框 + 记录流；按条查看/编辑/改名/删除。"""
from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from urllib.parse import quote, unquote

from app import runtime
from app.journal import JournalStore, entry_title
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
        store = _journal(request)
        text = store.get_entry(entry_id)
        if text is not None:
            date, tm = store.entry_datetime(entry_id)
            rt.search.index_page(entry_id, "journal",
                                 entry_title(entry_id, date, tm), text)


@router.get("/")
def journal_home(request: Request):
    """点「随手记」直接进入整页编辑器。"""
    return templates.TemplateResponse("journal_home.html", {"request": request})


@router.get("/journal")
def journal_list(request: Request):
    entries = _journal(request).list_entries(limit=200)
    return templates.TemplateResponse("journal_list.html", {
        "request": request, "entries": entries,
    })


@router.post("/journal/write")
def journal_write(request: Request, content: str = Form("")):
    """空内容也保存（落一条只有时间戳的记录）。保存后跳到这条记录。"""
    entry_id = _journal(request).add_entry(content)
    _after_write(request, entry_id)
    return RedirectResponse(f"/journal/{quote(entry_id)}", status_code=302)


@router.get("/journal/{entry_id}")
def journal_entry(request: Request, entry_id: str, rename_error: str = ""):
    store = _journal(request)
    entry_id = unquote(entry_id)
    try:
        text = store.get_entry(entry_id)
        date, tm = store.entry_datetime(entry_id)
    except (ValueError, OSError):
        text = None
    if text is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"记录不存在: {entry_id}"}, status_code=404)
    existing = set(_rt(request).store.all_slugs())
    html = render_markdown(text, existing)
    return templates.TemplateResponse("journal_entry.html", {
        "request": request, "entry_id": entry_id,
        "name": store.entry_name(entry_id),
        "date": date, "time": tm,
        "html": html, "empty": not text.strip(),
        "rename_error": rename_error,
    })


@router.get("/journal/{entry_id}/edit")
def journal_edit_form(request: Request, entry_id: str):
    store = _journal(request)
    entry_id = unquote(entry_id)
    try:
        text = store.get_entry(entry_id)
        date, tm = store.entry_datetime(entry_id)
    except (ValueError, OSError):
        text = None
    if text is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"记录不存在: {entry_id}"}, status_code=404)
    return templates.TemplateResponse("journal_edit.html", {
        "request": request, "entry_id": entry_id,
        "name": store.entry_name(entry_id), "date": date, "time": tm,
        "raw": text, "error": None,
    })


@router.post("/journal/{entry_id}/edit")
def journal_edit_save(request: Request, entry_id: str, content: str = Form("")):
    """清空内容是合法操作（变回只有时间戳的记录）。"""
    store = _journal(request)
    entry_id = unquote(entry_id)
    try:
        store.save_entry(entry_id, content)
    except ValueError as e:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": str(e)}, status_code=404)
    _after_write(request, entry_id)
    return RedirectResponse(f"/journal/{quote(entry_id)}", status_code=302)


@router.post("/journal/{entry_id}/rename")
def journal_rename(request: Request, entry_id: str, name: str = Form("")):
    """改记录名：内容与时间不变，FTS 换到新名字下。没输入名字就不动。"""
    entry_id = unquote(entry_id)
    if not (name or "").strip():
        return RedirectResponse(f"/journal/{quote(entry_id)}", status_code=302)
    rt = _rt(request)
    store = _journal(request)
    try:
        new_id = store.rename_entry(entry_id, name)
    except ValueError as e:
        return RedirectResponse(
            f"/journal/{quote(entry_id)}?rename_error={quote(str(e))}",
            status_code=302)
    if rt.search:
        rt.search.remove_page(entry_id, "journal")
    _after_write(request, new_id)
    return RedirectResponse(f"/journal/{quote(new_id)}", status_code=302)


@router.post("/journal/{entry_id}/delete")
def journal_delete(request: Request, entry_id: str):
    store = _journal(request)
    entry_id = unquote(entry_id)
    if store.delete_entry(entry_id):
        rt = _rt(request)
        if rt.search:
            rt.search.remove_page(entry_id)
    return RedirectResponse("/", status_code=302)
