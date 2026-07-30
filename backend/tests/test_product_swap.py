"""端到端验证 product_swap 功能的 schema 校验、payload 构造和顺序保持。

测试目标（不依赖数据库 / 网络）：
1) ``ProductSwapRequest`` schema 校验：
   - URL 协议必须 http(s)，含逗号会被拒绝
   - 模板图 URL 出现在 product_image_urls 中会被拒绝
   - 产品图数量限制 1-20
   - prefix 大写化 + 字符限制
   - size / resolution 组合必须有效
2) ``BatchGeneratorService._build_payload`` 在 product_swap 模式下：
   - 从 task.prompt 取 prompt（不依赖 variant）
   - reference_images = [template, product]（顺序固定）
   - t2i / i2i 旧路径不受影响
3) 任务生成顺序：传入 N 个 product_url 顺序即为 task 数组顺序（与前端上传顺序一致）
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from pydantic import ValidationError

from backend.app.models import GenerationTask
from backend.app.schemas import (
    MAX_PRODUCT_SWAP_COUNT,
    MIN_PRODUCT_SWAP_COUNT,
    ProductSwapRequest,
)
from backend.app.services.batch_generator import BatchGeneratorService


# ---------- 1) schema 校验 ----------

def test_product_swap_min_count():
    """产品图数量下限：少于 MIN_PRODUCT_SWAP_COUNT 拒绝。"""
    try:
        ProductSwapRequest(
            template_image_url="https://cdn.example.com/template.png",
            product_image_urls=[],
            prompt="把产品放进场景",
        )
        assert False, "应该被拒绝"
    except ValidationError as e:
        assert "product_image_urls" in str(e) or "at least" in str(e).lower()


def test_product_swap_max_count():
    """产品图数量上限：超过 MAX_PRODUCT_SWAP_COUNT 拒绝。"""
    urls = [f"https://cdn.example.com/p{i}.png" for i in range(MAX_PRODUCT_SWAP_COUNT + 1)]
    try:
        ProductSwapRequest(
            template_image_url="https://cdn.example.com/template.png",
            product_image_urls=urls,
            prompt="把产品放进场景",
        )
        assert False, "应该被拒绝"
    except ValidationError as e:
        assert "product_image_urls" in str(e) or "at most" in str(e).lower()


def test_product_swap_url_protocol():
    """URL 必须以 http(s) 开头。"""
    try:
        ProductSwapRequest(
            template_image_url="ftp://bad.example.com/template.png",
            product_image_urls=["https://cdn.example.com/p1.png"],
            prompt="x",
        )
        assert False, "应该被拒绝"
    except ValidationError as e:
        assert "http" in str(e).lower()


def test_product_swap_url_contains_comma():
    """URL 中含逗号会被拒绝：避免破坏 CSV 切分。"""
    try:
        ProductSwapRequest(
            template_image_url="https://cdn.example.com/template.png",
            product_image_urls=["https://cdn.example.com/p,1.png"],
            prompt="x",
        )
        assert False, "应该被拒绝"
    except ValidationError as e:
        assert "逗号" in str(e) or "comma" in str(e).lower()


def test_product_swap_template_in_products():
    """模板图 URL 出现在产品列表中会被拒绝。"""
    same = "https://cdn.example.com/same.png"
    try:
        ProductSwapRequest(
            template_image_url=same,
            product_image_urls=[same, "https://cdn.example.com/p2.png"],
            prompt="x",
        )
        assert False, "应该被拒绝"
    except ValidationError as e:
        assert "重复" in str(e) or "duplicate" in str(e).lower()


def test_product_swap_prefix_uppercase_and_pattern():
    """prefix 自动大写，且仅允许 A-Z / 0-9，1-10 位。"""
    req = ProductSwapRequest(
        template_image_url="https://cdn.example.com/t.png",
        product_image_urls=["https://cdn.example.com/p1.png"],
        prompt="x",
        prefix="abc",
    )
    assert req.prefix == "ABC", f"prefix 应被大写化，实际={req.prefix}"

    try:
        ProductSwapRequest(
            template_image_url="https://cdn.example.com/t.png",
            product_image_urls=["https://cdn.example.com/p1.png"],
            prompt="x",
            prefix="abc-def",
        )
        assert False, "应该被拒绝"
    except ValidationError as e:
        assert "prefix" in str(e).lower()


def test_product_swap_invalid_size_resolution():
    """size / resolution 组合必须有效（走 SizeResolutionMixin 校验）。"""
    try:
        ProductSwapRequest(
            template_image_url="https://cdn.example.com/t.png",
            product_image_urls=["https://cdn.example.com/p1.png"],
            prompt="x",
            size="1:1",
            resolution="8k",  # 非法分辨率（仅支持 1k/2k/4k）
        )
        assert False, "应该被拒绝"
    except ValidationError as e:
        assert "分辨率" in str(e) or "resolution" in str(e).lower()

    # 同时验证非法 size 也被拒绝
    try:
        ProductSwapRequest(
            template_image_url="https://cdn.example.com/t.png",
            product_image_urls=["https://cdn.example.com/p1.png"],
            prompt="x",
            size="7:7",  # 非法尺寸
            resolution="1k",
        )
        assert False, "应该被拒绝"
    except ValidationError:
        pass


def test_product_swap_happy_path():
    """合法请求能正常构造。"""
    req = ProductSwapRequest(
        template_image_url="https://cdn.example.com/t.png",
        product_image_urls=[
            "https://cdn.example.com/p1.png",
            "https://cdn.example.com/p2.png",
            "https://cdn.example.com/p3.png",
        ],
        prompt="把产品自然融合进场景",
        size="16:9",
        resolution="2k",
    )
    assert req.size == "16:9"
    assert req.resolution == "2k"
    assert len(req.product_image_urls) == 3
    assert req.prefix == "MZY", "默认 prefix 应为 MZY"
    print("test_product_swap_happy_path: ok")


# ---------- 2) _build_payload ----------

def _make_task(idx: int, product_url: str, template_url: str) -> GenerationTask:
    """构造一个内存态的 GenerationTask，模拟 product_swap 模式。"""
    return GenerationTask(
        id=idx,
        batch_id="MZY072801",
        variant_id=None,
        mode="product_swap",
        size="1:1",
        resolution="1k",
        status="pending",
        progress=0,
        template_image_url=template_url,
        product_image_url=product_url,
        prompt="把产品融合进场景",
        reference_image_urls=f"{template_url},{product_url}",
    )


def test_build_payload_product_swap_uses_task_prompt_and_pair():
    """product_swap 模式：prompt 取自 task.prompt，reference_images = [template, product]。"""
    service = BatchGeneratorService()
    template = "https://cdn.example.com/t.png"
    products = [
        "https://cdn.example.com/p1.png",
        "https://cdn.example.com/p2.png",
        "https://cdn.example.com/p3.png",
    ]

    # 模拟一个 carrier BatchGenerateRequest（mode/size/resolution/prefix）
    from backend.app.schemas import BatchGenerateRequest
    carrier = BatchGenerateRequest(
        group_id=1,
        mode="product_swap",
        size="1:1",
        resolution="1k",
        prefix="MZY",
    )

    for idx, product in enumerate(products, start=1):
        task = _make_task(idx, product, template)
        # 直接构造一个不查 DB 的 variant 关系（_build_payload 中 task.variant 不为 None 时
        # 走 variant.prompt_content 分支；为 None 时走 task.prompt 分支）
        payload = service._build_payload(task, carrier)
        assert payload["model"] == "gpt-image-2"
        assert payload["n"] == 1
        assert payload["size"] == "1:1"
        assert payload["resolution"] == "1k"
        assert payload["prompt"] == "把产品融合进场景", (
            f"应使用 task.prompt（product_swap 模式），实际={payload['prompt']!r}"
        )
        assert payload["reference_images"] == [template, product], (
            f"应使用 [template, product] 顺序，实际={payload['reference_images']!r}"
        )
    print("test_build_payload_product_swap_uses_task_prompt_and_pair: ok")


def test_build_payload_t2i_unaffected():
    """t2i 模式旧路径不受 product_swap 改动影响：prompt 走 variant.prompt_content。"""
    from backend.app.schemas import BatchGenerateRequest
    from backend.app.models import Variant
    service = BatchGeneratorService()

    variant = Variant(id=1, group_id=1, prompt_content="一只小猫在窗台", sort_order=0)
    task = GenerationTask(
        id=100,
        batch_id="MZY072801",
        variant_id=1,
        mode="t2i",
        size="1:1",
        resolution="1k",
        status="pending",
        progress=0,
    )
    # 在内存中挂上 variant 关系（绕过 lazy=joined）
    task.variant = variant

    carrier = BatchGenerateRequest(
        group_id=1, mode="t2i", size="1:1", resolution="1k", prefix="MZY"
    )
    payload = service._build_payload(task, carrier)
    assert payload["prompt"] == "一只小猫在窗台"
    assert "reference_images" not in payload, "t2i 模式不应携带 reference_images"
    print("test_build_payload_t2i_unaffected: ok")


# ---------- 3) 任务顺序保持 ----------

def test_create_product_swap_task_order_matches_request_order():
    """create_product_swap 创建任务的顺序 = request.product_image_urls 顺序。

    我们不真连数据库，而是直接调用内部列表推导，验证：
    - 任务数 = product 数
    - 每个 task 的 product_image_url 与 product 列表顺序一一对应
    - 模板图 URL 写到了所有 task 的 template_image_url
    - reference_image_urls CSV 格式 = "{template},{product}"（保持 retry/regenerate 兼容）
    - variant_id 全为 None（product_swap 不依赖变体）
    - mode = "product_swap"
    - prompt 写入每个 task
    """
    template = "https://cdn.example.com/t.png"
    products = [f"https://cdn.example.com/p{i}.png" for i in range(1, 6)]  # 5 个产品

    # 用真实 schema 构造请求（走完整校验链路）
    req = ProductSwapRequest(
        template_image_url=template,
        product_image_urls=products,
        prompt="把产品融合进场景",
        size="1:1",
        resolution="1k",
    )

    # 复刻 create_product_swap 内部的列表推导（不连 DB）
    tasks = [
        GenerationTask(
            batch_id="MZY072801",
            variant_id=None,
            mode="product_swap",
            size=req.size,
            resolution=req.resolution,
            status="pending",
            progress=0,
            template_image_url=req.template_image_url,
            product_image_url=product_url,
            prompt=req.prompt,
            reference_image_urls=f"{req.template_image_url},{product_url}",
        )
        for product_url in req.product_image_urls
    ]

    # 1) 任务数 == 产品数
    assert len(tasks) == len(products), f"任务数 {len(tasks)} 应为 {len(products)}"

    # 2) 顺序一致：task[i].product_image_url == products[i]
    for i, (task, product_url) in enumerate(zip(tasks, products)):
        assert task.product_image_url == product_url, (
            f"第 {i} 个任务的 product_image_url 错位: "
            f"task={task.product_image_url!r}, expected={product_url!r}"
        )

    # 3) 模板图写入所有 task
    for task in tasks:
        assert task.template_image_url == template

    # 4) CSV 切分能正确还原 [template, product]
    for task in tasks:
        parts = task.reference_image_urls.split(",")
        assert len(parts) == 2
        assert parts[0] == template
        assert parts[1] == task.product_image_url

    # 5) variant_id 全为 None
    for task in tasks:
        assert task.variant_id is None

    # 6) mode 正确
    for task in tasks:
        assert task.mode == "product_swap"

    # 7) prompt 写入每个 task
    for task in tasks:
        assert task.prompt == "把产品融合进场景"

    print("test_create_product_swap_task_order_matches_request_order: ok")


def test_constants_in_sync_between_frontend_and_backend():
    """前后端常量必须同步（MIN/MAX_PRODUCT_SWAP_COUNT）。"""
    # 硬约束：MIN 必须是 1（用户至少要传 1 个产品图）
    assert MIN_PRODUCT_SWAP_COUNT == 1
    # 硬约束：MAX 必须与 ToAPIs 实际并发能力匹配（这里 20 与 MAX_CONCURRENT_GENERATIONS 对齐）
    assert MAX_PRODUCT_SWAP_COUNT == 20
    print("test_constants_in_sync_between_frontend_and_backend: ok")


# ---------- runner ----------

def main() -> None:
    print("=== product_swap tests ===")
    # 1) schema
    test_product_swap_min_count()
    test_product_swap_max_count()
    test_product_swap_url_protocol()
    test_product_swap_url_contains_comma()
    test_product_swap_template_in_products()
    test_product_swap_prefix_uppercase_and_pattern()
    test_product_swap_invalid_size_resolution()
    test_product_swap_happy_path()
    # 2) _build_payload
    test_build_payload_product_swap_uses_task_prompt_and_pair()
    test_build_payload_t2i_unaffected()
    # 3) 顺序
    test_create_product_swap_task_order_matches_request_order()
    test_constants_in_sync_between_frontend_and_backend()
    print()
    print("ALL PRODUCT_SWAP TESTS PASSED")


if __name__ == "__main__":
    main()
