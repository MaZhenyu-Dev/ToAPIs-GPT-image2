from datetime import datetime
from typing import List

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class VariantGroup(Base):
    __tablename__ = "variant_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    variants: Mapped[List["Variant"]] = relationship(
        "Variant", back_populates="group", cascade="all, delete-orphan", order_by="Variant.sort_order"
    )


class Variant(Base):
    __tablename__ = "variants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    group_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("variant_groups.id", ondelete="CASCADE"), nullable=False
    )
    prompt_content: Mapped[str] = mapped_column(Text, nullable=False)
    sort_order: Mapped[int] = mapped_column(default=0, nullable=False)

    group: Mapped["VariantGroup"] = relationship("VariantGroup", back_populates="variants")


class GenerationTask(Base):
    __tablename__ = "generation_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # batch_id 格式说明：
    #   新格式 {prefix}{MMDD}{seq}，如 MZY072101
    #   - prefix: 用户自定义（默认 MZY），1-10 位 A-Z / 0-9
    #   - MMDD: 北京时间月日
    #   - seq: 当天该 prefix 下的批次序号（1-based，2 位补 0，>=100 自然展开）
    #   旧数据保留为 UUID（VARCHAR(36) 容纳两种格式）
    batch_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    variant_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("variants.id", ondelete="SET NULL"), nullable=True
    )
    toapis_task_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    # mode: 16 字符以容纳 "product_swap"（12 字符），旧值 t2i / i2i 兼容
    mode: Mapped[str] = mapped_column(String(16), nullable=False)
    size: Mapped[str] = mapped_column(String(10), nullable=False)
    resolution: Mapped[str] = mapped_column(String(5), nullable=False)
    # 生成模型：gpt-image-2（默认）/ gpt-image-2-vip / gemini-3.1-flash-image-preview
    # 持久化到任务记录，重试/重新生成时原样复用，避免丢模型
    model: Mapped[str] = mapped_column(String(64), nullable=False, default="gpt-image-2")
    # 精度档位（low/medium/high）：仅 gpt-image-2-vip 支持（quality 参数）。
    # 不支持的模型（gpt-image-2 / gemini 中转版）为 NULL
    quality: Mapped[str | None] = mapped_column(String(10), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", index=True)
    progress: Mapped[int] = mapped_column(default=0, nullable=False)
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    error_msg: Mapped[str | None] = mapped_column(Text, nullable=True)
    reference_image_urls: Mapped[str | None] = mapped_column(Text, nullable=True)
    # product_swap 模式专用字段：
    # - template_image_url: 批次级共享的模板图（场景图）
    # - product_image_url: 任务级产品图（用户自己的产品）
    # - prompt: 任务级 prompt（product_swap 模式不再依赖 variant）
    # 旧模式 t2i / i2i 保持 NULL，向后兼容
    template_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    product_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 重试次数：每次「重试失败任务 / 重新生成」+1。
    # 用途：近期批次总览页据此显示「重试 ×N」徽章（列表排序完全按批次号，
    # 重试刷新 created_at 不会让批次移动位置）。
    retried_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # 自动重试已执行次数（0-3）：任务失败后按模型阶梯自动重试
    # （gpt-image-2 → gpt-image-2-vip/medium → gemini-3.1-flash-image-preview）。
    # 与 retried_count 语义分离（那是用户手动重试计数，列表"重试过"标记依赖它）。
    auto_retry_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    variant: Mapped["Variant | None"] = relationship("Variant", lazy="joined")


class ErpConfig(Base):
    """工厂 ERP（七彩ERP）会话配置：单行记录（id 恒为 1）。

    cookies 为 JSON 字符串（_identity-backend / _csrf-backend / advanced-backend 等）。
    账号密码永不落库：过期后由用户重新输入获取新 cookie。
    """

    __tablename__ = "erp_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    cookies: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 最近一次会话探测/登录时间（用于前端显示 cookie 状态）
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class ErpOrderItem(Base):
    """工厂 ERP 图片缺失订单快照 + 提取产品图业务状态。

    一次同步把所选店铺的全部缺失订单落库（upsert 按 order_item_id）；
    「店铺 + 货号」去重后的一个生成单元对应一个 generation_task（多行共享
    generation_task_id），生成图上传回 ERP 时对单元内每个 order_item_id 都提交。

    erp_uploaded_at 非空 = 该订单已上传成功（ERP 中订单移出缺失列表后，
    本地记录永久保留供追溯）。
    """

    __tablename__ = "erp_order_items"

    order_item_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    supplier_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    store_name: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    goods_sn: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    size: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    skcid: Mapped[str | None] = mapped_column(String(64), nullable=True)
    skuid: Mapped[str | None] = mapped_column(String(64), nullable=True)
    material: Mapped[str | None] = mapped_column(String(255), nullable=True)
    input_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # 工厂原始图（ERP 同步时的默认输入图）。用户可把 input_image_url 替换为
    # 自定义上传图（家具遮挡严重时换清晰图），随时可重置回本字段值。
    factory_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    order_sn: Mapped[str | None] = mapped_column(String(64), nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    batch_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    generation_task_id: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True, index=True
    )
    result_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    erp_uploaded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), onupdate=func.now(), nullable=True
    )


class TitleTask(Base):
    """标题生成任务：基于已完成的 generation_task 图片调用多模态模型生成电商标题。

    与 generation_tasks 是 1:1 关联（每个 title_task 锁定一个源任务作为底图）。
    设计要点：
    - 每次「生成 / 重新生成」都新建一条 TitleTask 记录（status 走 pending→completed
      生命周期），便于审计 / 导出 CSV 时按时间排序。
    - 冗余 batch_id / source_image_url 字段避免跨表 JOIN 加速列表查询。
    - regenerated_count 统计该源任务累计重新生成次数（不含首次）。
    """

    __tablename__ = "title_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # 源任务（提供底图的 generation_task）；SET NULL 让源任务被删除时保留标题历史
    # 用 BigInteger 与 generation_tasks.id（init.sql 中为 BIGINT）保持一致，
    # 避免 MySQL FK 3780 "Referencing column ... and referenced column ... are incompatible"
    source_task_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("generation_tasks.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 冗余字段，加速列表查询与导出 CSV
    batch_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    source_image_url: Mapped[str] = mapped_column(String(500), nullable=False)
    # 模型 + prompt 快照：每次生成都把当时使用的参数固化下来，方便后续审计
    model: Mapped[str] = mapped_column(String(64), nullable=False)
    # 完整的 system prompt + 实际发送给模型的多模态 user 消息的文本部分
    # 调试 / 复现时直接看这一列就能还原请求
    prompt_snapshot: Mapped[str] = mapped_column(Text, nullable=False)
    # 用户在 system 之外附加的额外要求（可选），与 prompt_snapshot 区分以便 UI 渲染
    extra_instructions: Mapped[str | None] = mapped_column(Text, nullable=True)
    # max_tokens / temperature：NULL 表示走 ToAPIs 默认
    max_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    temperature: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 状态机：pending → in_progress → completed / failed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", index=True)
    # 生成的标题（成功时填入）
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_msg: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 累计重新生成次数（不含首次创建）
    regenerated_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # 懒加载 source_task 用于详情页（列表页只读冗余字段，不触发 JOIN）
    source_task: Mapped["GenerationTask | None"] = relationship("GenerationTask", lazy="noload")
