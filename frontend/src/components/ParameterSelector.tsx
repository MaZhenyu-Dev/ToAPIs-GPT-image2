import { useEffect } from 'react'
import {
  DEFAULT_RESOLUTION,
  DEFAULT_SIZE,
  isSizeSupportedForModel,
  SIZE_RESOLUTION_MAP,
} from '../constants'

interface Props {
  size: string
  resolution: string
  onChange: (params: { size: string; resolution: string }) => void
  /** 紧凑模式：适配工作流条布局（无输出尺寸提示，固定窄宽） */
  compact?: boolean
  /** 生图模型：2.5 普通版不支持的比例（2:1/1:2/9:21）选项禁用 */
  model?: string
}

export default function ParameterSelector({
  size,
  resolution,
  onChange,
  compact = false,
  model,
}: Props) {
  const sizeOptions = Object.keys(SIZE_RESOLUTION_MAP)
  const resolutionOptions = Object.keys(SIZE_RESOLUTION_MAP[size] || {})

  const handleSizeChange = (newSize: string) => {
    const available = Object.keys(SIZE_RESOLUTION_MAP[newSize] || {})
    const newResolution = available.includes(resolution)
      ? resolution
      : available[0] || DEFAULT_RESOLUTION
    onChange({ size: newSize, resolution: newResolution })
  }

  // 切换到 2.5 模型后，若当前比例不被支持则回退 1:1
  // （覆盖"先选 2:1/1:2/9:21 再切 2.5"的残留状态，选项此时已禁用）
  useEffect(() => {
    if (model && !isSizeSupportedForModel(model, size)) {
      const available = Object.keys(SIZE_RESOLUTION_MAP[DEFAULT_SIZE] || {})
      onChange({
        size: DEFAULT_SIZE,
        resolution: available.includes(resolution)
          ? resolution
          : available[0] || DEFAULT_RESOLUTION,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, size, resolution])

  const renderSizeOptions = () =>
    sizeOptions.map((s) => {
      const disabled = !!model && !isSizeSupportedForModel(model, s)
      return (
        <option
          key={s}
          value={s}
          disabled={disabled}
          title={disabled ? 'GPT-Image-2.5 不支持该比例' : undefined}
        >
          {s}
        </option>
      )
    })

  if (compact) {
    return (
      <>
        <div className="config-field config-field--select">
          <label htmlFor="size">宽高比</label>
          <select
            id="size"
            value={size}
            onChange={(e) => handleSizeChange(e.target.value)}
          >
            {renderSizeOptions()}
          </select>
        </div>

        <div className="config-field config-field--select">
          <label htmlFor="resolution">分辨率</label>
          <select
            id="resolution"
            value={resolution}
            onChange={(e) => onChange({ size, resolution: e.target.value })}
          >
            {resolutionOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      </>
    )
  }

  const dimensions = SIZE_RESOLUTION_MAP[size]?.[resolution]

  return (
    <div className="row">
      <div className="form-group">
        <label htmlFor="size">宽高比</label>
        <select
          id="size"
          value={size}
          onChange={(e) => handleSizeChange(e.target.value)}
        >
          {renderSizeOptions()}
        </select>
      </div>

      <div className="form-group">
        <label htmlFor="resolution">分辨率档位</label>
        <select
          id="resolution"
          value={resolution}
          onChange={(e) => onChange({ size, resolution: e.target.value })}
        >
          {resolutionOptions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {dimensions && <div className="hint">输出尺寸：{dimensions}</div>}
      </div>
    </div>
  )
}
