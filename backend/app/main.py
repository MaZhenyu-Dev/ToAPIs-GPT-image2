from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.app.config import settings
from backend.app.database import engine
from backend.app.migrations import run_migrations
from backend.app.models import Base
from backend.app.routers import batch, generations, product_swap, title_generation, variant_groups
from backend.app.services.background_poller import background_poller
from backend.app.toapis_client import client


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
    title="GPT-Image-2 批量变体生成平台",
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


@app.get("/health")
async def health():
    return {"status": "ok"}
