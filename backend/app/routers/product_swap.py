"""产品替换路由：上传 1 张模板图 + N 张产品图，生成 N 张结果图。

复用现有的轮询 / 重试 / 重新生成 / 删除等批量管理端点（routers.batch），
本 router 只新增 1 个创建端点。
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.database import get_db
from backend.app.schemas import BatchGenerateResponse, ProductSwapRequest
from backend.app.services.batch_generator import batch_generator

router = APIRouter(prefix="/product-swap", tags=["product-swap"])


@router.post("/generate", response_model=BatchGenerateResponse)
async def generate_product_swap(
    request: ProductSwapRequest,
    db: AsyncSession = Depends(get_db),
):
    """创建产品替换批次：N 个任务，每个任务用 [template, product] 作为参考图。

    返回值与 ``POST /api/batches/generate`` 保持一致（同样的 ``BatchGenerateResponse``），
    后续的 status / retry / regenerate / delete 全部走 ``/api/batches/{batch_id}/...``。
    """
    try:
        batch_id, task_count = await batch_generator.create_product_swap(db, request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return BatchGenerateResponse(batch_id=batch_id, task_count=task_count)
