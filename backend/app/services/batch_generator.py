import asyncio
import re
from datetime import datetime, timedelta, timezone
from typing import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import settings
from backend.app.crud.generation_tasks import (
    _format_seq,
    count_failed_tasks_by_batches,
    count_today_batches,
    create_generation_tasks,
    find_existing_batch_ids,
    get_failed_tasks_by_batch,
    get_task_by_id,
    get_tasks_by_batch,
    parse_batch_id_seq,
    reset_task_for_regenerate,
    update_task_status,
)
from backend.app.crud.variant_groups import get_variant_group
from backend.app.models import GenerationTask
from backend.app.schemas import (
    AUTO_RETRY_MODELS,
    AUTO_RETRY_QUALITY,
    EXTREME_SIZES,
    MAX_AUTO_RETRY,
    QUALITY_SUPPORTED_MODELS,
    BatchGenerateRequest,
    I2iMultiCreateRequest,
    ProductSwapRequest,
    RelayConfig,
)
from backend.app.toapis_client import client

# 提取 prompt 中的宽高比占位符：{ASPECT_RATIO, e.g. 3:2} 这类写法
# （大小写不敏感，允许占位符内带示例说明文字），提交时按任务实际 size 替换
ASPECT_RATIO_PATTERN = re.compile(r"\{ASPECT_RATIO[^}]*\}", re.IGNORECASE)


def replace_aspect_ratio(prompt: str, size: str) -> str:
    """把 prompt 中的 {ASPECT_RATIO...} 占位符替换为实际生成比例。

    无占位符时原样返回；用户手动改过占位符内容同样被替换
    （匹配规则是 {} 包裹的 ASPECT_RATIO 关键字，大小写不敏感）。
    """
    if not prompt or "ASPECT_RATIO" not in prompt.upper():
        return prompt
    return ASPECT_RATIO_PATTERN.sub(size, prompt)


def _group_by_batch(
    tasks: Sequence[GenerationTask],
) -> dict[str, list[GenerationTask]]:
    """按 batch_id 把任务列表分组（保持输入顺序）。

    用于 i2i_multi 模式按批次并发提交到 ToAPIs。
    """
    grouped: dict[str, list[GenerationTask]] = {}
    for task in tasks:
        grouped.setdefault(task.batch_id, []).append(task)
    return grouped


class BatchGeneratorService:
    """批量生成服务：基于变体组创建任务并并发提交到 ToAPIs。"""

    def __init__(self):
        self.semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_GENERATIONS)
        # 用于序列化进程内的 batch_id 生成，避免并发读到的 count 相同
        self._id_lock = asyncio.Lock()
        # 自动重试防重入：并发轮询（后台轮询 + 用户查看同步）同时读到 failed 时，
        # 锁内重新读取 + 递增计数，保证同一任务只被一个协程触发重试
        self._auto_retry_lock = asyncio.Lock()

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
                # 直接赋值关系对象（不要只设 variant_id）：
                # lazy="joined" 只在查询时加载关系，新建对象只设 variant_id 的话
                # 提交协程在 session 关闭后访问 task.variant 会抛 DetachedInstanceError，
                # 协程静默崩溃 → 任务永远 pending、请求发不出去。
                variant=variant,
                mode=request.mode,
                size=request.size,
                resolution=request.resolution,
                model=request.model,
                quality=request.quality,
                status="pending",
                progress=0,
                reference_image_urls=ref_urls_str,
            )
            for variant in group.variants
        ]

        await create_generation_tasks(db, tasks)

        # 自动接力套图：裂变批次全部结束后，后台协程自动用其图片创建套图批次
        if request.relay:
            asyncio.create_task(self._relay_watch(batch_id, request.relay))

        # 后台异步提交到 ToAPIs，不阻塞前端响应
        asyncio.create_task(self._submit_to_toapis(batch_id, tasks, request))

        return batch_id, len(tasks)

    # 自动接力监控参数：轮询间隔 5 秒；总等待上限 1 小时
    _RELAY_POLL_INTERVAL = 5
    _RELAY_MAX_WAIT = timedelta(hours=1)

    async def _relay_watch(
        self, batch_id: str, relay: RelayConfig
    ) -> None:
        """监控裂变批次直至全部任务终态，然后用已完成图片自动创建套图批次。

        - 每 5 秒查一次本地状态（状态由后台轮询器 / 用户查看时同步）
        - 全部终态（completed / failed）后：收集 completed 的 image_url，
          失败任务跳过；无任何成功图片则不接力
        - 只触发一次；后续重试 / 重新生成产生的新图不重复接力（可用手动接力补）
        - 1 小时超时兜底：避免任务因异常永远 pending 导致协程死循环
          （后端进程重启会丢失本协程，属可接受限制）
        """
        from backend.app.database import AsyncSessionLocal

        deadline = datetime.now(timezone.utc) + self._RELAY_MAX_WAIT
        while datetime.now(timezone.utc) < deadline:
            async with AsyncSessionLocal() as session:
                tasks = await get_tasks_by_batch(session, batch_id)
            if tasks and all(
                t.status in ("completed", "failed") for t in tasks
            ):
                break
            await asyncio.sleep(self._RELAY_POLL_INTERVAL)
        else:
            print(f"[AutoRelay] 批次 {batch_id} 等待超时，放弃自动接力")
            return

        urls = [
            t.image_url
            for t in tasks
            if t.status == "completed" and t.image_url
        ]
        if not urls:
            print(f"[AutoRelay] 批次 {batch_id} 无已完成图片，跳过自动接力")
            return

        try:
            async with AsyncSessionLocal() as session:
                request = I2iMultiCreateRequest(
                    group_id=relay.group_id,
                    image_urls=urls,
                    prefix=relay.prefix,
                    size=relay.size,
                    resolution=relay.resolution,
                    model=relay.model,
                    quality=relay.quality,
                )
                await self.create_i2i_multi(session, request)
            print(
                f"[AutoRelay] 批次 {batch_id} 自动接力完成："
                f"{len(urls)} 张图片 → 套图批次（前缀 {relay.prefix}）"
            )
        except Exception as exc:
            print(f"[AutoRelay] 批次 {batch_id} 自动接力失败: {exc}")

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
                model=request.model,
                quality=request.quality,
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
            model=request.model,
            quality=request.quality,
            prefix=prefix,
        )
        asyncio.create_task(self._submit_to_toapis(batch_id, tasks, carrier))

        return batch_id, len(tasks)

    async def create_i2i_multi(
        self, db: AsyncSession, request: I2iMultiCreateRequest
    ) -> tuple[list[str], int, str]:
        """文件夹批量图生图：原子创建 N 个 i2i 批次。

        与 ``create_batch`` 区别：
        - 前者 1 批次 + K 变体 → K 任务，整批共用 1 张参考图
        - 本方法 N 批次 × K 变体 → N×K 任务，每批次用各自绑定的图片

        关键保证：
        1. 进程内 ``_id_lock`` 串行化 N 个 seq 的分配（多 worker 部署需额外 DB 锁）
        2. 在锁内做一次 ``find_existing_batch_ids`` 完整性校验：
           若 [base_seq, base_seq+N-1] 任意一段已被其他用户占用，整体拒绝
        3. 校验通过后一次性 INSERT 全部 N×K 条任务，全部成功才算提交
        4. 后台并发提交 ToAPIs 时复用 ``_submit_to_toapis`` ，
           ``_build_payload`` 优先用 ``task.reference_image_urls`` 拿到该批次的图

        返回 ``(batch_ids, task_count, base_batch_id)``：
        - ``batch_ids`` 按 seq 升序
        - ``task_count`` = N × K
        - ``base_batch_id`` = 实际分配的起始批次 ID
        """
        # 1) 校验变体组与 K
        group = await get_variant_group(db, request.group_id)
        if group is None:
            raise ValueError(f"变体组 {request.group_id} 不存在")
        if not group.variants:
            raise ValueError("变体组中没有可用的 Prompt 变体")
        K = len(group.variants)
        N = len(request.image_urls)

        if N * K > settings.MAX_CONCURRENT_GENERATIONS:
            # 仅给警告，不阻塞（信号量会限流；放在锁外避免无谓等待）
            pass

        prefix = request.prefix  # 已通过 schema 校验并 uppercase

        # 2) 锁内：分配 N 个连续 seq + 冲突检测
        async with self._id_lock:
            _, date_str, base_batch_id = await count_today_batches(db, prefix)
            base_seq = parse_batch_id_seq(base_batch_id, prefix, date_str)
            prefix_with_date = f"{prefix}{date_str}"

            # 预生成所有目标 batch_id（seq 升序）
            target_batch_ids = [
                f"{prefix_with_date}{_format_seq(base_seq + i)}"
                for i in range(N)
            ]

            # 一次性检查全部 seq 是否可用（find 一次往返，避免 N 次单查）
            existing = await find_existing_batch_ids(db, target_batch_ids)
            if existing:
                # 数据一致性优先：只要任一 seq 被占，整体拒绝，由用户决定如何处理
                raise ValueError(
                    f"目标 batch_id 中有 {len(existing)} 个已被占用："
                    f"{sorted(existing)}。"
                    "请删除冲突批次或更换 prefix 后重试"
                )

            # 3) 构造 N×K 个 GenerationTask（按 seq 升序 / variant 顺序）
            all_tasks: list[GenerationTask] = []
            for batch_id, image_url in zip(target_batch_ids, request.image_urls):
                for variant in group.variants:
                    all_tasks.append(
                        GenerationTask(
                            batch_id=batch_id,
                            # 直接赋值关系对象（见 create_batch 注释：只设 variant_id
                            # 会导致提交协程 detached 访问 task.variant 崩溃）
                            variant=variant,
                            mode="i2i_multi",
                            size=request.size,
                            resolution=request.resolution,
                            model=request.model,
                            quality=request.quality,
                            status="pending",
                            progress=0,
                            # i2i_multi 关键：把"绑定到该批次的图"写到 task 级别
                            # _build_payload 会优先读这里（避免污染 request 级共享字段）
                            reference_image_urls=image_url,
                        )
                    )

            # 4) 一次性 INSERT（要么全成要么全失败 - 内部 commit 由 crud 完成）
            await create_generation_tasks(db, all_tasks)

        # 5) 后台并发提交到 ToAPIs（分批：每个 batch_id 一组，对应 K 个任务）
        # 用一个最小 BatchGenerateRequest 作为 carrier，让 _build_payload 拿到公共字段
        # 注意：必须 fire-and-forget（asyncio.create_task），不能 await，
        # 否则响应会等所有 ToAPIs 任务入队完成才返回，用户体验差且占用请求连接
        carrier = BatchGenerateRequest(
            group_id=request.group_id,
            mode="i2i_multi",  # type: ignore[arg-type]
            size=request.size,
            resolution=request.resolution,
            model=request.model,
            quality=request.quality,
            prefix=prefix,
        )
        # 按 batch_id 分组，每个 batch 一个后台协程，信号量会在 submit_one 内限流
        for batch_id, batch_tasks in _group_by_batch(all_tasks).items():
            asyncio.create_task(self._submit_to_toapis(batch_id, batch_tasks, carrier))

        return target_batch_ids, N * K, base_batch_id

    async def allocate_batch_id(self, db: AsyncSession, prefix: str) -> str:
        """公开分配一个批次号（{prefix}{MMDD}{seq}，进程内串行化）。"""
        async with self._id_lock:
            return await self._generate_batch_id(db, prefix)

    async def create_extract_batch(
        self,
        db: AsyncSession,
        *,
        batch_id: str,
        prompt: str,
        items: Sequence[dict],
        resolution: str,
        model: str,
        quality: str | None,
    ) -> tuple[str, list[GenerationTask]]:
        """提取产品图模式：1 批次 + N 任务，每个任务一张独立参考图 + 统一 prompt。

        ``items``: [{order_item_id, input_image_url, size, model?}]，size 已由调用方
        映射为预设比例（auto 按订单尺寸 / fixed 全统一）。item 可带 ``model``
        覆盖任务级模型（极端宽高比货号自动用 gemini，其余沿用全局模型）。
        任务与订单条目的关联（erp_order_items.generation_task_id）由调用方在返回后处理。

        ``batch_id`` 由调用方显式传入：
        - 工厂自动化：店铺名-货号（每个货号一个批次，可读可追溯）
        - 用户自定义：allocate_batch_id 分配的 {prefix}{MMDD}{seq}

        与 product_swap 的区别：每任务一张输入图（不是模板+产品两张），
        reference_image_urls 直接存输入图 URL，prompt 存任务级。
        """
        if not items:
            raise ValueError("没有可生成的订单/图片")
        if not batch_id or len(batch_id) > 36:
            raise ValueError(f"batch_id 非法（长度 1-36）: {batch_id!r}")

        tasks: list[GenerationTask] = []
        for item in items:
            input_url = item["input_image_url"]
            if not input_url:
                continue
            task_model = item.get("model") or model
            # gemini 模型不支持 quality 档位
            task_quality = quality if task_model in QUALITY_SUPPORTED_MODELS else None
            tasks.append(
                GenerationTask(
                    batch_id=batch_id,
                    variant_id=None,
                    mode="extract",
                    size=item["size"],
                    resolution=resolution,
                    model=task_model,
                    quality=task_quality,
                    status="pending",
                    progress=0,
                    # 每个任务按自身比例替换 {ASPECT_RATIO} 占位符
                    # （auto 映射下各任务比例可能不同，逐任务替换最准确）
                    prompt=replace_aspect_ratio(prompt, item["size"]),
                    # 每任务独立输入图（与 i2i_multi 相同语义）
                    reference_image_urls=input_url,
                )
            )
        if not tasks:
            raise ValueError("没有可生成的订单/图片")

        await create_generation_tasks(db, tasks)

        carrier = BatchGenerateRequest(
            group_id=1,  # extract 不依赖变体，仅占位
            mode="extract",
            size=tasks[0].size,
            resolution=resolution,
            model=model,
            quality=quality,
            prefix="EXT",  # 占位；_build_payload 对 extract 模式用 task.size
        )
        asyncio.create_task(self._submit_to_toapis(batch_id, tasks, carrier))
        return batch_id, tasks

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
                try:
                    payload = self._build_payload(task, request)
                    response = await client.create_generation(payload)
                except Exception as exc:
                    # 任何提交异常（含 payload 构建失败）都落库 failed，
                    # 绝不能静默吞掉——否则任务永远 pending、请求发不出去
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

        # 分块 gather：K 变体 × 500 批次 = 数千任务时，
        # 一次性 gather 全部协程会同时开数千个 DB 会话抢连接（连接池已放大
        # 到 100，但仍不该让提交风暴把池打满），分块让 DB 写操作平滑排队。
        submit_chunk = 100
        for i in range(0, len(tasks), submit_chunk):
            chunk = tasks[i : i + submit_chunk]
            await asyncio.gather(*[submit_one(task) for task in chunk])

    async def retry_failed(
        self, db: AsyncSession, batch_id: str
    ) -> tuple[str, int]:
        """重试批次中状态为失败的任务。

        将失败任务重置为 pending 并在后台重新提交到 ToAPIs。
        """
        failed_tasks = await get_failed_tasks_by_batch(db, batch_id)
        if not failed_tasks:
            raise ValueError(f"批次 {batch_id} 没有失败任务可重试")

        await self._reset_and_resubmit(db, batch_id, failed_tasks)
        return batch_id, len(failed_tasks)

    async def retry_failed_batches(
        self, db: AsyncSession, batch_ids: list[str]
    ) -> tuple[list[str], int, list[str]]:
        """跨批次一键重试失败任务（近期批次总览页「重试已选批次」）。

        - 只重试「确实存在 failed 任务」的批次，其余批次跳过并返回
        - 每个批次独立后台提交（互不影响，一个批次失败不影响其他）
        - 返回 ``(retried_batch_ids, retried_task_count, skipped_batch_ids)``
        """
        # 先做批次存在性校验：批量查这些批次是否真实存在
        existing = await find_existing_batch_ids(db, batch_ids)
        # 每个批次的失败任务数（决定哪些批次真正需要重试）
        failed_counts = await count_failed_tasks_by_batches(db, batch_ids)

        retried_batch_ids: list[str] = []
        skipped_batch_ids: list[str] = []
        retried_task_count = 0

        for batch_id in batch_ids:
            if batch_id not in existing:
                # 批次不存在（已被删除等）：跳过，不报错
                skipped_batch_ids.append(batch_id)
                continue
            failed_count = failed_counts.get(batch_id, 0)
            if failed_count == 0:
                # 没有失败任务：跳过
                skipped_batch_ids.append(batch_id)
                continue

            failed_tasks = await get_failed_tasks_by_batch(db, batch_id)
            await self._reset_and_resubmit(db, batch_id, failed_tasks)
            retried_batch_ids.append(batch_id)
            retried_task_count += len(failed_tasks)

        return retried_batch_ids, retried_task_count, skipped_batch_ids

    async def maybe_auto_retry(
        self, db: AsyncSession, task: GenerationTask
    ) -> bool:
        """任务失败后的自动重试：按模型阶梯逐级升级换模型重新提交。

        阶梯（AUTO_RETRY_MODELS，共 3 次）：
        - 第 1 次：gpt-image-2（原配置）
        - 第 2 次：gpt-image-2-vip + quality=medium
        - 第 3 次：gemini-3.1-flash-image-preview

        规则：
        - auto_retry_count >= 3 不再自动重试（保留用户手动重试；手动重试不清零计数）
        - 防重入：锁内重新读取任务，仅当仍为 failed 且未达上限才触发
        - 重置时刷新 created_at（轮询器 5 分钟超时从本次重试重新计时）
        - 换模型后更新 task.model/quality：任务卡徽章展示新模型，
          后续用户手动重试也跟随最新模型

        返回是否触发了重试。
        """
        if task.auto_retry_count >= MAX_AUTO_RETRY:
            return False

        # 极端宽高比任务跳过自动重试：重试阶梯（gpt→vip→gemini preview）
        # 都不支持 4:1/8:1，自动重试必然再次失败（浪费调用）。
        # 由用户手动重试（手动重试会用任务当前模型=官方 gemini 渠道）。
        if task.size in EXTREME_SIZES:
            return False

        async with self._auto_retry_lock:
            fresh = await db.get(GenerationTask, task.id)
            if (
                fresh is None
                or fresh.status != "failed"
                or fresh.auto_retry_count >= MAX_AUTO_RETRY
            ):
                return False

            step = fresh.auto_retry_count
            model = AUTO_RETRY_MODELS[step]

            # 重置任务状态（复用 retry 的字段重置语义）
            fresh.status = "pending"
            fresh.progress = 0
            fresh.image_url = None
            fresh.error_msg = None
            fresh.toapis_task_id = None
            fresh.completed_at = None
            fresh.created_at = datetime.now(timezone.utc)
            fresh.auto_retry_count = step + 1
            fresh.model = model
            fresh.quality = AUTO_RETRY_QUALITY.get(model)
            await db.commit()

        # 后台异步重新提交（fire-and-forget；信号量限流）
        request = BatchGenerateRequest(
            group_id=fresh.variant_id or 1,
            mode=fresh.mode,  # type: ignore[arg-type]
            size=fresh.size,
            resolution=fresh.resolution,  # type: ignore[arg-type]
            model=fresh.model or "gpt-image-2",
            quality=fresh.quality,  # type: ignore[arg-type]
            reference_image_urls=(
                fresh.reference_image_urls.split(",")
                if fresh.reference_image_urls
                else []
            ),
        )
        asyncio.create_task(
            self._submit_to_toapis(fresh.batch_id, [fresh], request)
        )
        return True

    async def _reset_and_resubmit(
        self, db: AsyncSession, batch_id: str, failed_tasks: Sequence[GenerationTask]
    ) -> None:
        """重置一批失败任务为 pending，并在后台重新提交到 ToAPIs。

        - 重置时刷新 created_at：让轮询器的 5 分钟超时从本次重试重新计时，
          否则隔天重试的任务会因 created_at 是昨天的而被立即判超时标 failed
        - 单个批次一个后台协程（内部按 chunk 分块提交），多批次互不影响
        """
        for task in failed_tasks:
            task.status = "pending"
            task.progress = 0
            task.image_url = None
            task.error_msg = None
            task.toapis_task_id = None
            task.completed_at = None
            task.created_at = datetime.now(timezone.utc)
            # 重试计数 +1：近期批次总览页据此识别「重试过的批次」
            task.retried_count = (task.retried_count or 0) + 1
        await db.commit()

        # 重建请求对象用于提交；group_id 仅用于 schema 校验，重试逻辑不依赖它
        first = failed_tasks[0]
        request = BatchGenerateRequest(
            group_id=first.variant_id or 1,
            mode=first.mode,  # type: ignore[arg-type]
            size=first.size,
            resolution=first.resolution,  # type: ignore[arg-type]
            model=first.model or "gpt-image-2",
            quality=first.quality,  # type: ignore[arg-type]
            reference_image_urls=(
                first.reference_image_urls.split(",")
                if first.reference_image_urls
                else []
            ),
        )

        # 后台异步重新提交
        asyncio.create_task(self._submit_to_toapis(batch_id, failed_tasks, request))

    def _build_payload(
        self, task: GenerationTask, request: BatchGenerateRequest
    ) -> dict:
        """按模型构建 ToAPIs 请求体。

        模型差异（对齐 ToAPIs 文档）：
        - gpt-image-2：顶层 resolution（1k/2k/4k），无 quality
        - gpt-image-2-vip：顶层 resolution + quality（low/medium/high）
        - gemini-3.1-flash-image-preview：resolution 在 metadata（大写 1K/2K/4K），
          无 quality（与 gpt-image-2 同逻辑）

        task 上持久化的 model/quality 是权威（重试/重新生成时原样复用），
        缺失时回退到 request（向后兼容旧数据）。
        """
        model = task.model or request.model or "gpt-image-2"
        quality = task.quality or request.quality

        payload: dict = {
            "model": model,
            "size": request.size,
            "n": 1,
            "response_format": "url",
        }
        # extract 模式：每任务独立 size（auto 映射按订单尺寸，可能各不相同）
        if task.mode == "extract" and task.size:
            payload["size"] = task.size

        if model == "gpt-image-2-vip":
            payload["resolution"] = request.resolution
            if quality:
                payload["quality"] = quality
        elif model in (
            "gemini-3.1-flash-image-preview",
            "gemini-3.1-flash-image-preview-official",
        ):
            # 两个 gemini 渠道（W8X 中转 / Vertex 官方直连）均使用
            # metadata.resolution（大写 1K/2K/4K），官方渠道额外支持 4:1/8:1
            payload["metadata"] = {"resolution": request.resolution.upper()}
        else:  # gpt-image-2 及未知模型：保持原有行为
            payload["resolution"] = request.resolution

        # prompt 优先级：product_swap 模式从 task.prompt 取（避免污染 variant_groups），
        # 其他模式从 variant.prompt_content 取（向后兼容）
        if task.prompt is not None:
            payload["prompt"] = task.prompt
        elif task.variant is not None:
            payload["prompt"] = task.variant.prompt_content
        else:
            payload["prompt"] = ""

        # 参考图优先级（保证每个模式的"语义边界"清晰可读）：
        # 1. i2i_multi 模式：用 task.reference_image_urls（每任务独立参考图）
        #    - 由 create_i2i_multi 在 task 级别写入，不依赖 request 级共享
        # 2. extract / extract_custom 模式：同 i2i_multi，每任务独立输入图
        # 3. product_swap 模式：用 [template, product]
        # 4. i2i 模式：用 request.reference_image_urls（批次内共享）
        if task.mode in ("i2i_multi", "extract", "extract_custom") and task.reference_image_urls:
            payload["reference_images"] = task.reference_image_urls.split(",")
        elif task.mode == "product_swap" and task.template_image_url and task.product_image_url:
            payload["reference_images"] = [
                task.template_image_url,
                task.product_image_url,
            ]
        elif request.mode == "i2i" and request.reference_image_urls:
            payload["reference_images"] = request.reference_image_urls

        return payload

    async def regenerate_task(
        self,
        db: AsyncSession,
        batch_id: str,
        task_id: int,
        model: str | None = None,
        quality: str | None = None,
        size: str | None = None,
        resolution: str | None = None,
        prompt: str | None = None,
    ) -> GenerationTask:
        """重新生成单个任务：重置状态后重新提交到 ToAPIs。

        复用现有任务记录（task_id 不变），仅替换远端生成结果。已结束的任务
        （completed/failed）可重新生成，进行中的任务拒绝以避免重复扣费。

        model / quality：用户可在此覆盖生成模型与精度（前端"重新生成"弹窗）；
        不传则沿用任务当前值。换到不支持精度的模型时清空 quality，
        避免残留导致后续手动重试重建请求时被 schema 校验拒绝（422）。

        size / resolution：可选覆盖（提取产品图模式重新生成允许调整尺寸）；
        不传则沿用任务原配置。size 单独覆盖时 resolution 必须同时覆盖。

        prompt：可选覆盖（提取产品图模式与前端文本框实时同步）；
        不传则沿用任务创建时保存的 prompt 快照。
        """
        task = await get_task_by_id(db, task_id)
        if task is None or task.batch_id != batch_id:
            raise ValueError(f"任务 {task_id} 不属于批次 {batch_id}")
        if task.status not in ("completed", "failed"):
            raise ValueError(
                f"任务当前状态为 {task.status}，仅已完成/失败的任务可重新生成"
            )

        # 模型覆盖 + 精度校正（防残留）
        if model is not None:
            task.model = model
            if model in QUALITY_SUPPORTED_MODELS:
                task.quality = quality or task.quality or "medium"
            else:
                task.quality = None
        elif quality is not None:
            task.quality = quality

        # 尺寸/分辨率覆盖（必须成对提供，schema 已校验）
        if size is not None and resolution is not None:
            task.size = size
            task.resolution = resolution

        # prompt 覆盖（与前端文本框实时同步）
        if prompt is not None:
            task.prompt = prompt

        await reset_task_for_regenerate(db, task)

        # 重建提交参数（参考 retry_failed 写法，group_id 不参与提交逻辑）
        request = BatchGenerateRequest(
            group_id=task.variant_id or 1,
            mode=task.mode,  # type: ignore[arg-type]
            size=task.size,
            resolution=task.resolution,  # type: ignore[arg-type]
            model=task.model or "gpt-image-2",
            quality=task.quality,  # type: ignore[arg-type]
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
