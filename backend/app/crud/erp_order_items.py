"""erp_order_items 数据访问层：快照落库 / 去重单元 / 生成任务关联 / 上传状态。"""

from datetime import datetime
from typing import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models import ErpOrderItem


async def upsert_order_items(
    db: AsyncSession, items: list[dict], now: datetime
) -> int:
    """批量 upsert 订单快照（按 order_item_id 主键），返回更新条数。

    items 元素为 dict（字段名与模型列一致）。

    输入图双轨制：
    - ``input_image_url``：实际用于生成的输入图（默认=工厂图；用户可替换为
      自定义上传图，解决工厂图被家具遮挡导致模型识别不准的问题）
    - ``factory_image_url``：工厂原始图（同步时总是更新）

    同步（upsert）时：工厂图总是刷新；已被用户替换过的输入图保持不变，
    未替换过的输入图跟随工厂图更新。missing_synced_at 刷新为本次同步时间
    （标记该订单本次仍在 ERP 缺失列表中）。业务状态（generation_task_id /
    erp_uploaded_at 等）从不被同步覆盖。
    """
    saved = 0
    for item in items:
        order_item_id = item["order_item_id"]
        factory_url = item.get("input_image_url")
        existing = await db.get(ErpOrderItem, order_item_id)
        if existing:
            for key, value in item.items():
                if key in ("order_item_id", "batch_id", "generation_task_id",
                           "result_image_url", "erp_uploaded_at",
                           "input_image_url", "factory_image_url",
                           "crop_enabled", "crop_threshold"):
                    continue
                setattr(existing, key, value)
            # 先记旧工厂图再更新：旧值是判断「用户是否替换过输入图」的基准。
            # （若拿新 factory_url 比较，两者恒等 → 未替换的输入图永远
            #  跟不上新工厂图，替换过的反而可能在巧合时被误重置。）
            old_factory = existing.factory_image_url
            existing.factory_image_url = factory_url
            # 输入图：已被用户替换（input != 旧工厂图）则保留自定义图，
            # 否则跟随最新工厂图
            if not existing.input_image_url or (
                old_factory and existing.input_image_url == old_factory
            ):
                existing.input_image_url = factory_url
            # 本次同步仍在缺失列表 → 刷新时间戳（only_missing 过滤依据）
            existing.missing_synced_at = now
            existing.updated_at = now
        else:
            row = dict(item)
            row["factory_image_url"] = factory_url
            row["missing_synced_at"] = now
            db.add(ErpOrderItem(**row, created_at=now))
        saved += 1
    await db.commit()
    return saved


async def get_items_by_suppliers(
    db: AsyncSession, supplier_ids: Sequence[int]
) -> list[ErpOrderItem]:
    """查询所选店铺的全部订单快照（按 order_item_id 升序）。"""
    if not supplier_ids:
        return []
    result = await db.execute(
        select(ErpOrderItem)
        .where(ErpOrderItem.supplier_id.in_(list(supplier_ids)))
        .order_by(ErpOrderItem.order_item_id)
    )
    return list(result.scalars().all())


async def get_items_by_batch(
    db: AsyncSession, batch_id: str
) -> list[ErpOrderItem]:
    """查询某生成批次关联的全部订单快照。"""
    result = await db.execute(
        select(ErpOrderItem)
        .where(ErpOrderItem.batch_id == batch_id)
        .order_by(ErpOrderItem.order_item_id)
    )
    return list(result.scalars().all())


async def get_items_by_key(
    db: AsyncSession, store_name: str, goods_sn: str
) -> list[ErpOrderItem]:
    """查询同店铺同货号的全部订单（上传时逐条覆盖）。"""
    result = await db.execute(
        select(ErpOrderItem)
        .where(
            ErpOrderItem.store_name == store_name,
            ErpOrderItem.goods_sn == goods_sn,
        )
        .order_by(ErpOrderItem.order_item_id)
    )
    return list(result.scalars().all())


async def set_generation_task(
    db: AsyncSession,
    order_item_ids: Sequence[int],
    batch_id: str,
    generation_task_id: int,
) -> None:
    """把一个生成单元内的所有订单关联到同一个生成任务。"""
    items = await get_items_by_ids(db, order_item_ids)
    for item in items:
        item.batch_id = batch_id
        item.generation_task_id = generation_task_id
    await db.commit()


async def get_items_by_ids(
    db: AsyncSession, order_item_ids: Sequence[int]
) -> list[ErpOrderItem]:
    if not order_item_ids:
        return []
    result = await db.execute(
        select(ErpOrderItem).where(ErpOrderItem.order_item_id.in_(list(order_item_ids)))
    )
    return list(result.scalars().all())


async def get_all_items(
    db: AsyncSession,
    query: str | None = None,
    limit: int = 2000,
) -> list[ErpOrderItem]:
    """查询全部「生成过」的订单快照（生成历史），按创建时间倒序。

    只返回 generation_task_id 非空的订单（生成过 / 重新生成过 / 已上传），
    从未生成过的待处理订单不进入历史，避免历史列表被爬取结果污染。

    ``query``: 货号 / 店铺名模糊搜索（任意位置子串匹配）。
    ``limit``: 上限防止记录量巨大时全表加载（内部工具量级下 2000 足够）。
    """
    stmt = (
        select(ErpOrderItem)
        .where(ErpOrderItem.generation_task_id.is_not(None))
        .order_by(ErpOrderItem.created_at.desc())
        .limit(limit)
    )
    if query:
        kw = f"%{query.strip()}%"
        stmt = stmt.where(
            ErpOrderItem.goods_sn.like(kw) | ErpOrderItem.store_name.like(kw)
        )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def mark_uploaded(
    db: AsyncSession, order_item_id: int, image_url: str, now: datetime
) -> bool:
    """标记单个订单已上传回 ERP，返回是否命中记录。"""
    item = await db.get(ErpOrderItem, order_item_id)
    if item is None:
        return False
    item.erp_uploaded_at = now
    if image_url:
        item.result_image_url = image_url
    await db.commit()
    return True
