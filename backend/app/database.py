from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from backend.app.config import settings

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    future=True,
    # 连接池放大：ToAPIs 并发升级后，poller / 提交器会同时开很多 DB 会话
    # （i2i_multi 一次最多 500 批次 × K 变体 = 上万任务）。
    # SQLAlchemy 默认 pool_size=5 + max_overflow=10 ≈ 15 个连接，
    # 轮询器一次 gather 上千协程时会全部排队等连接 → 状态永远不更新，
    # 表现为"图片已生成但一直排队中"。这里放宽到 100 个。
    pool_size=40,
    max_overflow=60,
    pool_pre_ping=True,
)

AsyncSessionLocal = sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
    autocommit=False,
)


async def get_db() -> AsyncSession:
    """FastAPI 依赖：获取异步数据库会话。"""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()
