from datetime import datetime, timedelta, timezone
import re

from sqlalchemy import case, delete, distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models import GenerationTask

# 北京时区（UTC+8），用于生成 batch_id 中的日期部分及今日批次统计
# 集中在此处供 services.batch_generator 与 routers.batch 共同引用，
# 避免循环依赖。
BEIJING_TZ = timezone(timedelta(hours=8))

# batch_id 尾部的连续数字段（= MMDD + seq，prefix 以数字结尾时更长）
_SEQ_SUFFIX_RE = re.compile(r"(\d+)$")


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


def _batch_sort_key(batch_id: str) -> tuple[int, str, int]:
    """近期批次排序键：完全基于批次号，与创建/重试时间无关。

    batch_id 格式 {prefix}{MMDD}{seq}：
    - prefix: 用户自定义（1-10 位 A-Z / 0-9）
    - MMDD: 北京时间月日（4 位，如 "0803"）
    - seq: 当天该 prefix 下的序号（<100 补 0 为 2 位，>=100 自然展开）

    排序（倒序）：
    1. MMDD 数值倒序：当天的批次排最前（用户反馈：当天任务应在列表前面）
    2. 同日期内 prefix 倒序
    3. 同前缀内 seq 数值倒序（用户反馈：同前缀按最后序号排列）

    解析：seq = 尾部连续数字段去掉前 4 位（MMDD），前缀 = batch_id 去掉 seq。
    这样列表位置只由批次号决定：重试/重新生成会刷新 created_at，但批次不会上移。

    注意：prefix 以数字结尾时（罕见），去掉前 4 位会截到 prefix 尾部，
    但同前缀内解析值仍与真实 seq 单调一致，不影响排序正确性。
    旧格式 UUID（非 {prefix}{MMDD}{seq} 结构）降级为日期 0 + 整串 + seq=0，排最后。
    """
    m = _SEQ_SUFFIX_RE.search(batch_id)
    if not m or len(m.group(1)) <= 4:
        return (0, batch_id, 0)
    seq_str = m.group(1)[4:]
    group = batch_id[: -len(seq_str)]  # prefix + MMDD
    return (int(group[-4:]), group[:-4], int(seq_str))


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


async def get_batch_thumbnails(
    db: AsyncSession, batch_ids: list[str], per_batch: int = 4
) -> dict[str, list[str]]:
    """批量获取批次的已完成图片 URL（每批最多 per_batch 张），用于列表缩略图。

    一次查询返回全部批次的 completed image_url（按任务 id 排序），
    Python 端分组截断——替代前端对每个批次单独调 status 接口（N 次请求 → 1 次）。
    """
    if not batch_ids:
        return {}
    result = await db.execute(
        select(GenerationTask.batch_id, GenerationTask.image_url)
        .where(
            GenerationTask.batch_id.in_(batch_ids),
            GenerationTask.status == "completed",
            GenerationTask.image_url.isnot(None),
        )
        .order_by(GenerationTask.id)
    )
    out: dict[str, list[str]] = {}
    for batch_id, image_url in result.all():
        urls = out.setdefault(batch_id, [])
        if len(urls) < per_batch:
            urls.append(image_url)
    return out


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
    db: AsyncSession,
    page: int = 1,
    page_size: int = 10,
    query: str | None = None,
) -> tuple[list[dict], int]:
    """分页获取最近的批次列表，包含任务数量与状态统计。

    返回 (batches, total) 元组：batches 为当前页数据，total 为总批次数。

    ``query``：批次号全库模糊搜索（任意位置子串匹配）。
    企业级规范：
    - 参数化查询（SQLAlchemy 绑定参数，防 SQL 注入）
    - LIKE 通配符转义：用户输入的 ``%`` / ``_`` / ``\\`` 按字面匹配，
      不会意外匹配全库（escape="\\"）
    - 过滤在 GROUP BY 之前下推，只聚合匹配批次，全库扫描成本可控
      （当前量级毫秒级；LIKE '%..%' 无索引可用属预期，数据量到
      十万级仍为几十毫秒量级）

    排序在 Python 端完成（见 _batch_sort_key）：完全按批次号
    （MMDD 倒序 → 同日期 prefix 倒序 → 同前缀 seq 数值倒序）。
    不依赖 created_at —— 重试/重新生成会刷新任务的 created_at，
    但批次在列表中的位置不变：当天批次始终在最前，同前缀批次
    按最后序号排列（用户反馈：不要置顶、不要因重试上移、当天批次在前）。
    """
    where = None
    if query:
        # 转义 LIKE 通配符，用户输入按字面匹配
        escaped = (
            query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        )
        where = GenerationTask.batch_id.like(f"%{escaped}%", escape="\\")

    stmt = select(
        GenerationTask.batch_id,
        func.count().label("task_count"),
        func.sum(
            case((GenerationTask.status == "completed", 1), else_=0)
        ).label("completed_count"),
        func.sum(
            case((GenerationTask.status == "failed", 1), else_=0)
        ).label("failed_count"),
        func.max(GenerationTask.retried_count).label("retried_count"),
        func.max(GenerationTask.created_at).label("last_created_at"),
    )
    # 排除提取产品图批次（mode=extract）：它们以「店铺名-货号」为批次号，
    # 由「提取产品图」页管理，不进入本列表，避免污染现有批量生成工作流。
    stmt = stmt.where(GenerationTask.mode != "extract")
    # 注意：不能无条件 .where(None)——SQLAlchemy 会编译出 "WHERE NULL"，
    # MySQL 下恒假导致返回空列表
    if where is not None:
        stmt = stmt.where(where)
    subq = stmt.group_by(GenerationTask.batch_id).subquery()

    result = await db.execute(select(subq))
    rows = []
    for row in result.all():
        rows.append(
            {
                "batch_id": row.batch_id,
                "task_count": row.task_count,
                "completed_count": row.completed_count or 0,
                "failed_count": row.failed_count or 0,
                "retried_count": row.retried_count or 0,
                "last_created_at": row.last_created_at,
            }
        )

    # 前缀倒序（新日期在前）+ 组内 seq 数值倒序（新序号在前）
    rows.sort(key=lambda b: _batch_sort_key(b["batch_id"]), reverse=True)

    total = len(rows)
    offset = (page - 1) * page_size
    return rows[offset : offset + page_size], total


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

    **重试计数 +1**：总览页据此识别「重试过的批次」并显示「重试 ×N」徽章。
    """
    task.status = "pending"
    task.progress = 0
    task.image_url = None
    task.error_msg = None
    task.toapis_task_id = None
    task.completed_at = None
    task.created_at = datetime.now(timezone.utc)
    task.retried_count = (task.retried_count or 0) + 1
    await db.commit()
    await db.refresh(task)
    return task
