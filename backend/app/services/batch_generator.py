import asyncio
from datetime import datetime
from typing import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import settings
from backend.app.crud.generation_tasks import (
    count_today_batches,
    create_generation_tasks,
    get_failed_tasks_by_batch,
    get_task_by_id,
    reset_task_for_regenerate,
    update_task_status,
)
from backend.app.crud.variant_groups import get_variant_group
from backend.app.models import GenerationTask
from backend.app.schemas import BatchGenerateRequest, ProductSwapRequest
from backend.app.toapis_client import client


class BatchGeneratorService:
    """批量生成服务：基于变体组创建任务并并发提交到 ToAPIs。"""

    def __init__(self):
        self.semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_GENERATIONS)
        # 用于序列化进程内的 batch_id 生成，避免并发读到的 count 相同
        self._id_lock = asyncio.Lock()

    async def create_batch(
        self, db: AsyncSession, request: BatchGenerateRequest
    ) -> tuple[str, int]:
        group = await get_variant_group(db, request.group_id)
        if group is None:
            raise ValueError(f"变体组 {request.group_id} 不存在")
        if not group.variants:
            raise ValueError("变体组中没有可用的 Prompt 变体")
        if len(group.variants) > settings.MAX_CONCURRENT_GENERATIONS:
            raise ValueError(
                f"变体数量 {len(group.variants)} 超过最大并发限制 "
                f"{settings.MAX_CONCURRENT_GENERATIONS}"
            )

        prefix = request.prefix  # 已通过 schema 校验并 uppercase
        async with self._id_lock:
            batch_id = await self._generate_batch_id(db, prefix)

        ref_urls_str = (
            ",".join(request.reference_image_urls or []) or None
        )

        tasks = [
            GenerationTask(
                batch_id=batch_id,
                variant_id=variant.id,
                mode=request.mode,
                size=request.size,
                resolution=request.resolution,
                status="pending",
                progress=0,
                reference_image_urls=ref_urls_str,
            )
            for variant in group.variants
        ]

        await create_generation_tasks(db, tasks)

        # 后台异步提交到 ToAPIs，不阻塞前端响应
        asyncio.create_task(self._submit_to_toapis(batch_id, tasks, request))

        return batch_id, len(tasks)

    async def _generate_batch_id(self, db: AsyncSession, prefix: str) -> str:
        """生成 batch_id，格式 `{prefix}{MMDD}{seq}`。

        直接调用 ``count_today_batches`` 复用"最小未使用 seq"算法，
        保证：
        - 填空隙：删除中间批次后下一个 seq 自动回收空洞
        - 无死循环：旧实现 ``count(distinct)+1`` 在存在删除空洞时会
          算出已存在的 seq，导致循环 1000 次后抛 RuntimeError

        进程内串行化由 ``self._id_lock`` 保证（避免两个并发请求同时
        拿到同一个 next_batch_id）。
        """
        _, _, next_batch_id = await count_today_batches(db, prefix)
        return next_batch_id

    async def create_product_swap(
        self, db: AsyncSession, request: ProductSwapRequest
    ) -> tuple[str, int]:
        """产品替换模式：创建 1 个批次 + N 个任务（每个产品 1 个任务）。

        与 ``create_batch`` 区别：
        - 不依赖 variant_group，每个任务有独立 product_image_url
        - 共用 prompt / template_image_url（存到 task 字段，不污染 variant_groups 表）
        - reference_image_urls 仍写 ``"{template},{product}"``，保证 retry/regenerate
          路径从 CSV 切分重建 payload 仍然正确
        """
        if not request.product_image_urls:
            raise ValueError("product_swap 模式必须提供至少 1 个产品图 URL")

        prefix = request.prefix
        async with self._id_lock:
            batch_id = await self._generate_batch_id(db, prefix)

        tasks = [
            GenerationTask(
                batch_id=batch_id,
                variant_id=None,  # product_swap 不依赖变体
                mode="product_swap",
                size=request.size,
                resolution=request.resolution,
                status="pending",
                progress=0,
                template_image_url=request.template_image_url,
                product_image_url=product_url,
                prompt=request.prompt,
                # 保持 CSV 兼容 retry/regenerate：写入 [template, product]
                reference_image_urls=f"{request.template_image_url},{product_url}",
            )
            for product_url in request.product_image_urls
        ]

        await create_generation_tasks(db, tasks)

        # 后台异步提交到 ToAPIs（与 create_batch 共用 _submit_to_toapis）
        # 注意：传一个最小 BatchGenerateRequest 让 _submit_one 拿到 mode/size/resolution，
        # _build_payload 会按 product_swap 模式从 task 字段读 [template, product]
        carrier = BatchGenerateRequest(
            group_id=1,  # product_swap 不需要真实 group_id，仅占位
            mode="product_swap",
            size=request.size,
            resolution=request.resolution,
            prefix=prefix,
        )
        asyncio.create_task(self._submit_to_toapis(batch_id, tasks, carrier))

        return batch_id, len(tasks)

    async def _submit_to_toapis(
        self,
        batch_id: str,
        tasks: Sequence[GenerationTask],
        request: BatchGenerateRequest,
    ) -> None:
        """在后台使用信号量并发提交生成任务。"""
        from backend.app.database import AsyncSessionLocal

        async def submit_one(task: GenerationTask) -> None:
            async with self.semaphore:
                payload = self._build_payload(task, request)
                try:
                    response = await client.create_generation(payload)
                    toapis_task_id = response.get("id")
                    async with AsyncSessionLocal() as session:
                        fresh_task = await session.get(GenerationTask, task.id)
                        if fresh_task:
                            await update_task_status(
                                session,
                                fresh_task,
                                status=response.get("status", "queued"),
                                progress=response.get("progress", 0),
                                toapis_task_id=toapis_task_id,
                            )
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

        await asyncio.gather(*[submit_one(task) for task in tasks])

    async def retry_failed(
        self, db: AsyncSession, batch_id: str
    ) -> tuple[str, int]:
        """重试批次中状态为失败的任务。

        将失败任务重置为 pending 并在后台重新提交到 ToAPIs。
        """
        failed_tasks = await get_failed_tasks_by_batch(db, batch_id)
        if not failed_tasks:
            raise ValueError(f"批次 {batch_id} 没有失败任务可重试")

        # 重置任务状态
        for task in failed_tasks:
            await update_task_status(
                db,
                task,
                status="pending",
                progress=0,
                image_url=None,
                error_msg=None,
                toapis_task_id=None,
            )

        # 重建请求对象用于提交；group_id 仅用于 schema 校验，重试逻辑不依赖它
        request = BatchGenerateRequest(
            group_id=failed_tasks[0].variant_id or 1,
            mode=failed_tasks[0].mode,  # type: ignore[arg-type]
            size=failed_tasks[0].size,
            resolution=failed_tasks[0].resolution,  # type: ignore[arg-type]
            reference_image_urls=(
                failed_tasks[0].reference_image_urls.split(",")
                if failed_tasks[0].reference_image_urls
                else []
            ),
        )

        # 后台异步重新提交
        asyncio.create_task(self._submit_to_toapis(batch_id, failed_tasks, request))

        return batch_id, len(failed_tasks)

    def _build_payload(
        self, task: GenerationTask, request: BatchGenerateRequest
    ) -> dict:
        payload: dict = {
            "model": "gpt-image-2",
            "size": request.size,
            "resolution": request.resolution,
            "n": 1,
            "response_format": "url",
        }
        # prompt 优先级：product_swap 模式从 task.prompt 取（避免污染 variant_groups），
        # 其他模式从 variant.prompt_content 取（向后兼容）
        if task.prompt is not None:
            payload["prompt"] = task.prompt
        elif task.variant is not None:
            payload["prompt"] = task.variant.prompt_content
        else:
            payload["prompt"] = ""

        # 参考图：product_swap 模式用 [template, product]，其他模式沿用 reference_image_urls
        if task.mode == "product_swap" and task.template_image_url and task.product_image_url:
            payload["reference_images"] = [
                task.template_image_url,
                task.product_image_url,
            ]
        elif request.mode == "i2i" and request.reference_image_urls:
            payload["reference_images"] = request.reference_image_urls

        return payload

    async def regenerate_task(
        self, db: AsyncSession, batch_id: str, task_id: int
    ) -> GenerationTask:
        """重新生成单个任务：重置状态后重新提交到 ToAPIs。

        复用现有任务记录（task_id 不变），仅替换远端生成结果。已结束的任务
        （completed/failed）可重新生成，进行中的任务拒绝以避免重复扣费。
        """
        task = await get_task_by_id(db, task_id)
        if task is None or task.batch_id != batch_id:
            raise ValueError(f"任务 {task_id} 不属于批次 {batch_id}")
        if task.status not in ("completed", "failed"):
            raise ValueError(
                f"任务当前状态为 {task.status}，仅已完成/失败的任务可重新生成"
            )

        await reset_task_for_regenerate(db, task)

        # 重建提交参数（参考 retry_failed 写法，group_id 不参与提交逻辑）
        request = BatchGenerateRequest(
            group_id=task.variant_id or 1,
            mode=task.mode,  # type: ignore[arg-type]
            size=task.size,
            resolution=task.resolution,  # type: ignore[arg-type]
            reference_image_urls=(
                task.reference_image_urls.split(",")
                if task.reference_image_urls
                else []
            ),
        )

        # 后台异步重新提交
        asyncio.create_task(self._submit_to_toapis(batch_id, [task], request))

        return task


batch_generator = BatchGeneratorService()
