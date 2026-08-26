from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.crud.generation_tasks import (
    count_batches_in_batches,
    count_today_batches,
    delete_batches,
    get_batch_thumbnails,
    get_recent_batches,
)
from backend.app.database import get_db
from backend.app.schemas import (
    BATCH_PREFIX_PATTERN,
    BatchDeleteResponse,
    BatchGenerateRequest,
    BatchGenerateResponse,
    BatchListResponse,
    BatchRetryRequest,
    BatchRetryResponse,
    BatchStatusResponse,
    GenerationTaskOut,
    I2iMultiCreateRequest,
    I2iMultiCreateResponse,
    TaskRegenerateRequest,
    TodayBatchCountResponse,
)
from backend.app.services.batch_generator import batch_generator
from backend.app.services.task_poller import task_poller

router = APIRouter(prefix="/batches", tags=["batches"])


@router.post("/generate", response_model=BatchGenerateResponse)
async def generate_batch(
    request: BatchGenerateRequest, db: AsyncSession = Depends(get_db)
):
    """基于变体组批量创建 ToAPIs 生成任务。"""
    try:
        batch_id, task_count = await batch_generator.create_batch(db, request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return BatchGenerateResponse(batch_id=batch_id, task_count=task_count)


@router.post("/i2i-multi", response_model=I2iMultiCreateResponse)
async def create_i2i_multi(
    request: I2iMultiCreateRequest, db: AsyncSession = Depends(get_db)
):
    """文件夹批量图生图：原子创建 N 个 i2i 批次，每个批次绑定一张图片。

    与 ``/generate`` 的核心差异：
    - ``/generate``    → 1 批次 × K 变体 = K 任务，整批共用 1 张参考图
    - ``/i2i-multi``   → N 批次 × K 变体 = N×K 任务，每批次用各自绑定的图片

    数据一致性保证：服务端在进程内串行化 N 个 seq 的分配；
    若 [base_seq, base_seq+N-1] 任意一段已被占用，整体拒绝。

    必须在所有 ``/{batch_id}/...`` 路由之前定义，避免 ``/i2i-multi`` 被解析成 batch_id。
    """
    try:
        batch_ids, task_count, base_batch_id = await batch_generator.create_i2i_multi(
            db, request
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return I2iMultiCreateResponse(
        batch_ids=batch_ids,
        task_count=task_count,
        base_batch_id=base_batch_id,
    )


@router.get("/thumbnails", response_model=dict[str, list[str]])
async def batch_thumbnails(
    batch_ids: list[str] = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """批量获取批次的已完成图片 URL（每批最多 4 张），供列表缩略图。

    替代前端逐批次调 /{batch_id}/status（N 次请求 → 1 次），
    支撑大分页（100/200/300 批次）时列表仍流畅。
    必须在所有 /{batch_id}/... 路由之前定义，避免被解析成 batch_id。
    """
    if len(batch_ids) > 500:
        raise HTTPException(status_code=400, detail="单次最多查询 500 个批次")
    return await get_batch_thumbnails(db, batch_ids)


@router.get("/today-count", response_model=TodayBatchCountResponse)
async def get_today_batch_count(
    prefix: str = Query(..., min_length=1, max_length=10, description="批次号前缀"),
    db: AsyncSession = Depends(get_db),
):
    """获取指定 prefix 在今天（北京时间）下一个可用的 batch_id，供前端预览。

    next_batch_id 由后端权威计算（最小未使用 seq，自动填空隙），
    与 ``BatchGeneratorService._generate_batch_id`` 共用同一份逻辑，
    保证前端预览 = 后端实际分配。

    必须在所有 ``/{batch_id}/...`` 路由之前定义，避免被解析为 batch_id。
    """
    prefix = prefix.upper()
    if not BATCH_PREFIX_PATTERN.match(prefix):
        raise HTTPException(status_code=400, detail="prefix 仅支持 1-10 位 A-Z / 0-9")
    count, date_str, next_batch_id = await count_today_batches(db, prefix)
    return TodayBatchCountResponse(
        count=count,
        prefix=prefix,
        date=date_str,
        next_batch_id=next_batch_id,
    )


@router.get("/{batch_id}/status", response_model=BatchStatusResponse)
async def get_batch_status(batch_id: str, db: AsyncSession = Depends(get_db)):
    """查询批次中所有任务的最新状态（会自动同步 ToAPIs 状态）。"""
    try:
        return await task_poller.sync_batch(db, batch_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{batch_id}/retry", response_model=BatchGenerateResponse)
async def retry_failed_tasks(batch_id: str, db: AsyncSession = Depends(get_db)):
    """重试批次中状态为失败的任务。"""
    try:
        batch_id, task_count = await batch_generator.retry_failed(db, batch_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return BatchGenerateResponse(batch_id=batch_id, task_count=task_count)


@router.post("/retry-failed", response_model=BatchRetryResponse)
async def retry_failed_batches_bulk(
    request: BatchRetryRequest,
    db: AsyncSession = Depends(get_db),
):
    """一键重试多个批次中的失败任务（近期批次总览页「重试已选批次」）。

    系统校验：
    - 只重试「存在 failed 任务」的批次；无失败任务的批次跳过并返回
    - 批次不存在（已删除）同样跳过，不报错
    - 每个批次独立后台提交，互不影响
    """
    if not request.batch_ids:
        raise HTTPException(status_code=400, detail="batch_ids 不能为空")
    try:
        retried_batch_ids, retried_task_count, skipped = (
            await batch_generator.retry_failed_batches(db, request.batch_ids)
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return BatchRetryResponse(
        retried_batch_ids=retried_batch_ids,
        retried_task_count=retried_task_count,
        skipped_batch_ids=skipped,
    )


@router.post(
    "/{batch_id}/tasks/{task_id}/regenerate", response_model=GenerationTaskOut
)
async def regenerate_task(
    batch_id: str,
    task_id: int,
    body: TaskRegenerateRequest | None = None,
    db: AsyncSession = Depends(get_db),
):
    """重新生成指定任务：复用 task_id，仅替换远端生成结果。

    可选请求体 TaskRegenerateRequest：覆盖 model / quality（前端"重新生成"弹窗），
    以及 size / resolution（提取产品图模式允许调整尺寸）；
    不传则沿用任务原配置。
    """
    try:
        task = await batch_generator.regenerate_task(
            db,
            batch_id,
            task_id,
            model=body.model if body else None,
            quality=body.quality if body else None,
            size=body.size if body else None,
            resolution=body.resolution if body else None,
            prompt=body.prompt if body else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # ORM 模型上无 variant_prompt 字段，需要从 variant 关系取值后手动构造响应
    # 与 task_poller._build_response 的处理方式保持一致
    return GenerationTaskOut(
        id=task.id,
        batch_id=task.batch_id,
        variant_id=task.variant_id,
        variant_prompt=task.variant.prompt_content if task.variant else None,
        toapis_task_id=task.toapis_task_id,
        mode=task.mode,
        size=task.size,
        resolution=task.resolution,
        model=task.model or "gpt-image-2",
        quality=task.quality,
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


@router.get("", response_model=BatchListResponse)
async def list_recent_batches(
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1, description="页码，从 1 开始"),
    page_size: int = Query(20, ge=1, le=500, description="每页数量，最大 500"),
    q: str | None = Query(
        None, max_length=64, description="批次号模糊搜索（任意位置子串匹配，通配符按字面处理）"
    ),
):
    """分页获取最近的批量生成批次列表；支持 q 全库模糊搜索。"""
    batches, total = await get_recent_batches(
        db, page=page, page_size=page_size, query=q
    )
    total_pages = (total + page_size - 1) // page_size if total else 0
    return BatchListResponse(
        batches=batches,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


@router.delete("", response_model=BatchDeleteResponse)
async def delete_batches_bulk(
    batch_ids: list[str] = Body(..., embed=True),
    db: AsyncSession = Depends(get_db),
):
    """批量删除指定批次及其所有任务。"""
    if not batch_ids:
        raise HTTPException(status_code=400, detail="batch_ids 不能为空")
    # 统计任务数（在删除前统计，确保响应字段真实）
    deleted_task_count = await count_batches_in_batches(db, batch_ids)
    await delete_batches(db, batch_ids)
    return BatchDeleteResponse(
        deleted_batch_ids=batch_ids,
        deleted_task_count=deleted_task_count,
    )


@router.delete("/{batch_id}", response_model=BatchDeleteResponse)
async def delete_batch(batch_id: str, db: AsyncSession = Depends(get_db)):
    """删除指定批次及其所有任务。"""
    deleted_task_count = await count_batches_in_batches(db, [batch_id])
    if deleted_task_count == 0:
        raise HTTPException(status_code=404, detail=f"批次 {batch_id} 不存在")
    await delete_batches(db, [batch_id])
    return BatchDeleteResponse(
        deleted_batch_ids=[batch_id],
        deleted_task_count=deleted_task_count,
    )
