"""平台图白边裁剪服务：Pillow + numpy 欧氏距离判定 → 裁剪 → 上传 ToAPIs。

设计要点：
- 阈值语义：像素与纯白 (255,255,255) 的欧氏距离 <= 阈值即视为白边。
  同一阈值下欧氏距离比「最大通道差」更保守（更不易误切浅色内容）。
- 无白边 / 全白图：不裁，crop_image_url 直接引用原图 URL，meta 记录原尺寸。
- 裁剪结果统一 PNG 编码；meta 记录字节级实测（原/新尺寸、原/新字节数、裁掉面积%）。
- 降级保障：Pillow/numpy 不可用或处理失败时记录 crop_meta.error，
  上传 ERP 自动回退原图，功能永不阻塞。
"""

import asyncio
import json
import logging
from io import BytesIO

import numpy as np
from PIL import Image, ImageChops

from backend.app.database import AsyncSessionLocal
from backend.app.models import GenerationTask
from backend.app.toapis_client import client as toapis_client

logger = logging.getLogger(__name__)

DEFAULT_CROP_THRESHOLD = 10

# 进程内 task 级裁剪锁：防止轮询钩子与补算接口并发重复裁剪
_crop_locks: dict[int, asyncio.Lock] = {}
# 后台裁剪任务引用：防止 asyncio.Task 被 GC（"Task was destroyed but it is pending"）
_pending_tasks: set[asyncio.Task] = set()


def _get_lock(task_id: int) -> asyncio.Lock:
    lock = _crop_locks.get(task_id)
    if lock is None:
        lock = asyncio.Lock()
        _crop_locks[task_id] = lock
    return lock


def trim_white_border(image: Image.Image, threshold: int) -> Image.Image | None:
    """按欧氏距离阈值裁掉白边。

    - 全白图（无任何非白像素）→ 返回 None（不裁）
    - 无白边（bbox 覆盖全图）→ 返回 None（不裁）
    - 否则返回裁剪后的图片
    """
    rgb = image.convert("RGB")
    arr = np.asarray(rgb, dtype=np.int16)
    dist = np.sqrt(np.sum((arr - 255) ** 2, axis=2))
    mask = dist > threshold
    if not mask.any():
        return None
    ys, xs = np.nonzero(mask)
    left, right = int(xs.min()), int(xs.max()) + 1
    top, bottom = int(ys.min()), int(ys.max()) + 1
    if left == 0 and top == 0 and right == rgb.width and bottom == rgb.height:
        return None
    return image.crop((left, top, right, bottom))


def crop_image_bytes(image_bytes: bytes, threshold: int) -> tuple[bytes | None, dict]:
    """裁剪图片字节流，返回 (裁剪后 PNG 字节 或 None=不裁, 统计 meta)。"""
    try:
        image = Image.open(BytesIO(image_bytes))
        image.load()
    except Exception as exc:
        raise ValueError(f"图片解析失败: {exc}") from exc

    orig_w, orig_h = image.size
    orig_size = len(image_bytes)
    base_meta = {
        "orig_w": orig_w,
        "orig_h": orig_h,
        "threshold": int(threshold),
    }
    cropped = trim_white_border(image, threshold)
    if cropped is None:
        base_meta.update(
            {
                "crop_w": orig_w,
                "crop_h": orig_h,
                "orig_size": orig_size,
                "crop_size": orig_size,
                "area_pct": 0.0,
            }
        )
        return None, base_meta

    out = BytesIO()
    cropped.save(out, format="PNG")
    crop_bytes = out.getvalue()
    crop_w, crop_h = cropped.size
    base_meta.update(
        {
            "crop_w": crop_w,
            "crop_h": crop_h,
            "orig_size": orig_size,
            "crop_size": len(crop_bytes),
            "area_pct": round((1 - (crop_w * crop_h) / (orig_w * orig_h)) * 100, 1),
        }
    )
    return crop_bytes, base_meta


async def process_crop_for_task(task_id: int, wait: bool = False) -> None:
    """为已完成任务计算裁剪图并落库（并发安全，幂等）。

    - 调度场景（轮询钩子）：wait=False，锁被占时直接跳过
    - 补算场景（recompute 接口）：wait=True，等待当前裁剪完成后重新执行
    - 幂等规则：任务已有裁剪结果且 meta.threshold 与当前配置一致 → 跳过。
      补算前若修改了阈值，meta.threshold 不一致 → 重新裁剪。
    """
    lock = _get_lock(task_id)
    if lock.locked():
        if not wait:
            return
        # 等待当前裁剪完成，随后重新执行主流程（幂等检查决定是否重跑）
        async with lock:
            pass

    async with lock:
        async with AsyncSessionLocal() as session:
            task = await session.get(GenerationTask, task_id)
            if (
                task is None
                or not task.crop_enabled
                or task.status != "completed"
                or not task.image_url
            ):
                return
            threshold = task.crop_threshold or DEFAULT_CROP_THRESHOLD
            if task.crop_image_url and task.crop_meta:
                try:
                    existing = json.loads(task.crop_meta)
                    if existing.get("threshold") == threshold and "error" not in existing:
                        return
                except (ValueError, TypeError):
                    pass
            image_url = task.image_url

        try:
            image_bytes = await toapis_client.fetch_image_bytes(image_url)
            crop_bytes, meta = await asyncio.to_thread(
                crop_image_bytes, image_bytes, threshold
            )
        except Exception as exc:
            logger.warning("裁剪失败 task=%s: %s", task_id, exc)
            async with AsyncSessionLocal() as session:
                task = await session.get(GenerationTask, task_id)
                if task:
                    task.crop_meta = json.dumps({"error": str(exc)})
                    await session.commit()
            return

        async with AsyncSessionLocal() as session:
            task = await session.get(GenerationTask, task_id)
            if task is None:
                return
            if crop_bytes is None:
                task.crop_image_url = image_url
                task.crop_meta = json.dumps(meta)
                await session.commit()
                return
            try:
                crop_url = await toapis_client.upload_image_bytes(
                    crop_bytes, filename="crop.png", content_type="image/png"
                )
            except Exception as exc:
                task.crop_meta = json.dumps({"error": f"裁剪图上传失败: {exc}"})
                await session.commit()
                return
            task.crop_image_url = crop_url
            task.crop_meta = json.dumps(meta)
            await session.commit()


def schedule_crop(task_id: int) -> None:
    """后台调度裁剪（轮询器钩子用），不阻塞调用方。"""
    t = asyncio.create_task(process_crop_for_task(task_id))
    _pending_tasks.add(t)
    t.add_done_callback(_pending_tasks.discard)


def _load_meta(task: GenerationTask) -> dict | None:
    if not task.crop_meta:
        return None
    try:
        return json.loads(task.crop_meta)
    except (ValueError, TypeError):
        return None
