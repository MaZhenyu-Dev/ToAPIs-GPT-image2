from datetime import datetime, timedelta, timezone
from sqlalchemy import case, delete, distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models import GenerationTask

# 北京时区（UTC+8），用于生成 batch_id 中的日期部分及今日批次统计
# 集中在此处供 services.batch_generator 与 routers.batch 共同引用，
# 避免循环依赖。
BEIJING_TZ = timezone(timedelta(hours=8))


def _format_seq(seq: int) -> str:
    """格式化批次序号：1->"01", 9->"09", 10->"10", 100->"100"。"""
    return f"{seq:02d}" if seq < 100 else str(seq)


def parse_batch_id_seq(batch_id: str, prefix: str, date_str: str) -> int:
    """从 batch_id 中解析出 seq 整数部分。

    用于 i2i_multi 模式在拿到 ``next_batch_id`` 后推算 N 个连续 seq。
    失败时抛 ValueError，调用方需将其转译为用户可读的错误信息。
    """
    prefix_with_date = f"{prefix}{date_str}"
    if not batch_id.startswith(prefix_with_date):
        raise ValueError(
            f"batch_id {batch_id!r} 不以 {prefix_with_date!r} 开头，"
            "无法解析 seq"
        )
    seq_str = batch_id[len(prefix_with_date):]
    return int(seq_str)


async def find_existing_batch_ids(
    db: AsyncSession, batch_ids: list[str]
) -> set[str]:
    """批量查询已存在的 batch_id（用于 i2i_multi 模式的 seq 冲突检测）。

    一次往返完成 N 个 seq 的存在性检查，避免在锁内做 N 次单点查询。
    """
    if not batch_ids:
        return set()
    result = await db.execute(
        select(GenerationTask.batch_id)
        .where(GenerationTask.batch_id.in_(batch_ids))
        .distinct()
    )
    return {row[0] for row in result.fetchall()}


async def create_generation_tasks(
    db: AsyncSession, tasks: list[GenerationTask]
) -> list[GenerationTask]:
    """批量创建任务。

    **性能说明**：i2i_multi 一次最多 500 张图 × K 变体 = 上万条任务。
    - 用 ``add_all`` + 单次 commit，一条 INSERT 语句批量写入；
    - **不要**对每个 task 做 ``db.refresh()``——那是上万次 SELECT 往返，
      会把一次创建拖慢到分钟级。自增 id 在 commit 时已由 ORM 回填，
      调用方直接读 ``task.id`` 即可。
    """
    db.add_all(tasks)
    await db.commit()
    return tasks


async def get_tasks_by_batch(
    db: AsyncSession, batch_id: str
) -> list[GenerationTask]:
    result = await db.execute(
        select(GenerationTask)
        .where(GenerationTask.batch_id == batch_id)
        .order_by(GenerationTask.id)
    )
    return list(result.scalars().all())


async def get_failed_tasks_by_batch(
    db: AsyncSession, batch_id: str
) -> list[GenerationTask]:
    """获取批次中状态为失败的任务，用于重试。"""
    result = await db.execute(
        select(GenerationTask)
        .where(
            GenerationTask.batch_id == batch_id,
            GenerationTask.status == "failed",
        )
        .order_by(GenerationTask.id)
    )
    return list(result.scalars().all())


async def get_failed_tasks_by_batches(
    db: AsyncSession, batch_ids: list[str]
) -> list[GenerationTask]:
    """跨批次获取所有失败任务（用于总览页一键重试）。"""
    if not batch_ids:
        return []
    result = await db.execute(
        select(GenerationTask)
        .where(
            GenerationTask.batch_id.in_(batch_ids),
            GenerationTask.status == "failed",
        )
        .order_by(GenerationTask.id)
    )
    return list(result.scalars().all())


async def count_failed_tasks_by_batches(
    db: AsyncSession, batch_ids: list[str]
) -> dict[str, int]:
    """统计多个批次各自的失败任务数，返回 {batch_id: failed_count}。

    用于批量重试前校验：过滤出「确实有失败任务」的批次，避免无谓提交。
    """
    if not batch_ids:
        return {}
    result = await db.execute(
        select(
            GenerationTask.batch_id,
            func.count().label("cnt"),
        )
        .where(
            GenerationTask.batch_id.in_(batch_ids),
            GenerationTask.status == "failed",
        )
        .group_by(GenerationTask.batch_id)
    )
    return {row.batch_id: int(row.cnt) for row in result.all()}


async def get_task_by_id(db: AsyncSession, task_id: int) -> GenerationTask | None:
    result = await db.execute(
        select(GenerationTask).where(GenerationTask.id == task_id)
    )
    return result.scalar_one_or_none()


async def get_incomplete_tasks(
    db: AsyncSession, limit: int = 5000
) -> list[GenerationTask]:
    """获取所有未结束的任务，用于后台轮询。

    limit 默认 5000：i2i_multi 一次最多 500 批次 × K 变体 ≈ 上万任务，
    500 太小会导致轮询器多轮才能覆盖全部任务，任务状态滞后几十分钟。
    """
    result = await db.execute(
        select(GenerationTask)
        .where(
            or_(
                GenerationTask.status == "pending",
                GenerationTask.status == "queued",
                GenerationTask.status == "in_progress",
            )
        )
        .order_by(GenerationTask.created_at)
        .limit(limit)
    )
    return list(result.scalars().all())


async def get_recent_batches(
    db: AsyncSession, page: int = 1, page_size: int = 10
) -> tuple[list[dict], int]:
    """分页获取最近的批次列表，包含任务数量与状态统计。

    返回 (batches, total) 元组：batches 为当前页数据，total 为总批次数。
    """
    offset = (page - 1) * page_size

    subq = (
        select(
            GenerationTask.batch_id,
            func.count().label("task_count"),
            func.sum(
                case((GenerationTask.status == "completed", 1), else_=0)
            ).label("completed_count"),
            func.sum(
                case((GenerationTask.status == "failed", 1), else_=0)
            ).label("failed_count"),
            func.max(GenerationTask.created_at).label("last_created_at"),
        )
        .group_by(GenerationTask.batch_id)
        .subquery()
    )

    # 先统计总批次数（按 batch_id 去重后的行数）
    total_result = await db.execute(select(func.count()).select_from(subq))
    total = int(total_result.scalar_one() or 0)

    # 排序：先按最近创建时间倒序，再按 seq 数值倒序作为稳定 tie-breaker
    # - last_created_at DESC: 刚创建的批次排前面
    # - LENGTH(batch_id) DESC, batch_id DESC: 当一批 i2i_multi 同时创建 N 个批次时
    #   （所有任务同一次 commit，created_at 几乎一致），需要按 seq 数值倒序作为
    #   稳定二级排序。注意：_format_seq 对 seq < 100 做 0 补齐（"01".."99"），
    #   但对 seq ≥ 100 走 str(seq)（"100"），此时纯字典序会错排
    #   （"100" < "89"，因为 '1' < '8'），所以先按 LENGTH DESC 让"位数多 =
    #   seq 更大"先成立，等长时再字典序 = 数值序。
    result = await db.execute(
        select(subq)
        .order_by(
            subq.c.last_created_at.desc(),
            func.length(subq.c.batch_id).desc(),
            subq.c.batch_id.desc(),
        )
        .offset(offset)
        .limit(page_size)
    )

    rows = []
    for row in result.all():
        rows.append(
            {
                "batch_id": row.batch_id,
                "task_count": row.task_count,
                "completed_count": row.completed_count or 0,
                "failed_count": row.failed_count or 0,
                "last_created_at": row.last_created_at,
            }
        )
    return rows, total


async def count_batches_in_batches(db: AsyncSession, batch_ids: list[str]) -> int:
    """统计指定批次 ID 列表中包含的任务总数（用于删除响应）。"""
    if not batch_ids:
        return 0
    result = await db.execute(
        select(func.count()).where(GenerationTask.batch_id.in_(batch_ids))
    )
    return int(result.scalar_one() or 0)


async def count_today_batches(
    db: AsyncSession, prefix: str
) -> tuple[int, str, str]:
    """计算指定 prefix 在今天（北京时间）下一个可用的 batch_id。

    使用"最小未使用 seq"策略（自动填充删除产生的空隙），保证：
    - ``count``：今日已存在的 distinct batch_id 数量
    - ``next_batch_id``：服务端即将分配给下一次创建的实际 ID
    - ``date_str``：北京时间 MMDD（如 "0721"）

    与 ``_generate_batch_id`` 共用同一份逻辑，确保前端预览序号与
    后端实际分配的序号完全一致（避免分页漏算 + 删除空洞）。

    历史背景：旧实现 ``count(distinct) + 1`` 在存在删除空洞时会
    算出"已存在的 seq"导致死循环；该算法天然不会冲突，无需重试。
    """
    date_str = datetime.now(BEIJING_TZ).strftime("%m%d")
    pattern = f"{prefix}{date_str}%"
    prefix_with_date = f"{prefix}{date_str}"

    result = await db.execute(
        select(GenerationTask.batch_id)
        .where(GenerationTask.batch_id.like(pattern))
        .distinct()
    )
    existing = [row[0] for row in result.fetchall()]

    used_seqs: set[int] = set()
    for bid in existing:
        seq_str = bid[len(prefix_with_date):]
        try:
            used_seqs.add(int(seq_str))
        except ValueError:
            # 防御：忽略无法解析为整数的 batch_id（正常情况不会发生，
            # pattern 已过滤掉 UUID 等旧格式）
            continue

    # 找最小未使用 seq（填空隙），保持"第 N 条 = N"的语义
    seq = 1
    while seq in used_seqs:
        seq += 1

    next_batch_id = f"{prefix_with_date}{_format_seq(seq)}"
    return len(existing), date_str, next_batch_id


async def delete_batches(db: AsyncSession, batch_ids: list[str]) -> int:
    """删除指定批次 ID 列表对应的所有任务，返回实际删除的任务数。"""
    if not batch_ids:
        return 0
    result = await db.execute(
        delete(GenerationTask).where(GenerationTask.batch_id.in_(batch_ids))
    )
    await db.commit()
    return int(result.rowcount or 0)


async def update_task_status(
    db: AsyncSession,
    task: GenerationTask,
    status: str,
    progress: int | None = None,
    image_url: str | None = None,
    error_msg: str | None = None,
    toapis_task_id: str | None = None,
) -> GenerationTask:
    task.status = status
    if progress is not None:
        task.progress = progress
    if image_url is not None:
        task.image_url = image_url
    if error_msg is not None:
        task.error_msg = error_msg
    if toapis_task_id is not None:
        task.toapis_task_id = toapis_task_id
    if status in ("completed", "failed"):
        task.completed_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(task)
    return task


async def reset_task_for_regenerate(
    db: AsyncSession, task: GenerationTask
) -> GenerationTask:
    """重置任务状态以便重新生成：清空图片/进度/错误/远端任务ID。

    **同时重置 created_at**：轮询器的"本地超时（5 分钟）"以 created_at 为
    计时基准，若重试/重新生成后不刷新它，第二天重试的任务会因 created_at
    是昨天的而被轮询器立刻判超时标 failed（连 ToAPIs 都不查）。
    """
    task.status = "pending"
    task.progress = 0
    task.image_url = None
    task.error_msg = None
    task.toapis_task_id = None
    task.completed_at = None
    task.created_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(task)
    return task
