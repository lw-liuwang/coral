"""搜索结果页。"""
from fastapi import APIRouter, Request

from app.views import templates

router = APIRouter()


@router.get("/search")
def search(request: Request, q: str = "", page: int = 1):
    rt = request.app.state.runtime
    q = q.strip()
    results = []
    total = 0
    pages_count = 0
    per = rt.config.results_per_page
    if q and rt.search:
        all_results = rt.search.query(q, limit=500)
        total = len(all_results)
        start = (max(1, page) - 1) * per
        results = all_results[start:start + per]
        for r in results:
            if r["kind"] == "wiki":
                p = rt.store.get_page(r["slug"])
                if p:
                    r["title"] = str(p[1].get("title") or r["slug"])
                else:
                    r["title"] = r["slug"]
                r["url"] = "/pages/" + r["slug"]
            elif r["kind"] == "journal":
                r["title"] = r["title"] or ("随手记 " + r["slug"][:10])
                r["url"] = "/journal/" + r["slug"]
            elif r["kind"] == "job":
                r["title"] = r["title"] or r["slug"]
                r["url"] = "/jobs/" + r["slug"]
            else:
                # source slug = 完整文件名
                r["title"] = r["slug"]
                r["url"] = "/sources/view/" + r["slug"]
        pages_count = (total + per - 1) // per
    return templates.TemplateResponse("search.html", {
        "request": request, "q": q, "results": results, "total": total,
        "page": max(1, page), "pages_count": pages_count, "per": per,
    })
