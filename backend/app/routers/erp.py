"""工厂 ERP（七彩ERP）路由：登录 / 会话 / 店铺与订单同步 / 提取生成 / 上传回传。

依赖 erp_client（无状态性由 DB 持久化的 cookie 保证：每个请求前从
erp_config 载入，会话过期返回 401 语义错误，前端提示重新登录）。
"""

import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.crud import erp_order_items as erp_crud
from backend.app.database import get_db
from backend.app.erp_client import ErpRequestError, ErpSessionError, erp_client
from backend.app.models import ErpConfig, ErpOrderItem, GenerationTask
from backend.app.prompts import EXTRACT_PROMPT_LABELS, EXTRACT_PROMPTS
from backend.app.schemas import (
    EXTREME_RATIO_MODEL,
    EXTREME_SIZES,
    CropConfigRequest,
    CropConfigResponse,
    ErpExtractUnit,
    ErpGenerateItem,
    ErpGenerateRequest,
    ErpGenerateResponse,
    ErpHistoryResponse,
    ErpInputImageRequest,
    ErpLoginRequest,
    ErpLoginResponse,
    ErpOrdersPreviewResponse,
    ErpOrdersSyncRequest,
    ErpSessionStatus,
    ErpStoreOut,
    ErpUploadAllRequest,
    ErpUploadAllResponse,
    ErpUploadRequest,
    ErpUploadResult,
)
from backend.app.services.batch_generator import batch_generator
from backend.app.services.crop_service import _load_meta, schedule_crop
from backend.app.services.size_mapping import map_size_to_ratio
from backend.app.toapis_client import client as toapis_client

router = APIRouter(prefix="/erp", tags=["erp"])

# batch_id 上限（generation_tasks.batch_id VARCHAR(36)）
MAX_BATCH_ID_LEN = 36


def build_unit_batch_id(store_name: str, supplier_id: int, goods_sn: str) -> str:
    """生成货号级批次号：`店铺名-货号`，超长回退 `S{店铺ID}-货号`。

    extract 模式一个货号一个批次，批次号即业务标识（用户可读可追溯）。
    """
    batch_id = f"{store_name}-{goods_sn}"
    if len(batch_id) > MAX_BATCH_ID_LEN:
        batch_id = f"S{supplier_id}-{goods_sn}"
    return batch_id[:MAX_BATCH_ID_LEN]


# ---------- 内部工具 ----------


async def _load_cookies(db: AsyncSession) -> bool:
    """从数据库载入 ERP cookie，返回是否已登录。"""
    result = await db.execute(select(ErpConfig).where(ErpConfig.id == 1))
    config = result.scalar_one_or_none()
    if config and config.cookies:
        try:
            cookies = json.loads(config.cookies)
        except (json.JSONDecodeError, TypeError):
            cookies = {}
        erp_client.set_cookies(cookies)
        return bool(cookies)
    erp_client.set_cookies({})
    return False


async def _save_cookies(db: AsyncSession) -> None:
    """把 erp_client 当前 cookie 持久化到数据库。"""
    result = await db.execute(select(ErpConfig).where(ErpConfig.id == 1))
    config = result.scalar_one_or_none()
    if config is None:
        config = ErpConfig(id=1)
        db.add(config)
    config.cookies = json.dumps(erp_client.get_cookies())
    config.updated_at = datetime.now(timezone.utc)
    config.last_error = None
    await db.commit()


async def _require_session(db: AsyncSession) -> None:
    """确保 ERP 会话有效，无效则抛 401。"""
    await _load_cookies(db)
    if not erp_client.has_cookies():
        raise HTTPException(status_code=401, detail="ERP 尚未登录，请先登录")
    try:
        valid = await erp_client.check_session()
    except ErpRequestError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if not valid:
        raise HTTPException(status_code=401, detail="ERP 登录已过期，请重新登录")


async def _store_name_map(db: AsyncSession) -> dict[int, str]:
    """从本地订单快照恢复 supplier_id → 店铺名映射（爬取时填充店铺名用）。"""
    result = await db.execute(
        select(ErpOrderItem.supplier_id, ErpOrderItem.store_name).distinct()
    )
    return {sid: name for sid, name in result.all()}


async def _build_units(db: AsyncSession, items: list[ErpOrderItem]) -> list[ErpExtractUnit]:
    """把订单快照按（店铺+货号）去重，组装生成单元（带任务状态）。"""
    groups: dict[tuple[str, str], list[ErpOrderItem]] = {}
    for item in items:
        groups.setdefault((item.store_name, item.goods_sn), []).append(item)

    # 批量查询关联任务（一次往返）
    task_ids: set[int] = set()
    for members in groups.values():
        rep = min(members, key=lambda i: i.order_item_id)
        if rep.generation_task_id:
            task_ids.add(rep.generation_task_id)
    task_map: dict[int, GenerationTask] = {}
    if task_ids:
        result = await db.execute(
            select(GenerationTask).where(GenerationTask.id.in_(task_ids))
        )
        task_map = {t.id: t for t in result.scalars().all()}

    units: list[ErpExtractUnit] = []
    for (store_name, goods_sn), members in groups.items():
        members.sort(key=lambda i: i.order_item_id)
        rep = members[0]
        task = task_map.get(rep.generation_task_id) if rep.generation_task_id else None

        if rep.erp_uploaded_at is not None:
            status = "uploaded"
        elif task is None:
            status = "pending"
        elif task.status == "completed":
            status = "completed"
        elif task.status == "failed":
            status = "failed"
        else:
            status = "generating"

        result_image = rep.result_image_url
        if task and task.status == "completed" and task.image_url:
            result_image = task.image_url

        # 白边裁剪：配置以单元（代表行）当前值为准（生成前可改，改后即时生效）；
        # 结果（crop_image_url/meta）来自任务。上传时也以单元配置为准。
        crop_enabled = rep.crop_enabled if rep.crop_enabled is not None else True
        crop_threshold = rep.crop_threshold or 10
        crop_image_url = None
        crop_meta = None
        if task:
            crop_image_url = task.crop_image_url
            crop_meta = _load_meta(task)

        units.append(
            ErpExtractUnit(
                unit_key=f"{store_name}::{goods_sn}",
                supplier_id=rep.supplier_id,
                store_name=store_name,
                goods_sn=goods_sn,
                order_item_ids=[m.order_item_id for m in members],
                representative_order_item_id=rep.order_item_id,
                input_image_url=rep.input_image_url or "",
                factory_image_url=rep.factory_image_url,
                size=rep.size or "",
                material=rep.material,
                mapped_ratio=map_size_to_ratio(rep.size or ""),
                batch_id=rep.batch_id,
                generation_task_id=rep.generation_task_id,
                status=status,
                result_image_url=result_image,
                error_msg=task.error_msg if task else None,
                created_at=rep.created_at,
                erp_uploaded_at=rep.erp_uploaded_at,
                progress=task.progress if task else 0,
                crop_enabled=crop_enabled,
                crop_threshold=crop_threshold,
                crop_image_url=crop_image_url,
                crop_meta=crop_meta,
            )
        )
    return units


# ---------- 登录 / 会话 ----------


@router.post("/login", response_model=ErpLoginResponse)
async def erp_login(request: ErpLoginRequest, db: AsyncSession = Depends(get_db)):
    """用账号密码登录 ERP 并保存 cookie；返回店铺列表。"""
    try:
        await erp_client.login(request.username, request.password)
    except (ErpRequestError, ErpSessionError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await _save_cookies(db)

    # 登录成功后立刻爬店铺列表返回（省一次前端请求）
    try:
        stores = await erp_client.get_stores()
    except (ErpRequestError, ErpSessionError):
        stores = []
    return ErpLoginResponse(
        stores=[ErpStoreOut(id=s.id, name=s.name) for s in stores]
    )


@router.get("/session", response_model=ErpSessionStatus)
async def erp_session(db: AsyncSession = Depends(get_db)):
    """探测 ERP 会话状态 + 已同步店铺数量。"""
    await _load_cookies(db)
    valid = False
    store_count = 0
    last_error: Optional[str] = None
    if erp_client.has_cookies():
        try:
            valid = await erp_client.check_session()
            if valid:
                stores = await erp_client.get_stores()
                store_count = len(stores)
        except (ErpRequestError, ErpSessionError) as exc:
            last_error = str(exc)
    return ErpSessionStatus(valid=valid, store_count=store_count, last_error=last_error)


@router.get("/stores", response_model=list[ErpStoreOut])
async def erp_stores(db: AsyncSession = Depends(get_db)):
    """同步店铺管理页全部店铺（依赖有效会话）。"""
    await _require_session(db)
    try:
        stores = await erp_client.get_stores()
    except ErpSessionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except ErpRequestError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return [ErpStoreOut(id=s.id, name=s.name) for s in stores]


# ---------- 爬取 + 生成单元 ----------


@router.post("/orders/sync", response_model=ErpOrdersPreviewResponse)
async def erp_orders_sync(
    request: ErpOrdersSyncRequest, db: AsyncSession = Depends(get_db)
):
    """同步所选店铺的图片缺失订单并落库，返回去重后的生成单元列表。"""
    await _require_session(db)
    supplier_ids = request.supplier_ids

    # 1) 同步店铺列表拿名字映射（订单行内不包含店铺 ID）
    try:
        stores = await erp_client.get_stores()
    except (ErpRequestError, ErpSessionError) as exc:
        raise HTTPException(status_code=502, detail=f"同步店铺列表失败: {exc}") from exc
    store_names = {s.id: s.name for s in stores}
    selected_names = [store_names.get(sid) for sid in supplier_ids]
    if any(not name for name in selected_names):
        raise HTTPException(
            status_code=400, detail="所选店铺 ID 不在 ERP 店铺列表中，请刷新店铺列表"
        )

    # 2) 同步图片缺失订单（按店铺过滤 + 自动翻页）
    try:
        orders = await erp_client.sync_image_missing_orders(supplier_ids, store_names)
    except ErpSessionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except ErpRequestError as exc:
        raise HTTPException(status_code=502, detail=f"同步订单失败: {exc}") from exc

    # 3) 落库（upsert；同店铺同货号多行共享一个生成单元）
    now = datetime.now(timezone.utc)
    rows: list[dict] = []
    for order in orders:
        sid = order.supplier_id
        rows.append(
            {
                "order_item_id": order.order_item_id,
                "supplier_id": sid,
                "store_name": store_names.get(sid, order.store_name) or order.store_name,
                "goods_sn": order.goods_sn,
                "size": order.size,
                "sku": order.sku,
                "skcid": order.skcid,
                "skuid": order.skuid,
                "material": order.material,
                "input_image_url": order.input_image_url,
                "order_sn": order.order_sn,
                "quantity": order.quantity,
            }
        )
    crawled = await erp_crud.upsert_order_items(db, rows, now)

    # 4) 组装单元：只显示「本次同步到」的订单（与 ERP 缺失列表保持一致）。
    #    已上传回 ERP 的订单已从缺失列表消失，不再展示在待处理视图，
    #    用户可在「生成历史」中找回。
    crawled_ids = {order.order_item_id for order in orders}
    items = await erp_crud.get_items_by_suppliers(db, supplier_ids)
    items = [item for item in items if item.order_item_id in crawled_ids]
    units = await _build_units(db, items)
    return ErpOrdersPreviewResponse(
        supplier_ids=supplier_ids, crawled_count=crawled, units=units
    )


@router.post("/generate", response_model=ErpGenerateResponse)
async def erp_generate(request: ErpGenerateRequest, db: AsyncSession = Depends(get_db)):
    """为所选店铺中「待生成」的单元创建 extract 任务。

    每个货号（店铺+货号去重单元）独立一个批次，batch_id = 店铺名-货号；
    支持 unit_keys 只生成指定单元（前端「单独生成」按钮）。
    生成前先把每张输入图从 ERP CDN 下载（防盗链头）并转传到 ToAPIs：
    img.cdnfe.com 校验 Referer/UA，ToAPIs 服务端直接拉取会被 403 拦截。
    """
    await _require_session(db)

    items = await erp_crud.get_items_by_suppliers(db, request.supplier_ids)
    units = await _build_units(db, items)
    pending_units = [u for u in units if u.status == "pending"]
    if request.unit_keys:
        target_keys = set(request.unit_keys)
        pending_units = [u for u in pending_units if u.unit_key in target_keys]
    if not pending_units:
        raise HTTPException(status_code=400, detail="所选店铺没有待生成的订单")

    results: list[ErpGenerateItem] = []
    for unit in pending_units:
        size = unit.mapped_ratio
        if request.size_mode == "fixed" and request.fixed_size:
            size = request.fixed_size
        override = request.size_overrides.get(str(unit.representative_order_item_id))
        if override:
            size = override

        # 极端宽高比（4:1/8:1 等）只有 gemini-3.1-flash-image-preview 支持：
        # 该货号自动切换模型，其余货号沿用用户选择的模型
        task_model = EXTREME_RATIO_MODEL if size in EXTREME_SIZES else request.model

        # 下载输入图（ERP CDN，防盗链）→ 转传到 ToAPIs
        try:
            if not unit.input_image_url:
                raise ErpRequestError("订单没有可用的输入图")
            image_bytes = await erp_client.get_image_bytes(unit.input_image_url)
            toapis_url = await toapis_client.upload_image_bytes(image_bytes)
        except (ErpRequestError, ErpSessionError) as exc:
            results.append(
                ErpGenerateItem(
                    batch_id=build_unit_batch_id(unit.store_name, unit.supplier_id, unit.goods_sn),
                    store_name=unit.store_name,
                    goods_sn=unit.goods_sn,
                    success=False,
                    message=f"输入图获取失败: {exc}",
                )
            )
            continue

        batch_id = build_unit_batch_id(unit.store_name, unit.supplier_id, unit.goods_sn)
        try:
            _, tasks = await batch_generator.create_extract_batch(
                db,
                batch_id=batch_id,
                prompt=request.prompt,
                items=[
                    {
                        "order_item_id": unit.representative_order_item_id,
                        "input_image_url": toapis_url,
                        "size": size,
                        "model": task_model,
                    }
                ],
                resolution=request.resolution,
                model=request.model,
                quality=request.quality,
            )
        except ValueError as exc:
            results.append(
                ErpGenerateItem(
                    batch_id=batch_id,
                    store_name=unit.store_name,
                    goods_sn=unit.goods_sn,
                    success=False,
                    message=str(exc),
                )
            )
            continue

        # 关联：单元内所有订单行指向同一个生成任务；清掉旧上传标记
        task = tasks[0]
        now = datetime.now(timezone.utc)
        await erp_crud.set_generation_task(db, unit.order_item_ids, batch_id, task.id)
        await _clear_uploaded(db, unit.order_item_ids, now)
        # 白边裁剪配置快照：生成时固化单元当前配置（后台裁剪/上传据此判定）
        task.crop_enabled = unit.crop_enabled
        task.crop_threshold = unit.crop_threshold
        await db.commit()

        results.append(
            ErpGenerateItem(
                batch_id=batch_id,
                store_name=unit.store_name,
                goods_sn=unit.goods_sn,
                generation_task_id=task.id,
                success=True,
                # 标记实际使用的模型（极端比例货号会自动切到 gemini）
                model=task.model,
                message=(
                    f"极端宽高比 {size}，已自动使用 {task_model}"
                    if size in EXTREME_SIZES
                    else ""
                ),
            )
        )

    return ErpGenerateResponse(
        results=results,
        succeeded=sum(1 for r in results if r.success),
        failed=sum(1 for r in results if not r.success),
    )


async def _clear_uploaded(db: AsyncSession, order_item_ids: list[int], now: datetime) -> None:
    items = await erp_crud.get_items_by_ids(db, order_item_ids)
    for item in items:
        item.erp_uploaded_at = None
    await db.commit()


@router.get("/orders", response_model=ErpOrdersPreviewResponse)
async def erp_orders_list(
    supplier_ids: str = "",
    status: str = "",
    db: AsyncSession = Depends(get_db),
):
    """待处理订单列表：按店铺 / 状态筛选生成单元。

    与 ERP 缺失列表同步：已上传（uploaded）的单元不在此展示，
    可在「生成历史」（GET /api/erp/history）中找回。
    """
    ids = [int(x) for x in supplier_ids.split(",") if x.strip().isdigit()]
    items = await erp_crud.get_items_by_suppliers(db, ids) if ids else []
    if not ids:
        # 未传店铺时返回全部（近期按 created_at 倒序）
        result = await db.execute(
            select(ErpOrderItem).order_by(ErpOrderItem.created_at.desc())
        )
        items = list(result.scalars().all())
    units = await _build_units(db, items)
    # 已上传的单元不再展示（待处理视图 = ERP 缺失列表）
    units = [u for u in units if u.status != "uploaded"]
    if status:
        units = [u for u in units if u.status == status]
    return ErpOrdersPreviewResponse(
        supplier_ids=ids, crawled_count=len(items), units=units
    )


# ---------- 上传回 ERP ----------


async def _upload_unit(
    db: AsyncSession,
    unit: ErpExtractUnit,
    now: datetime,
) -> ErpUploadResult:
    """把生成单元的结果图上传到 ERP（单元内每个订单条目逐条提交）。"""
    store_name, goods_sn = unit.store_name, unit.goods_sn
    first = unit.representative_order_item_id
    task = None
    if unit.generation_task_id:
        task = await db.get(GenerationTask, unit.generation_task_id)
    base_image_url = (task.image_url if task else None) or unit.result_image_url
    if not base_image_url or not task or task.status != "completed":
        return ErpUploadResult(
            order_item_id=first,
            store_name=store_name,
            goods_sn=goods_sn,
            success=False,
            message="该单元还没有可上传的生成结果",
        )

    # 白边裁剪：单元开启且任务已有裁剪结果 → 上传裁剪后的效果图
    crop_enabled = unit.crop_enabled if unit.crop_enabled is not None else True
    image_url = base_image_url
    use_cropped = crop_enabled and bool(task.crop_image_url)
    if use_cropped:
        image_url = task.crop_image_url

    # 下载生成图字节（ToAPIs CDN，走现有代理下载逻辑）
    try:
        image_bytes = await toapis_client.fetch_image_bytes(image_url)
    except Exception as exc:
        if use_cropped:
            # 降级保障：裁剪图获取失败 → 回退原图，功能不受影响
            try:
                image_bytes = await toapis_client.fetch_image_bytes(base_image_url)
            except Exception as exc2:
                return ErpUploadResult(
                    order_item_id=first,
                    store_name=store_name,
                    goods_sn=goods_sn,
                    success=False,
                    message=f"下载生成图失败（裁剪图与原图均不可用）: {exc2}",
                )
            use_cropped = False
        else:
            return ErpUploadResult(
                order_item_id=first,
                store_name=store_name,
                goods_sn=goods_sn,
                success=False,
                message=f"下载生成图失败: {exc}",
            )

    # 逐条提交到 ERP（ERP 端也会按货号批量标记，双保险）
    failed: list[str] = []
    uploaded_url = image_url
    for order_item_id in unit.order_item_ids:
        try:
            result = await erp_client.upload_order_image(
                order_item_id, goods_sn, image_bytes
            )
            data = result.get("data") or {}
            uploaded_url = data.get("image") or uploaded_url
            await erp_crud.mark_uploaded(db, order_item_id, uploaded_url, now)
        except ErpSessionError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        except ErpRequestError as exc:
            failed.append(f"#{order_item_id}: {exc}")

    if failed and len(failed) == len(unit.order_item_ids):
        return ErpUploadResult(
            order_item_id=first,
            store_name=store_name,
            goods_sn=goods_sn,
            success=False,
            message="；".join(failed),
        )
    return ErpUploadResult(
        order_item_id=first,
        store_name=store_name,
        goods_sn=goods_sn,
        success=True,
        message=(
            f"已上传 {len(unit.order_item_ids) - len(failed)}/{len(unit.order_item_ids)} 条"
            + (f"；失败: {'；'.join(failed)}" if failed else "")
            + ("" if use_cropped else "（裁剪图不可用，已回退上传原图）")
        ),
    )


@router.post("/upload", response_model=ErpUploadResult)
async def erp_upload(request: ErpUploadRequest, db: AsyncSession = Depends(get_db)):
    """单条上传：按 order_item_id 找到所属生成单元，把结果图上传回 ERP。"""
    await _require_session(db)
    item = await db.get(ErpOrderItem, request.order_item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="订单记录不存在")
    items = await erp_crud.get_items_by_key(db, item.store_name, item.goods_sn)
    units = await _build_units(db, items)
    if not units:
        raise HTTPException(status_code=404, detail="未找到对应生成单元")
    result = await _upload_unit(db, units[0], datetime.now(timezone.utc))
    return result


@router.post("/upload-all", response_model=ErpUploadAllResponse)
async def erp_upload_all(
    request: ErpUploadAllRequest, db: AsyncSession = Depends(get_db)
):
    """批量上传：把所有已完成（且未上传）的生成单元上传回 ERP。

    supplier_ids 不传 = 全部店铺；传了只上传所选店铺的单元。
    """
    await _require_session(db)
    if request.supplier_ids:
        items = await erp_crud.get_items_by_suppliers(db, request.supplier_ids)
    else:
        result = await db.execute(select(ErpOrderItem))
        items = list(result.scalars().all())
    if not items:
        raise HTTPException(status_code=404, detail="没有可上传的订单记录")
    units = await _build_units(db, items)
    targets = [u for u in units if u.status == "completed"]

    now = datetime.now(timezone.utc)
    results: list[ErpUploadResult] = []
    succeeded = failed = 0
    for unit in targets:
        result = await _upload_unit(db, unit, now)
        results.append(result)
        if result.success:
            succeeded += 1
        else:
            failed += 1
    return ErpUploadAllResponse(results=results, succeeded=succeeded, failed=failed)


@router.get("/history", response_model=ErpHistoryResponse)
async def erp_history(
    q: str = "",
    db: AsyncSession = Depends(get_db),
):
    """生成历史：查询本地持久化的全部订单单元（不依赖 ERP 同步）。

    已上传回 ERP 的订单会从 ERP 缺失列表消失，但本地记录永久保留，
    在此按时间倒序展示，支持货号/店铺名模糊搜索。
    """
    items = await erp_crud.get_all_items(db, query=q or None)
    units = await _build_units(db, items)
    return ErpHistoryResponse(units=units, total=len(units))


# ---------- 输入图替换（用户自定义图 / 重置回工厂图） ----------


@router.post("/orders/{order_item_id}/input-image")
async def erp_set_input_image(
    order_item_id: int,
    request: ErpInputImageRequest,
    db: AsyncSession = Depends(get_db),
):
    """替换单元的输入图为自定义上传图（工厂图被家具遮挡时用清晰图）。

    首次替换时固化 factory_image_url（工厂原始图），供「重置」恢复。
    生成时使用 input_image_url，替换立即生效。
    """
    item = await db.get(ErpOrderItem, order_item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="订单记录不存在")
    # 首次替换：固化工厂原始图
    if not item.factory_image_url:
        item.factory_image_url = item.input_image_url
    item.input_image_url = request.image_url
    await db.commit()
    return {"success": True, "input_image_url": request.image_url}


@router.post("/orders/{order_item_id}/input-image/reset")
async def erp_reset_input_image(
    order_item_id: int,
    db: AsyncSession = Depends(get_db),
):
    """重置输入图为工厂原始图（防误触，随时可恢复）。"""
    item = await db.get(ErpOrderItem, order_item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="订单记录不存在")
    if item.factory_image_url:
        item.input_image_url = item.factory_image_url
        await db.commit()
    return {"success": True, "input_image_url": item.factory_image_url}


@router.post("/orders/{order_item_id}/crop-config", response_model=CropConfigResponse)
async def erp_set_crop_config(
    order_item_id: int,
    request: CropConfigRequest,
    db: AsyncSession = Depends(get_db),
):
    """设置单元的「白边裁剪」开关 / 阈值（生成前可改，改后即时生效）。

    - 配置写单元全部订单行（代表行变化不丢配置）
    - 已有生成任务时同步写任务快照（后台裁剪/上传据此判定）
    - 开启且任务已完成后：立即补算裁剪（无结果时后台调度）
    """
    item = await db.get(ErpOrderItem, order_item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="订单记录不存在")

    members = await erp_crud.get_items_by_key(db, item.store_name, item.goods_sn)
    for member in members:
        member.crop_enabled = request.enabled
        member.crop_threshold = request.threshold

    task: GenerationTask | None = None
    if item.generation_task_id:
        task = await db.get(GenerationTask, item.generation_task_id)
    if task:
        task.crop_enabled = request.enabled
        task.crop_threshold = request.threshold
    await db.commit()

    # 开启且任务已完成：有裁剪结果则复用；无结果或阈值已变/之前失败 → 后台补算
    crop_image_url = None
    crop_meta = None
    if request.enabled and task and task.status == "completed":
        crop_image_url = task.crop_image_url
        if task.crop_meta:
            try:
                crop_meta = json.loads(task.crop_meta)
            except (ValueError, TypeError):
                crop_meta = None
        stale = (
            crop_meta is None
            or "error" in crop_meta
            or crop_meta.get("threshold") != request.threshold
        )
        if not crop_image_url or stale:
            schedule_crop(task.id)
            crop_image_url = None
            crop_meta = None

    return CropConfigResponse(
        crop_enabled=request.enabled,
        crop_threshold=request.threshold,
        crop_image_url=crop_image_url,
        crop_meta=crop_meta,
    )


# 供前端获取提取产品图 prompt 预设（客厅地毯 / 走廊地毯）
@router.get("/prompt")
async def erp_default_prompt():
    return {
        "prompts": EXTRACT_PROMPTS,
        "labels": EXTRACT_PROMPT_LABELS,
    }
