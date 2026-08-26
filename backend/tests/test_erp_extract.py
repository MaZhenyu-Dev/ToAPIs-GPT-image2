"""提取产品图功能测试：ERP HTML 解析 / 尺寸映射 / extract payload / schema 校验。

测试目标（不依赖数据库 / 网络）：
1) ``ErpClient._parse_image_missing``：用真实页面 HTML fixture 验证字段解析
   （订单 ID / 货号 / 尺寸 / SKU 信息 / 输入图 / 店铺名 / 备货单号）
2) ``ErpClient._parse_stores``：店铺表格解析
3) ``map_size_to_ratio``：订单尺寸 → 预设比例（含异常输入回退）
4) ``BatchGeneratorService._build_payload`` 在 extract 模式下：
   - 每个任务独立 size（auto 映射后各不相同）
   - reference_images = [输入图]
   - prompt 取自 task.prompt
5) schema 校验：ErpGenerateRequest / ExtractGenerateRequest
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from pydantic import ValidationError

from backend.app.erp_client import ErpClient
from backend.app.models import GenerationTask
from backend.app.schemas import (
    BatchGenerateRequest,
    ErpGenerateRequest,
    ExtractGenerateRequest,
)
from backend.app.services.batch_generator import BatchGeneratorService
from backend.app.services.size_mapping import map_size_to_ratio

FIXTURE = Path(__file__).parent / "fixtures" / "image_missing_row.html"


# ---------- 1) 图片缺失订单解析（真实 HTML） ----------

def test_parse_image_missing_real_html():
    """用 ERP 真实页面片段解析：字段必须完整且正确。"""
    html = FIXTURE.read_text(encoding="utf-8")
    items = ErpClient._parse_image_missing(html)

    assert len(items) == 2, f"应解析出 2 行，实际 {len(items)}"

    first = items[0]
    assert first.order_item_id == 1867010
    assert first.goods_sn == "MZY072905"
    assert first.size == "80x400", f"尺寸应从 .size data-width/height 解析: {first.size!r}"
    assert first.sku == "MZY072905-/80*400cm"
    assert first.skcid == "66831276000"
    assert first.skuid == "84151453355"
    assert first.material == "天鹅绒+树叶点塑底+850g/m²", f"材质: {first.material!r}"
    assert first.input_image_url == "https://img.cdnfe.com/product/fancy/ebe59051-9ae9-4f67-a2f0-73cdab5d3d7d.jpg"
    assert first.order_sn == "WB2608263315509"
    assert first.quantity == 1
    assert first.store_name == "Maison Tiss", f"店铺名应取自 title=供应商: {first.store_name!r}"

    second = items[1]
    assert second.order_item_id == 1867009
    assert second.goods_sn == "MZY072905"  # 同货号不同尺寸
    assert second.size == "80x300"
    assert second.skuid == "75705350487"
    assert second.input_image_url == "https://img.cdnfe.com/product/fancy/7440f3c2-5b3c-409b-8cc0-278b58e39cef.jpg"

    # 同货号不同行 → 输入图不同（去重时取第一行）
    assert first.input_image_url != second.input_image_url
    print("test_parse_image_missing_real_html: ok")


def test_parse_image_missing_skips_summary_row():
    """GridView 的统计行（无 checkbox）必须被跳过。"""
    html = FIXTURE.read_text(encoding="utf-8")
    # 模拟统计行插在 tbody 最前面（真实页面 GridView 行为）
    summary = '<tr><td><strong>10</strong></td></tr>'
    modified = html.replace("<tbody>", "<tbody>" + summary)
    items = ErpClient._parse_image_missing(modified)
    assert len(items) == 2, "统计行不应被解析成订单"
    print("test_parse_image_missing_skips_summary_row: ok")


def test_parse_image_missing_empty():
    """无数据表格返回空列表。"""
    assert ErpClient._parse_image_missing("<html><body>no table</body></html>") == []
    assert ErpClient._parse_image_missing('<table class="kv-grid-table"><tbody></tbody></table>') == []
    print("test_parse_image_missing_empty: ok")


# ---------- 2) 店铺列表解析 ----------

def test_parse_stores():
    """店铺管理页解析：ID + 名称（名称按钮文本优先）。"""
    html = """
    <table class="kv-grid-table"><tbody>
      <tr>
        <td><input type="checkbox" class="kv-row-checkbox" value="2"></td>
        <td>2</td>
        <td>tmsearch</td>
        <td>634418217818572</td>
        <td><button type="button">Vivid Abodes 设置别名</button></td>
        <td>jt7ooy</td>
        <td>正常</td>
      </tr>
      <tr>
        <td><input type="checkbox" class="kv-row-checkbox" value="3"></td>
        <td>3</td>
        <td>tmsearch</td>
        <td>634418215771319</td>
        <td><button type="button">TF DoorMat 设置别名</button></td>
        <td>zof6yg</td>
        <td>正常</td>
      </tr>
    </tbody></table>
    """
    stores = ErpClient._parse_stores(html)
    assert [(s.id, s.name) for s in stores] == [(2, "Vivid Abodes"), (3, "TF DoorMat")]
    print("test_parse_stores: ok")


def test_parse_stores_skips_bad_rows():
    """店铺名/ID 缺失的行跳过。"""
    html = """
    <table class="kv-grid-table"><tbody>
      <tr><td><input type="checkbox" value="1"></td><td>x</td><td></td><td></td><td></td></tr>
      <tr><td><input type="checkbox" value="5"></td><td>5</td><td>tmsearch</td><td>3613654109317</td>
          <td><button type="button">Trendy Beats 设置别名</button></td></tr>
    </tbody></table>
    """
    stores = ErpClient._parse_stores(html)
    assert [(s.id, s.name) for s in stores] == [(5, "Trendy Beats")]
    print("test_parse_stores_skips_bad_rows: ok")


# ---------- 3) 尺寸映射 ----------

def test_map_size_to_ratio():
    """订单尺寸 → 横版比例（长边水平、短边竖直）。

    80x400 表示宽80 高400，工厂要求长边(400)水平 → 目标 400/80=5 → 4:1
    （新增极端比例后不再强压 21:9）。
    """
    cases = {
        "80x400": "4:1",    # 5.0 → 4:1(4.0)（比 21:9 更接近真实比例）
        "80x300": "4:1",    # 3.75 → 4:1(0.25) vs 21:9(1.42)
        "75x400": "4:1",    # 5.33 → 4:1
        "80x200": "21:9",   # 2.5 → 21:9(0.17) vs 4:1(1.5)
        "200x300": "3:2",   # 1.5 → 3:2
        "160x230": "3:2",   # 1.4375 → 3:2
        "120x180": "3:2",   # 1.5 → 3:2
        "120x170": "3:2",   # 1.417 → 3:2
        "80x80": "1:1",
        "120x120": "1:1",
        "50x55": "1:1",     # 1.1 → 1:1
        "50x80": "3:2",     # 1.6 → 3:2
        "240x300": "5:4",   # 1.25 → 5:4
    }
    for size_text, expected in cases.items():
        actual = map_size_to_ratio(size_text)
        assert actual == expected, f"{size_text} → {actual}，期望 {expected}"
    print("test_map_size_to_ratio: ok")


def test_map_size_to_ratio_edge_cases():
    """异常输入回退 1:1；横版约束：结果比例恒 >= 1。"""
    assert map_size_to_ratio("") == "1:1"
    assert map_size_to_ratio("圆形") == "1:1"
    assert map_size_to_ratio("0x0") == "1:1"
    assert map_size_to_ratio("200*300cm") == "3:2"  # 星号分隔 + 单位后缀
    assert map_size_to_ratio("200×300") == "3:2"    # 全角乘号

    # 所有尺寸映射结果必须是横版（宽>=高）
    for text in ["80x400", "300x200", "50x80", "120x170", "90x110", "55x50", "1024x768"]:
        ratio = map_size_to_ratio(text)
        left, _, right = ratio.partition(":")
        assert float(left) >= float(right), f"{text} → {ratio} 不是横版"
    print("test_map_size_to_ratio_edge_cases: ok")


# ---------- 4) extract payload ----------

def test_build_payload_extract_uses_task_size_and_input():
    """extract 模式：size 取 task.size（每任务独立）、reference_images=[输入图]、
    prompt 取 task.prompt。"""
    service = BatchGeneratorService()
    carrier = BatchGenerateRequest(
        group_id=1, mode="extract", size="1:1", resolution="1k", prefix="MZY"
    )

    # 两个任务，auto 映射后尺寸不同（80x400→9:21、200x300→2:3）
    tasks = [
        GenerationTask(
            id=1, batch_id="MZY082601", variant_id=None, mode="extract",
            size="9:21", resolution="1k", status="pending", progress=0,
            prompt="生成干净的产品图",
            reference_image_urls="https://img.cdnfe.com/product/fancy/a.jpg",
        ),
        GenerationTask(
            id=2, batch_id="MZY082601", variant_id=None, mode="extract",
            size="2:3", resolution="1k", status="pending", progress=0,
            prompt="生成干净的产品图",
            reference_image_urls="https://img.cdnfe.com/product/fancy/b.jpg",
        ),
    ]
    for task in tasks:
        payload = service._build_payload(task, carrier)
        assert payload["size"] == task.size, (
            f"extract 模式必须用 task.size（任务独立），实际={payload['size']}"
        )
        assert payload["reference_images"] == [task.reference_image_urls]
        assert payload["prompt"] == "生成干净的产品图"
        assert payload["resolution"] == "1k"
        assert payload["n"] == 1
    print("test_build_payload_extract_uses_task_size_and_input: ok")


def test_build_payload_i2i_multi_unaffected():
    """i2i_multi 模式原有行为不受 extract 改动影响。"""
    service = BatchGeneratorService()
    carrier = BatchGenerateRequest(
        group_id=1, mode="i2i_multi", size="1:1", resolution="1k", prefix="MZY"
    )
    task = GenerationTask(
        id=3, batch_id="MZY082601", variant_id=1, mode="i2i_multi",
        size="1:1", resolution="1k", status="pending", progress=0,
        reference_image_urls="https://cdn.example.com/ref.jpg",
    )
    payload = service._build_payload(task, carrier)
    assert payload["size"] == "1:1"
    assert payload["reference_images"] == ["https://cdn.example.com/ref.jpg"]
    print("test_build_payload_i2i_multi_unaffected: ok")


# ---------- 5) schema 校验 ----------

def test_erp_generate_request_validation():
    """ErpGenerateRequest：fixed 模式必须带 fixed_size；size_overrides 键值校验；
    unit_keys 可选；不再有 prefix 字段。"""
    # auto 模式不需要 fixed_size
    req = ErpGenerateRequest(
        supplier_ids=[2, 3],
        prompt="生成产品图",
        size_mode="auto",
    )
    assert req.size_mode == "auto"

    # fixed 模式不带 fixed_size → 拒绝
    try:
        ErpGenerateRequest(
            supplier_ids=[2], prompt="x", size_mode="fixed"
        )
        assert False, "应该被拒绝"
    except ValidationError as e:
        assert "fixed_size" in str(e)

    # fixed 模式带 fixed_size → 通过
    req2 = ErpGenerateRequest(
        supplier_ids=[2], prompt="x", size_mode="fixed", fixed_size="9:21"
    )
    assert req2.fixed_size == "9:21"

    # unit_keys 可选（单独生成某几个货号）
    req3 = ErpGenerateRequest(
        supplier_ids=[2], prompt="x", unit_keys=["Maison Tiss::MZY072905"]
    )
    assert req3.unit_keys == ["Maison Tiss::MZY072905"]

    # 非法 size 覆盖值 → 拒绝
    try:
        ErpGenerateRequest(
            supplier_ids=[2], prompt="x",
            size_overrides={"1867010": "7:7"},
        )
        assert False, "应该被拒绝"
    except ValidationError:
        pass
    print("test_erp_generate_request_validation: ok")


def test_extract_generate_request_validation():
    """ExtractGenerateRequest：URL 协议 / 逗号 / 数量限制。"""
    # URL 协议校验
    try:
        ExtractGenerateRequest(
            image_urls=["ftp://bad.example.com/a.jpg"], prompt="x"
        )
        assert False, "应该被拒绝"
    except ValidationError as e:
        assert "http" in str(e).lower()

    # 逗号校验（CSV 切分安全）
    try:
        ExtractGenerateRequest(
            image_urls=["https://cdn.example.com/a,b.jpg"], prompt="x"
        )
        assert False, "应该被拒绝"
    except ValidationError as e:
        assert "逗号" in str(e) or "comma" in str(e).lower()

    # 数量上限
    try:
        ExtractGenerateRequest(
            image_urls=[f"https://cdn.example.com/{i}.jpg" for i in range(21)],
            prompt="x",
        )
        assert False, "应该被拒绝"
    except ValidationError:
        pass

    # 正常请求
    req = ExtractGenerateRequest(
        image_urls=["https://cdn.example.com/a.jpg"],
        prompt="生成干净的产品图",
        size="9:21",
        resolution="2k",
        model="gpt-image-2-vip",
        quality="medium",
    )
    assert req.size == "9:21"
    assert req.quality == "medium"
    print("test_extract_generate_request_validation: ok")


# ---------- runner ----------

def main() -> None:
    print("=== erp_extract tests ===")
    # 1) HTML 解析
    test_parse_image_missing_real_html()
    test_parse_image_missing_skips_summary_row()
    test_parse_image_missing_empty()
    # 2) 店铺解析
    test_parse_stores()
    test_parse_stores_skips_bad_rows()
    # 3) 尺寸映射
    test_map_size_to_ratio()
    test_map_size_to_ratio_edge_cases()
    # 4) payload
    test_build_payload_extract_uses_task_size_and_input()
    test_build_payload_i2i_multi_unaffected()
    # 5) schema
    test_erp_generate_request_validation()
    test_extract_generate_request_validation()
    print()
    print("ALL ERP_EXTRACT TESTS PASSED")


if __name__ == "__main__":
    main()
