"""订单尺寸 → 生成比例（SIZE_RESOLUTION_MAP）自动映射 + 走廊地毯占位符填充。

工厂用图要求「长边水平、短边竖直」（横版），而 ERP 订单尺寸如
"80x400" 描述为 宽x高（短x长）。映射规则：取长边/短边作为目标宽高比，
只从横版比例池（宽≥高，含 1:1）中选择最接近的一项；无法解析时回退 "1:1"。

走廊地毯「1:1 画布 + 占位符 prompt」方案（v2）：
- 生成画布恒为 1:1，真实比例写进 prompt 占位符（{{ASPECT_RATIO}} 等），
  避免极端宽高比（4:1/8:1）触发模型切换、且多数模型画布比例失真
- 占位符填充规则：
  {{RUG_WIDTH_CM}}    = 短边 cm（80）
  {{RUG_LENGTH_CM}}   = 长边 cm（200）
  {{ASPECT_RATIO}}    = 长宽比数值（2.5，保留 1 位小数，整数为 1 位）
  {{RUG_CANVAS_WIDTH}}  = 90%（地毯横向顶到 90% 宽，左右各留 5%）
  {{RUG_CANVAS_HEIGHT}} = 90% ÷ 宽高比（200/80=2.5 → 36%），上下自然留白
  {{BACKGROUND_COLOR}}  = pure white (#FFFFFF)
"""

import re
from typing import Optional

from backend.app.schemas import SIZE_RESOLUTION_MAP

SIZE_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*[xX*×]\s*(\d+(?:\.\d+)?)")

# 横版比例池：宽高比 >= 1（含 1:1 正方形），工厂用图长边必须水平
LANDSCAPE_RATIOS: list[str] = []

# 走廊地毯 1:1 画布：地毯横向占画布宽度的百分比（上下自然留白）
CORRIDOR_CANVAS_WIDTH_PCT = 90
# 走廊地毯背景色（与模板 {{BACKGROUND_COLOR}} 对应）
CORRIDOR_BACKGROUND_COLOR = "pure white (#FFFFFF)"


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
    """把订单尺寸映射到最近的横版比例（长边水平、短边竖直）；解析失败回退 1:1。

    走廊地毯白名单规格（宽 75/80 × 长 200/240/300/360/400）统一返回 1:1：
    生成画布恒为正方形，真实长宽比由 prompt 占位符（{{ASPECT_RATIO}}）承载。
    """
    if is_corridor_size(size_text):
        return "1:1"
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


# ---------- 走廊地毯：1:1 画布 + 占位符填充 ----------

# 走廊地毯规格白名单（工厂规范）：宽度 × 长度（cm，长短边自动识别）。
# 命中即视为走廊地毯：生成画布强制 1:1，真实比例/尺寸写入 prompt 占位符，
# 不再走「订单尺寸 → 最近横版比例」映射（80x300 不会被映射成 4:1）。
CORRIDOR_WIDTHS = {75, 80}
CORRIDOR_LENGTHS = {200, 240, 300, 360, 400}


def is_corridor_size(size_text: str) -> bool:
    """订单尺寸是否为走廊地毯规格（宽 75/80 × 长 200/240/300/360/400）。

    长短边自动识别（80x200 与 200x80 等价）；解析失败返回 False。
    """
    parsed = parse_order_size(size_text)
    if parsed is None:
        return False
    width, height = parsed
    if width <= 0 or height <= 0:
        return False
    short_edge = round(min(width, height))
    long_edge = round(max(width, height))
    return short_edge in CORRIDOR_WIDTHS and long_edge in CORRIDOR_LENGTHS


def format_aspect_ratio(ratio: float) -> str:
    """宽高比数值格式化：整数不带小数（2 → "2"），否则保留 1 位（2.5 → "2.5"）。"""
    if ratio == int(ratio):
        return str(int(ratio))
    return f"{ratio:.1f}"


def build_corridor_placeholders(size_text: str) -> dict[str, str]:
    """按订单实际尺寸（如 "80x200"）计算走廊地毯 prompt 占位符。

    解析失败返回空 dict —— 走廊地毯必须有真实尺寸（工厂规范），
    调用方拿到空 dict 应直接报错而不是带着占位符原文提交。
    """
    parsed = parse_order_size(size_text)
    if parsed is None:
        return {}
    width, height = parsed
    if width <= 0 or height <= 0:
        return {}

    short_edge = min(width, height)
    long_edge = max(width, height)
    ratio = long_edge / short_edge

    canvas_w = f"{CORRIDOR_CANVAS_WIDTH_PCT}%"
    canvas_h = f"{round(CORRIDOR_CANVAS_WIDTH_PCT / ratio)}%"

    return {
        "{{RUG_WIDTH_CM}}": f"{short_edge:g}",
        "{{RUG_LENGTH_CM}}": f"{long_edge:g}",
        "{{ASPECT_RATIO}}": format_aspect_ratio(ratio),
        "{{RUG_CANVAS_WIDTH}}": canvas_w,
        "{{RUG_CANVAS_HEIGHT}}": canvas_h,
        "{{BACKGROUND_COLOR}}": CORRIDOR_BACKGROUND_COLOR,
    }


def fill_corridor_placeholders(prompt: str, size_text: str) -> str:
    """把走廊地毯模板中的 {{XXX}} 占位符替换为订单实际尺寸参数。

    尺寸解析失败时返回空字符串（调用方应视为错误，不能带占位符原文提交）。
    模板中没有占位符时原样返回（用户自定义过 prompt 的情况）。
    """
    if not prompt:
        return prompt
    values = build_corridor_placeholders(size_text)
    if not values and "{{" in prompt:
        # 模板含占位符但尺寸解析失败 → 拒绝（工厂规范必有尺寸）
        return ""
    filled = prompt
    for key, val in values.items():
        filled = filled.replace(key, val)
    return filled
