"""生成任务通用路由：白边裁剪配置 / 立即补算（用户自定义历史等按任务操作）。

与 erp 单元级配置（/api/erp/orders/{id}/crop-config）的区别：
- 单元级配置写 erp_order_items（待生成时也能改），本模块直接操作任务快照；
- 工厂自动化前端用单元级接口；用户自定义历史用本模块接口。
"""

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.database import get_db
from backend.app.models import GenerationTask
from backend.app.schemas import CropConfigRequest, CropConfigResponse
from backend.app.services.crop_service import process_crop_for_task

router = APIRouter(prefix="/tasks", tags=["tasks"])


async def _get_task(db: AsyncSession, task_id: int) -> GenerationTask:
    task = await db.get(GenerationTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="生成任务不存在")
    return task


@router.post("/{task_id}/crop-config", response_model=CropConfigResponse)
async def task_set_crop_config(
    task_id: int,
    request: CropConfigRequest,
    db: AsyncSession = Depends(get_db),
):
    """设置任务的白边裁剪开关 / 阈值；开启且已完成时立即补算。"""
    task = await _get_task(db, task_id)
    task.crop_enabled = request.enabled
    task.crop_threshold = request.threshold
    await db.commit()

    crop_image_url = None
    crop_meta = None
    if request.enabled and task.status == "completed":
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
            # 无结果或阈值已变/之前失败 → 同步补算（前端等待新结果）
            await process_crop_for_task(task.id, wait=True)
            await db.refresh(task)
            crop_image_url = task.crop_image_url
            if task.crop_meta:
                try:
                    crop_meta = json.loads(task.crop_meta)
                except (ValueError, TypeError):
                    crop_meta = None

    return CropConfigResponse(
        crop_enabled=request.enabled,
        crop_threshold=request.threshold,
        crop_image_url=crop_image_url,
        crop_meta=crop_meta,
    )


@router.post("/{task_id}/crop/recompute", response_model=CropConfigResponse)
async def task_recompute_crop(
    task_id: int,
    db: AsyncSession = Depends(get_db),
):
    """立即重新计算任务的裁剪图（改阈值后手动触发；同步等待结果）。"""
    task = await _get_task(db, task_id)
    if task.status != "completed" or not task.image_url:
        raise HTTPException(status_code=400, detail="任务还没有可裁剪的生成结果")
    task.crop_enabled = True
    await db.commit()
    await process_crop_for_task(task.id, wait=True)
    await db.refresh(task)

    crop_meta = None
    if task.crop_meta:
        try:
            crop_meta = json.loads(task.crop_meta)
        except (ValueError, TypeError):
            crop_meta = None
    return CropConfigResponse(
        crop_enabled=True,
        crop_threshold=task.crop_threshold,
        crop_image_url=task.crop_image_url,
        crop_meta=crop_meta,
    )
