import { useEffect, useState } from 'react'
import { CROP_THRESHOLD_MAX } from '../../constants'

/**
 * 白边裁剪开关 + 阈值（0-255）控件。
 * - 开关变化立即保存；阈值在失焦 / Enter 时保存
 * - saving 时禁用交互，防重复提交
 */
export default function CropToggle({
  enabled,
  threshold,
  saving = false,
  onSave,
}: {
  enabled: boolean
  threshold: number
  saving?: boolean
  onSave: (enabled: boolean, threshold: number) => void
}) {
  const [draft, setDraft] = useState(String(threshold))
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    setDraft(String(threshold))
    setTouched(false)
  }, [threshold])

  const parsed = Math.max(0, Math.min(CROP_THRESHOLD_MAX, Number(draft)))
  const valid = Number.isFinite(parsed) && draft.trim() !== ''

  const commitThreshold = () => {
    if (!valid) return
    const value = Math.round(parsed)
    setDraft(String(value))
    setTouched(false)
    if (value !== threshold) onSave(enabled, value)
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.45rem',
        fontSize: '0.8rem',
        whiteSpace: 'nowrap',
        color: 'var(--text-2)',
      }}
      title="白边裁剪：像素与纯白 (255,255,255) 的欧氏距离 ≤ 阈值即视为白边，越大越激进"
    >
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.3rem',
          cursor: saving ? 'not-allowed' : 'pointer',
          userSelect: 'none',
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => onSave(e.target.checked, threshold)}
        />
        裁剪白边
      </label>
      {enabled && (
        <>
          <span style={{ color: 'var(--text-3)' }}>阈值</span>
          <input
            type="number"
            min={0}
            max={CROP_THRESHOLD_MAX}
            value={touched ? draft : String(threshold)}
            disabled={saving}
            onChange={(e) => {
              setDraft(e.target.value)
              setTouched(true)
            }}
            onBlur={commitThreshold}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitThreshold()
              }
            }}
            style={{
              width: '56px',
              padding: '0.15rem 0.4rem',
              fontSize: '0.78rem',
              fontVariantNumeric: 'tabular-nums',
              borderColor: !valid ? 'var(--danger)' : undefined,
            }}
            aria-label="白边判定阈值（0-255）"
          />
        </>
      )}
    </span>
  )
}
