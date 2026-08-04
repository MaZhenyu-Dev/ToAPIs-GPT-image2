from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models import GenerationTask, TitleTask


# ---------- 查询辅助 ----------

async def get_title_task_by_id(
    db: AsyncSession, title_task_id: int
) -> TitleTask | None:
    """按 ID 查询 TitleTask；找不到返回 None。"""
    result = await db.execute(
        select(TitleTask).where(TitleTask.id == title_task_id)
    )
    return result.scalar_one_or_none()


async def get_completed_images_by_batch(
    db: AsyncSession, batch_id: str
) -> list[GenerationTask]:
    """查询某批次中所有可作为标题底图的图片（status=completed 且 image_url 非空）。

    按 id 升序返回，调用方按列表顺序构造 1-based 索引（即「第 K 张图」语义）。
    """
    result = await db.execute(
        select(GenerationTask)
        .where(
            and_(
                GenerationTask.batch_id == batch_id,
                GenerationTask.status == "completed",
                GenerationTask.image_url.isnot(None),
                GenerationTask.image_url != "",
            )
        )
        .order_by(GenerationTask.id)
    )
    return list(result.scalars().all())


async def get_completed_image_count_by_batch(
    db: AsyncSession, batch_ids: list[str]
) -> dict[str, int]:
    """批量查询多个批次的「已完成图」数量，1 次往返避免 N+1。

    返回 {batch_id: count}，未出现的 batch_id 表示 0 张（需要在前端做交集合规）。
    """
    if not batch_ids:
        return {}
    result = await db.execute(
        select(
            GenerationTask.batch_id,
            func.count().label("cnt"),
        )
        .where(
            and_(
                GenerationTask.batch_id.in_(batch_ids),
                GenerationTask.status == "completed",
                GenerationTask.image_url.isnot(None),
                GenerationTask.image_url != "",
            )
        )
        .group_by(GenerationTask.batch_id)
    )
    return {row.batch_id: int(row.cnt) for row in result.all()}


async def get_nth_completed_image(
    db: AsyncSession, batch_id: str, image_index: int
) -> GenerationTask | None:
    """取某批次中第 image_index 张已完成图片（1-based），不存在返回 None。

    实现方式：取该批次所有已完成图后用 Python 切片；image_index 越界返回 None。
    对于"少则几十张"的任务量级足够简单，避开数据库特定的 LIMIT/OFFSET 子查询方言。
    """
    if image_index < 1:
        return None
    images = await get_completed_images_by_batch(db, batch_id)
    if len(images) < image_index:
        return None
    return images[image_index - 1]


# ---------- 写入 ----------

async def create_title_task(
    db: AsyncSession,
    source_task: Optional[GenerationTask],
    batch_id: str,
    source_image_url: str,
    model: str,
    prompt_snapshot: str,
    extra_instructions: Optional[str] = None,
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
    regenerated_count: int = 0,
) -> TitleTask:
    """创建一条 TitleTask 记录，初始状态为 pending。"""
    title_task = TitleTask(
        source_task_id=source_task.id if source_task else None,
        batch_id=batch_id,
        source_image_url=source_image_url,
        model=model,
        prompt_snapshot=prompt_snapshot,
        extra_instructions=extra_instructions,
        max_tokens=max_tokens,
        temperature=temperature,
        regenerated_count=regenerated_count,
        status="pending",
    )
    db.add(title_task)
    await db.commit()
    await db.refresh(title_task)
    return title_task


async def update_title_task_result(
    db: AsyncSession,
    title_task: TitleTask,
    *,
    status: str,
    title: Optional[str] = None,
    error_msg: Optional[str] = None,
) -> TitleTask:
    """把 TitleTask 状态推进到 completed / failed，并写入结果。"""
    title_task.status = status
    if status == "completed":
        title_task.title = title
        title_task.error_msg = None
        title_task.completed_at = datetime.now(timezone.utc)
    elif status == "failed":
        title_task.title = None
        title_task.error_msg = error_msg
        title_task.completed_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(title_task)
    return title_task


async def mark_title_task_in_progress(db: AsyncSession, title_task: TitleTask) -> TitleTask:
    """把 TitleTask 标记为 in_progress（已发出请求，等待模型响应）。"""
    title_task.status = "in_progress"
    await db.commit()
    await db.refresh(title_task)
    return title_task


# ---------- 列表 / 分页 ----------

async def list_title_tasks(
    db: AsyncSession,
    *,
    batch_id: Optional[str] = None,
    batch_ids: Optional[list[str]] = None,
    source_task_id: Optional[int] = None,
    source_task_ids: Optional[list[int]] = None,
    status: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[TitleTask], int]:
    """分页查询 TitleTask，支持 batch_id / batch_ids / source_task_id / source_task_ids / status 过滤。

    - batch_id 与 batch_ids 二选一；同时给定时 batch_ids 优先生效
    - source_task_id 与 source_task_ids 二选一；同时给定时 source_task_ids 优先生效
    - batch_ids / source_task_ids 传空列表时直接返回 ([], 0)，避免 IN () 报错
    - 返回 (items, total)。按 created_at DESC + id DESC 排序（最新在前）
    """
    filters = []
    if batch_ids is not None:
        if not batch_ids:
            return [], 0
        filters.append(TitleTask.batch_id.in_(batch_ids))
    elif batch_id is not None:
        filters.append(TitleTask.batch_id == batch_id)
    if source_task_ids is not None:
        if not source_task_ids:
            return [], 0
        filters.append(TitleTask.source_task_id.in_(source_task_ids))
    elif source_task_id is not None:
        filters.append(TitleTask.source_task_id == source_task_id)
    if status is not None:
        filters.append(TitleTask.status == status)

    # 总数
    count_query = select(func.count()).select_from(TitleTask)
    if filters:
        count_query = count_query.where(and_(*filters))
    total = int((await db.execute(count_query)).scalar_one() or 0)

    # 列表
    offset = (page - 1) * page_size
    query = select(TitleTask)
    if filters:
        query = query.where(and_(*filters))
    query = query.order_by(TitleTask.created_at.desc(), TitleTask.id.desc())
    query = query.offset(offset).limit(page_size)
    items = list((await db.execute(query)).scalars().all())
    return items, total


async def delete_title_task(db: AsyncSession, title_task_id: int) -> bool:
    """单条删除；返回是否真的删了。"""
    result = await db.execute(
        delete(TitleTask).where(TitleTask.id == title_task_id)
    )
    await db.commit()
    return (result.rowcount or 0) > 0


async def delete_title_tasks_bulk(
    db: AsyncSession, title_task_ids: list[int]
) -> int:
    """批量删除；返回实际删除条数。"""
    if not title_task_ids:
        return 0
    result = await db.execute(
        delete(TitleTask).where(TitleTask.id.in_(title_task_ids))
    )
    await db.commit()
    return int(result.rowcount or 0)


# ---------- 工具 ----------

async def count_titles_by_source_task(
    db: AsyncSession, source_task_id: int
) -> int:
    """统计某源任务累计创建过多少条 TitleTask（含首次 + 重新生成），用于 regenerated_count。"""
    result = await db.execute(
        select(func.count()).where(TitleTask.source_task_id == source_task_id)
    )
    return int(result.scalar_one() or 0)


# ---------- 导出 CSV ----------

async def get_latest_completed_titles_for_export(
    db: AsyncSession,
    batch_ids: list[str] | None = None,
    limit: int = 50000,
) -> list[TitleTask]:
    """导出 CSV 用：取每个 source_task_id 的「最新一条 completed」标题。

    设计要点：
    - 同一 source_task_id 可能因"重新生成"产生多条 TitleTask 记录，
      导出时只保留最新的一条（按 created_at + id 倒序取 1）。
    - 可选按 batch_ids 过滤（前端"只导出我选中的批次"场景）。
    - 默认上限 5 万条，防止误操作全表扫。

    实现：用窗口函数的替代方案：先按 source_task_id NOT NULL 分组取 max(id)，
    再 join 回原表拿完整行。SQLAlchemy 2.x 异步可写成两条 SELECT，
    比子查询窗口函数更直观 + 兼容性更好。
    """
    if limit <= 0:
        return []

    # Step 1: 找出每个 source_task_id 的最新一条 title_task.id
    # - 只考虑 status='completed' 的记录（pending/in_progress/failed 都不导出）
    # - 只考虑 source_task_id NOT NULL（SET NULL 的孤儿记录不参与）
    inner_filters = [
        TitleTask.source_task_id.isnot(None),
        TitleTask.status == "completed",
    ]
    if batch_ids:
        inner_filters.append(TitleTask.batch_id.in_(batch_ids))

    subq = (
        select(
            TitleTask.source_task_id.label("src"),
            func.max(TitleTask.id).label("max_id"),
        )
        .where(and_(*inner_filters))
        .group_by(TitleTask.source_task_id)
        .subquery()
    )

    # Step 2: 拿回最新一条的完整记录
    # 排序：先按 batch_id 数值升序（同前缀同日时让 seq 小的排前面，CSV 输出顺序更直观），
    #       再按 id 升序作为稳定 tie-breaker。
    # 同样要注意 _format_seq 对 seq ≥ 100 走自然格式（"100"），
    # 纯字典序会让 "MT0803100" < "MT080301"（'1' < '0'），与数值序相反。
    # 因此先按 LENGTH(batch_id) ASC 让"位数少 = seq 更小"先成立，
    # 等长时再字典序 = 数值序。
    stmt = (
        select(TitleTask)
        .join(subq, TitleTask.id == subq.c.max_id)
        .order_by(
            func.length(TitleTask.batch_id).asc(),
            TitleTask.batch_id.asc(),
            TitleTask.id.asc(),
        )
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())
