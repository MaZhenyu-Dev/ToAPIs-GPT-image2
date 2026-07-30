import re
from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field, field_validator, model_validator

# 批次号 prefix 校验：仅允许 A-Z / 0-9，长度 1-10
BATCH_PREFIX_PATTERN = re.compile(r"^[A-Z0-9]{1,10}$")


SUPPORTED_SIZES = Literal[
    "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5",
    "16:9", "9:16", "2:1", "1:2", "21:9", "9:21",
]

# 生成模式：t2i（文生图）/ i2i（图生图，批次共享 reference）/ product_swap（产品替换，每任务独立 product）
GENERATION_MODE = Literal["t2i", "i2i", "product_swap"]

# product_swap 模式：产品图数量上下限，与 MAX_CONCURRENT_GENERATIONS=20 对齐
MIN_PRODUCT_SWAP_COUNT = 1
MAX_PRODUCT_SWAP_COUNT = 20

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

class BatchGenerateRequest(SizeResolutionMixin):
    """批量生成请求：基于变体组创建一组生成任务。

    `prefix` 用于自定义批次号前缀（如 "MZY"），最终批次号格式为
    `{prefix}{MMDD}{seq}`（MMDD 取北京时间，seq 为当天该 prefix 下的序号）。
    """

    group_id: int = Field(..., ge=1)
    mode: GENERATION_MODE = "t2i"
    reference_image_urls: Optional[list[str]] = Field(default_factory=list)
    prefix: str = Field(default="MZY", description="批次号前缀，仅允许 A-Z / 0-9")

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


class ProductSwapRequest(SizeResolutionMixin):
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


class GenerationTaskOut(BaseModel):
    id: int
    batch_id: str
    variant_id: Optional[int]
    variant_prompt: Optional[str]
    toapis_task_id: Optional[str]
    mode: str
    size: str
    resolution: str
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
