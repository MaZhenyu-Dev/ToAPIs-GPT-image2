import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_IMAGE_QUALITY,
  IMAGE_MODEL_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
} from '../../constants'
import type { GenerationTaskItem, ImageModelId, ImageQuality } from '../../types'
import GlassButton from '../ui/GlassButton'
import SegmentedControl from '../ui/SegmentedControl'
import { IconRefresh } from '../ui/Icon'

interface RegenerateDialogProps {
  task: GenerationTaskItem | null
  /** 确认回调：返回所选模型与精度 */
  onConfirm: (model: ImageModelId, quality: ImageQuality | undefined) => void
  onClose: () => void
}

/**
 * 重新生成弹窗：先选模型（+ 精度，仅支持精度的模型显示）再提交。
 * 尺寸/分辨率沿用任务原配置；默认预填任务当前模型/精度（不调整即等效原行为）。
 */
export default function RegenerateDialog({
  task,
  onConfirm,
  onClose,
}: RegenerateDialogProps) {
  const [model, setModel] = useState<ImageModelId>('gpt-image-2')
  const [quality, setQuality] = useState<ImageQuality>(DEFAULT_IMAGE_QUALITY)

  // 打开时预填任务当前模型/精度
  useEffect(() => {
    if (!task) return
    const current = IMAGE_MODEL_OPTIONS.find((m) => m.id === task.model)
    if (current) setModel(current.id)
    if (task.quality === 'low' || task.quality === 'medium' || task.quality === 'high') {
      setQuality(task.quality)
    }
  }, [task])

  const selectedModel = useMemo(
    () => IMAGE_MODEL_OPTIONS.find((m) => m.id === model),
    [model]
  )
  const qualitySupported = selectedModel?.qualitySupported ?? false

  if (!task) return null

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="regenerate-dialog-title"
      >
        <h3 className="modal-title" id="regenerate-dialog-title">
          <span className="modal-title-icon">
            <IconRefresh width={17} height={17} />
          </span>
          重新生成任务
        </h3>
        <div className="modal-body">
          将使用所选模型重新生成，尺寸 / 分辨率保持不变。
        </div>

        <div className="form-group" style={{ marginTop: 'var(--space-4)' }}>
          <label htmlFor="regenerate-model">生图模型</label>
          <select
            id="regenerate-model"
            value={model}
            onChange={(e) => setModel(e.target.value as ImageModelId)}
            autoFocus
          >
            {IMAGE_MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {qualitySupported && (
          <div className="form-group">
            <label>精度档位</label>
            <SegmentedControl<ImageQuality>
              ariaLabel="重新生成精度档位"
              value={quality}
              onChange={setQuality}
              options={IMAGE_QUALITY_OPTIONS.map((q) => ({
                value: q.id,
                label: q.label,
                title:
                  q.id === 'low'
                    ? '快速省钱，适合草稿/预览'
                    : q.id === 'high'
                      ? '最高精度，适合正式出图'
                      : '平衡速度与质量',
              }))}
            />
          </div>
        )}

        <div className="modal-actions">
          <GlassButton variant="ghost" onClick={onClose}>
            取消
          </GlassButton>
          <GlassButton
            variant="primary"
            onClick={() => onConfirm(model, qualitySupported ? quality : undefined)}
          >
            确认重新生成
          </GlassButton>
        </div>
      </div>
    </div>
  )
}
