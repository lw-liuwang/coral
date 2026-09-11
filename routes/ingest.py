"""Ingest：入队 + 状态页。"""
from typing import Optional

from fastapi import APIRouter, Form, Request
from fastapi.responses import RedirectResponse

from app import runtime
from app.views import templates

router = APIRouter()

STATE_BADGES = {"done": "state-done", "error": "state-error",
                "queued": "state-queued", "running": "state-queued"}


@router.post("/ingest")
def ingest_start(request: Request, source: str = Form(...)):
    rt = request.app.state.runtime
    if rt.ingest is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": "ingest 服务尚未启动"}, status_code=503)
    rt.ingest.enqueue(source)
    return RedirectResponse("/ingest", status_code=302)


@router.get("/ingest")
def ingest_status(request: Request):
    rt = request.app.state.runtime
    if rt.ingest is None:
        return templates.TemplateResponse("error.html", {
            "request": request, "message": "ingest 服务尚未启动"}, status_code=503)
    active = rt.ingest.active
    queued = rt.ingest.queued_items()
    history = rt.search.list_runs() if rt.search else []
    return templates.TemplateResponse("ingest.html", {
        "request": request,
        "active": active,
        "queued": queued,
        "history": history,
        "state_badges": STATE_BADGES,
        "auto_refresh": active is not None or len(queued) > 0,
    })
