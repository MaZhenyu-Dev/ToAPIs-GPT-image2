"""验证自动接力套图监控逻辑（_relay_watch），不依赖真实数据库 / ToAPIs。

覆盖关键分支：
- 全部终态 → 用已完成图片调用 create_i2i_multi（失败任务跳过）
- 部分完成 → 只收集成功的图片
- 全部失败 → 不创建套图
- 未终态 → 轮询等待，终态后再触发
- 超过最大等待 → 放弃，不创建
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.models import GenerationTask
from backend.app.schemas import RelayConfig
from backend.app.services.batch_generator import batch_generator


def make_task(status: str, image_url: str | None = None) -> GenerationTask:
    return GenerationTask(
        batch_id="MZY082101",
        status=status,
        image_url=image_url,
        created_at=datetime.now(timezone.utc),
    )


def make_relay() -> RelayConfig:
    return RelayConfig(group_id=1, prefix="TAO", size="1:1", resolution="1k")


def make_session(execute_results):
    """mock AsyncSession：每次 execute 依次返回 execute_results 中的任务列表。"""
    session = MagicMock()
    results = []
    for tasks in execute_results:
        r = MagicMock()
        r.scalars.return_value.all.return_value = tasks
        results.append(r)
    session.execute = AsyncMock(side_effect=results)
    return session


def make_db_ctx(session):
    """mock AsyncSessionLocal()：async with 恒进入同一 session。"""
    ctx = AsyncMock()
    ctx.__aenter__ = AsyncMock(return_value=session)
    return ctx


def run_relay(tasks_seq, relay=None):
    """以给定任务序列驱动 _relay_watch，返回 create_i2i_multi 的 await 情况。

    tasks_seq 的每一项是一次 get_tasks_by_batch 查询应返回的任务列表。
    """
    db_ctx = make_db_ctx(make_session(tasks_seq))
    with patch("backend.app.database.AsyncSessionLocal", return_value=db_ctx):
        with patch.object(
            batch_generator, "create_i2i_multi", new=AsyncMock(return_value=(["TAO082101"], 2, "TAO082101"))
        ) as create_mock:
            with patch.object(batch_generator, "_RELAY_POLL_INTERVAL", 0):
                asyncio.run(
                    batch_generator._relay_watch("MZY082101", relay or make_relay())
                )
    return create_mock


def test_relay_all_completed() -> None:
    """全部完成：收集所有已完成图片创建套图，失败任务跳过。"""
    tasks = [
        make_task("completed", "http://img/1"),
        make_task("completed", "http://img/2"),
        make_task("failed"),
    ]
    create_mock = run_relay([tasks])
    create_mock.assert_awaited_once()
    request = create_mock.await_args.args[1]
    assert request.image_urls == ["http://img/1", "http://img/2"]
    assert request.prefix == "TAO"
    assert request.group_id == 1
    assert request.size == "1:1"
    print("[1] 全部完成 → 收集图片创建套图: ok")


def test_relay_all_failed_no_create() -> None:
    """全部失败：不创建套图。"""
    tasks = [make_task("failed"), make_task("failed")]
    create_mock = run_relay([tasks])
    create_mock.assert_not_awaited()
    print("[2] 全部失败 → 不创建: ok")


def test_relay_waits_until_done() -> None:
    """未终态时轮询等待，终态后再触发（只触发一次）。"""
    pending = [make_task("in_progress", "http://img/1")]
    done = [make_task("completed", "http://img/1"), make_task("completed", "http://img/2")]
    create_mock = run_relay([pending, done])
    create_mock.assert_awaited_once()
    request = create_mock.await_args.args[1]
    assert request.image_urls == ["http://img/1", "http://img/2"]
    print("[3] 未终态 → 轮询等待 → 终态后触发: ok")


def test_relay_timeout_gives_up() -> None:
    """超过最大等待时间：放弃且不创建套图。"""
    tasks = [make_task("pending")]
    db_ctx = make_db_ctx(make_session([tasks]))
    with patch("backend.app.database.AsyncSessionLocal", return_value=db_ctx):
        with patch.object(
            batch_generator, "create_i2i_multi", new=AsyncMock()
        ) as create_mock:
            with patch.object(
                batch_generator, "_RELAY_MAX_WAIT", timedelta(seconds=-1)
            ):
                asyncio.run(
                    batch_generator._relay_watch("MZY082101", make_relay())
                )
    create_mock.assert_not_awaited()
    print("[4] 超过最大等待 → 放弃: ok")


if __name__ == "__main__":
    test_relay_all_completed()
    test_relay_all_failed_no_create()
    test_relay_waits_until_done()
    test_relay_timeout_gives_up()
    print("\nALL TESTS PASSED")
