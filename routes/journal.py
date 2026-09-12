"""日记路由：首页写作框 + 时间线；按日查看/编辑。"""
from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse
from urllib.parse import quote

from app import runtime
from app.journal import JournalStore
from app.render import render_markdown
from app.views import templates

router = APIRouter()


def _rt(request: Request):
    return request.app.state.runtime


def _journal(request: Request) -> JournalStore:
    return JournalStore(_rt(request).store.data_dir)


def _after_write(request: Request, date: str) -> None:
    rt = _rt(request)
    if rt.search:
        text = _journal(request).get_day(date)
        if text is not None:
            rt.search.index_page(date, "journal", f"日记 {date}", text)


@router.get("/")
def journal_home(request: Request):
    store = _journal(request)
    today = store.today()
    days = store.list_days()
    today_text = store.get_day(today)
    return templates.TemplateResponse("journal_home.html", {
        "request": request, "days": days, "today": today,
        "today_text": today_text,
    })


@router.post("/journal/write")
def journal_write(request: Request, content: str = Form(...)):
    store = _journal(request)
    content = content.strip()
    if not content:
        return RedirectResponse("/", status_code=302)
    date, _ = store.append_entry(content)
    _after_write(request, date)
    return RedirectResponse("/", status_code=302)


@router.get("/journal/{date}")
def journal_day(request: Request, date: str):
    store = _journal(request)
    try:
        text = store.get_day(date)
    except ValueError:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"日期不合法: {date}"}, status_code=400)
    if text is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"这天没有日记: {date}"}, status_code=404)
    from app.journal import WEEKDAYS
    import datetime as _dt
    weekday = WEEKDAYS[_dt.date.fromisoformat(date).weekday()]
    existing = set(_rt(request).store.all_slugs())
    html = render_markdown(text, existing)
    return templates.TemplateResponse("journal_day.html", {
        "request": request, "date": date, "weekday": weekday,
        "html": html, "raw": text,
    })


@router.get("/journal/{date}/edit")
def journal_edit_form(request: Request, date: str):
    store = _journal(request)
    try:
        text = store.get_day(date)
    except ValueError:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"日期不合法: {date}"}, status_code=400)
    if text is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"这天没有日记: {date}"}, status_code=404)
    return templates.TemplateResponse("journal_edit.html", {
        "request": request, "date": date, "raw": text, "error": None,
    })


@router.post("/journal/{date}/edit")
def journal_edit_save(request: Request, date: str, content: str = Form(...)):
    store = _journal(request)
    try:
        store.save_day(date, content)
    except ValueError as e:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": str(e)}, status_code=400)
    _after_write(request, date)
    return RedirectResponse(f"/journal/{quote(date)}", status_code=302)
