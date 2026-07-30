from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import Response

import httpx

from backend.app.schemas import (
    GenerationRequest,
    GenerationTaskResponse,
    ImageUploadResponse,
    TaskStatusResponse,
)
from backend.app.toapis_client import client

router = APIRouter(prefix="/generations", tags=["generations"])


@router.post("/generate", response_model=GenerationTaskResponse)
async def generate(req: GenerationRequest):
    """单次文生图：创建 ToAPIs 异步生成任务。"""
    payload = {
        "model": "gpt-image-2",
        "prompt": req.prompt,
        "size": req.size,
        "resolution": req.resolution,
        "n": 1,
        "response_format": "url",
    }
    return await client.create_generation(payload)


@router.get("/tasks/{task_id}", response_model=TaskStatusResponse)
async def get_task(task_id: str):
    """透传 ToAPIs 任务状态查询，并对图片 URL 字段做归一化。"""
    status = await client.get_task_status(task_id)
    # ToAPIs 不同接口/版本返回的图片 URL 字段位置不固定，
    # 统一注入到顶层 url，保证前端预览/下载逻辑一致。
    if isinstance(status, dict) and not status.get("url"):
        url = client.extract_image_url(status)
        if url:
            status["url"] = url
    return status


@router.get("/download")
async def download_image(url: str = Query(..., description="图片 URL")):
    """代理下载图片，绕过浏览器 CORS 限制。

    ToAPIs 生成的图片 URL（如 files.toapis.com）通常不携带
    ``Access-Control-Allow-Origin`` 响应头，前端直接 fetch 会失败。
    通过本接口由后端中转下载后再返回给前端。
    """
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="仅支持 HTTP/HTTPS URL")

    try:
        content = await client.fetch_image_bytes(url)
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504, detail=f"下载图片超时: {exc}"
        ) from exc
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        # 4xx 视为上游资源问题（URL 失效/被删/鉴权失败等），透传给前端
        if 400 <= status < 500:
            raise HTTPException(
                status_code=status,
                detail=f"上游返回 {status}: {exc.response.text[:200] if exc.response.text else ''}",
            ) from exc
        # 5xx 归为 Bad Gateway
        raise HTTPException(
            status_code=502, detail=f"上游 CDN 错误: HTTP {status}"
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"下载图片失败: {exc}"
        ) from exc

    # 根据 URL 后缀推断 content-type,默认按 png 处理
    lower = url.lower().split("?", 1)[0]
    if lower.endswith((".jpg", ".jpeg")):
        content_type = "image/jpeg"
    elif lower.endswith(".webp"):
        content_type = "image/webp"
    elif lower.endswith(".gif"):
        content_type = "image/gif"
    else:
        content_type = "image/png"

    return Response(content=content, media_type=content_type)


@router.post("/uploads/images", response_model=ImageUploadResponse)
async def upload_image(file: UploadFile = File(...)):
    """上传本地图片到 ToAPIs，供图生图使用。"""
    url = await client.upload_image(file)
    return {"url": url}
