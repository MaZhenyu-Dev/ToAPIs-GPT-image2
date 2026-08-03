"""手动测试 i2i-multi 端点（不需要真实 DB 的几个分支）。"""
import sys
sys.path.insert(0, r"c:\Users\Admin\Desktop\GPT2")

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

from backend.app.schemas import I2iMultiCreateRequest, I2iMultiCreateResponse
from backend.app.services.batch_generator import BatchGeneratorService
from backend.app.crud.generation_tasks import (
    find_existing_batch_ids,
    parse_batch_id_seq,
)


def test_schema_validation():
    """测试 schema 校验。"""
    # 正常
    req = I2iMultiCreateRequest(
        group_id=1,
        image_urls=[f"https://x.com/{i}.png" for i in range(10)],
        size="1:1",
        resolution="1k",
    )
    assert req.prefix == "MZY"
    assert len(req.image_urls) == 10
    print("[1] schema normal: ok")

    # 数量超限
    try:
        I2iMultiCreateRequest(
            group_id=1,
            image_urls=[f"https://x.com/{i}.png" for i in range(51)],
        )
        assert False, "应该被拒绝"
    except Exception as e:
        assert "at most 50" in str(e) or "at most" in str(e).lower()
        print(f"[2] schema max count rejected: ok ({e})")

    # prefix 大写
    req = I2iMultiCreateRequest(
        group_id=1,
        image_urls=["https://x.com/a.png"],
        prefix="zl",
    )
    assert req.prefix == "ZL"
    print("[3] schema prefix uppercase: ok")

    # URL 含逗号
    try:
        I2iMultiCreateRequest(
            group_id=1,
            image_urls=["https://x.com/a,b.png"],
        )
        assert False, "应该被拒绝"
    except Exception as e:
        assert "逗号" in str(e)
        print(f"[4] schema comma rejected: ok")

    # URL 非 http
    try:
        I2iMultiCreateRequest(
            group_id=1,
            image_urls=["ftp://x.com/a.png"],
        )
        assert False, "应该被拒绝"
    except Exception as e:
        assert "http" in str(e).lower()
        print(f"[5] schema non-http rejected: ok")


def test_seq_parsing():
    """测试 batch_id seq 解析。"""
    assert parse_batch_id_seq("MZY072361", "MZY", "0723") == 61
    assert parse_batch_id_seq("MZY0723100", "MZY", "0723") == 100
    assert parse_batch_id_seq("MZY072302", "MZY", "0723") == 2
    print("[6] parse_batch_id_seq: ok")


async def test_create_i2i_multi_group_not_found():
    """测试变体组不存在的情况。"""
    from backend.app.schemas import I2iMultiCreateRequest
    from backend.app.services.batch_generator import batch_generator

    db = MagicMock()

    # Mock get_variant_group 返回 None
    from backend.app.crud import variant_groups
    original = variant_groups.get_variant_group
    variant_groups.get_variant_group = AsyncMock(return_value=None)
    batch_generator.__init__()

    try:
        req = I2iMultiCreateRequest(
            group_id=9999,
            image_urls=["https://x.com/a.png"],
        )
        await batch_generator.create_i2i_multi(db, req)
        assert False, "应该被拒绝"
    except ValueError as e:
        assert "不存在" in str(e)
        print(f"[7] group not found rejected: ok ({e})")
    finally:
        variant_groups.get_variant_group = original


async def main():
    test_schema_validation()
    test_seq_parsing()
    await test_create_i2i_multi_group_not_found()
    print("\n所有 i2i_multi 单元检查通过 ✓")


asyncio.run(main())
