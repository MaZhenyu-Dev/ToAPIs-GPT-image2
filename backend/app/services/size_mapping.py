"""订单尺寸 → 生成比例（SIZE_RESOLUTION_MAP）自动映射。

工厂用图要求「长边水平、短边竖直」（横版），而 ERP 订单尺寸如
"80x400" 描述为 宽x高（短x长）。映射规则：取长边/短边作为目标宽高比，
只从横版比例池（宽≥高，含 1:1）中选择最接近的一项；无法解析时回退 "1:1"。
"""

import re
from typing import Optional

from backend.app.schemas import SIZE_RESOLUTION_MAP

SIZE_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*[xX*×]\s*(\d+(?:\.\d+)?)")

# 横版比例池：宽高比 >= 1（含 1:1 正方形），工厂用图长边必须水平
LANDSCAPE_RATIOS: list[str] = []


def ratio_of(size_key: str) -> float:
    """预设比例 key（如 "21:9"）→ 数值宽高比（宽 / 高）。"""
    left, _, right = size_key.partition(":")
    try:
        return float(left) / float(right)
    except (ValueError, ZeroDivisionError):
        return 1.0


def _landscape_ratios() -> list[str]:
    global LANDSCAPE_RATIOS
    if not LANDSCAPE_RATIOS:
        LANDSCAPE_RATIOS = [
            k for k in SIZE_RESOLUTION_MAP if ratio_of(k) >= 1.0
        ]
    return LANDSCAPE_RATIOS


def parse_order_size(size_text: str) -> Optional[tuple[float, float]]:
    """从尺寸文本解析出 (宽, 高)。支持 "80x400" / "80*400" / "80×400" / "200*300cm"。"""
    m = SIZE_PATTERN.search(size_text or "")
    if not m:
        return None
    return float(m.group(1)), float(m.group(2))


def map_size_to_ratio(size_text: str) -> str:
    """把订单尺寸映射到最近的横版比例（长边水平、短边竖直）；解析失败回退 1:1。"""
    parsed = parse_order_size(size_text)
    if parsed is None:
        return "1:1"
    width, height = parsed
    if width <= 0 or height <= 0:
        return "1:1"
    # 工厂用图要求长边水平：目标比例 = 长边 / 短边（恒 >= 1）
    long_edge = max(width, height)
    short_edge = min(width, height)
    target = long_edge / short_edge
    best = min(_landscape_ratios(), key=lambda k: abs(ratio_of(k) - target))
    return best
