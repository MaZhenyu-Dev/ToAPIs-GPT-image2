from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models import Variant, VariantGroup
from backend.app.schemas import VariantGroupCreate, VariantGroupUpdate


async def create_variant_group(
    db: AsyncSession, data: VariantGroupCreate
) -> VariantGroup:
    group = VariantGroup(
        name=data.name,
        description=data.description,
        variants=[
            Variant(prompt_content=v.prompt_content, sort_order=v.sort_order)
            for v in data.variants
        ],
    )
    db.add(group)
    await db.commit()
    await db.refresh(group)
    # 预加载关联变体，避免序列化时出现懒加载错误
    result = await db.execute(
        select(VariantGroup)
        .where(VariantGroup.id == group.id)
        .options(selectinload(VariantGroup.variants))
    )
    return result.scalar_one()


async def get_variant_group(db: AsyncSession, group_id: int) -> VariantGroup | None:
    result = await db.execute(
        select(VariantGroup)
        .where(VariantGroup.id == group_id)
        .options(selectinload(VariantGroup.variants))
    )
    return result.scalar_one_or_none()


async def list_variant_groups(db: AsyncSession) -> list[VariantGroup]:
    result = await db.execute(
        select(VariantGroup).options(selectinload(VariantGroup.variants))
    )
    return result.scalars().all()


async def update_variant_group(
    db: AsyncSession, group: VariantGroup, data: VariantGroupUpdate
) -> VariantGroup:
    if data.name is not None:
        group.name = data.name
    if data.description is not None:
        group.description = data.description

    if data.variants is not None:
        # 简化实现：删除旧变体并重建
        await db.execute(
            select(Variant).where(Variant.group_id == group.id)
        )
        for variant in list(group.variants):
            await db.delete(variant)
        group.variants = [
            Variant(prompt_content=v.prompt_content, sort_order=v.sort_order)
            for v in data.variants
        ]

    await db.commit()
    await db.refresh(group)
    result = await db.execute(
        select(VariantGroup)
        .where(VariantGroup.id == group.id)
        .options(selectinload(VariantGroup.variants))
    )
    return result.scalar_one()


async def delete_variant_group(db: AsyncSession, group: VariantGroup) -> None:
    await db.delete(group)
    await db.commit()
