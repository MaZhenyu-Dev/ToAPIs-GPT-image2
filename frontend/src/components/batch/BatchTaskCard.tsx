import { useState } from 'react'
import { getModelDisplayName } from '../../constants'
import { sizeToAspectRatio } from '../../lib/batchDownloads'
import type { GenerationTaskItem } from '../../types'
import Badge from '../ui/Badge'
import FadeInImage from '../ui/FadeInImage'
import GlassButton from '../ui/GlassButton'
import ProgressBar from '../ui/ProgressBar'
import { IconRefresh } from '../ui/Icon'

const STATUS_TEXT: Record<string, string> = {
  pending: '待提交',
  queued: '排队中',
  in_progress: '生成中',
  completed: '已完成',
  failed: '生成失败',
}

const STATUS_BADGE: Record<string, { tone: 'success' | 'danger' | 'warning' | 'neutral'; pulse: boolean }> = {
  pending: { tone: 'neutral', pulse: false },
  queued: { tone: 'neutral', pulse: true },
  in_progress: { tone: 'warning', pulse: true },
  completed: { tone: 'success', pulse: false },
  failed: { tone: 'danger', pulse: false },
}

interface BatchTaskCardProps {
  index: number
  task: GenerationTaskItem
  selected: boolean
  onToggle: () => void
  onPreview: () => void
  onDownload: () => void
  onRegenerate: () => void
  regenerating: boolean
}

/**
 * 批次详情任务卡。
 * 图像区按批次宽高比（aspect-ratio）contain 展示整图，绝不裁切；
 * 点击图片 → 全屏 Lightbox 查看细节。
 */
export default function BatchTaskCard({
  index,
  task,
  selected,
  onToggle,
  onPreview,
  onDownload,
  onRegenerate,
  regenerating,
}: BatchTaskCardProps) {
  const [imageError, setImageError] = useState(false)
  const isCompleted = task.status === 'completed'
  const isFailed = task.status === 'failed'
  const badge = STATUS_BADGE[task.status] ?? { tone: 'neutral' as const, pulse: false }
  const aspect = sizeToAspectRatio(task.size)

  return (
    <div
      className={selected ? 'task-card task-card--selected' : 'task-card'}
      style={{ ['--task-aspect' as string]: aspect }}
    >
      <div className="task-card-head">
        <span className="task-card-index">#{index + 1}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {task.model && task.model !== 'gpt-image-2' && (
            <span
              className="task-card-model"
              title={getModelDisplayName(task.model, task.quality)}
            >
              {getModelDisplayName(task.model, task.quality, 'short')}
            </span>
          )}
          <Badge tone={badge.tone} pulse={badge.pulse}>
            {STATUS_TEXT[task.status] ?? task.status}
          </Badge>
          {isCompleted && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              aria-label={`选择任务 ${index + 1}`}
              style={{ cursor: 'pointer' }}
            />
          )}
        </div>
      </div>

      <div className="task-card-media">
        {isCompleted && task.image_url ? (
          imageError ? (
            <div className="task-card-media-placeholder">图片加载失败</div>
          ) : (
            <FadeInImage
              className="task-card-image"
              src={task.image_url}
              alt={`任务 ${index + 1} 生成结果`}
              onClick={onPreview}
              onError={() => setImageError(true)}
              loading="lazy"
            />
          )
        ) : isFailed ? (
          <div
            className="task-card-media-placeholder"
            onClick={onPreview}
            title="该任务生成失败，暂无可预览的图片"
            style={{ cursor: 'pointer' }}
          >
            生成失败
          </div>
        ) : (
          <div
            className="task-card-media-placeholder"
            onClick={onPreview}
            title="图片尚未生成完成，请稍候"
            style={{ cursor: 'pointer' }}
          >
            <ProgressBar progress={task.progress} animated={task.status !== 'pending'} />
            <span>{task.progress}%</span>
          </div>
        )}
      </div>

      {task.variant_prompt && (
        <div className="task-card-prompt" title={task.variant_prompt}>
          {task.variant_prompt}
        </div>
      )}

      {isFailed && task.error_msg && (
        <div className="task-card-error" title={task.error_msg}>
          {task.error_msg}
        </div>
      )}
      {isFailed && task.auto_retry_count > 0 && (
        <div className="task-card-error" title="自动重试已全部执行完毕（gpt-image-2 → VIP → Gemini），可手动重新生成或批次级重试">
          已自动重试 {task.auto_retry_count} 次，仍失败 · 可手动重试
        </div>
      )}

      <div className="task-card-actions">
        <GlassButton
          size="sm"
          variant="secondary"
          onClick={onPreview}
          disabled={!isCompleted || !task.image_url || imageError}
        >
          预览
        </GlassButton>
        <GlassButton
          size="sm"
          variant="secondary"
          onClick={onDownload}
          disabled={!isCompleted || !task.image_url || imageError}
        >
          下载
        </GlassButton>
        {(isCompleted || isFailed) && (
          <GlassButton
            size="sm"
            variant="ghost"
            onClick={onRegenerate}
            disabled={regenerating}
            icon={<IconRefresh width={13} height={13} />}
          >
            {regenerating ? '生成中…' : '重新生成'}
          </GlassButton>
        )}
      </div>
    </div>
  )
}
