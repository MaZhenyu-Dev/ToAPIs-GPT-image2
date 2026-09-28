"""提取产品图输入图刷新测试：修复「重新生成仍用首次替换图」bug。

背景：任务创建时会把输入图快照写入 reference_image_urls；用户在生成后
再次替换输入图时，快照不会自动更新，导致重新生成 / 重试仍提交旧图。
修复后：重新提交前以 erp_order_items.input_image_url 为唯一事实源解析。

覆盖（不依赖数据库 / 网络，mock AsyncSession 与 ERP/ToAPIs 客户端）：
1) _resolve_extract_input_url：
   - 用户替换图（input != factory）→ 直接复用，不触发下载/转存
   - 工厂图（input == factory，含重置回工厂图）→ 下载 ERP CDN 后转存 ToAPIs
   - 非 extract / 无关联订单 / 无输入图 → 不刷新（保持原快照）
2) regenerate_task：提交前刷新快照；解析失败抛 502 且任务保持原状
3) _reset_and_resubmit：重试同样刷新；刷新失败不阻断（沿用旧快照）
"""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fastapi import HTTPException

from backend.app.erp_client import ErpRequestError, erp_client
from backend.app.models import ErpOrderItem, GenerationTask
from backend.app.services.batch_generator import (
    BatchGeneratorService,
    _resolve_extract_input_url,
)
from backend.app.toapis_client import client as toapis_client


def make_task(mode: str = "extract", **overrides) -> GenerationTask:
    fields = dict(
        id=7,
        batch_id="Maison Tiss-MZY072905",
        variant_id=None,
        mode=mode,
        size="1:1",
        resolution="1k",
        model="gpt-image-2",
        status="completed",
        progress=0,
        reference_image_urls="https://file.toapis.com/uploaded/old.png",
        prompt="生成干净的产品图",
    )
    fields.update(overrides)
    return GenerationTask(**fields)


def make_order_item(input_url: str | None, factory_url: str | None) -> ErpOrderItem:
    return ErpOrderItem(
        order_item_id=1867010,
        supplier_id=2,
        store_name="Maison Tiss",
        goods_sn="MZY072905",
        input_image_url=input_url,
        factory_image_url=factory_url,
    )


def make_db(item) -> MagicMock:
    """mock AsyncSession：execute 返回带 scalar_one_or_none 的结果对象。"""
    result = MagicMock()
    result.scalar_one_or_none.return_value = item
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)
    db.commit = AsyncMock()
    return db


# ---------- 1) 输入图解析 ----------


def test_replaced_image_reused_without_transcode() -> None:
    """用户替换图（input != factory）：已是 ToAPIs URL，零网络直接复用。"""
    task = make_task()
    item = make_order_item(
        input_url="https://file.toapis.com/uploaded/new.png",
        factory_url="https://img.cdnfe.com/product/fancy/a.jpg",
    )
    with patch.object(
        erp_client, "get_image_bytes", new=AsyncMock()
    ) as get_bytes, patch.object(
        toapis_client, "upload_image_bytes", new=AsyncMock()
    ) as upload:
        url = asyncio.run(_resolve_extract_input_url(make_db(item), task))
    assert url == "https://file.toapis.com/uploaded/new.png"
    get_bytes.assert_not_awaited()
    upload.assert_not_awaited()
    print("[1] 用户替换图 → 直接复用（零网络）: ok")


def test_factory_image_transcoded_to_toapis() -> None:
    """工厂图（input == factory，含重置回工厂图）：下载 CDN 后转存 ToAPIs。"""
    task = make_task()
    factory_url = "https://img.cdnfe.com/product/fancy/a.jpg"
    item = make_order_item(input_url=factory_url, factory_url=factory_url)
    with patch.object(
        erp_client, "get_image_bytes", new=AsyncMock(return_value=b"img-bytes")
    ) as get_bytes, patch.object(
        toapis_client,
        "upload_image_bytes",
        new=AsyncMock(return_value="https://file.toapis.com/uploaded/transcoded.png"),
    ) as upload:
        url = asyncio.run(_resolve_extract_input_url(make_db(item), task))
    assert url == "https://file.toapis.com/uploaded/transcoded.png"
    get_bytes.assert_awaited_once_with(factory_url)
    upload.assert_awaited_once_with(b"img-bytes")
    print("[2] 工厂图（含重置）→ 下载转存 ToAPIs: ok")


def test_unknown_factory_transcoded() -> None:
    """历史数据工厂图为空：无法判定是否替换过，保守转存（兼容旧行）。"""
    task = make_task()
    item = make_order_item(
        input_url="https://img.cdnfe.com/product/fancy/legacy.jpg",
        factory_url=None,
    )
    with patch.object(
        erp_client, "get_image_bytes", new=AsyncMock(return_value=b"legacy")
    ) as get_bytes, patch.object(
        toapis_client,
        "upload_image_bytes",
        new=AsyncMock(return_value="https://file.toapis.com/uploaded/legacy.png"),
    ) as upload:
        url = asyncio.run(_resolve_extract_input_url(make_db(item), task))
    assert url == "https://file.toapis.com/uploaded/legacy.png"
    get_bytes.assert_awaited_once_with(item.input_image_url)
    upload.assert_awaited_once_with(b"legacy")
    print("[2b] 工厂图未知（历史数据）→ 保守转存: ok")


def test_no_refresh_for_other_modes_or_missing_item() -> None:
    """非 extract 模式 / 无关联订单 / 无输入图：返回 None，保持原快照。"""
    # 非 extract 模式：不查库
    db = make_db(make_order_item("https://a/b.png", None))
    assert asyncio.run(_resolve_extract_input_url(db, make_task("extract_custom"))) is None
    db.execute.assert_not_awaited()

    # 无关联订单
    assert asyncio.run(_resolve_extract_input_url(make_db(None), make_task())) is None

    # 有关联订单但没有输入图
    item = make_order_item(input_url=None, factory_url=None)
    assert asyncio.run(_resolve_extract_input_url(make_db(item), make_task())) is None
    print("[3] 非 extract / 无订单 / 无输入图 → 不刷新: ok")


# ---------- 2) regenerate_task 提交前刷新 ----------


def test_regenerate_refreshes_reference_image() -> None:
    """重新生成：任务快照在提交前被刷新为订单当前输入图。"""
    service = BatchGeneratorService()
    task = make_task()
    db = MagicMock()
    with patch(
        "backend.app.services.batch_generator.get_task_by_id",
        new=AsyncMock(return_value=task),
    ), patch(
        "backend.app.services.batch_generator.reset_task_for_regenerate",
        new=AsyncMock(),
    ) as reset_mock, patch(
        "backend.app.services.batch_generator._resolve_extract_input_url",
        new=AsyncMock(
            return_value="https://file.toapis.com/uploaded/second-replace.png"
        ),
    ), patch(
        "backend.app.services.batch_generator.asyncio.create_task",
        side_effect=lambda coro: coro.close(),
    ) as create_mock:
        asyncio.run(service.regenerate_task(db, task.batch_id, task.id))
    assert task.reference_image_urls == (
        "https://file.toapis.com/uploaded/second-replace.png"
    )
    reset_mock.assert_awaited_once()
    create_mock.assert_called_once()
    print("[4] regenerate_task → 提交前刷新输入图: ok")


def test_regenerate_resolve_failure_keeps_task_untouched() -> None:
    """解析失败：抛 502，任务不重置、不带旧图提交。"""
    service = BatchGeneratorService()
    task = make_task()
    db = MagicMock()
    with patch(
        "backend.app.services.batch_generator.get_task_by_id",
        new=AsyncMock(return_value=task),
    ), patch(
        "backend.app.services.batch_generator.reset_task_for_regenerate",
        new=AsyncMock(),
    ) as reset_mock, patch(
        "backend.app.services.batch_generator._resolve_extract_input_url",
        new=AsyncMock(side_effect=ErpRequestError("图片下载失败（HTTP 403）")),
    ), patch(
        "backend.app.services.batch_generator.asyncio.create_task",
        side_effect=lambda coro: coro.close(),
    ) as create_mock:
        try:
            asyncio.run(service.regenerate_task(db, task.batch_id, task.id))
            assert False, "应该抛出 HTTPException(502)"
        except HTTPException as exc:
            assert exc.status_code == 502
            assert "输入图获取失败" in exc.detail
    assert task.status == "completed"
    assert task.reference_image_urls == (
        "https://file.toapis.com/uploaded/old.png"
    )
    reset_mock.assert_not_awaited()
    create_mock.assert_not_called()
    print("[5] 解析失败 → 502 且任务保持原状: ok")


# ---------- 3) 重试路径刷新 ----------


def test_reset_and_resubmit_refreshes_and_tolerates_failure() -> None:
    """重试：成功的刷新快照，失败的沿用旧快照且不阻断整批重试。"""
    service = BatchGeneratorService()
    t1 = make_task(status="failed", reference_image_urls="old-1")
    t1.id = 1
    t2 = make_task(status="failed", reference_image_urls="old-2")
    t2.id = 2

    async def resolver(db, task):
        if task.id == 1:
            return "https://file.toapis.com/uploaded/new-1.png"
        raise ErpRequestError("boom")

    db = MagicMock()
    db.commit = AsyncMock()
    with patch(
        "backend.app.services.batch_generator._resolve_extract_input_url",
        new=AsyncMock(side_effect=resolver),
    ), patch(
        "backend.app.services.batch_generator.asyncio.create_task",
        side_effect=lambda coro: coro.close(),
    ) as create_mock:
        asyncio.run(service._reset_and_resubmit(db, "B", [t1, t2]))

    assert t1.reference_image_urls == "https://file.toapis.com/uploaded/new-1.png"
    assert t2.reference_image_urls == "old-2"
    assert t1.status == "pending" and t2.status == "pending"
    create_mock.assert_called_once()
    print("[6] 重试 → 刷新成功生效 / 失败沿用快照: ok")


# ---------- runner ----------


def main() -> None:
    print("=== extract input refresh tests ===")
    test_replaced_image_reused_without_transcode()
    test_factory_image_transcoded_to_toapis()
    test_unknown_factory_transcoded()
    test_no_refresh_for_other_modes_or_missing_item()
    test_regenerate_refreshes_reference_image()
    test_regenerate_resolve_failure_keeps_task_untouched()
    test_reset_and_resubmit_refreshes_and_tolerates_failure()
    print()
    print("ALL EXTRACT INPUT REFRESH TESTS PASSED")


if __name__ == "__main__":
    main()
