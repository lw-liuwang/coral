"""Lint 结果页：断链 + 孤儿页。"""
from fastapi import APIRouter, Request

from app.lint import run_lint
from app.views import templates

router = APIRouter()


@router.get("/lint")
def lint(request: Request):
    rt = request.app.state.runtime
    result = run_lint(rt.store)
    return templates.TemplateResponse("lint.html", {
        "request": request,
        "broken": result["broken"],
        "orphans": result["orphans"],
        "no_outlinks": result["no_outlinks"],
    })
