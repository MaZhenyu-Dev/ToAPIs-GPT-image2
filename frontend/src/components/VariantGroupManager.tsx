import { useCallback, useEffect, useState } from 'react'
import type { VariantGroup, VariantGroupListItem } from '../types'
import {
  createVariantGroup,
  deleteVariantGroup,
  getVariantGroup,
  listVariantGroups,
  updateVariantGroup,
} from '../api'

const MAX_VARIANTS = 20

interface Props {
  onSelect?: (group: VariantGroupListItem) => void
  selectedGroupId?: number | null
}

export default function VariantGroupManager({
  onSelect,
  selectedGroupId,
}: Props) {
  const [groups, setGroups] = useState<VariantGroupListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [editingGroup, setEditingGroup] = useState<VariantGroup | null>(null)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [variants, setVariants] = useState<string[]>([''])

  const loadGroups = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listVariantGroups()
      setGroups(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载变体组失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGroups()
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
    setError(null)
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
      setError(err instanceof Error ? err.message : '加载变体组失败')
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
    const filtered = variants
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
    if (filtered.length === 0) {
      setError('至少需要 1 个有效的 Prompt 变体')
      return
    }
    if (filtered.length > MAX_VARIANTS) {
      setError(`变体数量不能超过 ${MAX_VARIANTS} 个`)
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

    setError(null)
    try {
      if (editingGroup) {
        await updateVariantGroup(editingGroup.id, payload)
      } else {
        await createVariantGroup(payload)
      }
      resetForm()
      await loadGroups()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    }
  }

  const handleDelete = async (groupId: number) => {
    if (!confirm('确定删除该变体组吗？')) return
    setError(null)
    try {
      await deleteVariantGroup(groupId)
      await loadGroups()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
        }}
      >
        <h2 style={{ margin: 0 }}>变体组管理</h2>
        <button type="button" onClick={openCreateForm}>
          新建变体组
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {isFormOpen && (
        <form onSubmit={handleSubmit} style={{ marginBottom: '1.5rem' }}>
          <div className="form-group">
            <label>变体组名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：未来城市海报"
              required
            />
          </div>
          <div className="form-group">
            <label>描述（可选）</label>
            <input
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
              <div
                key={index}
                style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}
              >
                <textarea
                  value={value}
                  onChange={(e) => handleVariantChange(index, e.target.value)}
                  placeholder={`变体 ${index + 1} 的 Prompt`}
                  style={{ minHeight: '60px', flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => handleRemoveVariant(index)}
                  style={{
                    background: '#ef4444',
                    padding: '0.4rem 0.8rem',
                  }}
                >
                  删除
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={handleAddVariant}
              disabled={variants.length >= MAX_VARIANTS}
              style={{ background: '#10b981' }}
            >
              添加变体
            </button>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button type="submit">
              {editingGroup ? '保存修改' : '创建变体组'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              style={{ background: '#6b7280' }}
            >
              取消
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div>加载中...</div>
      ) : groups.length === 0 ? (
        <div className="hint">暂无变体组，请先创建。</div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {groups.map((group) => (
            <li
              key={group.id}
              style={{
                padding: '0.75rem',
                borderBottom: '1px solid #e5e7eb',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background:
                  selectedGroupId === group.id ? '#eff6ff' : 'transparent',
                borderRadius: '8px',
              }}
            >
              <div
                style={{ flex: 1, cursor: onSelect ? 'pointer' : 'default' }}
                onClick={() => onSelect?.(group)}
              >
                <div style={{ fontWeight: 500 }}>{group.name}</div>
                <div className="hint">
                  {group.variant_count} 个变体
                  {group.description ? ` · ${group.description}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {onSelect && (
                  <button
                    type="button"
                    onClick={() => onSelect(group)}
                    style={{ padding: '0.4rem 0.8rem' }}
                  >
                    选择
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openEditForm(group.id)}
                  style={{ padding: '0.4rem 0.8rem', background: '#6b7280' }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(group.id)}
                  style={{ padding: '0.4rem 0.8rem', background: '#ef4444' }}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
