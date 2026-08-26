import {
  DEFAULT_IMAGE_QUALITY,
  IMAGE_MODEL_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
} from '../../constants'
import type { ImageModelId, ImageQuality } from '../../types'

interface Props {
  model: ImageModelId
  quality: ImageQuality | undefined
  onChange: (params: { model: ImageModelId; quality: ImageQuality | undefined }) => void
  disabled?: boolean
}

/** 生图模型 + 精度档位选择（提取产品图专用，逻辑与 RegenerateDialog 对齐） */
export default function ModelSelector({ model, quality, onChange, disabled }: Props) {
  const current = IMAGE_MODEL_OPTIONS.find((m) => m.id === model) ?? IMAGE_MODEL_OPTIONS[0]

  const handleModelChange = (next: ImageModelId) => {
    const meta = IMAGE_MODEL_OPTIONS.find((m) => m.id === next)
    if (!meta) return
    if (!meta.qualitySupported) {
      onChange({ model: next, quality: undefined })
    } else {
      onChange({ model: next, quality: quality ?? DEFAULT_IMAGE_QUALITY })
    }
  }

  return (
    <>
      <div className="form-group">
        <label htmlFor="extract-model">生成模型</label>
        <select
          id="extract-model"
          value={model}
          onChange={(e) => handleModelChange(e.target.value as ImageModelId)}
          disabled={disabled}
        >
          {IMAGE_MODEL_OPTIONS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <div className="hint">{current.description}</div>
      </div>

      {current.qualitySupported && (
        <div className="form-group">
          <label htmlFor="extract-quality">精度档位</label>
          <select
            id="extract-quality"
            value={quality ?? DEFAULT_IMAGE_QUALITY}
            onChange={(e) => onChange({ model, quality: e.target.value as ImageQuality })}
            disabled={disabled}
          >
            {IMAGE_QUALITY_OPTIONS.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  )
}
