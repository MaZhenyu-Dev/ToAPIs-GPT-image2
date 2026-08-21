import { DEFAULT_RESOLUTION, SIZE_RESOLUTION_MAP } from '../constants'

interface Props {
  size: string
  resolution: string
  onChange: (params: { size: string; resolution: string }) => void
  /** 紧凑模式：适配工作流条布局（无输出尺寸提示，固定窄宽） */
  compact?: boolean
}

export default function ParameterSelector({
  size,
  resolution,
  onChange,
  compact = false,
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
            {sizeOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
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
          {sizeOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
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
