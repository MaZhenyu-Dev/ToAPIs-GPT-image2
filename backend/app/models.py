from datetime import datetime
from typing import List

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    variant: Mapped["Variant | None"] = relationship("Variant", lazy="joined")
