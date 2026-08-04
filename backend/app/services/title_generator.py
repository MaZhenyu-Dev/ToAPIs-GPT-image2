"""标题生成服务：调用 ToAPIs chat/completions 多模态模型生成电商标题。

设计要点：
- 每个 TitleTask 是 1 个独立 HTTP 请求，独立落库，独立重试。
- 全局信号量 ``MAX_CONCURRENT_TITLE_GENERATIONS`` 控制同时在飞的请求数，
  避免触发 ToAPIs 429。
- 失败不会影响其他任务，错误信息会写到 title_task.error_msg。
- 后台任务用 ``BackgroundTasks`` 调度，立即返回 TitleTask 列表给前端，
  前端通过轮询 /api/title-tasks 拉最新状态。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import settings
from backend.app.crud import title_tasks as crud
from backend.app.database import AsyncSessionLocal
from backend.app.models import GenerationTask, TitleTask
from backend.app.toapis_client import client

logger = logging.getLogger(__name__)

# 全局信号量：限制同时在飞的 chat/completions 请求数。
# 防止批量 50 个标题瞬间打爆 ToAPIs 触发 429。
_title_semaphore: Optional[asyncio.Semaphore] = None


def _get_semaphore() -> asyncio.Semaphore:
    """懒加载信号量（asyncio.Semaphore 必须在事件循环里实例化）。"""
    global _title_semaphore
    if _title_semaphore is None:
        _title_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_TITLE_GENERATIONS)
    return _title_semaphore


def build_title_messages(
    system_prompt: str,
    image_url: str,
) -> list[dict]:
    """组装发给 ToAPIs /v1/chat/completions 的 messages。

    - system: 用户给定的 system prompt
    - user:   文本块（指示"根据图片生成标题"）+ image_url 块（直接传远端 URL）

    注意：image_url 透传远端 URL（依据用户回复：不需要后端代理下载再 base64）。
    """
    return [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "请基于这张商品图片，生成 1 条电商标题。",
                },
                {
                    "type": "image_url",
                    "image_url": {"url": image_url},
                },
            ],
        },
    ]


def extract_assistant_content(payload: dict) -> str:
    """从 ToAPIs chat/completions 响应里抽出 assistant 文本内容。

    兼容多种返回结构：
    1. ``choices[0].message.content``（标准 OpenAI 格式）
    2. ``choices[0].text``（部分旧模型/接口）
    3. ``content`` 顶层字段
    """
    if not isinstance(payload, dict):
        return ""
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    return content.strip()
            text = first.get("text")
            if isinstance(text, str):
                return text.strip()
    content = payload.get("content")
    if isinstance(content, str):
        return content.strip()
    return ""


async def _generate_one(
    title_task_id: int,
    model: str,
    system_prompt: str,
    image_url: str,
    max_tokens: Optional[int],
    temperature: Optional[float],
) -> None:
    """单个 TitleTask 的生成逻辑：发请求 → 写库。

    独立 session，失败不影响其他任务，最后一定把状态推进到 completed/failed。
    """
    sem = _get_semaphore()
    async with sem:
        # 标记为 in_progress（独立 session，避免与请求方的事务冲突）
        async with AsyncSessionLocal() as db:
            title_task = await crud.get_title_task_by_id(db, title_task_id)
            if title_task is None:
                logger.warning("TitleTask %s 已不存在，跳过", title_task_id)
                return
            await crud.mark_title_task_in_progress(db, title_task)

        # 实际调用 ToAPIs
        try:
            messages = build_title_messages(system_prompt, image_url)
            payload = await client.chat_completion(
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                timeout=120,  # 标题生成通常 < 30s，给 2 分钟兜底
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("TitleTask %s 调用 ToAPIs 失败: %s", title_task_id, exc)
            async with AsyncSessionLocal() as db:
                title_task = await crud.get_title_task_by_id(db, title_task_id)
                if title_task is not None:
                    await crud.update_title_task_result(
                        db, title_task,
                        status="failed",
                        error_msg=str(exc) or exc.__class__.__name__,
                    )
            return

        content = extract_assistant_content(payload)
        if not content:
            err = "模型返回内容为空"
            logger.warning("TitleTask %s %s，原始 payload=%s", title_task_id, err, payload)
            async with AsyncSessionLocal() as db:
                title_task = await crud.get_title_task_by_id(db, title_task_id)
                if title_task is not None:
                    await crud.update_title_task_result(
                        db, title_task, status="failed", error_msg=err
                    )
            return

        # 落库 completed
        async with AsyncSessionLocal() as db:
            title_task = await crud.get_title_task_by_id(db, title_task_id)
            if title_task is not None:
                await crud.update_title_task_result(
                    db, title_task, status="completed", title=content
                )
        logger.info("TitleTask %s 标题生成成功，长度=%d", title_task_id, len(content))


def schedule_title_generation(
    background: BackgroundTasks,
    title_task: TitleTask,
) -> None:
    """把单个 TitleTask 的生成逻辑挂到 FastAPI BackgroundTasks。"""
    background.add_task(
        _generate_one,
        title_task_id=title_task.id,
        model=title_task.model,
        system_prompt=title_task.prompt_snapshot,
        image_url=title_task.source_image_url,
        max_tokens=title_task.max_tokens,
        temperature=title_task.temperature,
    )


def schedule_regenerate(
    background: BackgroundTasks,
    title_task: TitleTask,
    *,
    model: str,
    system_prompt: str,
    max_tokens: Optional[int],
    temperature: Optional[float],
) -> None:
    """重新生成：调用前先把 regenerated_count 写到 title_task（已由调用方 commit）。"""
    background.add_task(
        _generate_one,
        title_task_id=title_task.id,
        model=model,
        system_prompt=system_prompt,
        image_url=title_task.source_image_url,
        max_tokens=max_tokens,
        temperature=temperature,
    )


async def build_prompt_snapshot(
    system_prompt: str,
    image_url: str,
) -> str:
    """生成写入数据库的 prompt_snapshot：包含 system 全文 + 远端 image_url 引用。

    调试 / 复现时直接看这一列就能还原请求；不需要把 base64 图片塞进 DB。
    """
    return (
        f"[system]\n{system_prompt}\n\n"
        f"[user]\n请基于图片生成标题：{image_url}"
    )
