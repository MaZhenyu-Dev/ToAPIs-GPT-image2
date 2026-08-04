"""验证 get_recent_batches 排序对变长 seq 的处理。

历史 bug：ORDER BY batch_id DESC 是纯字典序比较。
因为 ``_format_seq`` 对 seq ≥ 100 走自然格式（"100"）而非 0 补齐，
字符串比较时 "100" < "89"（'1' (0x31) < '8' (0x38)），
导致 MT0803100 沉到列表底部，而非按数值应该待的最顶端。

修复：二级排序改成 ``LENGTH(batch_id) DESC, batch_id DESC``，让
"位数多 = seq 更大"先成立，等长时再字典序 = 数值序。

本测试不依赖真实数据库（不引入 aiosqlite 依赖），而是：
1) 抓取实际下发的 SQL，断言 ORDER BY 里包含 LENGTH(batch_id)，
   防止后续重构时不小心把 LENGTH 拿掉。
2) 用一个 Python 端的 sort key 重现 SQL 的 LENGTH DESC + 字典序 DESC 行为，
   验证在 seq 跨 1/10/99/100/999/1000 边界时输出顺序符合直觉。
"""
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.crud.generation_tasks import get_recent_batches
from backend.app.models import Base, GenerationTask


# ---------- 1. SQL 契约测试：确保 ORDER BY 含 LENGTH ----------

async def _capture_sql() -> str:
    """调一次 get_recent_batches，把下发的 SQL 文本抓下来。"""
    captured_sql: list[str] = []
    session = MagicMock(spec=AsyncSession)
    result_mock = MagicMock()
    result_mock.all = MagicMock(return_value=[])
    result_mock.scalar_one = MagicMock(return_value=0)

    async def fake_execute(stmt, *args, **kwargs):
        compiled = str(stmt.compile(compile_kwargs={"literal_binds": True}))
        captured_sql.append(compiled)
        return result_mock

    session.execute = fake_execute

    await get_recent_batches(session, page=1, page_size=10)

    assert len(captured_sql) == 2, f"预期 2 条 SQL(count + select)，实际 {len(captured_sql)}"
    return captured_sql[1]


def test_recent_batches_orderby_uses_length() -> None:
    """回归保护：get_recent_batches 必须在二级排序里使用 LENGTH(batch_id)。

    之前纯字典序的 batch_id DESC 会让 seq ≥ 100 被错排。
    """
    select_sql = asyncio.run(_capture_sql())
    # 必须有 LENGTH(batch_id) DESC
    assert "length" in select_sql.lower(), f"ORDER BY 缺少 LENGTH 排序: {select_sql}"
    assert "batch_id" in select_sql.lower(), f"ORDER BY 缺少 batch_id 排序: {select_sql}"
    # 必须按 DESC 排（LENGTH 和 batch_id 都是 DESC）
    assert select_sql.lower().count("desc") >= 2, (
        f"LENGTH 和 batch_id 都应 DESC 排: {select_sql}"
    )
    print(f"[1] ORDER BY 包含 LENGTH(batch_id) DESC + batch_id DESC: ok")


# ---------- 2. 演示 SQL 排序行为的 Python 实现 ----------

def sql_style_sort(batch_ids: list[str]) -> list[str]:
    """复刻 SQL 的 ``LENGTH(batch_id) DESC, batch_id DESC`` 排序行为。

    用于测试时对比"如果不加 LENGTH"会得到什么错误顺序。

    实现：用 -len 当主 key（让长的在前），用 ``tuple(-ord(c) for c in b)`` 当
    副 key（让每字符的 ord 取反，等价于字符串 DESC），这样 sorted 升序
    比较就能同时拿到 LENGTH DESC 和 字符串 DESC 的效果。

    注意：这只在 batch_id 同前缀 + 同日期时严格 = 数值序；
    不同前缀混排时 LENGTH 是合理 tie-breaker（避免 '1' < '0' 陷阱）。
    """
    return sorted(batch_ids, key=lambda b: (-len(b), tuple(-ord(c) for c in b)))


# ---------- 3. 各种场景下的预期排序 ----------

def test_user_reported_scenario() -> None:
    """复现用户截图里的场景：MT0803100 必须排在 MT080389 之前。"""
    input_ids = [
        "MT080381",
        "MT080382",
        "MT080389",
        "MT0803100",  # 3 位 seq，bug 场景
    ]
    actual = sql_style_sort(input_ids)
    expected = [
        "MT0803100",  # 100, 3 位 → 第一
        "MT080389",   # 89
        "MT080382",   # 82
        "MT080381",   # 81
    ]
    assert actual == expected, f"\n实际: {actual}\n预期: {expected}"
    print(f"[2] 用户场景: {' -> '.join(actual)}")


def test_seq_boundary() -> None:
    """seq 跨 1/10/99/100/999/1000 边界，必须按数值倒序。"""
    input_ids = [
        "MT08032",     # 2
        "MT080310",    # 10
        "MT0803999",   # 999
        "MT0803100",   # 100
        "MT08031",     # 1
        "MT08031000",  # 1000
        "MT080399",    # 99
        "MT0803101",   # 101
    ]
    actual = sql_style_sort(input_ids)
    expected = [
        "MT08031000",  # 1000 (4 位)
        "MT0803999",   # 999  (4 位)
        "MT0803101",   # 101  (4 位)
        "MT0803100",   # 100  (4 位)
        "MT080399",    # 99   (3 位)
        "MT080310",    # 10   (3 位)
        "MT08032",     # 2    (2 位)
        "MT08031",     # 1    (2 位)
    ]
    assert actual == expected, f"\n实际: {actual}\n预期: {expected}"
    print(f"[3] 跨位边界: {' -> '.join(actual)}")


def test_old_sort_was_wrong() -> None:
    """反向证明：纯字典序排序确实会把 MT0803100 错排。"""
    input_ids = ["MT080389", "MT080381", "MT0803100"]
    pure_str_desc = sorted(input_ids, reverse=True)
    # 纯字典序 DESC: "MT080389" > "MT080381" > "MT0803100"
    # → MT0803100 排最后，这正是 bug
    assert pure_str_desc[-1] == "MT0803100", (
        f"纯字典序确实把 MT0803100 排最后，验证 bug 存在: {pure_str_desc}"
    )
    # 而正确排序应该是 MT0803100 在最前
    correct = sql_style_sort(input_ids)
    assert correct[0] == "MT0803100", (
        f"加 LENGTH 之后 MT0803100 排最前: {correct}"
    )
    print(f"[4] 反向验证: 纯字典序把 MT0803100 排最后，加 LENGTH 后排最前")


# ---------- 4. 编译模型 metadata 也跑得通（确认没漏导入字段） ----------

def test_models_metadata_is_valid() -> None:
    """GenerationTask 模型的元数据没坏。"""
    tables = list(Base.metadata.tables.keys())
    assert "generation_tasks" in tables
    # batch_id 列存在
    cols = {c.name for c in Base.metadata.tables["generation_tasks"].columns}
    assert "batch_id" in cols
    assert "created_at" in cols
    print(f"[5] models.Base.metadata OK: tables={tables}")


if __name__ == "__main__":
    test_recent_batches_orderby_uses_length()
    test_user_reported_scenario()
    test_seq_boundary()
    test_old_sort_was_wrong()
    test_models_metadata_is_valid()
    print("\nALL TESTS PASSED")
