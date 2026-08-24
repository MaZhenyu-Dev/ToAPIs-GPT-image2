import re
from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field, field_validator, model_validator

from .prompts import CARPET_PROMPTS, CARPET_TYPE_LABELS

# 批次号 prefix 校验：仅允许 A-Z / 0-9，长度 1-10
BATCH_PREFIX_PATTERN = re.compile(r"^[A-Z0-9]{1,10}$")


SUPPORTED_SIZES = Literal[
    "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5",
    "16:9", "9:16", "2:1", "1:2", "21:9", "9:21",
]

# 生成模式：
#   t2i        - 文生图
#   i2i        - 图生图，批次内所有任务共享同一组 reference_image_urls
#   product_swap - 产品替换，1 模板 + N 产品 → N 任务
#   i2i_multi  - 文件夹批量图生图：N 张图各自成一个批次，每批次内 K 个任务共享该图片
GENERATION_MODE = Literal["t2i", "i2i", "product_swap", "i2i_multi"]

# 生图模型白名单（与 ToAPIs 文档对齐；前端 IMAGE_MODEL_OPTIONS 需同步）：
# - gpt-image-2：默认模型，不支持 quality 参数
# - gpt-image-2-vip：支持 quality（low/medium/high），分辨率在顶层
# - gemini-3.1-flash-image-preview：ToAPIs 中转版（Nano banana 2），分辨率在
#   metadata（大写 1K/2K/4K），不支持 quality（与 gpt-image-2 同逻辑）
IMAGE_MODEL_ORDER = [
    "gpt-image-2",
    "gpt-image-2-vip",
    "gemini-3.1-flash-image-preview",
]

IMAGE_MODEL = Literal[
    "gpt-image-2",
    "gpt-image-2-vip",
    "gemini-3.1-flash-image-preview",
]

# 统一精度档位（low/medium/high）：当前仅 gpt-image-2-vip 支持（quality 参数）
IMAGE_QUALITY = Literal["low", "medium", "high"]

# 支持 quality 参数的模型（其余模型传 quality 直接校验报错，避免"选了没用上"）
QUALITY_SUPPORTED_MODELS = {"gpt-image-2-vip"}

# 自动重试模型阶梯：任务失败后依次尝试（每次失败后自动换下一个模型重新提交）
# 第 1 次：gpt-image-2（原配置）→ 第 2 次：gpt-image-2-vip + quality=medium → 第 3 次：gemini
# 3 次全部失败后停止，交由用户手动重试（手动重试不清零计数，避免无限循环）
AUTO_RETRY_MODELS = [
    "gpt-image-2",
    "gpt-image-2-vip",
    "gemini-3.1-flash-image-preview",
]
MAX_AUTO_RETRY = len(AUTO_RETRY_MODELS)
# 各阶梯模型的精度档位（不支持的模型为 None，不传 quality）
AUTO_RETRY_QUALITY: dict[str, Optional[str]] = {
    "gpt-image-2-vip": "medium",
}

# product_swap 模式：产品图数量上下限，与 MAX_CONCURRENT_GENERATIONS=20 对齐
MIN_PRODUCT_SWAP_COUNT = 1
MAX_PRODUCT_SWAP_COUNT = 20

# i2i_multi（文件夹批量图生图）：一次请求创建的批次数量上下限
# 1 是最小值（至少 1 张图），500 是 ToAPIs 官方并发升级后的新上限
# （原 50；联系 ToAPIs 将生图模型并发提升到 6000 后放款）。
# 与前端 I2I_MULTI_QUICK_PICKS / 自定义输入 max 对齐。
MIN_I2I_MULTI_COUNT = 1
MAX_I2I_MULTI_COUNT = 500

# ToAPIs 尺寸 / 分辨率 / 像素对照表
SIZE_RESOLUTION_MAP: dict[str, dict[str, str]] = {
    "1:1": {"1k": "1024x1024", "2k": "2048x2048", "4k": "2880x2880"},
    "3:2": {"1k": "1536x1024", "2k": "2048x1360", "4k": "3520x2336"},
    "2:3": {"1k": "1024x1536", "2k": "1360x2048", "4k": "2336x3520"},
    "4:3": {"1k": "1024x768", "2k": "2048x1536", "4k": "3312x2480"},
    "3:4": {"1k": "768x1024", "2k": "1536x2048", "4k": "2480x3312"},
    "5:4": {"1k": "1280x1024", "2k": "2560x2048", "4k": "3216x2576"},
    "4:5": {"1k": "1024x1280", "2k": "2048x2560", "4k": "2576x3216"},
    "16:9": {"1k": "1536x864", "2k": "2048x1152", "4k": "3840x2160"},
    "9:16": {"1k": "864x1536", "2k": "1152x2048", "4k": "2160x3840"},
    "2:1": {"1k": "2048x1024", "2k": "2688x1344", "4k": "3840x1920"},
    "1:2": {"1k": "1024x2048", "2k": "1344x2688", "4k": "1920x3840"},
    "21:9": {"1k": "2016x864", "2k": "2688x1152", "4k": "3840x1648"},
    "9:21": {"1k": "864x2016", "2k": "1152x2688", "4k": "1648x3840"},
}


class SizeResolutionMixin(BaseModel):
    size: SUPPORTED_SIZES = "1:1"
    resolution: Literal["1k", "2k", "4k"] = "1k"

    @model_validator(mode="after")
    def check_size_resolution(self):
        allowed = SIZE_RESOLUTION_MAP.get(self.size, {})
        if self.resolution not in allowed:
            raise ValueError(
                f"分辨率 '{self.resolution}' 不支持尺寸 '{self.size}'，"
                f"可选: {list(allowed.keys())}"
            )
        return self


class ModelQualityMixin(BaseModel):
    """生图模型 + 精度档位（各批量/替换请求共用）。

    - model: 白名单（见 IMAGE_MODEL），默认 gpt-image-2
    - quality: low/medium/high；仅支持 quality 的模型允许传入，其余模型
      传 quality 直接报错（避免"选了精度却没生效"的困惑）
    """

    model: IMAGE_MODEL = "gpt-image-2"
    quality: Optional[IMAGE_QUALITY] = None

    @model_validator(mode="after")
    def check_quality_supported(self):
        if self.quality is not None and self.model not in QUALITY_SUPPORTED_MODELS:
            raise ValueError(
                f"模型 {self.model} 不支持 quality 参数，"
                f"仅 {sorted(QUALITY_SUPPORTED_MODELS)} 支持"
            )
        return self


class GenerationRequest(SizeResolutionMixin):
    """单次文生图请求参数。"""

    prompt: str = Field(..., min_length=1, max_length=32000)
    n: int = Field(1, ge=1, le=1)


class GenerationTaskResponse(BaseModel):
    """ToAPIs 创建任务后返回的初始任务信息。"""

    id: str
    object: str = "generation.task"
    model: str
    status: str
    progress: int
    created_at: int
    metadata: dict = {}


class TaskStatusResponse(BaseModel):
    """ToAPIs 任务状态查询结果。"""

    id: str
    object: str = "generation.task"
    model: str
    status: str
    progress: int
    created_at: int
    completed_at: Optional[int] = None
    url: Optional[str] = None
    expires_at: Optional[int] = None
    error: Optional[dict] = None


class ImageUploadResponse(BaseModel):
    """图片上传后返回的公开 URL。"""

    url: str


# ---------- 变体组 schema ----------

class VariantCreate(BaseModel):
    prompt_content: str = Field(..., min_length=1, max_length=32000)
    sort_order: int = Field(0, ge=0)


class VariantUpdate(BaseModel):
    prompt_content: Optional[str] = Field(None, min_length=1, max_length=32000)
    sort_order: Optional[int] = Field(None, ge=0)


class VariantOut(BaseModel):
    id: int
    group_id: int
    prompt_content: str
    sort_order: int

    class Config:
        from_attributes = True


class VariantGroupCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    variants: list[VariantCreate] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_variants_count(self):
        if len(self.variants) > 20:
            raise ValueError("变体数量不能超过 20 个")
        return self


class VariantGroupUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = None
    variants: Optional[list[VariantCreate]] = None

    @model_validator(mode="after")
    def check_variants_count(self):
        if self.variants is not None and len(self.variants) > 20:
            raise ValueError("变体数量不能超过 20 个")
        return self


class VariantGroupOut(BaseModel):
    id: int
    name: str
    description: Optional[str]
    created_at: datetime
    variants: list[VariantOut]

    class Config:
        from_attributes = True


class VariantGroupListOut(BaseModel):
    id: int
    name: str
    description: Optional[str]
    created_at: datetime
    variant_count: int


# ---------- 批量生成 schema ----------

class BatchGenerateRequest(SizeResolutionMixin, ModelQualityMixin):
    """批量生成请求：基于变体组创建一组生成任务。

    `prefix` 用于自定义批次号前缀（如 "MZY"），最终批次号格式为
    `{prefix}{MMDD}{seq}`（MMDD 取北京时间，seq 为当天该 prefix 下的序号）。
    `model` / `quality` 来自 ModelQualityMixin（默认 gpt-image-2）。
    """

    group_id: int = Field(..., ge=1)
    mode: GENERATION_MODE = "t2i"
    reference_image_urls: Optional[list[str]] = Field(default_factory=list)
    prefix: str = Field(default="MZY", description="批次号前缀，仅允许 A-Z / 0-9")
    relay: Optional["RelayConfig"] = Field(
        default=None, description="自动接力套图配置（可选，传则批次完成后自动创建套图）"
    )

    @field_validator("prefix")
    @classmethod
    def validate_prefix(cls, v: str) -> str:
        v = v.upper()
        if not BATCH_PREFIX_PATTERN.match(v):
            raise ValueError("prefix 仅支持 1-10 位 A-Z / 0-9 字符")
        return v

    @model_validator(mode="after")
    def check_i2i_reference(self):
        if self.mode == "i2i" and not self.reference_image_urls:
            raise ValueError("图生图模式必须提供参考图 URL")
        return self


class RelayConfig(SizeResolutionMixin, ModelQualityMixin):
    """自动接力套图配置：裂变批次全部结束后，自动用其已完成图片创建套图批次。

    挂在 ``BatchGenerateRequest.relay`` 上；不传则不接力（维持现状）。
    套图批次号前缀独立于裂变前缀（如 TAO），seq 按套图前缀独立分配。
    与手动接力（前端收集已完成图后调 /api/batches/i2i-multi）共用同一套
    i2i_multi 创建逻辑。
    """

    group_id: int = Field(..., ge=1)
    prefix: str = Field(default="TAO", description="套图批次前缀，仅允许 A-Z / 0-9")

    @field_validator("prefix")
    @classmethod
    def validate_prefix(cls, v: str) -> str:
        v = v.upper()
        if not BATCH_PREFIX_PATTERN.match(v):
            raise ValueError("prefix 仅支持 1-10 位 A-Z / 0-9 字符")
        return v


class ProductSwapRequest(SizeResolutionMixin, ModelQualityMixin):
    """产品替换请求：上传 1 张模板图 + N 张产品图，生成 N 张结果图。

    每个产品对应一次 ToAPIs 请求，请求体携带 [template, product] 两张参考图，
    n=1。N 个任务共用同一 prompt、同一模板图、同一 size/resolution。
    """

    template_image_url: str = Field(..., min_length=1, max_length=500)
    product_image_urls: list[str] = Field(
        ...,
        min_length=MIN_PRODUCT_SWAP_COUNT,
        max_length=MAX_PRODUCT_SWAP_COUNT,
        description="产品图 URL 列表，按上传顺序生成，1-20 项",
    )
    prompt: str = Field(..., min_length=1, max_length=32000)
    prefix: str = Field(default="MZY", description="批次号前缀，仅允许 A-Z / 0-9")

    @field_validator("template_image_url", "product_image_urls")
    @classmethod
    def validate_urls(cls, v):
        """校验每个 URL 是 http(s) 协议，且不含逗号（避免破坏 CSV 切分）。"""
        urls = v if isinstance(v, list) else [v]
        for url in urls:
            if not url.startswith(("http://", "https://")):
                raise ValueError(f"URL 必须以 http:// 或 https:// 开头: {url!r}")
            if "," in url:
                raise ValueError(f"URL 不得含逗号（会破坏 CSV 切分）: {url!r}")
        return v

    @field_validator("prefix")
    @classmethod
    def validate_prefix(cls, v: str) -> str:
        v = v.upper()
        if not BATCH_PREFIX_PATTERN.match(v):
            raise ValueError("prefix 仅支持 1-10 位 A-Z / 0-9 字符")
        return v

    @model_validator(mode="after")
    def check_template_not_in_products(self):
        if self.template_image_url in self.product_image_urls:
            raise ValueError("模板图 URL 不能与产品图 URL 重复")
        return self


class BatchGenerateResponse(BaseModel):
    batch_id: str
    task_count: int


class TaskRegenerateRequest(ModelQualityMixin):
    """任务重新生成请求：可覆盖模型与精度（尺寸/分辨率等沿用任务原配置）。

    - model: 不传则沿用任务当前 model
    - quality: 仅支持 quality 的模型允许传（ModelQualityMixin 校验）；
      换到不支持精度的模型时服务端会清空任务 quality，避免残留导致后续 422
    """

    model: Optional[IMAGE_MODEL] = None
    quality: Optional[IMAGE_QUALITY] = None


class GenerationTaskOut(BaseModel):
    id: int
    batch_id: str
    variant_id: Optional[int]
    variant_prompt: Optional[str]
    toapis_task_id: Optional[str]
    mode: str
    size: str
    resolution: str
    model: str = "gpt-image-2"
    quality: Optional[str] = None
    auto_retry_count: int = 0
    status: str
    progress: int
    image_url: Optional[str]
    error_msg: Optional[str]
    # product_swap 模式字段：t2i/i2i 时为 None
    template_image_url: Optional[str] = None
    product_image_url: Optional[str] = None
    prompt: Optional[str] = None
    created_at: datetime
    completed_at: Optional[datetime]

    class Config:
        from_attributes = True


class BatchStatusResponse(BaseModel):
    batch_id: str
    total: int
    completed: int
    failed: int
    in_progress: int
    queued: int
    pending: int
    tasks: list[GenerationTaskOut]


class BatchSummary(BaseModel):
    batch_id: str
    task_count: int
    completed_count: int
    failed_count: int = 0
    # 批次内任务的最大重试次数（>0 表示该批次被重试过，列表显示「重试 ×N」徽章）
    retried_count: int = 0
    last_created_at: datetime


class BatchListResponse(BaseModel):
    """近期批次列表（带分页信息）。"""

    batches: list[BatchSummary]
    total: int
    page: int
    page_size: int
    total_pages: int


class BatchDeleteResponse(BaseModel):
    """批次删除响应。"""

    deleted_batch_ids: list[str]
    deleted_task_count: int


class BatchRetryRequest(BaseModel):
    """批量重试失败任务请求：对选中的批次，重试其中所有 failed 任务。"""

    batch_ids: list[str] = Field(..., min_length=1, max_length=500)


class BatchRetryResponse(BaseModel):
    """批量重试失败任务响应。"""

    # 实际发起了重试的批次（存在 failed 任务的批次）
    retried_batch_ids: list[str]
    retried_task_count: int
    # 用户选中但没有 failed 任务、被跳过的批次
    skipped_batch_ids: list[str]


class TodayBatchCountResponse(BaseModel):
    """今日批次计数响应：用于前端批次号预览，保证预览=实际分配。

    - count: 匹配 `{prefix}{date}` 模式的 distinct batch_id 数量
    - prefix: 经校验+大写化后的 prefix
    - date: 北京时间 MMDD（如 "0721"），前端用此日期拼预览，避免本地时区误差
    - next_batch_id: 服务端即将分配给下一次创建的实际 ID（已自动填空隙）
    """

    count: int
    prefix: str
    date: str
    next_batch_id: str


# ---------- 文件夹批量图生图 schema（i2i_multi） ----------

class I2iMultiCreateRequest(SizeResolutionMixin, ModelQualityMixin):
    """文件夹批量图生图请求：一次创建 N 个 i2i 批次，每个批次对应一张图片。

    使用场景：用户从一个本地文件夹中选 N 张图片（命名规范为阿拉伯数字），
    把每张图分别作为独立批次的"参考图"，与同一变体组（K 个 prompt）组合，
    最终产出 N 个批次 × K 个任务 = N×K 个生成任务。

    与 ``BatchGenerateRequest`` 的关键差异：
    - 前者一次创建 1 个批次、N 个变体 → N 个任务，共用 1 张参考图
    - 本请求一次创建 N 个批次，每个批次 1 张独立参考图 → N×K 个任务

    批次号分配：服务端拿到 next_batch_id 后按 seq 递增 1~N 分配；
    任何一段 seq 已被占用会整体拒绝（数据一致性优先）。
    """

    group_id: int = Field(..., ge=1)
    image_urls: list[str] = Field(
        ...,
        min_length=MIN_I2I_MULTI_COUNT,
        max_length=MAX_I2I_MULTI_COUNT,
        description=f"图片 URL 列表，按顺序生成 N 个批次（{MIN_I2I_MULTI_COUNT}-{MAX_I2I_MULTI_COUNT} 项）",
    )
    prefix: str = Field(default="MZY", description="批次号前缀，仅允许 A-Z / 0-9")

    @field_validator("prefix")
    @classmethod
    def validate_prefix(cls, v: str) -> str:
        v = v.upper()
        if not BATCH_PREFIX_PATTERN.match(v):
            raise ValueError("prefix 仅支持 1-10 位 A-Z / 0-9 字符")
        return v

    @field_validator("image_urls")
    @classmethod
    def validate_urls(cls, v: list[str]) -> list[str]:
        """校验每个 URL 是 http(s) 协议，且不含逗号（避免破坏 CSV 切分）。"""
        for url in v:
            if not url.startswith(("http://", "https://")):
                raise ValueError(f"URL 必须以 http:// 或 https:// 开头: {url!r}")
            if "," in url:
                raise ValueError(f"URL 不得含逗号（会破坏 CSV 切分）: {url!r}")
        return v


class I2iMultiCreateResponse(BaseModel):
    """文件夹批量图生图响应：返回创建的所有 batch_id。

    - batch_ids: 实际分配并入库的批次 ID 列表，按 seq 升序
    - task_count: 总任务数 = batch_ids 长度 × 变体组大小（K）
    - base_batch_id: 起始批次 ID（即 next_batch_id 实际值，前端用此渲染预览）
    """

    batch_ids: list[str] = Field(..., description="创建成功的批次 ID 列表（按 seq 升序）")
    task_count: int = Field(..., description="总任务数 = batch_ids 长度 × 变体组大小")
    base_batch_id: str = Field(..., description="起始批次 ID")


# ---------- 标题生成 schema ----------

# 支持的多模态模型列表。前端展示 + 后端校验白名单。
# 顺序与前端 TITLE_MODEL_OPTIONS 保持一致（同时也是失败重试的切换顺序）。
# 注：Literal 必须显式列出（Python 3.10 及以下不支持 Literal[*list]），
# 修改模型清单时记得同步 TITLE_MODEL_ORDER 与 SUPPORTED_TITLE_MODELS。
TITLE_MODEL_ORDER = [
    "gemini-3.7-flash",
    "gpt-5.6-terra",
    "gpt-5.4-mini",
    "claude-haiku-4-5",
    "gpt-5.4-mini-official",
    "grok-4.6",
    "gemini-3.1-pro",
    "grok-4.5",
    "gpt-5.6-sol",
    "gpt-5.4-nano-official",
]

SUPPORTED_TITLE_MODELS = Literal[
    "gemini-3.7-flash",
    "gpt-5.6-terra",
    "gpt-5.4-mini",
    "claude-haiku-4-5",
    "gpt-5.4-mini-official",
    "grok-4.6",
    "gemini-3.1-pro",
    "grok-4.5",
    "gpt-5.6-sol",
    "gpt-5.4-nano-official",
]

# 地毯类型：决定使用哪份内置 prompt（corridor=走廊, living_room=客厅, general=通用）
# 详细 prompt 在 backend/app/prompts/*.md，启动时由 prompts.__init__ 加载到 CARPET_PROMPTS
CARPET_TYPES = Literal["corridor", "living_room", "general"]


class TitleGenerateRequest(BaseModel):
    """批量标题生成请求：基于 N 个批次 × 第 K 张图创建 N 条 TitleTask。

    - batch_ids: 用户选中的 N 个批次 ID（1-200 个，与前端 BATCH_PAGE_SIZE 对齐）
    - carpet_type: 地毯类型，决定使用哪份内置 prompt（corridor / living_room / general）
    - image_index: 从每个批次中取第几张已完成任务的图（1-based）
    - model: 多模态模型 ID（白名单）
    - system_prompt: 覆盖默认 system prompt；不传或为空时使用 carpet_type 对应的内置 prompt
    - max_tokens / temperature: 可选，None 表示用 ToAPIs 默认
    """

    batch_ids: list[str] = Field(
        ...,
        min_length=1,
        # 与前端批次选择 BATCH_PAGE_SIZE=200 对齐；超过 200 应该让前端分批
        max_length=200,
        description="待生成标题的批次 ID 列表（1-200 个）",
    )
    carpet_type: CARPET_TYPES = Field(
        default="general",
        description=(
            "地毯类型：corridor(走廊) / living_room(客厅) / general(通用)，"
            "决定使用哪份内置 prompt"
        ),
    )
    image_index: int = Field(..., ge=1, le=1000, description="从每个批次中取第几张图（1-based）")
    model: SUPPORTED_TITLE_MODELS = "gemini-3.7-flash"
    system_prompt: Optional[str] = Field(
        default=None,
        description=(
            "发送给模型的 system 指令；不传或为空时，"
            "使用 carpet_type 对应的内置 prompt"
        ),
    )
    max_tokens: Optional[int] = Field(default=None, ge=1, le=32768)
    temperature: Optional[float] = Field(default=None, ge=0.0, le=2.0)

    @field_validator("batch_ids")
    @classmethod
    def validate_batch_ids(cls, v: list[str]) -> list[str]:
        """校验每个 batch_id 非空且不含逗号（避免破坏 CSV）。"""
        for bid in v:
            if not bid or not bid.strip():
                raise ValueError("batch_id 不能为空")
            if "," in bid:
                raise ValueError(f"batch_id 不得含逗号: {bid!r}")
        return v

    @field_validator("system_prompt")
    @classmethod
    def validate_system_prompt_length(cls, v):
        """system_prompt 留空/空字符串都是允许的（= 用 carpet_type 内置 prompt），
        但非空时必须满足 1~8000 字符。
        """
        if v is None:
            return v
        if not v.strip():
            return None  # 空字符串归一为 None，方便后续 model_validator 判断
        if len(v) > 8000:
            raise ValueError(f"system_prompt 超过 8000 字符限制（实际 {len(v)}）")
        return v

    @model_validator(mode="after")
    def resolve_default_system_prompt(self):
        """若 user 没传 system_prompt，用 carpet_type 对应的内置 prompt 填充。"""
        if not self.system_prompt:
            self.system_prompt = CARPET_PROMPTS[self.carpet_type]
        return self


class TitleTaskOut(BaseModel):
    """TitleTask 输出结构。"""

    id: int
    source_task_id: Optional[int]
    batch_id: str
    source_image_url: str
    model: str
    extra_instructions: Optional[str]
    max_tokens: Optional[int]
    temperature: Optional[float]
    status: str
    title: Optional[str]
    error_msg: Optional[str]
    regenerated_count: int
    created_at: datetime
    completed_at: Optional[datetime]

    class Config:
        from_attributes = True


class TitleGenerateResponse(BaseModel):
    """批量标题生成响应：返回创建成功的 TitleTask 列表。"""

    created: int = Field(..., description="实际创建的 TitleTask 数量")
    skipped: int = Field(0, description="跳过的批次数量（如没有第 K 张图）")
    title_tasks: list[TitleTaskOut] = Field(default_factory=list)
    errors: list[dict] = Field(
        default_factory=list,
        description="跳过的批次及原因 [{batch_id, reason}]",
    )


class TitleRegenerateRequest(BaseModel):
    """单条 TitleTask 重新生成请求：可覆盖地毯类型 / 模型 / prompt / 参数。

    - 优先顺序：自定义 system_prompt > carpet_type 内置 prompt > 沿用旧任务
    - 不传 carpet_type 也不传 system_prompt 时，沿用旧 TitleTask 的 prompt_snapshot
    """

    carpet_type: Optional[CARPET_TYPES] = Field(
        default=None,
        description=(
            "可选：地毯类型，提供后用对应内置 prompt 作为默认；"
            "不传则继续使用旧任务记录的 prompt"
        ),
    )
    model: Optional[SUPPORTED_TITLE_MODELS] = None
    system_prompt: Optional[str] = Field(default=None, description="可选：自定义 system prompt")
    max_tokens: Optional[int] = Field(default=None, ge=1, le=32768)
    temperature: Optional[float] = Field(default=None, ge=0.0, le=2.0)

    @field_validator("system_prompt")
    @classmethod
    def validate_system_prompt_length(cls, v):
        """system_prompt 留空/空字符串 = None（用 carpet_type 或沿用旧任务）。"""
        if v is None:
            return v
        if not v.strip():
            return None
        if len(v) > 8000:
            raise ValueError(f"system_prompt 超过 8000 字符限制（实际 {len(v)}）")
        return v


class TitleBatchImageItem(BaseModel):
    """批次中一张已完成图片（用于前端"选第 K 张图"逻辑）。"""

    index: int = Field(..., description="在该批次的 1-based 序号（按 id 升序）")
    task_id: int
    image_url: str


class TitleBatchImagesResponse(BaseModel):
    """单个批次中可作为底图的图片列表（仅含 status=completed 且 image_url 非空的任务）。"""

    batch_id: str
    images: list[TitleBatchImageItem]


class TitleBatchDeleteRequest(BaseModel):
    """批量删除 TitleTask 请求。"""

    title_task_ids: list[int] = Field(..., min_length=1, max_length=500)
