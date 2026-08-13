"""标题生成服务：调用 ToAPIs chat/completions 多模态模型生成电商标题。

设计要点：
- 每个 TitleTask 是 1 个独立 HTTP 请求，独立落库，独立重试。
- 全局信号量 ``MAX_CONCURRENT_TITLE_GENERATIONS`` 控制同时在飞的请求数，
  避免触发 ToAPIs 429。
- 失败不会影响其他任务，错误信息会写到 title_task.error_msg。
- **并发调度**：使用 ``asyncio.create_task`` 把每个 TitleTask 挂到事件循环里
  独立运行，**不要**用 FastAPI ``BackgroundTasks``——后者是 ``for/await`` 顺序
  执行，会让 N 条标题串行排队生成（参见 _generate_one 注释）。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import settings
from backend.app.crud import title_tasks as crud
from backend.app.database import AsyncSessionLocal
from backend.app.models import GenerationTask, TitleTask
from backend.app.schemas import TITLE_MODEL_ORDER
from backend.app.toapis_client import client

logger = logging.getLogger(__name__)

# 全局信号量：限制同时在飞的 chat/completions 请求数。
# 防止批量 50 个标题瞬间打爆 ToAPIs 触发 429。
_title_semaphore: Optional[asyncio.Semaphore] = None

# 单个标题任务最多尝试的模型数（原模型 1 次 + 失败后换模型重试 2 次）。
# 换模型的顺序 = TITLE_MODEL_ORDER（与前端下拉框顺序一致）。
# 全部失败后任务标记为 failed，由前端引导用户手动重试。
MAX_TITLE_MODEL_ATTEMPTS = 3


def _get_semaphore() -> asyncio.Semaphore:
    """懒加载信号量（asyncio.Semaphore 必须在事件循环里实例化）。"""
    global _title_semaphore
    if _title_semaphore is None:
        _title_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_TITLE_GENERATIONS)
    return _title_semaphore


def build_attempt_model_order(initial_model: str) -> list[str]:
    """生成本次任务实际尝试的模型序列。

    规则：
    - 首选用户指定的模型；
    - 失败后按 TITLE_MODEL_ORDER 的顺序依次切换其它模型；
    - 总尝试次数不超过 MAX_TITLE_MODEL_ATTEMPTS。
    """
    attempts = [initial_model]
    for model in TITLE_MODEL_ORDER:
        if model != initial_model:
            attempts.append(model)
        if len(attempts) >= MAX_TITLE_MODEL_ATTEMPTS:
            break
    return attempts


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

    模型容错：首选用户指定的模型；调用失败 / 返回内容为空时，按
    ``TITLE_MODEL_ORDER`` 顺序依次切换其它模型，最多尝试
    ``MAX_TITLE_MODEL_ATTEMPTS`` 个模型。全部失败才标记 failed，
    error_msg 会包含每个模型的失败原因，方便前端引导用户手动重试。

    顶层 try/except 是兜底：任何未被内层 try 捕获的异常（DB 写失败、
    asyncio 取消等）都会被捕获并把任务标为 failed，避免 asyncio 抛
    "Task exception was never retrieved" 警告。
    """
    try:
        sem = _get_semaphore()
        async with sem:
            # 标记为 in_progress（独立 session，避免与请求方的事务冲突）
            async with AsyncSessionLocal() as db:
                title_task = await crud.get_title_task_by_id(db, title_task_id)
                if title_task is None:
                    logger.warning("TitleTask %s 已不存在，跳过", title_task_id)
                    return
                await crud.mark_title_task_in_progress(db, title_task)

            attempts = build_attempt_model_order(model)
            last_error = ""
            for attempt_no, attempt_model in enumerate(attempts, start=1):
                try:
                    messages = build_title_messages(system_prompt, image_url)
                    payload = await client.chat_completion(
                        model=attempt_model,
                        messages=messages,
                        max_tokens=max_tokens,
                        temperature=temperature,
                        timeout=120,  # 标题生成通常 < 30s，给 2 分钟兜底
                    )
                except Exception as exc:  # noqa: BLE001
                    last_error = f"{attempt_model}: {exc}"
                    logger.warning(
                        "TitleTask %s 模型 %s 调用失败（尝试 %d/%d）: %s",
                        title_task_id, attempt_model, attempt_no, len(attempts), exc,
                    )
                    continue

                content = extract_assistant_content(payload)
                if not content:
                    last_error = f"{attempt_model}: 模型返回内容为空"
                    logger.warning(
                        "TitleTask %s 模型 %s 返回内容为空（尝试 %d/%d），原始 payload=%s",
                        title_task_id, attempt_model, attempt_no, len(attempts), payload,
                    )
                    continue

                # 成功：落库 completed（model 字段记录实际成功的模型，供前端展示）
                async with AsyncSessionLocal() as db:
                    title_task = await crud.get_title_task_by_id(db, title_task_id)
                    if title_task is not None:
                        await crud.update_title_task_result(
                            db, title_task,
                            status="completed", title=content,
                            model=attempt_model,
                        )
                logger.info(
                    "TitleTask %s 标题生成成功（模型 %s），长度=%d",
                    title_task_id, attempt_model, len(content),
                )
                return

            # 所有模型都失败
            error_msg = (
                f"已尝试 {len(attempts)} 个模型均失败：{'; '.join(attempts)}。"
                f"最后错误：{last_error}"
            )
            logger.error("TitleTask %s 生成失败: %s", title_task_id, error_msg)
            async with AsyncSessionLocal() as db:
                title_task = await crud.get_title_task_by_id(db, title_task_id)
                if title_task is not None:
                    await crud.update_title_task_result(
                        db, title_task,
                        status="failed", error_msg=error_msg,
                    )
    except Exception as exc:  # noqa: BLE001
        # 兜底：捕获所有未被内层处理的异常（含 DB 失败、asyncio.CancelledError
        # 之外的取消等），把任务标为 failed，避免事件循环报未检索任务异常。
        logger.exception("TitleTask %s 未捕获异常: %s", title_task_id, exc)
        try:
            async with AsyncSessionLocal() as db:
                title_task = await crud.get_title_task_by_id(db, title_task_id)
                if title_task is not None:
                    await crud.update_title_task_result(
                        db, title_task,
                        status="failed",
                        error_msg=f"未捕获异常: {exc}",
                    )
        except Exception:
            logger.exception("TitleTask %s 写入失败状态时再次异常", title_task_id)


def schedule_title_generation(
    background,  # 保留兼容参数（路由层可能传 BackgroundTasks），实际不使用
    title_task: TitleTask,
) -> None:
    """把单个 TitleTask 的生成逻辑挂到事件循环。

    **重要**：必须用 ``asyncio.create_task`` 而不是 ``background.add_task``。
    FastAPI 的 ``BackgroundTasks`` 在响应后是 ``for/await`` 顺序执行所有任务，
    会让 N 条标题串行生成；用 ``asyncio.create_task`` 可以让 N 条任务真正并发飞。

    调用方必须在事件循环内（async router 函数里），本函数是同步的。
    """
    _ = background  # 显式忽略，避免 lint 警告
    asyncio.create_task(
        _generate_one(
            title_task_id=title_task.id,
            model=title_task.model,
            system_prompt=title_task.prompt_snapshot,
            image_url=title_task.source_image_url,
            max_tokens=title_task.max_tokens,
            temperature=title_task.temperature,
        )
    )


def schedule_regenerate(
    background,  # 保留兼容参数，实际不使用
    title_task: TitleTask,
    *,
    model: str,
    system_prompt: str,
    max_tokens: Optional[int],
    temperature: Optional[float],
) -> None:
    """重新生成：调用前先把 regenerated_count 写到 title_task（已由调用方 commit）。

    同 ``schedule_title_generation``，用 ``asyncio.create_task`` 触发并发。
    """
    _ = background
    asyncio.create_task(
        _generate_one(
            title_task_id=title_task.id,
            model=model,
            system_prompt=system_prompt,
            image_url=title_task.source_image_url,
            max_tokens=max_tokens,
            temperature=temperature,
        )
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
