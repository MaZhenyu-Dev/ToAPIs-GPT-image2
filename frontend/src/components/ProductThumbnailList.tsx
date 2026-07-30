import { MAX_PRODUCT_SWAP_COUNT } from '../constants'

export interface ProductItem {
  /** 公开 URL（已上传到 ToAPIs） */
  url: string
  /** 用户原文件名（用于显示） */
  name?: string
}

interface Props {
  products: ProductItem[]
  onChange: (next: ProductItem[]) => void
  /** 任何 reorder/remove 操作在 batch 存在时被禁用（防止影响进行中批次） */
  disabled?: boolean
}

/**
 * 产品图带 ↑/↓/× 的缩略图列表。
 *
 * - 顺序：用户拖动或点击 ↑/↓ 时调整，输出文件名按当前顺序生成
 * - 删除：× 直接从列表移除
 * - 上限：达到 MAX_PRODUCT_SWAP_COUNT 时禁用 + 按钮（在调用方控制）
 */
export default function ProductThumbnailList({ products, onChange, disabled }: Props) {
  const moveUp = (index: number) => {
    if (index <= 0) return
    const next = [...products]
    ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
    onChange(next)
  }

  const moveDown = (index: number) => {
    if (index >= products.length - 1) return
    const next = [...products]
    ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
    onChange(next)
  }

  const remove = (index: number) => {
    onChange(products.filter((_, i) => i !== index))
  }

  if (products.length === 0) {
    return (
      <div className="hint" style={{ marginTop: '0.5rem' }}>
        尚未添加产品图。上传后将按列表顺序生成（最多 {MAX_PRODUCT_SWAP_COUNT} 张）。
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div className="hint">
        已添加 {products.length} 张产品图 · 将按下列顺序生成（最多 {MAX_PRODUCT_SWAP_COUNT} 张）
      </div>
      {products.map((p, index) => (
        <div
          key={`${p.url}-${index}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '0.5rem',
            border: '1px solid #e5e7eb',
            borderRadius: '8px',
            background: '#fafafa',
          }}
        >
          <div
            style={{
              width: '32px',
              fontSize: '0.85rem',
              fontWeight: 600,
              color: '#6b7280',
              textAlign: 'center',
            }}
          >
            #{index + 1}
          </div>
          <img
            src={p.url}
            alt={`产品 ${index + 1}`}
            style={{
              width: '64px',
              height: '64px',
              objectFit: 'cover',
              borderRadius: '6px',
              border: '1px solid #e5e7eb',
              flexShrink: 0,
            }}
          />
          <div
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: '0.85rem',
              color: '#374151',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={p.name || p.url}
          >
            {p.name || p.url.split('/').pop() || p.url}
          </div>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            <button
              type="button"
              onClick={() => moveUp(index)}
              disabled={disabled || index === 0}
              title="上移"
              style={{
                padding: '0.3rem 0.5rem',
                fontSize: '0.85rem',
                background: disabled || index === 0 ? undefined : '#6b7280',
              }}
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => moveDown(index)}
              disabled={disabled || index === products.length - 1}
              title="下移"
              style={{
                padding: '0.3rem 0.5rem',
                fontSize: '0.85rem',
                background: disabled || index === products.length - 1 ? undefined : '#6b7280',
              }}
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => remove(index)}
              disabled={disabled}
              title="删除"
              style={{
                padding: '0.3rem 0.5rem',
                fontSize: '0.85rem',
                background: disabled ? undefined : '#dc2626',
              }}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
