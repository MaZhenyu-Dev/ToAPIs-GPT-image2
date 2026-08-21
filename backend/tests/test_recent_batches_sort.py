"""验证 get_recent_batches 的排序行为。

排序在 Python 端完成（``_batch_sort_key``）：完全按批次号排列
（MMDD 数值倒序 → 同日期 prefix 倒序 → 同前缀 seq 数值倒序），
不依赖 created_at。重试/重新生成会刷新任务的 created_at，
但批次在列表中的位置不变 —— 这是用户反馈的诉求：
不要置顶、不要因重试上移、同前缀批次按最后序号排列、当天批次在最前。

历史 bug（SQL 版排序）：纯 ``batch_id DESC`` 是字典序比较，
``_format_seq`` 对 seq ≥ 100 走自然格式（"100"）而非 0 补齐，
字符串比较时 "100" < "89"（'1' (0x31) < '8' (0x38)），
导致 MT0803100 沉到列表底部，而非按数值应该待的最顶端。
现在改为解析出 seq 数值后比较，天然消除该问题。

本测试不依赖真实数据库（不引入 aiosqlite 依赖），而是：
1) 抓取实际下发的 SQL，断言只发一条查询且不含 ORDER BY
   （排序逻辑在 Python，防止后续重构把 created_at 排序加回 SQL）；
2) 用 mock 的聚合行直接验证 get_recent_batches 的输出顺序。
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import NamedTuple
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.crud.generation_tasks import _batch_sort_key, get_recent_batches
from backend.app.models import Base, GenerationTask


class BatchRow(NamedTuple):
    batch_id: str
    task_count: int
    completed_count: int
    failed_count: int
    retried_count: int
    last_created_at: datetime


def _mk(
    batch_id: str,
    last_created_at: datetime | None = None,
    retried_count: int = 0,
) -> BatchRow:
    return BatchRow(
        batch_id=batch_id,
        task_count=2,
        completed_count=2,
        failed_count=0,
        retried_count=retried_count,
        last_created_at=last_created_at or datetime.now(timezone.utc),
    )


async def _run(rows: list[BatchRow], page=1, page_size=10) -> tuple[list[dict], int]:
    """mock session 执行一次 get_recent_batches，返回 (batches, total, sqls)。"""
    captured: list[str] = []
    session = MagicMock(spec=AsyncSession)
    result_mock = MagicMock()
    result_mock.all = MagicMock(return_value=rows)

    async def fake_execute(stmt, *args, **kwargs):
        captured.append(str(stmt.compile(compile_kwargs={"literal_binds": True})))
        return result_mock

    session.execute = fake_execute
    batches, total = await get_recent_batches(session, page=page, page_size=page_size)
    return batches, total, captured


# ---------- 1. SQL 契约测试：排序在 Python，SQL 不排序 ----------

def test_recent_batches_single_select_no_orderby() -> None:
    """回归保护：get_recent_batches 只发一条聚合查询且不含 ORDER BY。

    排序完全由 Python 端 _batch_sort_key 决定，若有人把 created_at
    排序加回 SQL，重试会让批次上移（正是用户反馈想避免的行为）。
    """
    batches, total, sqls = asyncio.run(_run([_mk("MZY072101")]))
    assert len(sqls) == 1, f"预期 1 条聚合 SQL，实际 {len(sqls)}: {sqls}"
    sql_lower = sqls[0].lower()
    assert "order by" not in sql_lower, f"排序应在 Python 端完成: {sqls[0]}"
    assert "group by" in sql_lower, f"应按 batch_id 分组聚合: {sqls[0]}"
    # 回归保护：无 query 时不得出现 WHERE NULL（MySQL 恒假 → 列表空）
    assert "where null" not in sql_lower, f"无查询条件时不应有 WHERE NULL: {sqls[0]}"
    assert [b["batch_id"] for b in batches] == ["MZY072101"], (
        f"mock 行应原样透出: {batches}"
    )
    assert batches[0]["retried_count"] == 0 and batches[0]["task_count"] == 2
    assert total == 1
    print(f"[1] 单条聚合 SQL、无 ORDER BY、Python 排序: ok")


# ---------- 2. 同前缀内按 seq 数值倒序 ----------

def test_user_reported_scenario() -> None:
    """复现用户截图里的场景：MT0803100 必须排在 MT080389 之前。"""
    rows = [
        _mk("MT080381"),
        _mk("MT080382"),
        _mk("MT080389"),
        _mk("MT0803100"),  # 3 位 seq，历史上纯字典序 bug 场景
    ]
    batches, total, _ = asyncio.run(_run(rows))
    ids = [b["batch_id"] for b in batches]
    expected = ["MT0803100", "MT080389", "MT080382", "MT080381"]
    assert ids == expected, f"\n实际: {ids}\n预期: {expected}"
    assert total == 4
    print(f"[2] 用户场景: {' -> '.join(ids)}")


def test_seq_boundary() -> None:
    """同前缀 seq 跨 1/10/99/100/999/1000 边界，必须按数值倒序。"""
    rows = [
        _mk("MT08032"),     # 2
        _mk("MT080310"),    # 10
        _mk("MT0803999"),   # 999
        _mk("MT0803100"),   # 100
        _mk("MT08031"),     # 1
        _mk("MT08031000"),  # 1000
        _mk("MT080399"),    # 99
        _mk("MT0803101"),   # 101
    ]
    batches, _, _ = asyncio.run(_run(rows))
    ids = [b["batch_id"] for b in batches]
    expected = [
        "MT08031000",  # 1000
        "MT0803999",   # 999
        "MT0803101",   # 101
        "MT0803100",   # 100
        "MT080399",    # 99
        "MT080310",    # 10
        "MT08032",     # 2
        "MT08031",     # 1
    ]
    assert ids == expected, f"\n实际: {ids}\n预期: {expected}"
    print(f"[3] 跨位边界: {' -> '.join(ids)}")


def test_old_pure_dict_sort_was_wrong() -> None:
    """反向证明：纯字典序排序确实会把 MT0803100 错排。"""
    input_ids = ["MT080389", "MT080381", "MT0803100"]
    pure_str_desc = sorted(input_ids, reverse=True)
    assert pure_str_desc[-1] == "MT0803100", (
        f"纯字典序确实把 MT0803100 排最后，验证 bug 存在: {pure_str_desc}"
    )
    ids = sorted(input_ids, key=_batch_sort_key, reverse=True)
    assert ids[0] == "MT0803100", f"解析 seq 数值后 MT0803100 排最前: {ids}"
    print(f"[4] 反向验证: 纯字典序错排，数值解析正确排: {ids}")


# ---------- 3. 重试/时间刷新不影响位置 ----------

def test_retry_does_not_move_batch() -> None:
    """重试刷新 created_at 后批次不得上移：仍按 seq 数值倒序。"""
    now = datetime(2026, 8, 21, 12, 0, tzinfo=timezone.utc)
    rows = [
        # seq=01 刚被重试（created_at 最新），也不应排到 seq=02 前面
        _mk("MZY080201", last_created_at=now, retried_count=1),
        _mk("MZY080202", last_created_at=now - timedelta(days=1)),
    ]
    batches, _, _ = asyncio.run(_run(rows))
    ids = [b["batch_id"] for b in batches]
    assert ids == ["MZY080202", "MZY080201"], f"重试不应上移: {ids}"
    print(f"[5] 重试不上移: {' -> '.join(ids)}")


# ---------- 4. 跨前缀：日期（MMDD）倒序优先，当天批次在最前 ----------

def test_cross_prefix_by_date() -> None:
    """不同日期批次按日期倒序（新日期在前），同日期按 prefix 倒序。"""
    rows = [
        _mk("MZY072198"),
        _mk("ZL080301"),
        _mk("MZY080302"),
    ]
    batches, _, _ = asyncio.run(_run(rows))
    ids = [b["batch_id"] for b in batches]
    # 0803（8月3日）两个前缀都在 0721（7月21日）之前；同日期 ZL > MZY
    expected = ["ZL080301", "MZY080302", "MZY072198"]
    assert ids == expected, f"\n实际: {ids}\n预期: {expected}"
    print(f"[6] 跨前缀日期: {' -> '.join(ids)}")


def test_today_batches_on_top() -> None:
    """用户反馈：当天生成的批次必须排最前，即使前缀字母序靠后（TAO < ZY）。"""
    rows = [
        _mk("ZY073101"),
        _mk("ZLL073110"),
        _mk("TAO082101"),  # 今天（0821）创建的套图批次，前缀字母序靠后
        _mk("MZY082102"),
    ]
    batches, _, _ = asyncio.run(_run(rows))
    ids = [b["batch_id"] for b in batches]
    # 0821 的全部排前（TAO > MZY），0731 的排后（ZY > ZLL）
    expected = ["TAO082101", "MZY082102", "ZY073101", "ZLL073110"]
    assert ids == expected, f"\n实际: {ids}\n预期: {expected}"
    print(f"[7] 当天批次置顶: {' -> '.join(ids)}")


# ---------- 5. 分页在排序后切片 ----------

def test_pagination_after_sort() -> None:
    """排序在 Python 完成后切片分页，跨页顺序连续。"""
    rows = [_mk(f"MZY0803{seq:02d}") for seq in range(8, 0, -1)]
    batches, total, _ = asyncio.run(_run(rows, page=2, page_size=3))
    ids = [b["batch_id"] for b in batches]
    assert total == 8
    assert ids == ["MZY080305", "MZY080304", "MZY080303"], f"第 2 页应为 05/04/03: {ids}"
    print(f"[8] 分页切片: page2 -> {' '.join(ids)}")


# ---------- 6. 全库模糊搜索 ----------

def test_search_filters_and_escapes() -> None:
    """q 模糊搜索：SQL 下推 LIKE 过滤 + 通配符转义为字面匹配。"""
    rows = [_mk("MZY080301"), _mk("MZY080302"), _mk("TAO082101")]
    sqls: list[str] = []

    session = MagicMock(spec=AsyncSession)
    result_mock = MagicMock()
    result_mock.all = MagicMock(return_value=rows)

    async def fake_execute(stmt, *args, **kwargs):
        sqls.append(str(stmt.compile(compile_kwargs={"literal_binds": True})))
        return result_mock

    session.execute = fake_execute

    asyncio.run(get_recent_batches(session, page=1, page_size=10, query="0821"))
    sql_lower = sqls[0].lower()
    # LIKE 过滤下推 + 参数化（不拼接用户输入）
    assert "like" in sql_lower and "0821" in sql_lower, f"应有 LIKE 过滤: {sqls[0]}"

    # 通配符转义：% 被转义为 \% （字面匹配，不会匹配全部）
    asyncio.run(get_recent_batches(session, page=1, page_size=10, query="%"))
    sql_lower = sqls[1].lower()
    assert "\\%" in sql_lower, f"% 应被转义为字面量: {sqls[1]}"
    print("[9] 搜索 SQL 下推 + 通配符转义: ok")


# ---------- 7. 编译模型 metadata 也跑得通（确认没漏导入字段） ----------

def test_models_metadata_is_valid() -> None:
    """GenerationTask 模型的元数据没坏。"""
    tables = list(Base.metadata.tables.keys())
    assert "generation_tasks" in tables
    cols = {c.name for c in Base.metadata.tables["generation_tasks"].columns}
    assert "batch_id" in cols
    assert "created_at" in cols
    print(f"[9] models.Base.metadata OK: tables={tables}")


if __name__ == "__main__":
    test_recent_batches_single_select_no_orderby()
    test_user_reported_scenario()
    test_seq_boundary()
    test_old_pure_dict_sort_was_wrong()
    test_retry_does_not_move_batch()
    test_cross_prefix_by_date()
    test_today_batches_on_top()
    test_pagination_after_sort()
    test_search_filters_and_escapes()
    test_models_metadata_is_valid()
    print("\nALL TESTS PASSED")
