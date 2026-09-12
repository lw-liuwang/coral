"""求职跟踪路由：表格视图、新增投递、状态推进、复盘追加。"""
from urllib.parse import quote, unquote

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse

from app import runtime
from app.jobs import ALL_STATUS, STATUS_FLOW, JobsStore
from app.render import render_markdown
from app.views import templates

router = APIRouter()


def _rt(request: Request):
    return request.app.state.runtime


def _jobs(request: Request) -> JobsStore:
    return JobsStore(_rt(request).store.data_dir)


def _index_job(request: Request, slug: str) -> None:
    rt = _rt(request)
    if not rt.search:
        return
    job = _jobs(request).get_job(slug)
    if job is None:
        rt.search.remove_page(slug)
    else:
        title = job.company + (f" · {job.position}" if job.position else "")
        rt.search.index_page(slug, "job", title,
                             f"{job.company} {job.position} {job.status}\n{job.body}")


@router.get("/jobs")
def jobs_table(request: Request):
    active, ended = _jobs(request).sorted_jobs()
    return templates.TemplateResponse("jobs.html", {
        "request": request, "active": active, "ended": ended,
    })


@router.get("/jobs/new")
def job_new_form(request: Request, error: str = None):
    import datetime
    return templates.TemplateResponse("job_new.html", {
        "request": request, "error": error,
        "today": datetime.date.today().isoformat(),
        "statuses": ALL_STATUS,
    })


@router.post("/jobs/new")
def job_new_create(request: Request, company: str = Form(...),
                   position: str = Form(""), applied: str = Form(""),
                   status: str = Form("已投"), note: str = Form("")):
    try:
        slug = _jobs(request).add_job(company, position, applied, status, note)
    except ValueError as e:
        return templates.TemplateResponse("job_new.html", {
            "request": request, "error": str(e),
            "today": applied, "statuses": ALL_STATUS}, status_code=400)
    _index_job(request, slug)
    return RedirectResponse(f"/jobs/{quote(slug)}", status_code=302)


@router.get("/jobs/{slug}")
def job_view(request: Request, slug: str):
    slug = unquote(slug)
    job = _jobs(request).get_job(slug)
    if job is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"投递记录不存在: {slug}"}, status_code=404)
    existing = set(_rt(request).store.all_slugs())
    html = render_markdown(job.body, existing)
    # 推进按钮的默认下一步状态
    flow = list(STATUS_FLOW)
    try:
        default_next = flow[min(flow.index(job.status) + 1, len(flow) - 1)] \
            if job.status in flow else "已投"
    except ValueError:
        default_next = "已投"
    return templates.TemplateResponse("job_view.html", {
        "request": request, "job": job, "html": html,
        "statuses": ALL_STATUS, "default_next": default_next,
    })


@router.post("/jobs/{slug}/advance")
def job_advance(request: Request, slug: str, status: str = Form(...),
                note: str = Form(""), next_date: str = Form("")):
    slug = unquote(slug)
    try:
        job = _jobs(request).advance(slug, status, note, next_date)
    except ValueError as e:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": str(e)}, status_code=400)
    if job is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"投递记录不存在: {slug}"}, status_code=404)
    _index_job(request, slug)
    return RedirectResponse(f"/jobs/{quote(slug)}", status_code=302)


@router.post("/jobs/{slug}/retro")
def job_retro(request: Request, slug: str, content: str = Form(...)):
    slug = unquote(slug)
    try:
        job = _jobs(request).append_retro(slug, content)
    except ValueError as e:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": str(e)}, status_code=400)
    if job is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": f"投递记录不存在: {slug}"}, status_code=404)
    _index_job(request, slug)
    return RedirectResponse(f"/jobs/{quote(slug)}", status_code=302)


@router.post("/jobs/{slug}/delete")
def job_delete(request: Request, slug: str):
    slug = unquote(slug)
    if _jobs(request).delete_job(slug):
        rt = _rt(request)
        if rt.search:
            rt.search.remove_page(slug)
    return RedirectResponse("/jobs", status_code=302)
