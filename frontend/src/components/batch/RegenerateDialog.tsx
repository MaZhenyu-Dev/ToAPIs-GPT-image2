import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_RESOLUTION,
  DEFAULT_SIZE,
  EXTREME_RATIO_MODEL,
  EXTREME_SIZES,
  IMAGE_MODEL_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
  SIZE_RESOLUTION_MAP,
} from '../../constants'
import type { GenerationTaskItem, ImageModelId, ImageQuality } from '../../types'
import GlassButton from '../ui/GlassButton'
import SegmentedControl from '../ui/SegmentedControl'
import { IconRefresh } from '../ui/Icon'

interface RegenerateDialogProps {
  task: GenerationTaskItem | null
  /** 确认回调：返回所选模型、精度，以及可选的尺寸/分辨率覆盖 */
  onConfirm: (
    model: ImageModelId,
    quality: ImageQuality | undefined,
    size?: string,
    resolution?: string
  ) => void
  onClose: () => void
  /** 提取产品图模式：允许调整尺寸/分辨率（默认沿用任务原配置） */
  showSizeResolution?: boolean
}

/**
 * 重新生成弹窗：先选模型（+ 精度，仅支持精度的模型显示）再提交。
 * 尺寸/分辨率默认沿用任务原配置；提取产品图模式（showSizeResolution）
 * 额外显示宽高比/分辨率选择，重新生成时可以调整。
 */
export default function RegenerateDialog({
  task,
  onConfirm,
  onClose,
  showSizeResolution = false,
}: RegenerateDialogProps) {
  const [model, setModel] = useState<ImageModelId>('gpt-image-2')
  const [quality, setQuality] = useState<ImageQuality>(DEFAULT_IMAGE_QUALITY)
  const [size, setSize] = useState(DEFAULT_SIZE)
  const [resolution, setResolution] = useState(DEFAULT_RESOLUTION)

  // 打开时预填任务当前模型/精度/尺寸。
  // 依赖用 task?.id 而非 task 对象引用：父组件每次渲染都会构造新的 task
  // 对象（如提取页轮询刷新时），若依赖对象引用会导致反复重置用户已选的
  // 模型/精度/尺寸（表现为"极端比例自动切换模型后又被改回去"）。
  useEffect(() => {
    if (!task) return
    const current = IMAGE_MODEL_OPTIONS.find((m) => m.id === task.model)
    if (current) setModel(current.id)
    if (task.quality === 'low' || task.quality === 'medium' || task.quality === 'high') {
      setQuality(task.quality)
    }
    if (showSizeResolution) {
      if (task.size && SIZE_RESOLUTION_MAP[task.size]) setSize(task.size)
      if (task.resolution === '1k' || task.resolution === '2k' || task.resolution === '4k') {
        setResolution(task.resolution)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, showSizeResolution])

  const selectedModel = useMemo(
    () => IMAGE_MODEL_OPTIONS.find((m) => m.id === model),
    [model]
  )
  const qualitySupported = selectedModel?.qualitySupported ?? false

  if (!task) return null

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  // Portal 挂到 body：祖先容器的 backdrop-filter / transform 会破坏 fixed
  // 定位（成为 containing block），导致遮罩只覆盖容器区域而非全屏
  return createPortal(
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

        {showSizeResolution && (
          <>
            <div className="form-group">
              <label htmlFor="regenerate-size">宽高比</label>
              <select
                id="regenerate-size"
                value={size}
                onChange={(e) => {
                  const nextSize = e.target.value
                  const available = Object.keys(SIZE_RESOLUTION_MAP[nextSize] || {})
                  setSize(nextSize)
                  if (!available.includes(resolution)) {
                    setResolution(available[0] || DEFAULT_RESOLUTION)
                  }
                  // 极端宽高比只有 gemini 支持：自动切换模型
                  if (EXTREME_SIZES.has(nextSize)) {
                    setModel(EXTREME_RATIO_MODEL as ImageModelId)
                  }
                }}
              >
                {Object.keys(SIZE_RESOLUTION_MAP).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {EXTREME_SIZES.has(size) && (
                <div className="hint" style={{ color: 'var(--warning)' }}>
                  极端宽高比，仅 Gemini 3.1 Flash Image Preview 支持（已自动切换）
                </div>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="regenerate-resolution">分辨率档位</label>
              <select
                id="regenerate-resolution"
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
              >
                {Object.keys(SIZE_RESOLUTION_MAP[size] || {}).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              {SIZE_RESOLUTION_MAP[size]?.[resolution] && (
                <div className="hint">
                  输出尺寸：{SIZE_RESOLUTION_MAP[size][resolution]}
                </div>
              )}
            </div>
          </>
        )}

        <div className="modal-actions">
          <GlassButton variant="ghost" onClick={onClose}>
            取消
          </GlassButton>
          <GlassButton
            variant="primary"
            onClick={() =>
              onConfirm(
                model,
                qualitySupported ? quality : undefined,
                showSizeResolution ? size : undefined,
                showSizeResolution ? resolution : undefined
              )
            }
          >
            确认重新生成
          </GlassButton>
        </div>
      </div>
    </div>,
    document.body
  )
}
