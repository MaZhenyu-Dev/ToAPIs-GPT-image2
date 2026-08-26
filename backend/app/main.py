from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.app.config import settings
from backend.app.database import engine
from backend.app.migrations import run_migrations
from backend.app.models import Base
from backend.app.routers import (
    batch,
    erp,
    extract,
    generations,
    product_swap,
    title_generation,
    variant_groups,
)
from backend.app.services.background_poller import background_poller
from backend.app.toapis_client import client

# 前端构建产物目录（生产模式单端口部署：npm run build 后直接访问后端端口）
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时建表并启动后台轮询，退出时关闭资源。"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    # 轻量自动迁移：为已存在的表补齐新增列（如 retried_count），幂等
    await run_migrations(engine)
    background_poller.start()
    yield
    await background_poller.stop()
    await client.close()
    await engine.dispose()


app = FastAPI(
    title="图灵 · 批量变体生成平台",
    version="0.3.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(generations.router, prefix="/api")
app.include_router(variant_groups.router, prefix="/api")
app.include_router(batch.router, prefix="/api")
app.include_router(product_swap.router, prefix="/api")
app.include_router(title_generation.router, prefix="/api")
app.include_router(erp.router, prefix="/api")
app.include_router(extract.router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}


# 生产模式静态托管：前端 dist 存在时挂载到根路径（单端口访问）。
# 必须放在所有 API 路由之后注册（"/" 兜底，/api/* 与 /health 优先匹配）。
# 前端无 URL 路由（tab 状态切换），无需 SPA history fallback。
# 开发模式用 vite dev server（--reload），dist 不存在时不影响。
if FRONTEND_DIST.is_dir():
    app.mount(
        "/",
        StaticFiles(directory=str(FRONTEND_DIST), html=True),
        name="frontend",
    )
