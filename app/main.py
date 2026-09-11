"""coral 主应用：FastAPI 工厂、startup 初始化（目录/FTS 对账/ingest 线程）。"""
import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import index_log, paths, runtime
from .config import Config, load_config

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")


def create_app(config: Config = None) -> FastAPI:
    if config is None:
        config = load_config()
    paths.init_data_dirs(config.data_dir)
    rt = runtime.init_runtime(config)
    index_log.ensure_initialized(rt.store)

    app = FastAPI(title="coral", docs_url=None, redoc_url=None)
    app.state.runtime = rt
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    from routes import pages as pages_routes
    from routes import ingest as ingest_routes
    from routes import search as search_routes
    from routes import lint as lint_routes
    from routes import sources as sources_routes
    app.include_router(pages_routes.router)
    app.include_router(sources_routes.router)
    app.include_router(ingest_routes.router)
    app.include_router(search_routes.router)
    app.include_router(lint_routes.router)

    @app.on_event("startup")
    def _startup() -> None:
        from .ingest import IngestManager
        from .search import SearchIndex
        rt.search = SearchIndex(config)
        rt.search.reconcile(rt.store)
        rt.ingest = IngestManager(config, rt.store, search=rt.search)
        rt.ingest.start()

    return app


app = create_app()
