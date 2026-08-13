import asyncio
from typing import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import settings
from backend.app.crud.generation_tasks import get_tasks_by_batch, update_task_status
from backend.app.database import AsyncSessionLocal
from backend.app.models import GenerationTask
from backend.app.schemas import BatchStatusResponse, GenerationTaskOut
from backend.app.toapis_client import client


class TaskPollerService:
    """任务状态同步服务：将 ToAPIs 任务状态刷新到本地数据库。"""

    # 单轮 gather 的任务块大小：防止一次并发上千个 DB 会话打爆连接池
    _SYNC_CHUNK = 100

    def __init__(self):
        self.semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_GENERATIONS)

    async def sync_batch(
        self, db: AsyncSession, batch_id: str
    ) -> BatchStatusResponse:
        tasks = await get_tasks_by_batch(db, batch_id)
        if not tasks:
            raise ValueError(f"批次 {batch_id} 不存在")

        active_tasks = [
            task for task in tasks if task.status not in ("completed", "failed")
        ]

        # 分块 gather：避免一个批次上千个任务时一次性并发上千个协程，
        # 每个协程都开 DB 会话抢连接，打爆 SQLAlchemy 连接池（默认 ~15）。
        for i in range(0, len(active_tasks), self._SYNC_CHUNK):
            chunk = active_tasks[i : i + self._SYNC_CHUNK]
            await asyncio.gather(*[self._sync_one(task) for task in chunk])

        # 重新读取最新状态
        tasks = await get_tasks_by_batch(db, batch_id)
        return self._build_response(tasks)

    async def _sync_one(self, task: GenerationTask) -> None:
        if not task.toapis_task_id:
            return
        async with self.semaphore:
            try:
                status = await client.get_task_status(task.toapis_task_id)
            except Exception as exc:
                async with AsyncSessionLocal() as session:
                    fresh_task = await session.get(GenerationTask, task.id)
                    if fresh_task:
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
        error_msg = error.get("message") if isinstance(error, dict) else str(error) if error else None

        async with AsyncSessionLocal() as session:
            fresh_task = await session.get(GenerationTask, task.id)
            if fresh_task:
                await update_task_status(
                    session,
                    fresh_task,
                    status=new_status,
                    progress=progress,
                    image_url=image_url,
                    error_msg=error_msg,
                )

    def _build_response(
        self, tasks: Sequence[GenerationTask]
    ) -> BatchStatusResponse:
        counts = {
            "pending": 0,
            "queued": 0,
            "in_progress": 0,
            "completed": 0,
            "failed": 0,
        }
        task_outs: list[GenerationTaskOut] = []
        for task in tasks:
            counts[task.status] = counts.get(task.status, 0) + 1
            task_outs.append(
                GenerationTaskOut(
                    id=task.id,
                    batch_id=task.batch_id,
                    variant_id=task.variant_id,
                    variant_prompt=task.variant.prompt_content if task.variant else None,
                    toapis_task_id=task.toapis_task_id,
                    mode=task.mode,
                    size=task.size,
                    resolution=task.resolution,
                    status=task.status,
                    progress=task.progress,
                    image_url=task.image_url,
                    error_msg=task.error_msg,
                    template_image_url=task.template_image_url,
                    product_image_url=task.product_image_url,
                    prompt=task.prompt,
                    created_at=task.created_at,
                    completed_at=task.completed_at,
                )
            )

        return BatchStatusResponse(
            batch_id=tasks[0].batch_id,
            total=len(tasks),
            completed=counts["completed"],
            failed=counts["failed"],
            in_progress=counts["in_progress"],
            queued=counts["queued"],
            pending=counts["pending"],
            tasks=task_outs,
        )


task_poller = TaskPollerService()
