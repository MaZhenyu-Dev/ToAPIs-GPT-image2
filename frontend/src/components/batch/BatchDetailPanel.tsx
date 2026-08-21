import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getModelDisplayName } from '../../constants'
import {
  downloadTasks,
  displayBatchId,
  sizeToAspectRatio,
} from '../../lib/batchDownloads'
import {
  isFsAccessSupported,
  pickDirectory,
  saveTasksToDirectory,
} from '../../lib/fsDownload'
import type { BatchStatusResponse, BatchSummary, GenerationTaskItem } from '../../types'
import Badge from '../ui/Badge'
import { useConfirm } from '../ui/ConfirmDialog'
import GlassButton from '../ui/GlassButton'
import Lightbox from '../ui/Lightbox'
import type { LightboxItem } from '../ui/Lightbox'
import StatCard from '../ui/StatCard'
import { useToast } from '../ui/Toast'
import { IconArrowLeft, IconArrowRight, IconDownload, IconRefresh, IconTrash } from '../ui/Icon'
import BatchTaskCard from './BatchTaskCard'

interface BatchDetailPanelProps {
  batch: BatchStatusResponse
  connectionStatus: 'ok' | 'error'
  /** 工作台级操作进行中（重试/删除），禁用面板内交互 */
  busy: boolean
  regeneratingTaskId: number | null
  /** 批次快速切换条数据（最近批次摘要） */
  recentBatches: BatchSummary[]
  /** 正在切换中的批次号（chip 显示加载态） */
  switchingBatchId: string | null
  onSwitchBatch: (batchId: string) => void
  onBack: () => void
  onRetryFailed: () => Promise<void>
  onRegenerateTask: (task: GenerationTaskItem) => void
  onDeleteBatch: () => Promise<void>
}

/**
 * 批次详情：进度环 + 统计卡 + 操作栏 + 任务网格（contain 整图）+ Lightbox。
 */
export default function BatchDetailPanel({
  batch,
  connectionStatus,
  busy,
  regeneratingTaskId,
  recentBatches,
  switchingBatchId,
  onSwitchBatch,
  onBack,
  onRetryFailed,
  onRegenerateTask,
  onDeleteBatch,
}: BatchDetailPanelProps) {
  const toast = useToast()
  const confirm = useConfirm()
  const [selectedTasks, setSelectedTasks] = useState<Set<number>>(new Set())
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [dirDownloading, setDirDownloading] = useState(false)
  const [dirProgress, setDirProgress] = useState<{ done: number; total: number; current: number } | null>(null)

  const completedTasks = useMemo(
    () => batch.tasks.filter((t) => t.status === 'completed'),
    [batch.tasks]
  )
  const failedTasks = useMemo(
    () => batch.tasks.filter((t) => t.status === 'failed'),
    [batch.tasks]
  )

  const percent = batch.total > 0 ? Math.round((batch.completed / batch.total) * 100) : 0
  const ringTone =
    failedTasks.length > 0 && batch.completed < batch.total
      ? ('danger' as const)
      : batch.completed >= batch.total && batch.total > 0
        ? ('success' as const)
        : ('default' as const)

  // Lightbox 条目：所有已完成任务（label 展示模型名，prompt 走展开查看）
  const lightboxItems = useMemo<LightboxItem[]>(() => {
    return batch.tasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => task.status === 'completed' && task.image_url)
      .map(({ task, index }) => ({
        url: task.image_url as string,
        alt: `任务 ${index + 1} 生成结果`,
        sourceId: task.id,
        meta: {
          label: `#${index + 1} · ${getModelDisplayName(task.model, task.quality)}`,
          prompt: task.variant_prompt ?? undefined,
          size: task.size,
          resolution: task.resolution,
          batchId: batch.batch_id,
        },
      }))
  }, [batch])

  // 精确预览：按任务 ID 定位到可预览列表中的真实位置，点哪张看哪张
  const handlePreview = useCallback(
    (task: GenerationTaskItem) => {
      const idx = lightboxItems.findIndex((item) => item.sourceId === task.id)
      if (idx >= 0) {
        setPreviewIndex(idx)
      } else if (task.status === 'failed') {
        toast.warning('该任务生成失败，暂无可预览的图片')
      } else {
        toast.info('图片尚未生成完成，请稍候')
      }
    },
    [lightboxItems, toast]
  )

  const toggleTask = useCallback((taskId: number) => {
    setSelectedTasks((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [])

  const toggleSelectAll = () => {
    const allSelected =
      completedTasks.length > 0 &&
      completedTasks.every((t) => selectedTasks.has(t.id))
    if (allSelected) setSelectedTasks(new Set())
    else setSelectedTasks(new Set(completedTasks.map((t) => t.id)))
  }

  const handleDownloadSelected = () => {
    if (selectedTasks.size === 0) return
    const items = batch.tasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => selectedTasks.has(task.id))
    void downloadTasks(items, `batch_${batch.batch_id}.zip`, (msg) => toast.error(msg))
  }

  const handleDownloadAll = () => {
    const items = batch.tasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => task.status === 'completed')
    void downloadTasks(items, `batch_${batch.batch_id}_all.zip`, (msg) => toast.error(msg))
  }

  const runDirDownload = async (
    items: { task: GenerationTaskItem; index: number }[]
  ) => {
    if (!isFsAccessSupported()) {
      toast.warning('当前浏览器不支持文件夹直存，请改用 Chrome / Edge / Opera')
      return
    }
    let dirHandle: FileSystemDirectoryHandle | null
    try {
      dirHandle = await pickDirectory()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      toast.error(err instanceof Error ? err.message : '选择目录失败')
      return
    }
    if (!dirHandle) return

    const valid = items.filter((it) => it.task.image_url)
    if (valid.length === 0) {
      toast.warning('暂无可下载的已完成图片')
      return
    }

    setDirDownloading(true)
    setDirProgress({ done: 0, total: valid.length, current: 0 })
    try {
      const result = await saveTasksToDirectory(
        valid,
        dirHandle,
        (p) => setDirProgress({ done: p.done, total: p.total, current: p.current })
      )
      if (result.failed === 0) {
        toast.success(`已保存 ${result.success} 张图片到所选目录`)
      } else {
        const head = result.errors.slice(0, 3).join('；')
        toast.error(
          `已保存 ${result.success}/${result.total} 张；失败 ${result.failed} 条。` +
            (head ? ` 例：${head}` : '')
        )
      }
    } finally {
      setDirDownloading(false)
      setDirProgress(null)
    }
  }

  const handleRetry = async () => {
    const ok = await confirm({
      title: '重试失败任务',
      message: `将重试该批次中 ${failedTasks.length} 个失败任务，确定继续吗？`,
      confirmLabel: '开始重试',
      tone: 'primary',
    })
    if (!ok) return
    setRetrying(true)
    try {
      await onRetryFailed()
    } finally {
      setRetrying(false)
    }
  }

  const handleDelete = async () => {
    const ok = await confirm({
      title: '删除批次',
      message: `确定要删除批次 ${batch.batch_id} 及其所有任务吗？此操作不可恢复。`,
      confirmLabel: '删除',
      tone: 'danger',
    })
    if (!ok) return
    setDeleting(true)
    try {
      await onDeleteBatch()
    } finally {
      setDeleting(false)
    }
  }

  const aspect = sizeToAspectRatio(batch.tasks[0]?.size ?? '1:1')

  // ---------- 批次快速切换 ----------
  const chipRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const switching = switchingBatchId !== null

  // 当前批次变化时自动滚动 chip 到可视区
  useEffect(() => {
    const el = chipRefs.current.get(batch.batch_id)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [batch.batch_id])

  const currentIdx = recentBatches.findIndex((b) => b.batch_id === batch.batch_id)
  const goPrev = () => {
    const prev = currentIdx > 0 ? recentBatches[currentIdx - 1] : null
    if (prev) onSwitchBatch(prev.batch_id)
  }
  const goNext = () => {
    const next =
      currentIdx >= 0 && currentIdx < recentBatches.length - 1
        ? recentBatches[currentIdx + 1]
        : null
    if (next) onSwitchBatch(next.batch_id)
  }

  return (
    <div className="panel-in" style={{ ['--task-aspect' as string]: aspect }}>
      {/* 批次快速切换条 */}
      {recentBatches.length > 0 && (
        <div className="batch-switcher">
          <button
            type="button"
            className="batch-switcher-arrow"
            onClick={goPrev}
            disabled={currentIdx <= 0 || switching}
            aria-label="上一个批次"
          >
            <IconArrowLeft width={15} height={15} />
          </button>
          <div className="batch-switcher-scroll">
            {recentBatches.map((b) => {
              const isCurrent = b.batch_id === batch.batch_id
              const done = b.task_count > 0 && b.completed_count >= b.task_count
              const running = b.completed_count > 0 && !done
              const pending = b.completed_count === 0
              const failed = b.failed_count > 0
              const isSwitching = switchingBatchId === b.batch_id
              const dotClass =
                failed && !done
                  ? 'batch-switch-dot'
                  : done
                    ? 'batch-switch-dot'
                    : running
                      ? 'batch-switch-dot batch-switch-dot--running'
                      : 'batch-switch-dot'
              const dotColor = failed && !done
                ? 'var(--danger)'
                : done
                  ? 'var(--success)'
                  : running
                    ? 'var(--warning)'
                    : 'var(--text-3)'
              const pct =
                b.task_count > 0
                  ? Math.round((b.completed_count / b.task_count) * 100)
                  : 0
              return (
                <button
                  key={b.batch_id}
                  type="button"
                  ref={(el) => {
                    if (el) chipRefs.current.set(b.batch_id, el)
                    else chipRefs.current.delete(b.batch_id)
                  }}
                  className={[
                    'batch-switch-chip',
                    isCurrent ? 'batch-switch-chip--current' : '',
                    isSwitching ? 'batch-switch-chip--loading' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => onSwitchBatch(b.batch_id)}
                  disabled={switching}
                  title={`${displayBatchId(b.batch_id)} · ${b.completed_count}/${b.task_count} 完成` +
                    (failed ? ` · ${b.failed_count} 失败` : '') +
                    (pending ? ' · 待开始' : '')}
                  aria-current={isCurrent ? 'true' : undefined}
                >
                  <span
                    className={dotClass}
                    style={{ background: dotColor }}
                    aria-hidden="true"
                  />
                  {displayBatchId(b.batch_id)}
                  {failed && !done && (
                    <span className="batch-switch-fail">✕{b.failed_count}</span>
                  )}
                  {running && <span className="batch-switch-pct">{pct}%</span>}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            className="batch-switcher-arrow"
            onClick={goNext}
            disabled={currentIdx < 0 || currentIdx >= recentBatches.length - 1 || switching}
            aria-label="下一个批次"
          >
            <IconArrowRight width={15} height={15} />
          </button>
        </div>
      )}

      <div className="batch-detail-head">
        <div className="batch-detail-title">
          <GlassButton variant="ghost" size="sm" onClick={onBack} icon={<IconArrowLeft width={14} height={14} />}>
            返回列表
          </GlassButton>
          <span className="batch-detail-id">{batch.batch_id}</span>
          <Badge tone={connectionStatus === 'ok' ? 'success' : 'danger'}>
            {connectionStatus === 'ok' ? '连接正常' : '连接异常'}
          </Badge>
        </div>
        <GlassButton
          variant="danger"
          size="sm"
          onClick={handleDelete}
          disabled={busy || deleting}
          icon={<IconTrash width={13} height={13} />}
        >
          {deleting ? '删除中…' : '删除批次'}
        </GlassButton>
      </div>

      <div className="batch-detail-summary">
        <ProgressRing percent={percent} tone={ringTone} caption="完成率" />
        <div className="batch-detail-stats">
          <StatCard label="总计" value={batch.total} />
          <StatCard label="已完成" value={batch.completed} tone="success" />
          <StatCard label="失败" value={batch.failed} tone={batch.failed > 0 ? 'danger' : 'default'} />
          <StatCard label="进行中" value={batch.in_progress} tone={batch.in_progress > 0 ? 'accent' : 'default'} />
          <StatCard label="排队中" value={batch.queued + batch.pending} />
        </div>
      </div>

      <div className="batch-detail-actions">
        {failedTasks.length > 0 && (
          <GlassButton
            variant="warning"
            size="sm"
            onClick={handleRetry}
            disabled={busy || retrying}
            icon={<IconRefresh width={13} height={13} />}
          >
            {retrying ? '重试中…' : `重试失败任务 (${failedTasks.length})`}
          </GlassButton>
        )}
        {completedTasks.length > 0 && (
          <>
            <GlassButton variant="ghost" size="sm" onClick={toggleSelectAll}>
              {completedTasks.length > 0 &&
              completedTasks.every((t) => selectedTasks.has(t.id))
                ? '取消全选'
                : '全选'}
            </GlassButton>
            <GlassButton
              variant="secondary"
              size="sm"
              onClick={handleDownloadSelected}
              disabled={selectedTasks.size === 0}
              icon={<IconDownload width={13} height={13} />}
            >
              下载已选 ({selectedTasks.size})
            </GlassButton>
            <GlassButton variant="secondary" size="sm" onClick={handleDownloadAll}>
              下载全部 (zip)
            </GlassButton>
            <GlassButton
              variant="secondary"
              size="sm"
              onClick={() =>
                void runDirDownload(
                  batch.tasks
                    .map((task, index) => ({ task, index }))
                    .filter(({ task }) => selectedTasks.has(task.id))
                )
              }
              disabled={selectedTasks.size === 0 || dirDownloading}
            >
              导出已选到文件夹
            </GlassButton>
            <GlassButton
              variant="secondary"
              size="sm"
              onClick={() =>
                void runDirDownload(
                  batch.tasks
                    .map((task, index) => ({ task, index }))
                    .filter(({ task }) => task.status === 'completed')
                )
              }
              disabled={dirDownloading}
            >
              导出全部到文件夹
            </GlassButton>
            {dirDownloading && dirProgress && (
              <span className="config-meta">
                写入中 {dirProgress.done}/{dirProgress.total}
                {dirProgress.done > 0 && ` · 当前 #${dirProgress.current}`}
              </span>
            )}
          </>
        )}
      </div>

      {batch.tasks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">该批次暂无任务</div>
        </div>
      ) : (
        <div className="task-grid">
          {batch.tasks.map((task, index) => (
            <BatchTaskCard
              key={task.id}
              index={index}
              task={task}
              selected={selectedTasks.has(task.id)}
              onToggle={() => toggleTask(task.id)}
              onPreview={() => handlePreview(task)}
              onDownload={() =>
                void downloadTasks([{ task, index }], '', (msg) => toast.error(msg))
              }
              onRegenerate={() => void onRegenerateTask(task)}
              regenerating={regeneratingTaskId === task.id}
            />
          ))}
        </div>
      )}

      <Lightbox
        open={previewIndex !== null}
        items={lightboxItems}
        initialIndex={previewIndex ?? 0}
        onClose={() => setPreviewIndex(null)}
      />
    </div>
  )
}

function ProgressRing({
  percent,
  tone,
  caption,
}: {
  percent: number
  tone: 'default' | 'success' | 'danger'
  caption: string
}) {
  const size = 78
  const stroke = 6
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - percent / 100)
  const fillClass =
    tone === 'success'
      ? 'progress-ring-fill progress-ring-fill--success'
      : tone === 'danger'
        ? 'progress-ring-fill progress-ring-fill--danger'
        : 'progress-ring-fill'

  return (
    <svg
      className="progress-ring"
      width={size}
      height={size}
      role="img"
      aria-label={`完成率 ${percent}%`}
    >
      <circle className="progress-ring-track" cx={size / 2} cy={size / 2} r={radius} />
      <circle
        className={fillClass}
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text className="progress-ring-label" x={size / 2} y={size / 2 - 4}>
        {percent}%
      </text>
      <text className="progress-ring-caption" x={size / 2} y={size / 2 + 13}>
        {caption}
      </text>
    </svg>
  )
}
