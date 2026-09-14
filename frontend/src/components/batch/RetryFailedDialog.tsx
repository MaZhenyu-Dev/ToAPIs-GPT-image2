import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY,
  IMAGE_MODEL_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
} from '../../constants'
import type { ImageModelId, ImageQuality } from '../../types'
import GlassButton from '../ui/GlassButton'
import SegmentedControl from '../ui/SegmentedControl'
import { IconRefresh } from '../ui/Icon'

interface RetryFailedDialogProps {
  /** 批次中失败任务数（仅用于文案展示） */
  failedCount: number
  /** 确认回调：返回所选模型与精度（精度仅支持 quality 的模型会传） */
  onConfirm: (model: ImageModelId, quality: ImageQuality | undefined) => void
  onClose: () => void
  busy?: boolean
}

/**
 * 重试失败任务弹窗：先选模型（+ 精度，仅支持精度的模型显示）再提交。
 * 所选模型不支持某些失败任务的宽高比时，由后端跳过这些任务并在结果中提示。
 */
export default function RetryFailedDialog({
  failedCount,
  onConfirm,
  onClose,
  busy = false,
}: RetryFailedDialogProps) {
  const [model, setModel] = useState<ImageModelId>(DEFAULT_IMAGE_MODEL)
  const [quality, setQuality] = useState<ImageQuality>(DEFAULT_IMAGE_QUALITY)

  const selectedModel = useMemo(
    () => IMAGE_MODEL_OPTIONS.find((m) => m.id === model),
    [model]
  )
  const qualitySupported = selectedModel?.qualitySupported ?? false

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !busy) onClose()
  }

  // Portal 挂到 body：祖先容器的 backdrop-filter / transform 会破坏 fixed 定位
  return createPortal(
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="retry-failed-dialog-title"
      >
        <h3 className="modal-title" id="retry-failed-dialog-title">
          <span className="modal-title-icon">
            <IconRefresh width={17} height={17} />
          </span>
          重试失败任务
        </h3>
        <div className="modal-body">
          将使用所选模型重试该批次中 {failedCount} 个失败任务；不支持所选模型
          宽高比的任务会自动跳过。
        </div>

        <div className="form-group" style={{ marginTop: 'var(--space-4)' }}>
          <label htmlFor="retry-failed-model">生图模型</label>
          <select
            id="retry-failed-model"
            value={model}
            onChange={(e) => {
              const next = e.target.value as ImageModelId
              setModel(next)
              const meta = IMAGE_MODEL_OPTIONS.find((m) => m.id === next)
              if (!meta?.qualitySupported) setQuality(DEFAULT_IMAGE_QUALITY)
            }}
            autoFocus
            disabled={busy}
          >
            {IMAGE_MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {selectedModel && <div className="hint">{selectedModel.description}</div>}
        </div>

        {qualitySupported && (
          <div className="form-group">
            <label>精度档位</label>
            <SegmentedControl<ImageQuality>
              ariaLabel="重试精度档位"
              value={quality}
              onChange={setQuality}
              options={IMAGE_QUALITY_OPTIONS.map((q) => ({
                value: q.id,
                label: q.label,
              }))}
            />
          </div>
        )}

        <div className="modal-actions">
          <GlassButton variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </GlassButton>
          <GlassButton
            variant="primary"
            onClick={() => onConfirm(model, qualitySupported ? quality : undefined)}
            disabled={busy}
          >
            {busy ? '重试中…' : '开始重试'}
          </GlassButton>
        </div>
      </div>
    </div>,
    document.body
  )
}
