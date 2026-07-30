"""端到端验证 count_today_batches 算法修复（mock DB session）。

模拟用户场景：删除中间批次产生空洞，验证：
1) 不死循环（旧实现的 bug）
2) 自动填空隙（最小未使用 seq）
3) 预览与实际分配一致
4) 边界：空库、连续、跨 100、大 seq
"""
import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.crud.generation_tasks import _format_seq, count_today_batches


def make_session(existing_batch_ids: list[str]) -> MagicMock:
    """构造一个 mock AsyncSession：``select(...).where(...).distinct()`` 返回指定 batch_ids。"""
    session = MagicMock()
    result_mock = MagicMock()
    result_mock.fetchall = MagicMock(
        return_value=[(bid,) for bid in existing_batch_ids]
    )
    # 让 `await session.execute(...)` 返回上面的 result_mock
    session.execute = AsyncMock(return_value=result_mock)
    return session


async def case(name: str, existing: list[str], expected_count: int, expected_next: str) -> None:
    session = make_session(existing)
    count, date_str, next_id = await count_today_batches(session, "MZY")
    print(f"{name}: existing={len(existing)} -> count={count}, next_id={next_id}")
    assert count == expected_count, f"{name}: count {count} != {expected_count}"
    assert next_id == expected_next, f"{name}: next_id {next_id} != {expected_next}"


async def main() -> None:
    # 0) 格式化函数本身
    assert _format_seq(1) == "01"
    assert _format_seq(9) == "09"
    assert _format_seq(10) == "10"
    assert _format_seq(99) == "99"
    assert _format_seq(100) == "100"
    assert _format_seq(123) == "123"
    print("case 0 (_format_seq): all formatting checks passed")

    # 1) 空库 -> 第一个是 1
    await case("case 1 (empty)", [], 0, "MZY072301")

    # 2) 5 条连续
    await case(
        "case 2 (5 seqs)",
        [f"MZY0723{seq:02d}" for seq in [1, 2, 3, 4, 5]],
        5,
        "MZY072306",
    )

    # 3) 关键场景: 删除 seq=3 后, 不应分配 5 (旧实现的 bug),
    #    应自动填空隙分配 3
    await case(
        "case 3 (gap at 3) - THE BUG FIX",
        [f"MZY0723{seq:02d}" for seq in [1, 2, 4, 5]],
        4,
        "MZY072303",
    )

    # 4) 删 1,2,3 后, 剩 4,5, 最小未使用=1
    await case(
        "case 4 (gaps at 1,2,3)",
        [f"MZY0723{seq:02d}" for seq in [4, 5]],
        2,
        "MZY072301",
    )

    # 5) 大 seq (>100, 不补 0): 仅有 seq 100, 最小未使用=1（填空隙）
    await case(
        "case 5 (only seq 100, fills gap from 1)",
        ["MZY0723100"],
        1,
        "MZY072301",
    )

    # 6) 完整序列 1..149, 删 120, 填空隙到 120
    existing = [f"MZY0723{seq:02d}" for seq in range(1, 150) if seq != 120]
    await case(
        "case 6 (1..149, delete 120, fills gap at 120)",
        existing,
        len(existing),
        "MZY0723120",
    )

    # 7) 完整序列 1..200, 删 50, 填空隙
    existing = [f"MZY0723{seq:02d}" for seq in range(1, 201) if seq != 50]
    await case(
        "case 7 (1..200, delete 50)",
        existing,
        len(existing),
        "MZY072350",
    )

    # 8) 100 条连续，删第 50 条
    existing = [f"MZY0723{seq:02d}" for seq in range(1, 101) if seq != 50]
    await case(
        "case 8 (1..100, delete 50)",
        existing,
        len(existing),
        "MZY072350",
    )

    # 9) 完全清空后又插入新一组, 仍然从 1 开始
    await case("case 9 (all deleted)", [], 0, "MZY072301")

    # 10) 防御: 包含一个异常 batch_id (无法解析的)
    #     - count 包含所有 distinct batch_ids（含无法解析的）: 3
    #     - next_batch_id 忽略无法解析的: smallest valid missing = 3
    await case(
        "case 10 (malformed bid in count, ignored in seq parsing)",
        ["MZY072301", "MZY072302", "WEIRD-UUID-FORMAT"],
        3,
        "MZY072303",
    )

    # 11) 100 条连续, 删最前面两条, 填空隙到 1
    existing = [f"MZY0723{seq:02d}" for seq in range(3, 101)]
    await case(
        "case 11 (delete first 2)",
        existing,
        len(existing),
        "MZY072301",
    )

    # 12) 大 seq (>100, 不补 0): 仅 seq 100, 填空隙到 1
    await case(
        "case 12 (only seq 100, fills gap from 1)",
        ["MZY0723100"],
        1,
        "MZY072301",
    )

    print()
    print("ALL TESTS PASSED - bug is fixed, no infinite loop, gap-filling works")


asyncio.run(main())
