import { useEffect, useState } from 'react'
import { erpPrompts } from '../../api'
import GlassButton from '../ui/GlassButton'

interface Props {
  /** 当前 prompt 内容 */
  value: string
  /** 切换预设时回填模板（覆盖当前内容，可继续编辑） */
  onChange: (prompt: string) => void
  disabled?: boolean
}

export type ExtractPromptType = 'living_room' | 'corridor'

const FALLBACK_LABELS: Record<ExtractPromptType, string> = {
  living_room: '客厅地毯',
  corridor: '走廊地毯',
}

/** 提取产品图 prompt 预设切换：客厅地毯 / 走廊地毯（模板来自后端，可热更新） */
export default function ExtractPromptSelector({ value, onChange, disabled }: Props) {
  const [prompts, setPrompts] = useState<Record<string, string> | null>(null)
  const [labels, setLabels] = useState<Record<string, string> | null>(null)

  useEffect(() => {
    erpPrompts()
      .then((r) => {
        setPrompts(r.prompts)
        setLabels(r.labels)
      })
      .catch(() => {
        /* 加载失败时隐藏切换控件，不影响使用 */
      })
  }, [])

  const types = (Object.keys(prompts ?? {}) as ExtractPromptType[]).filter(
    (t) => t === 'living_room' || t === 'corridor'
  )
  if (types.length === 0) return null

  const detectActive = (): ExtractPromptType | null => {
    if (!prompts) return null
    for (const t of types) {
      if (value.trim() === prompts[t].trim()) return t
    }
    return null
  }
  const active = detectActive()

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        flexWrap: 'wrap',
      }}
    >
      <span className="hint" style={{ fontSize: '0.8rem' }}>
        Prompt 模板：
      </span>
      {types.map((t) => (
        <GlassButton
          key={t}
          type="button"
          size="sm"
          variant={active === t ? 'primary' : 'ghost'}
          onClick={() => prompts && onChange(prompts[t])}
          disabled={disabled}
          title="切换后覆盖当前 Prompt 内容（可继续编辑）；走廊地毯模板提交时会自动填充订单实际尺寸（宽/长 cm、宽高比、画布占比）并强制 1:1 画布"
        >
          {labels?.[t] ?? FALLBACK_LABELS[t]}
        </GlassButton>
      ))}
      <span className="hint" style={{ fontSize: '0.75rem' }}>
        {active ? '（使用中）' : '点击切换模板'}
      </span>
    </div>
  )
}
