import { useCallback, useEffect, useState } from 'react'
import type { VariantGroup, VariantGroupListItem } from '../types'
import {
  createVariantGroup,
  deleteVariantGroup,
  getVariantGroup,
  listVariantGroups,
  updateVariantGroup,
} from '../api'
import { useConfirm } from './ui/ConfirmDialog'
import GlassButton from './ui/GlassButton'
import GlassCard from './ui/GlassCard'
import { useToast } from './ui/Toast'
import { IconTrash } from './ui/Icon'

const MAX_VARIANTS = 20

interface Props {
  onSelect?: (group: VariantGroupListItem) => void
  selectedGroupId?: number | null
}

export default function VariantGroupManager({ onSelect, selectedGroupId }: Props) {
  const toast = useToast()
  const confirm = useConfirm()
  const [groups, setGroups] = useState<VariantGroupListItem[]>([])
  const [loading, setLoading] = useState(false)

  const [editingGroup, setEditingGroup] = useState<VariantGroup | null>(null)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [variants, setVariants] = useState<string[]>([''])
  const [saving, setSaving] = useState(false)

  const loadGroups = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listVariantGroups()
      setGroups(data)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载变体组失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void loadGroups()
  }, [loadGroups])

  const resetForm = () => {
    setName('')
    setDescription('')
    setVariants([''])
    setEditingGroup(null)
    setIsFormOpen(false)
  }

  const openCreateForm = () => {
    resetForm()
    setIsFormOpen(true)
  }

  const openEditForm = async (groupId: number) => {
    try {
      const group = await getVariantGroup(groupId)
      setEditingGroup(group)
      setName(group.name)
      setDescription(group.description || '')
      setVariants(
        group.variants.length
          ? group.variants
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((v) => v.prompt_content)
          : ['']
      )
      setIsFormOpen(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载变体组失败')
    }
  }

  const handleAddVariant = () => {
    if (variants.length >= MAX_VARIANTS) return
    setVariants([...variants, ''])
  }

  const handleRemoveVariant = (index: number) => {
    const next = variants.filter((_, i) => i !== index)
    setVariants(next.length ? next : [''])
  }

  const handleVariantChange = (index: number, value: string) => {
    const next = [...variants]
    next[index] = value
    setVariants(next)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const filtered = variants.map((v) => v.trim()).filter((v) => v.length > 0)
    if (filtered.length === 0) {
      toast.warning('至少需要 1 个有效的 Prompt 变体')
      return
    }
    if (filtered.length > MAX_VARIANTS) {
      toast.warning(`变体数量不能超过 ${MAX_VARIANTS} 个`)
      return
    }

    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      variants: filtered.map((v, i) => ({
        prompt_content: v,
        sort_order: i,
      })),
    }

    setSaving(true)
    try {
      if (editingGroup) {
        await updateVariantGroup(editingGroup.id, payload)
        toast.success('变体组已更新')
      } else {
        await createVariantGroup(payload)
        toast.success('变体组已创建')
      }
      resetForm()
      await loadGroups()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (groupId: number) => {
    const ok = await confirm({
      title: '删除变体组',
      message: '确定删除该变体组吗？组内的 Prompt 变体将一并删除。',
      confirmLabel: '删除',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await deleteVariantGroup(groupId)
      toast.success('变体组已删除')
      await loadGroups()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <GlassCard>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
        }}
      >
        <h2 style={{ margin: 0 }}>变体组管理</h2>
        <GlassButton variant="primary" size="sm" onClick={openCreateForm}>
          新建变体组
        </GlassButton>
      </div>

      {isFormOpen && (
        <form
          onSubmit={handleSubmit}
          style={{ marginBottom: '1.5rem', padding: '1.25rem', background: 'var(--glass-1-bg)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)' }}
        >
          <div className="form-group">
            <label htmlFor="group-name">变体组名称</label>
            <input
              id="group-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：未来城市海报"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="group-desc">描述（可选）</label>
            <input
              id="group-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简短描述该组用途"
            />
          </div>

          <div className="form-group">
            <label>
              Prompt 变体 ({variants.length}/{MAX_VARIANTS})
            </label>
            {variants.map((value, index) => (
              <div key={index} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <textarea
                  value={value}
                  onChange={(e) => handleVariantChange(index, e.target.value)}
                  placeholder={`变体 ${index + 1} 的 Prompt`}
                  style={{ minHeight: '60px', flex: 1 }}
                  aria-label={`变体 ${index + 1}`}
                />
                <GlassButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemoveVariant(index)}
                  icon={<IconTrash width={13} height={13} />}
                >
                  删除
                </GlassButton>
              </div>
            ))}
            <GlassButton
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleAddVariant}
              disabled={variants.length >= MAX_VARIANTS}
            >
              添加变体
            </GlassButton>
          </div>

          <div className="config-actions" style={{ marginTop: 'var(--space-3)' }}>
            <GlassButton type="submit" variant="primary" loading={saving}>
              {editingGroup ? '保存修改' : '创建变体组'}
            </GlassButton>
            <GlassButton type="button" variant="ghost" onClick={resetForm}>
              取消
            </GlassButton>
          </div>
        </form>
      )}

      {loading ? (
        <div className="hint">加载中...</div>
      ) : groups.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">暂无变体组</div>
          <div className="empty-state-description">创建第一个变体组，即可在批量生成中使用。</div>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {groups.map((group) => (
            <li
              key={group.id}
              style={{
                padding: '0.85rem 1rem',
                marginBottom: '0.5rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background:
                  selectedGroupId === group.id ? 'var(--accent-soft)' : 'var(--glass-1-bg)',
                border: '1px solid var(--glass-border)',
                borderRadius: 'var(--radius-md)',
                transition: 'background var(--dur), border-color var(--dur)',
              }}
            >
              <div
                style={{ flex: 1, cursor: onSelect ? 'pointer' : 'default' }}
                onClick={() => onSelect?.(group)}
              >
                <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>{group.name}</div>
                <div className="hint">
                  {group.variant_count} 个变体
                  {group.description ? ` · ${group.description}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {onSelect && (
                  <GlassButton size="sm" variant="secondary" onClick={() => onSelect(group)}>
                    选择
                  </GlassButton>
                )}
                <GlassButton size="sm" variant="ghost" onClick={() => void openEditForm(group.id)}>
                  编辑
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleDelete(group.id)}
                  icon={<IconTrash width={12} height={12} />}
                  style={{ color: 'var(--danger)' }}
                >
                  删除
                </GlassButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  )
}
