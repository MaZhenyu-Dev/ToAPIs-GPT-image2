from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.database import get_db
from backend.app.crud.variant_groups import (
    create_variant_group,
    delete_variant_group,
    get_variant_group,
    list_variant_groups,
    update_variant_group,
)
from backend.app.schemas import (
    VariantGroupCreate,
    VariantGroupListOut,
    VariantGroupOut,
    VariantGroupUpdate,
)

router = APIRouter(prefix="/variant-groups", tags=["variant-groups"])


@router.post("", response_model=VariantGroupOut)
async def create_group(
    data: VariantGroupCreate, db: AsyncSession = Depends(get_db)
):
    group = await create_variant_group(db, data)
    return group


@router.get("", response_model=list[VariantGroupListOut])
async def list_groups(db: AsyncSession = Depends(get_db)):
    groups = await list_variant_groups(db)
    return [
        VariantGroupListOut(
            id=g.id,
            name=g.name,
            description=g.description,
            created_at=g.created_at,
            variant_count=len(g.variants),
        )
        for g in groups
    ]


@router.get("/{group_id}", response_model=VariantGroupOut)
async def get_group(group_id: int, db: AsyncSession = Depends(get_db)):
    group = await get_variant_group(db, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="变体组不存在")
    return group


@router.put("/{group_id}", response_model=VariantGroupOut)
async def update_group(
    group_id: int,
    data: VariantGroupUpdate,
    db: AsyncSession = Depends(get_db),
):
    group = await get_variant_group(db, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="变体组不存在")
    group = await update_variant_group(db, group, data)
    return group


@router.delete("/{group_id}", status_code=204)
async def delete_group(group_id: int, db: AsyncSession = Depends(get_db)):
    group = await get_variant_group(db, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="变体组不存在")
    await delete_variant_group(db, group)
    return None
