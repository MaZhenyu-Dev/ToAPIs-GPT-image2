import asyncio
from datetime import datetime, timedelta, timezone

from backend.app.config import settings
from backend.app.crud.generation_tasks import (
    get_incomplete_tasks,
    update_task_status,
)
from backend.app.database import AsyncSessionLocal
from backend.app.models import GenerationTask
from backend.app.toapis_client import client


class BackgroundPoller:
    """后台任务轮询器：周期性同步未结束任务的状态，并处理本地超时。"""

    # 本地超时阈值：任务创建后超过该时间仍未完成则标记失败
    TASK_TIMEOUT = timedelta(minutes=5)

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
        """执行一次全量未结束任务同步。"""
        async with AsyncSessionLocal() as session:
            tasks = await get_incomplete_tasks(session)

        if not tasks:
            return

        await asyncio.gather(*[self._sync_one(task) for task in tasks])

    async def _sync_one(self, task: GenerationTask) -> None:
        """同步单个任务状态，并处理本地超时。"""
        # 本地超时兜底
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
            return

        if not task.toapis_task_id:
            # 仍在等待后台提交到 ToAPIs，无需查询
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


background_poller = BackgroundPoller(
    interval=getattr(settings, "POLL_INTERVAL_SECONDS", 5),
    max_concurrent=settings.MAX_CONCURRENT_GENERATIONS,
)
