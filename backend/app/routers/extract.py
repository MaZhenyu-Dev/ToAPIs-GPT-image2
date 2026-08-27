"""用户自定义提取产品图路由：手动传 N 张图 + 统一参数 → N 个生成任务。

与工厂自动化（routers.erp）共享 extract 生成链路；本模块无 ERP
关联，生成完成后由用户自行下载 / 上传，平台不干预。

历史记录持久化在 generation_tasks（mode=extract_custom），
通过 GET /api/extract/history 独立查询（不进入工厂自动化的历史）。
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import json

from backend.app.database import get_db
from backend.app.models import GenerationTask
from backend.app.schemas import (
    BatchGenerateResponse,
    ExtractGenerateRequest,
    ExtractHistoryItem,
    ExtractHistoryResponse,
)
from backend.app.services.batch_generator import batch_generator

router = APIRouter(prefix="/extract", tags=["extract"])

HISTORY_LIMIT = 200


@router.post("/generate", response_model=BatchGenerateResponse)
async def extract_generate(
    request: ExtractGenerateRequest,
    db: AsyncSession = Depends(get_db),
):
    """创建用户自定义提取批次：N 张输入图 × 统一 prompt → N 个任务。"""
    items = [
        {
            "order_item_id": i,
            "input_image_url": url,
            "size": request.size,
        }
        for i, url in enumerate(request.image_urls)
    ]
    try:
        batch_id = await batch_generator.allocate_batch_id(db, request.prefix)
        batch_id, tasks = await batch_generator.create_extract_batch(
            db,
            batch_id=batch_id,
            prompt=request.prompt,
            items=items,
            resolution=request.resolution,
            model=request.model,
            quality=request.quality,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # 把任务标记为用户自定义模式（区别于工厂自动化的 extract）
    for task in tasks:
        task.mode = "extract_custom"
        # 白边裁剪配置快照（本批次统一，生成完成后自动裁剪）
        task.crop_enabled = request.crop_enabled
        task.crop_threshold = request.crop_threshold
    await db.commit()
    return BatchGenerateResponse(batch_id=batch_id, task_count=len(tasks))


@router.get("/history", response_model=ExtractHistoryResponse)
async def extract_history(
    limit: int = Query(50, ge=1, le=HISTORY_LIMIT),
    db: AsyncSession = Depends(get_db),
):
    """用户自定义提取历史：最近 N 条任务（按创建时间倒序）。

    输入图从 reference_image_urls 取第一个（自定义模式每任务一张输入图）。
    """
    result = await db.execute(
        select(GenerationTask)
        .where(GenerationTask.mode == "extract_custom")
        .order_by(GenerationTask.created_at.desc())
        .limit(limit)
    )
    tasks = list(result.scalars().all())

    items: list[ExtractHistoryItem] = []
    for task in tasks:
        input_url = None
        if task.reference_image_urls:
            input_url = task.reference_image_urls.split(",")[0].strip() or None
        crop_meta = None
        if task.crop_meta:
            try:
                crop_meta = json.loads(task.crop_meta)
            except (ValueError, TypeError):
                crop_meta = None
        items.append(
            ExtractHistoryItem(
                task_id=task.id,
                batch_id=task.batch_id,
                status=task.status,
                model=task.model or "gpt-image-2",
                quality=task.quality,
                size=task.size,
                resolution=task.resolution,
                prompt=task.prompt,
                input_image_url=input_url,
                result_image_url=task.image_url,
                error_msg=task.error_msg,
                created_at=task.created_at,
                completed_at=task.completed_at,
                progress=task.progress,
                crop_enabled=task.crop_enabled if task.crop_enabled is not None else True,
                crop_threshold=task.crop_threshold or 10,
                crop_image_url=task.crop_image_url,
                crop_meta=crop_meta,
            )
        )

    count_result = await db.execute(
        select(func.count()).select_from(GenerationTask).where(
            GenerationTask.mode == "extract_custom"
        )
    )
    total = int(count_result.scalar_one() or 0)
    return ExtractHistoryResponse(items=items, total=total)
