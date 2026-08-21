import asyncio
from datetime import datetime, timedelta, timezone

from backend.app.config import settings
from backend.app.crud.generation_tasks import (
    get_incomplete_tasks,
    update_task_status,
)
from backend.app.database import AsyncSessionLocal
from backend.app.models import GenerationTask
from backend.app.services.batch_generator import batch_generator
from backend.app.toapis_client import client


class BackgroundPoller:
    """后台任务轮询器：周期性同步未结束任务的状态，并处理本地超时。"""

    # 本地超时阈值：任务创建后超过该时间仍未完成则标记失败
    TASK_TIMEOUT = timedelta(minutes=5)
    # 单轮 gather 的任务块大小：防止一次并发上千个 DB 会话打爆连接池
    _POLL_CHUNK = 100

    def __init__(
        self,
        interval: int = 5,
        max_concurrent: int = 20,
    ):
        self.interval = interval
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

    def start(self) -> None:
        """启动后台轮询任务。"""
        if self._task is None or self._task.done():
            self._stop_event.clear()
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        """停止后台轮询任务。"""
        self._stop_event.set()
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        """主循环：定时拉取未结束任务并同步状态。"""
        while not self._stop_event.is_set():
            try:
                await self._poll_once()
            except Exception as exc:
                # 避免轮询异常导致后台任务退出
                print(f"[BackgroundPoller] 轮询异常: {exc}")
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(), timeout=self.interval
                )
            except asyncio.TimeoutError:
                pass

    async def _poll_once(self) -> None:
        """执行一次全量未结束任务同步。

        **重要**：任务按块（``_POLL_CHUNK``）分批 gather，而不是一次
        ``asyncio.gather`` 全部任务。i2i_multi 一次可创建上万任务，
        若一次 gather 数千个协程，每个协程都开一个 DB 会话抢连接，
        会耗尽 SQLAlchemy 连接池（默认仅 ~15 个连接），导致整个应用的
        DB 操作全部排队、状态永不更新——表现为"图片已生成但一直排队中"。
        """
        async with AsyncSessionLocal() as session:
            tasks = await get_incomplete_tasks(session)

        if not tasks:
            return

        for i in range(0, len(tasks), self._POLL_CHUNK):
            chunk = tasks[i : i + self._POLL_CHUNK]
            await asyncio.gather(*[self._sync_one(task) for task in chunk])

    async def _sync_one(self, task: GenerationTask) -> None:
        """同步单个任务状态，并处理本地超时。"""
        # 尚未提交到 ToAPIs（无远端任务 ID）的任务不判超时：
        # - 可能还在排队等待提交（高并发时成千上万任务排队很正常）
        # - 重试后 created_at 已刷新，超时从重试时刻重新计时
        if not task.toapis_task_id:
            return

        # 本地超时兜底：只对「已提交到 ToAPIs 但超过 5 分钟没结果」的任务生效
        created_at = task.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - created_at > self.TASK_TIMEOUT:
            async with AsyncSessionLocal() as session:
                fresh_task = await session.get(GenerationTask, task.id)
                if fresh_task and fresh_task.status not in ("completed", "failed"):
                    await update_task_status(
                        session,
                        fresh_task,
                        status="failed",
                        progress=task.progress,
                        error_msg="任务本地超时（超过 5 分钟未完成）",
                    )
                    # 失败后自动重试（模型阶梯；3 次后停止交由用户手动重试）
                    await batch_generator.maybe_auto_retry(session, fresh_task)
            return

        async with self.semaphore:
            try:
                status = await client.get_task_status(task.toapis_task_id)
            except Exception as exc:
                async with AsyncSessionLocal() as session:
                    fresh_task = await session.get(GenerationTask, task.id)
                    if fresh_task and fresh_task.status not in (
                        "completed",
                        "failed",
                    ):
                        await update_task_status(
                            session,
                            fresh_task,
                            status="failed",
                            error_msg=str(exc),
                        )
                        # 失败后自动重试（模型阶梯；3 次后停止交由用户手动重试）
                        await batch_generator.maybe_auto_retry(session, fresh_task)
                return

        new_status = status.get("status", task.status)
        progress = status.get("progress", task.progress)
        image_url = client.extract_image_url(status)
        error = status.get("error")
        error_msg = (
            error.get("message")
            if isinstance(error, dict)
            else str(error)
            if error
            else None
        )

        async with AsyncSessionLocal() as session:
            fresh_task = await session.get(GenerationTask, task.id)
            if fresh_task and fresh_task.status not in ("completed", "failed"):
                await update_task_status(
                    session,
                    fresh_task,
                    status=new_status,
                    progress=progress,
                    image_url=image_url,
                    error_msg=error_msg,
                )
                if new_status == "failed":
                    # 失败后自动重试（模型阶梯；3 次后停止交由用户手动重试）
                    await batch_generator.maybe_auto_retry(session, fresh_task)


background_poller = BackgroundPoller(
    interval=getattr(settings, "POLL_INTERVAL_SECONDS", 5),
    max_concurrent=settings.MAX_CONCURRENT_GENERATIONS,
)
