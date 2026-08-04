"""标题生成路由：批量生成 / 列表 / 重新生成 / 删除 / 批次图片查询 / CSV 导出。"""

import csv
import io
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.crud import title_tasks as crud
from backend.app.database import get_db
from backend.app.models import TitleTask
from backend.app.schemas import (
    TitleBatchDeleteRequest,
    TitleBatchImageItem,
    TitleBatchImagesResponse,
    TitleGenerateRequest,
    TitleGenerateResponse,
    TitleRegenerateRequest,
    TitleTaskOut,
)
from backend.app.services.title_generator import (
    build_prompt_snapshot,
    schedule_regenerate,
    schedule_title_generation,
)

router = APIRouter(prefix="/title-tasks", tags=["title-tasks"])


# ---------- 列表 ----------

@router.get("", response_model=list[TitleTaskOut])
async def list_title_tasks(
    batch_id: str | None = Query(None, description="按单个批次 ID 过滤"),
    # 批量批次过滤：用 FastAPI 的 list[Query[str]] 接收 ?batch_ids=A&batch_ids=B
    # 与 ?source_task_ids=1&source_task_ids=2 一致的重复 key 风格
    batch_ids: list[str] | None = Query(
        None, description="按批次 ID 列表过滤（可重复）"
    ),
    source_task_id: int | None = Query(None, description="按单个源任务 ID 过滤"),
    # 批量源任务过滤：用 FastAPI 的 list[Query[int]] 接收 ?source_task_ids=1&source_task_ids=2
    # 这样无需前端拼逗号分隔字符串，后端原生解析为 int 列表
    source_task_ids: list[int] | None = Query(
        None, description="按源任务 ID 列表过滤（可重复）"
    ),
    status: str | None = Query(None, description="按状态过滤（pending/in_progress/completed/failed）"),
    page: int = Query(1, ge=1, le=10000),
    # 上限 2000：前端「检测已有标题」场景需要一次性 IN 一批批次 + 拿到所有 completed，
    # 单次最多可能 200 批次 × 多张图 × 多次重生成，给 2000 留足余量
    page_size: int = Query(50, ge=1, le=2000),
    db: AsyncSession = Depends(get_db),
):
    """分页查询 TitleTask 列表（最新在前）。"""
    items, _total = await crud.list_title_tasks(
        db,
        batch_id=batch_id,
        batch_ids=batch_ids,
        source_task_id=source_task_id,
        source_task_ids=source_task_ids,
        status=status,
        page=page,
        page_size=page_size,
    )
    return items


# ---------- 批次图片查询（用于前端"选第 K 张图"）----------

@router.get(
    "/batches/{batch_id}/images",
    response_model=TitleBatchImagesResponse,
    summary="查询某批次可作为标题底图的图片列表",
)
async def get_batch_title_images(
    batch_id: str,
    db: AsyncSession = Depends(get_db),
):
    """返回该批次所有「已完成 + image_url 非空」的任务，按 id 升序，1-based 索引。

    前端拿到此列表后让用户选 image_index（=列表的 index 字段值）。
    """
    images = await crud.get_completed_images_by_batch(db, batch_id)
    return TitleBatchImagesResponse(
        batch_id=batch_id,
        images=[
            TitleBatchImageItem(
                index=i + 1,
                task_id=task.id,
                image_url=task.image_url,  # type: ignore[arg-type]
            )
            for i, task in enumerate(images)
        ],
    )


# ---------- 批量生成 ----------

@router.post(
    "/generate",
    response_model=TitleGenerateResponse,
    summary="为多个批次 × 同一图位生成标题",
)
async def generate_titles(
    request: TitleGenerateRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """核心流程：

    1. 对每个 batch_id，取其「已完成 + image_url 非空」任务的列表；
    2. 取第 ``image_index`` 张图作为底图；
    3. 若该批次图数 < image_index → 跳过并在 errors 中说明；
    4. 为每条成功解析的图创建 TitleTask（pending），挂到 BackgroundTasks 并发调用。

    约束：
    - ``MAX_CONCURRENT_TITLE_GENERATIONS`` 信号量在 service 层控制并发；
    - 每条 TitleTask 独立事务、独立落库，失败不影响其他任务；
    - 前端通过轮询 GET /api/title-tasks 拿最新状态。
    """
    title_tasks: list[TitleTask] = []
    errors: list[dict] = []

    for batch_id in request.batch_ids:
        source_task = await crud.get_nth_completed_image(db, batch_id, request.image_index)
        if source_task is None or not source_task.image_url:
            errors.append(
                {
                    "batch_id": batch_id,
                    "reason": (
                        f"批次 {batch_id} 没有第 {request.image_index} 张已完成图片，"
                        "请先在该批次中生成至少这么多张图"
                    ),
                }
            )
            continue

        # regenerated_count：从 0 开始（首次创建）
        prompt_snapshot = await build_prompt_snapshot(
            request.system_prompt, source_task.image_url
        )
        title_task = await crud.create_title_task(
            db,
            source_task=source_task,
            batch_id=batch_id,
            source_image_url=source_task.image_url,
            model=request.model,
            prompt_snapshot=prompt_snapshot,
            extra_instructions=None,
            max_tokens=request.max_tokens,
            temperature=request.temperature,
            regenerated_count=0,
        )
        schedule_title_generation(background, title_task)
        title_tasks.append(title_task)

    return TitleGenerateResponse(
        created=len(title_tasks),
        skipped=len(errors),
        title_tasks=title_tasks,
        errors=errors,
    )


# ---------- 单条重新生成 ----------

@router.post(
    "/{title_task_id}/regenerate",
    response_model=TitleTaskOut,
    summary="基于已有 TitleTask 的源任务重新生成标题",
)
async def regenerate_title(
    title_task_id: int,
    request: TitleRegenerateRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """以旧 TitleTask 的源任务为基准，新建一条 TitleTask 记录（regenerated_count + 1）。

    - 旧记录保留（审计 + 导出 CSV 时能拿到历史结果）
    - 新记录初始 status=pending，挂到 BackgroundTasks 异步生成
    - 可选覆盖 model / system_prompt / max_tokens / temperature（不传则沿用旧的）
    """
    old = await crud.get_title_task_by_id(db, title_task_id)
    if old is None:
        raise HTTPException(status_code=404, detail=f"TitleTask {title_task_id} 不存在")

    new_model = request.model or old.model
    new_system_prompt = request.system_prompt or old.prompt_snapshot.split("\n\n", 1)[0]
    # prompt_snapshot 形如 "[system]\n...\n\n[user]\n..."，按 \n\n 切首段拿回 system 原文
    # 防御：如果旧记录不是这个格式（向前兼容），退化为整个 prompt_snapshot
    if not new_system_prompt.startswith("[system]"):
        new_system_prompt = old.prompt_snapshot
    else:
        new_system_prompt = new_system_prompt[len("[system]\n"):]

    new_max_tokens = request.max_tokens if request.max_tokens is not None else old.max_tokens
    new_temperature = request.temperature if request.temperature is not None else old.temperature

    regenerated_count = await crud.count_titles_by_source_task(db, old.source_task_id) if old.source_task_id else 0
    # regenerated_count 含义：累计创建过多少条 TitleTask - 1（首次不算）
    # 由于本次即将创建一条新的，总数会变 +1；这里把"除本次外的历史条数"作为 regenerated_count
    new_regenerated_count = max(0, regenerated_count)  # +1 由"创建后再加"或本次体现为新行
    # 简化：regenerated_count 表示"之前已经重新生成过几次"，本次创建后历史就是 N+1
    # 所以本次新行 = max(0, N)，避免 0 变 1 这种抖动
    # 实际上更直观：本次新行写"重新生成前的累计次数"，即 regenerated_count
    # 此处 regenerating = 已经重新生成过 N 次的语义已经在旧行体现，新行写 history_of_source_task - 1（含旧行）
    new_regenerated_count = max(0, regenerated_count - 1) if old.source_task_id else 0

    new_prompt_snapshot = await build_prompt_snapshot(
        new_system_prompt, old.source_image_url
    )
    new_task = await crud.create_title_task(
        db,
        source_task=old.source_task,  # type: ignore[arg-type]
        batch_id=old.batch_id,
        source_image_url=old.source_image_url,
        model=new_model,
        prompt_snapshot=new_prompt_snapshot,
        extra_instructions=None,
        max_tokens=new_max_tokens,
        temperature=new_temperature,
        regenerated_count=new_regenerated_count,
    )

    schedule_regenerate(
        background,
        new_task,
        model=new_model,
        system_prompt=new_system_prompt,
        max_tokens=new_max_tokens,
        temperature=new_temperature,
    )
    return new_task


# ---------- 单条 / 批量删除 ----------

@router.delete("/{title_task_id}", response_model=dict)
async def delete_title_task(
    title_task_id: int,
    db: AsyncSession = Depends(get_db),
):
    """单条删除。"""
    deleted = await crud.delete_title_task(db, title_task_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"TitleTask {title_task_id} 不存在")
    return {"deleted": 1, "id": title_task_id}


@router.post("/batch-delete", response_model=dict)
async def delete_title_tasks_bulk(
    request: TitleBatchDeleteRequest,
    db: AsyncSession = Depends(get_db),
):
    """批量删除。"""
    deleted = await crud.delete_title_tasks_bulk(db, request.title_task_ids)
    return {"deleted": deleted}


# ---------- CSV 导出 ----------

@router.get(
    "/export.csv",
    summary="导出标题为 CSV（无列头）",
    response_class=StreamingResponse,
)
async def export_titles_csv(
    batch_ids: Optional[str] = Query(
        None,
        description="可选：逗号分隔的 batch_id 列表，None 表示导出全部已完成标题",
    ),
    db: AsyncSession = Depends(get_db),
):
    """导出 CSV 文件，格式：

    ```
    {batch_id},{title}
    {batch_id},{title}
    ...
    ```

    - 无列头（按用户要求）
    - 每个 source_task_id 只导出「最新一条 completed」记录（避免重新生成产生重复行）
    - 标题按 RFC 4180 转义：含逗号/引号/换行的字段用双引号包裹，内部引号双写
    - 文件以 UTF-8 BOM 开头（\\ufeff），Excel 直接打开不会乱码
    - 文件名形如 ``titles-20260803-162045.csv``
    """
    id_list: list[str] | None = None
    if batch_ids:
        id_list = [b.strip() for b in batch_ids.split(",") if b.strip()]
        if not id_list:
            raise HTTPException(status_code=400, detail="batch_ids 不能全是空白")

    rows = await crud.get_latest_completed_titles_for_export(
        db, batch_ids=id_list, limit=50000
    )

    # 用 io.StringIO 内存组装，避免磁盘 IO
    buf = io.StringIO()
    # BOM：让 Excel for Windows 直接识别 UTF-8
    buf.write("\ufeff")
    writer = csv.writer(buf, lineterminator="\n")
    for t in rows:
        title = (t.title or "").strip()
        # csv 模块默认会用 QUOTE_MINIMAL，但为了对换行更稳：
        # 含 , " \n \r 的字段自动加双引号并转义引号
        writer.writerow([t.batch_id, title])

    content = buf.getvalue()
    buf.close()

    from datetime import datetime
    filename = f"titles-{datetime.now().strftime('%Y%m%d-%H%M%S')}.csv"

    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )
