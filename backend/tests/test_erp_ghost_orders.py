"""幽灵订单 + 输入图重置链路回归测试（真实 MySQL，测试库隔离）。

验证：
1) 同步 upsert 会刷新 missing_synced_at（新订单 / 已存在订单都刷新）
2) only_missing 过滤：未在本次同步中的订单被过滤掉（幽灵订单 bug）
3) 用户替换输入图后再次同步：自定义输入图保留、factory_image_url 跟随最新
4) 重置输入图 → 回到工厂图；再次同步后仍是工厂图（不被同步逻辑覆盖）
5) 未在本次同步出现、且从未替换过的订单：输入图跟随新工厂图

运行：python backend/tests/test_erp_ghost_orders.py
"""
import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import sqlalchemy  # noqa: E402

TEST_DB = "gpt_image2_platform_test"
# 指向独立测试库（避免污染开发数据）
os.environ["DATABASE_URL"] = (
    "mysql+aiomysql://root:040716@localhost:3306/" + TEST_DB
)

from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from backend.app.crud import erp_order_items as erp_crud  # noqa: E402
from backend.app.models import Base, ErpOrderItem  # noqa: E402


def make_row(order_item_id: int, goods_sn: str, image: str, supplier: int = 775) -> dict:
    return {
        "order_item_id": order_item_id,
        "supplier_id": supplier,
        "store_name": "Maison Tiss",
        "goods_sn": goods_sn,
        "size": "80x400",
        "sku": f"{goods_sn}-/80*400cm",
        "input_image_url": image,
        "quantity": 1,
    }


def naive(dt: datetime) -> datetime:
    """MySQL DATETIME 读回是 naive 且截断微秒，统一后再比较。"""
    return dt.replace(tzinfo=None, microsecond=0)


async def main() -> None:
    # 1) 先连服务器（不指定库）创建测试库
    server_engine = create_async_engine(
        "mysql+aiomysql://root:040716@localhost:3306/", future=True
    )
    async with server_engine.begin() as conn:
        await conn.execute(sqlalchemy.text(f"DROP DATABASE IF EXISTS {TEST_DB}"))
        await conn.execute(
            sqlalchemy.text(f"CREATE DATABASE {TEST_DB} CHARACTER SET utf8mb4")
        )
    await server_engine.dispose()

    # 2) 连测试库建表（只需要 erp_order_items，跳过其他表的 FK 兼容问题）
    engine = create_async_engine(os.environ["DATABASE_URL"], future=True)
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[ErpOrderItem.__table__],
        )

    from backend.app.database import AsyncSessionLocal  # 绑定测试库

    # 固定递增时间戳（同秒内跑完会让精确比较失效）
    base = datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc)
    times = [base.replace(minute=0, second=s) for s in range(1, 7)]
    t1, t2, t3, t4, t5, t6 = times

    # ---------- 1) 首次同步：订单 A(1867010) B(1867009) C(1867008) ----------
    rows = [
        make_row(1867010, "MZY072905", "https://img.cdnfe.com/a.jpg"),
        make_row(1867009, "MZY072905", "https://img.cdnfe.com/b.jpg"),
        make_row(1867008, "MZY072906", "https://img.cdnfe.com/c.jpg"),
    ]
    async with AsyncSessionLocal() as s:
        n = await erp_crud.upsert_order_items(s, rows, t1)
        assert n == 3
        items = await erp_crud.get_items_by_suppliers(s, [775])
        db_vals = [repr(i.missing_synced_at) for i in items]
        assert all(naive(i.missing_synced_at) == naive(t1) for i in items), (
            f"首次同步应刷新全部 missing_synced_at: t1={t1!r}, db={db_vals}"
        )
        by_id = {i.order_item_id: i for i in items}
        assert by_id[1867010].input_image_url == "https://img.cdnfe.com/a.jpg"
        assert by_id[1867010].factory_image_url == "https://img.cdnfe.com/a.jpg"
    print("case 1 (first sync stamps missing_synced_at): ok")

    # ---------- 2) 用户替换 A 的输入图 → 再同步 ----------
    async with AsyncSessionLocal() as s:
        item_a = await s.get(ErpOrderItem, 1867010)
        item_a.input_image_url = "https://cdn.example.com/custom-a.jpg"
        await s.commit()

        # ERP 端 A 的工厂图更新了，再同步
        await erp_crud.upsert_order_items(
            s, [make_row(1867010, "MZY072905", "https://img.cdnfe.com/a2.jpg")], t2
        )
        item_a = await s.get(ErpOrderItem, 1867010)
        assert item_a.input_image_url == "https://cdn.example.com/custom-a.jpg", (
            f"替换过的输入图必须保留，实际 {item_a.input_image_url}"
        )
        assert item_a.factory_image_url == "https://img.cdnfe.com/a2.jpg", (
            "factory_image_url 应跟随最新同步"
        )
        assert naive(item_a.missing_synced_at) == naive(t2)
    print("case 2 (custom input preserved on re-sync): ok")

    # ---------- 3) 未替换的订单 B：跟随新工厂图 ----------
    async with AsyncSessionLocal() as s:
        await erp_crud.upsert_order_items(
            s,
            [
                make_row(1867010, "MZY072905", "https://img.cdnfe.com/a2.jpg"),
                make_row(1867009, "MZY072905", "https://img.cdnfe.com/b2.jpg"),
            ],
            t3,
        )
        item_b = await s.get(ErpOrderItem, 1867009)
        s.expire(item_b)  # 身份映射缓存了旧值，强制刷新
        item_b = await s.get(ErpOrderItem, 1867009)
        assert item_b.input_image_url == "https://img.cdnfe.com/b2.jpg", (
            "未替换的输入图应跟随最新工厂图"
        )
    print("case 3 (unmodified input follows factory image): ok")

    # ---------- 4) 重置 A → 工厂图；再同步跟随最新工厂图 ----------
    async with AsyncSessionLocal() as s:
        item_a = await s.get(ErpOrderItem, 1867010)
        item_a.input_image_url = item_a.factory_image_url  # 模拟 reset 接口
        await s.commit()

        await erp_crud.upsert_order_items(
            s,
            [make_row(1867010, "MZY072905", "https://img.cdnfe.com/a3.jpg")],
            t4,
        )
        item_a = await s.get(ErpOrderItem, 1867010)
        assert item_a.input_image_url == "https://img.cdnfe.com/a3.jpg", (
            f"重置后输入图应跟随最新工厂图，实际 {item_a.input_image_url}"
        )
    print("case 4 (reset input then re-sync follows factory): ok")

    # ---------- 5) only_missing 过滤（幽灵订单根因） ----------
    # C(1867008) 本次同步没出现（ERP 缺失列表已消失），missing_synced_at 停在 t1
    async with AsyncSessionLocal() as s:
        await erp_crud.upsert_order_items(
            s,
            [make_row(1867010, "MZY072905", "https://img.cdnfe.com/a3.jpg")],
            t5,
        )
        items = await erp_crud.get_items_by_suppliers(s, [775])
    strict = [i for i in items if naive(i.missing_synced_at) == naive(t5)]
    assert sorted(i.order_item_id for i in strict) == [1867010], (
        f"严格过滤后应只剩本次同步到的订单，实际 {[i.order_item_id for i in strict]}"
    )
    assert any(i.order_item_id == 1867008 for i in items), "非严格模式下幽灵订单仍在"
    print("case 5 (only_missing filters ghost orders): ok")

    # ---------- 6) 重置后再次同步：重置状态稳定（用户报的 bug） ----------
    async with AsyncSessionLocal() as s:
        # 替换
        item_a = await s.get(ErpOrderItem, 1867010)
        item_a.input_image_url = "https://cdn.example.com/custom-again.jpg"
        await s.commit()
        # 重置接口
        item_a = await s.get(ErpOrderItem, 1867010)
        item_a.input_image_url = item_a.factory_image_url
        await s.commit()
        # 页面刷新 → 同步按钮（同一工厂图）
        await erp_crud.upsert_order_items(
            s,
            [make_row(1867010, "MZY072905", "https://img.cdnfe.com/a3.jpg")],
            t6,
        )
        item_a = await s.get(ErpOrderItem, 1867010)
        assert item_a.input_image_url == item_a.factory_image_url, (
            "重置后同步：输入图应保持工厂图不变"
        )
    print("case 6 (reset then sync keeps factory image): ok")

    await engine.dispose()
    print()
    print("ALL GHOST-ORDER TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
