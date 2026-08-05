"""标题生成 prompt 加载器。

把 ``prompts/`` 目录下的 3 个 .md 文件读入内存 dict，供 schemas 和 routers 使用。

设计要点：
- 启动时一次性加载到模块级常量 ``CARPET_PROMPTS``，**不在每次请求时读盘**
- 文件缺失或内容为空时回退到内置 ``DEFAULT_CARPET_TITLE_SYSTEM_PROMPT``，
  保证服务不会因为 prompt 文件被误删而启动失败
- 不在 schemas.py 放 3 份 prompt 字符串：
  - schemas.py 是"数据形状"的真相源，放大段营销文案会让它变成 2000 行的庞然大物
  - 改文案时不用动 Python，纯文本编辑器改 .md 即可
  - 改 .md 后用 ``uvicorn --reload`` 自动重载（依赖文件被 watch）
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(__file__).parent


# ---------- 旧版默认 prompt（保留作为 fallback）----------

# 旧版本地毯标题 system prompt，保留在代码里以兼容"加载失败"场景。
# 当 .md 文件不存在或为空时，临时用这个回退，保证服务不中断。
DEFAULT_CARPET_TITLE_SYSTEM_PROMPT = """你是一名专业的电商店铺标题优化专家。请根据用户提供的商品图片，生成 1 条适合 Temu 平台全托模式的电商标题，要求：

开头固定为「JIT 天鹅绒 850g」；

后续依次覆盖：地毯图案描述 + 材质特点 + 地毯卖点 + 使用场景 + 推荐购买词 + 秋冬字眼；

用优秀的电商店铺标题特点（卖点前置、节奏感强、关键词密度高）润色；

【地毯卖点】只能从以下白名单中选取组合，不得自造：
厚实 / 加厚 / 绒面 / 脚感柔软舒适 / 回弹好 / 可折叠 / 易打理 / 不掉绒 / 不掉色 / 耐踩耐磨 / 加绒保暖。
【严禁出现】防滑、抓地、止滑、non-slip、skid（会触发防滑资质）；
阻燃、防火、flame retardant（触发阻燃标识/资质）；
抗菌、抑菌、防螨、除螨（触发功能资质）；
防水、100% waterproof（强宣称触发资质）；
隔音、降噪（功能资质）。

【推荐购买词】只能从以下中性利益词中选 1 个，不得自造：
居家优选 / 换季推荐 / 室内必备 / 装修搭配 / 应季好物。
【严禁任何促销炒作词】：爆款、热卖、热销、秒杀、抢购、疯抢、限量、
销量第一、人气、首选、必买、断货。

【秋冬字眼】用中性保暖描述：秋冬保暖 / 加绒御寒 / 冬季暖足 / 秋冬适用，不得与促销词混搭；

严禁使用以下高风险词（中英双语）：

绝对化：Best、Top、No.1、The Cheapest、#1、Ultimate、The Only、Perfect、
All-Time Favorite、Most Popular、Best Seller、最、第一、顶级、极品、
全网最低、百分百、100%、永不、永不褪色；
功能夸大/医疗/迷信：Never Fade、Anti-Allergy、Hypoallergenic、Medical Grade、
Cure、Treat、Heal、Miracle、治疗、预防、改善、招财、辟邪；
其他：3D；
严禁出现「儿童」「宝宝」「婴儿」「童」及 kids、baby、infant、nursery、toddler
等任何与儿童相关的内容（无儿童资质，红线）；

格式要求：【不使用任何标点符号】（无逗号、顿号、斜杠、感叹号、破折号、
emoji 等，避免触发平台"特殊符号"风控）；但【必须用空格分隔每个语义段落】——
开头规格、图案描述、材质特点、卖点、使用场景、推荐购买词、秋冬字眼，
相邻两段之间各用 1 个空格隔开，保证可读性，禁止整句连写无空格；

不要输出任何解释、编号、引号或前后缀，只输出最终标题文本本身。"""


# ---------- 加载配置 ----------

# 3 个地毯类型 → 对应 .md 文件名
_CARPET_TYPE_TO_FILE: dict[str, str] = {
    "corridor": "carpet_corridor.md",
    "living_room": "carpet_living_room.md",
    "general": "carpet_general.md",
}

# 中文标签（前端展示用，导出给前端复用）
CARPET_TYPE_LABELS: dict[str, str] = {
    "corridor": "走廊地毯",
    "living_room": "客厅地毯",
    "general": "通用地毯",
}


def load_carpet_prompts() -> dict[str, str]:
    """启动时一次性加载 3 个 prompt 文件到内存 dict。

    加载失败（文件缺失 / 内容为空）时回退到内置 ``DEFAULT_CARPET_TITLE_SYSTEM_PROMPT``。
    """
    prompts: dict[str, str] = {}
    for carpet_type, filename in _CARPET_TYPE_TO_FILE.items():
        path = PROMPTS_DIR / filename
        try:
            content = path.read_text(encoding="utf-8").strip()
            if not content:
                raise ValueError("文件为空")
            prompts[carpet_type] = content
            logger.info("已加载 prompt: %s (%d chars)", filename, len(content))
        except (FileNotFoundError, ValueError, OSError) as exc:
            logger.warning(
                "prompt 文件 %s 加载失败（%s），回退到内置 DEFAULT_CARPET_TITLE_SYSTEM_PROMPT",
                filename, exc,
            )
            prompts[carpet_type] = DEFAULT_CARPET_TITLE_SYSTEM_PROMPT
    return prompts


# 模块级常量：服务启动后整个进程生命周期复用，不重复读盘
CARPET_PROMPTS: dict[str, str] = load_carpet_prompts()


__all__ = [
    "CARPET_PROMPTS",
    "CARPET_TYPE_LABELS",
    "DEFAULT_CARPET_TITLE_SYSTEM_PROMPT",
    "load_carpet_prompts",
]
