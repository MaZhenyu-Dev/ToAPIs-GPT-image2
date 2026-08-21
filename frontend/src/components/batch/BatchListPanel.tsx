import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createI2iMulti,
  deleteBatch,
  deleteBatches,
  getBatchStatus,
  listRecentBatches,
  retryFailedBatches,
} from '../../api'
import { displayBatchId } from '../../lib/batchDownloads'
import { exportBatchesToDirectory } from '../../lib/fsDownload'
import type { BatchExportProgress } from '../../lib/fsDownload'
import { isFsAccessSupported, pickDirectory } from '../../lib/fsDownload'
import { useBatchThumbnails } from '../../hooks/useBatchThumbnails'
import { MAX_I2I_MULTI_COUNT } from '../../constants'
import type {
  BatchListResponse,
  BatchSummary,
  VariantGroupListItem,
} from '../../types'
import Badge from '../ui/Badge'
import EmptyState from '../ui/EmptyState'
import FadeInImage from '../ui/FadeInImage'
import GlassButton from '../ui/GlassButton'
import ProgressBar from '../ui/ProgressBar'
import { useConfirm } from '../ui/ConfirmDialog'
import { useToast } from '../ui/Toast'
import { IconLayers } from '../ui/Icon'
import AutoRelayDialog from './AutoRelayDialog'
import type { RelayStats } from './AutoRelayDialog'
import type { AutoRelayConfig } from '../../types'

const LIST_POLL_INTERVAL_MS = 3000
const SEARCH_DEBOUNCE_MS = 300
// 大分页：后端排序在 Python 端全量完成（无 SQL 深分页），
// 缩略图走批量接口，100/200/300 页大小无压力
const PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 300] as const

interface BatchListPanelProps {
  /** 外部（如创建新批次后）触发重新加载 */
  refreshKey?: number
  onOpenBatch: (batchId: string) => void
  /** 数据变更（增/删/重试）后通知外部（用于刷新批次号计数） */
  onDataChanged: () => void
  /** 变体组列表（接力套图弹窗选择套图提示词用） */
  groups: VariantGroupListItem[]
}

interface ExportState {
  progress: BatchExportProgress | null
  exporting: boolean
}

/**
 * 近期批次列表：搜索 / 状态卡片（含缩略图带）/ 全选批量操作 / 分页。
 * 有未完成批次时自动轮询刷新，全部完成自动停止。
 */
export default function BatchListPanel({
  refreshKey,
  onOpenBatch,
  onDataChanged,
  groups,
}: BatchListPanelProps) {
  const toast = useToast()
  const confirm = useConfirm()

  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(20)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedBatches, setSelectedBatches] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [relayCollecting, setRelayCollecting] = useState(false)
  const [relayStats, setRelayStats] = useState<RelayStats | null>(null)
  const [exportState, setExportState] = useState<ExportState>({
    progress: null,
    exporting: false,
  })
  const mounted = useRef(true)
  const requestSeq = useRef(0)
  const searchRef = useRef('')
  const searchTimer = useRef<number | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadPage = useCallback(
    async (
      targetPage: number,
      targetPageSize: number,
      silent = false,
      searchQuery?: string
    ) => {
      // 竞态保护：快速连续搜索/翻页时只应用最新一次请求的结果
      const seq = ++requestSeq.current
      const q = searchQuery ?? searchRef.current
      if (!silent) setLoading(true)
      try {
        const response: BatchListResponse = await listRecentBatches({
          page: targetPage,
          pageSize: targetPageSize,
          q: q || undefined,
        })
        if (!mounted.current || seq !== requestSeq.current) return
        setBatches(response.batches)
        setTotal(response.total)
        setTotalPages(response.total_pages)
        setPage(response.page)
        setPageSize(response.page_size)
        // 清掉已不存在的选中项
        setSelectedBatches((prev) => {
          const ids = new Set(response.batches.map((b) => b.batch_id))
          const next = new Set<string>()
          prev.forEach((id) => {
            if (ids.has(id)) next.add(id)
          })
          return next
        })
      } catch {
        // 列表非关键信息，失败静默（保留旧数据）
      } finally {
        if (mounted.current && !silent && seq === requestSeq.current) {
          setLoading(false)
        }
      }
    },
    []
  )

  // 搜索输入：300ms 防抖后请求后端全库模糊查询（通配符后端已按字面转义）
  const handleSearchChange = (value: string) => {
    setSearch(value)
    searchRef.current = value.trim()
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(() => {
      void loadPage(1, pageSize, false, searchRef.current)
    }, SEARCH_DEBOUNCE_MS)
  }

  // 卸载时清理防抖定时器
  useEffect(() => {
    return () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
    }
  }, [])

  // 初次挂载 / 外部刷新键变化时加载第 1 页
  useEffect(() => {
    void loadPage(1, pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // 有未完成批次时自动刷新
  const hasIncomplete = useMemo(
    () => batches.some((b) => b.completed_count < b.task_count),
    [batches]
  )
  useEffect(() => {
    if (!hasIncomplete) return
    const timer = setInterval(() => {
      void loadPage(page, pageSize, true)
    }, LIST_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [hasIncomplete, page, pageSize, loadPage])

  const thumbnails = useBatchThumbnails(batches)

  const toggleBatch = (batchId: string) => {
    setSelectedBatches((prev) => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId)
      else next.add(batchId)
      return next
    })
  }

  const toggleSelectAll = () => {
    const visible = batches.map((b) => b.batch_id)
    const allSelected =
      visible.length > 0 && visible.every((id) => selectedBatches.has(id))
    if (allSelected) {
      setSelectedBatches(new Set())
    } else {
      setSelectedBatches(new Set(visible))
    }
  }

  const handleDeleteOne = async (batchId: string) => {
    const ok = await confirm({
      title: '删除批次',
      message: `确定要删除批次 ${displayBatchId(batchId)} 及其所有任务吗？此操作不可恢复。`,
      confirmLabel: '删除',
      tone: 'danger',
    })
    if (!ok) return
    setDeleting(true)
    try {
      await deleteBatch(batchId)
      setSelectedBatches((prev) => {
        const next = new Set(prev)
        next.delete(batchId)
        return next
      })
      toast.success(`批次 ${displayBatchId(batchId)} 已删除`)
      onDataChanged()
      await loadPage(page, pageSize)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除批次失败')
    } finally {
      setDeleting(false)
    }
  }

  const handleDeleteSelected = async () => {
    if (selectedBatches.size === 0) return
    const ok = await confirm({
      title: '删除所选批次',
      message: `确定要删除已选中的 ${selectedBatches.size} 个批次及其所有任务吗？此操作不可恢复。`,
      confirmLabel: '删除',
      tone: 'danger',
    })
    if (!ok) return
    setDeleting(true)
    try {
      const ids = Array.from(selectedBatches)
      await deleteBatches(ids)
      setSelectedBatches(new Set())
      toast.success(`已删除 ${ids.length} 个批次`)
      onDataChanged()
      await loadPage(page, pageSize)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量删除失败')
    } finally {
      setDeleting(false)
    }
  }

  const handleRetrySelected = async () => {
    if (selectedBatches.size === 0) return
    const selectedIds = Array.from(selectedBatches)
    const failedInSelected = batches.filter(
      (b) => selectedBatches.has(b.batch_id) && b.failed_count > 0
    )
    const failedTaskCount = failedInSelected.reduce(
      (sum, b) => sum + b.failed_count,
      0
    )
    const skippedCount = selectedIds.length - failedInSelected.length

    if (failedInSelected.length === 0) {
      toast.warning('选中的批次没有失败任务，无需重试')
      return
    }
    const ok = await confirm({
      title: '重试失败任务',
      message:
        `将重试 ${failedInSelected.length} 个批次中的 ${failedTaskCount} 个失败任务` +
        (skippedCount > 0 ? `（${skippedCount} 个批次无失败任务，将自动跳过）` : ''),
      confirmLabel: '开始重试',
      tone: 'primary',
    })
    if (!ok) return

    setRetrying(true)
    try {
      const result = await retryFailedBatches(selectedIds)
      setSelectedBatches(new Set())
      toast.success(
        `已重试 ${result.retried_batch_ids.length} 个批次、${result.retried_task_count} 个失败任务` +
          (result.skipped_batch_ids.length > 0
            ? `；${result.skipped_batch_ids.length} 个批次无失败任务已跳过`
            : '')
      )
      onDataChanged()
      await loadPage(page, pageSize)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量重试失败')
    } finally {
      setRetrying(false)
    }
  }

  // ---------- 接力套图 ----------

  /** 收集到的图片 URL（弹窗确认后提交用；弹窗只展示统计） */
  const relayUrlsRef = useRef<string[]>([])

  /** 收集选中批次中的已完成图片，供接力弹窗预览（无图时直接提示返回） */
  const handleRelayCollect = async () => {
    if (selectedBatches.size === 0) return
    const selectedIds = Array.from(selectedBatches)
    setRelayCollecting(true)
    try {
      const imageUrls: string[] = []
      const skippedBatchIds: string[] = []
      for (const batchId of selectedIds) {
        let status
        try {
          status = await getBatchStatus(batchId)
        } catch {
          skippedBatchIds.push(batchId)
          continue
        }
        const completed = status.tasks.filter(
          (t) => t.status === 'completed' && t.image_url
        )
        if (completed.length === 0) {
          skippedBatchIds.push(batchId)
          continue
        }
        imageUrls.push(...completed.map((t) => t.image_url!))
      }

      if (imageUrls.length === 0) {
        toast.warning('选中的批次没有已完成图片，无法接力套图')
        return
      }

      let usableUrls = imageUrls
      if (imageUrls.length > MAX_I2I_MULTI_COUNT) {
        usableUrls = imageUrls.slice(0, MAX_I2I_MULTI_COUNT)
        toast.warning(
          `图片数量 ${imageUrls.length} 超过单次上限 ${MAX_I2I_MULTI_COUNT}，仅使用前 ${MAX_I2I_MULTI_COUNT} 张`
        )
      }

      relayUrlsRef.current = usableUrls
      setRelayStats({
        batchCount: selectedIds.length,
        imageCount: usableUrls.length,
        skippedCount: skippedBatchIds.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '收集已完成图片失败')
    } finally {
      setRelayCollecting(false)
    }
  }

  /** 弹窗确认后：用收集到的图片批量创建套图批次 */
  const handleRelayConfirm = async (config: AutoRelayConfig) => {
    const urls = relayUrlsRef.current
    if (urls.length === 0) return
    try {
      const result = await createI2iMulti({
        group_id: config.group_id,
        image_urls: urls,
        prefix: config.prefix,
        size: config.size,
        resolution: config.resolution,
        model: config.model,
        quality: config.quality,
      })
      setRelayStats(null)
      setSelectedBatches(new Set())
      toast.success(
        `接力套图成功：创建 ${result.batch_ids.length} 个批次、${result.task_count} 个任务` +
          (relayStats?.skippedCount
            ? `（${relayStats.skippedCount} 个批次无已完成图片已跳过）`
            : '')
      )
      onDataChanged()
      await loadPage(page, pageSize)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '接力套图失败')
    }
  }

  const handleExportSelectedToDir = async () => {
    if (selectedBatches.size === 0) return
    if (!isFsAccessSupported()) {
      toast.warning('当前浏览器不支持文件夹直存，请改用 Chrome / Edge / Opera')
      return
    }

    let dirHandle: FileSystemDirectoryHandle
    try {
      const picked = await pickDirectory()
      if (!picked) return
      dirHandle = picked
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      toast.error(err instanceof Error ? err.message : '选择目录失败')
      return
    }

    const ids = Array.from(selectedBatches)
    setExportState({ progress: null, exporting: true })

    const lines: string[] = []
    let doneBatches = 0
    const skippedNames: string[] = []

    try {
      for (const batchId of ids) {
        const batchName = displayBatchId(batchId)
        // 拉批次状态拿已完成图片
        let status
        try {
          status = await getBatchStatus(batchId)
        } catch (err) {
          lines.push(`[${batchName}] 查询失败：${err instanceof Error ? err.message : '未知错误'}`)
          doneBatches++
          continue
        }

        const items = status.tasks
          .map((task, index) => ({ task, index }))
          .filter(({ task }) => task.status === 'completed' && task.image_url)

        setExportState({
          exporting: true,
          progress: {
            done: doneBatches,
            total: ids.length,
            currentBatch: batchName,
            currentFile: 0,
            fileTotal: items.length,
            ok: true,
            skipped: false,
          },
        })

        const result = await exportBatchesToDirectory(
          [{ batchName, items }],
          dirHandle,
          {
            onConflict: async (name) => {
              const overwrite = await confirm({
                title: '子文件夹已存在',
                message: `子文件夹 "${name}" 已存在且不为空，是否覆盖？\n\n确定 = 清空后下载\n取消 = 跳过该批次`,
                confirmLabel: '覆盖',
                cancelLabel: '跳过',
                tone: 'primary',
              })
              return overwrite ? 'overwrite' : 'skip'
            },
            onProgress: (p) => {
              setExportState({
                exporting: true,
                progress: {
                  done: doneBatches,
                  total: ids.length,
                  currentBatch: p.currentBatch,
                  currentFile: p.currentFile,
                  fileTotal: p.fileTotal,
                  ok: p.ok,
                  skipped: p.skipped,
                },
              })
            },
          }
        )

        const detail = result.details[0]
        if (detail) {
          if (detail.skipped) {
            lines.push(`[${detail.batchName}] 跳过（${detail.reason ?? ''}）`)
            if (detail.reason === '用户选择跳过') skippedNames.push(detail.batchName)
          } else if (detail.failed > 0) {
            const head = detail.errors.slice(0, 2).join('；')
            lines.push(
              `[${detail.batchName}] 部分失败 ${detail.success}/${detail.total}` +
                (head ? `（例：${head}）` : '')
            )
          } else {
            lines.push(`[${detail.batchName}] 成功 ${detail.success} 张`)
          }
        }
        doneBatches++
      }

      const summary = `批量导出完成：共 ${ids.length} 个批次\n` + lines.join('\n')
      if (skippedNames.length > 0) {
        toast.warning(`${summary}\n被跳过的批次：${skippedNames.join('、')}`)
      } else if (lines.some((l) => l.includes('失败'))) {
        toast.error(summary)
      } else {
        toast.success(summary)
      }
    } finally {
      setExportState({ progress: null, exporting: false })
    }
  }

  const goToPage = (target: number) => {
    if (target < 1 || target > totalPages || target === page) return
    void loadPage(target, pageSize)
  }

  const visibleIds = batches.map((b) => b.batch_id)
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedBatches.has(id))
  const someSelected = visibleIds.some((id) => selectedBatches.has(id))

  return (
    <div className="glass glass-card-padding--md">
      <div className="batch-list-toolbar">
        <h3 className="batch-list-title">
          近期批次{' '}
          <span className="batch-list-count">
            {search ? `匹配 ${total} 条` : `共 ${total} 条`}
          </span>
        </h3>
        <div className="batch-list-actions">
          <input
            type="search"
            className="batch-search"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="搜索批次号（全库模糊查询，如 0821 / TAO）"
            aria-label="搜索批次号"
          />
          <GlassButton
            size="sm"
            variant="secondary"
            onClick={handleRetrySelected}
            disabled={selectedBatches.size === 0 || retrying}
          >
            {retrying ? '重试中…' : `重试失败任务 (${selectedBatches.size})`}
          </GlassButton>
          <GlassButton
            size="sm"
            variant="secondary"
            onClick={() => void handleRelayCollect()}
            disabled={selectedBatches.size === 0 || relayCollecting}
            title="将已选批次中已完成的产品图作为参考图，批量创建套图批次"
          >
            {relayCollecting ? '收集图片中…' : `接力套图 (${selectedBatches.size})`}
          </GlassButton>
          <GlassButton
            size="sm"
            variant="secondary"
            onClick={handleExportSelectedToDir}
            disabled={selectedBatches.size === 0 || exportState.exporting}
            title={
              isFsAccessSupported()
                ? '将已选中的批次按批次号分目录导出到本地'
                : '当前浏览器不支持文件夹直存，请使用 Chrome / Edge / Opera'
            }
          >
            {exportState.exporting ? '导出中…' : `导出到文件夹 (${selectedBatches.size})`}
          </GlassButton>
          <GlassButton
            size="sm"
            variant="danger"
            onClick={handleDeleteSelected}
            disabled={selectedBatches.size === 0 || deleting}
          >
            {deleting ? '删除中…' : `删除已选 (${selectedBatches.size})`}
          </GlassButton>
        </div>
      </div>

      {exportState.progress && (
        <div style={{ marginBottom: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '0.3rem' }}>
            <span className="config-meta">
              {exportState.progress.currentBatch || '准备中…'}
              {exportState.progress.skipped && ' · 跳过'}
            </span>
            <span className="config-meta">
              {exportState.progress.done}/{exportState.progress.total} 批次
              {exportState.progress.fileTotal > 0 &&
                ` · ${exportState.progress.currentFile}/${exportState.progress.fileTotal}`}
            </span>
          </div>
          <ProgressBar
            progress={
              exportState.progress.total > 0
                ? Math.round((exportState.progress.done / exportState.progress.total) * 100)
                : 0
            }
          />
        </div>
      )}

      <div className="batch-legend">
        <SelectAllCheckbox
          allSelected={allSelected}
          someSelected={someSelected}
          disabled={batches.length === 0}
          onToggle={toggleSelectAll}
        />
        <span className="batch-legend-sep" aria-hidden="true" />
        <Badge tone="success">已完成</Badge>
        <Badge tone="warning" pulse>进行中</Badge>
        <Badge tone="neutral">待开始</Badge>
        <Badge tone="accent">重试过</Badge>
      </div>

      {loading && batches.length === 0 ? (
        <div style={{ padding: '2rem 0', textAlign: 'center' }}>
          <span className="config-meta">加载中…</span>
        </div>
      ) : batches.length === 0 ? (
        search ? (
          <EmptyState
            title="没有匹配的批次"
            description={`没有包含「${search}」的批次，试试其他关键字。`}
          />
        ) : (
          <EmptyState
            icon={<IconLayers width={20} height={20} />}
            title="暂无生成批次"
            description="在上方配置好变体组与参数并开始批量生成，结果会显示在这里。"
          />
        )
      ) : (
        <div className="batch-list">
          {batches.map((batch) => (
            <BatchCard
              key={batch.batch_id}
              batch={batch}
              selected={selectedBatches.has(batch.batch_id)}
              thumbs={thumbnails.thumbnails[batch.batch_id] ?? []}
              onToggle={() => toggleBatch(batch.batch_id)}
              onOpen={() => onOpenBatch(batch.batch_id)}
              onDelete={() => void handleDeleteOne(batch.batch_id)}
              deleting={deleting}
            />
          ))}
        </div>
      )}

      {total > 0 && (
        <div className="batch-pagination">
          <span>
            第 {page} / {Math.max(totalPages, 1)} 页 · 每页{' '}
            <select
              value={pageSize}
              onChange={(e) => {
                const next = Number(e.target.value)
                setPageSize(next)
                void loadPage(1, next)
              }}
              style={{ width: 'auto', padding: '0.2rem 0.5rem', fontSize: '0.8rem' }}
              aria-label="每页数量"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </span>
          <div className="pagination-pages">
            <GlassButton size="sm" variant="ghost" onClick={() => goToPage(page - 1)} disabled={page <= 1}>
              上一页
            </GlassButton>
            {buildPageNumbers(page, totalPages).map((item, i) =>
              item === '…' ? (
                <span key={`e${i}`} className="config-meta">…</span>
              ) : (
                <button
                  key={item}
                  type="button"
                  className={item === page ? 'pagination-page pagination-page--active' : 'pagination-page'}
                  onClick={() => goToPage(item)}
                  aria-label={`第 ${item} 页`}
                >
                  {item}
                </button>
              )
            )}
            <GlassButton size="sm" variant="ghost" onClick={() => goToPage(page + 1)} disabled={page >= totalPages}>
              下一页
            </GlassButton>
          </div>
        </div>
      )}

      {/* 接力套图弹窗（与自动接力共用同一样式/组件） */}
      {relayStats && (
        <AutoRelayDialog
          initial={null}
          stats={relayStats}
          groups={groups}
          onConfirm={(config) => void handleRelayConfirm(config)}
          onClose={() => setRelayStats(null)}
        />
      )}
    </div>
  )
}

function BatchCard({
  batch,
  selected,
  thumbs,
  onToggle,
  onOpen,
  onDelete,
  deleting,
}: {
  batch: BatchSummary
  selected: boolean
  thumbs: string[]
  onToggle: () => void
  onOpen: () => void
  onDelete: () => void
  deleting: boolean
}) {
  const pct =
    batch.task_count > 0
      ? Math.round((batch.completed_count / batch.task_count) * 100)
      : 0
  const done = batch.completed_count >= batch.task_count && batch.task_count > 0
  const running = batch.completed_count > 0 && !done
  const retried = batch.retried_count > 0

  return (
    <div className={selected ? 'batch-card batch-card--selected' : 'batch-card'}>
      <input
        type="checkbox"
        className="batch-card-check"
        checked={selected}
        onChange={onToggle}
        aria-label={`选择批次 ${displayBatchId(batch.batch_id)}`}
      />
      <div className="batch-card-body">
        <div className="batch-card-main">
          <div className="batch-card-head">
            <span className="batch-card-id">{displayBatchId(batch.batch_id)}</span>
            {done && <Badge tone="success">✓ {batch.completed_count}/{batch.task_count}</Badge>}
            {running && <Badge tone="warning" pulse>{batch.completed_count}/{batch.task_count}</Badge>}
            {!running && !done && <Badge tone="neutral">待开始</Badge>}
            {retried && <Badge tone="accent">重试 ×{batch.retried_count}</Badge>}
            {batch.failed_count > 0 && (
              <Badge tone="danger">{batch.failed_count} 失败</Badge>
            )}
          </div>
          <div className="batch-card-time">
            {new Date(batch.last_created_at).toLocaleString()}
          </div>
          {running && (
            <div className="batch-card-progress">
              <ProgressBar progress={pct} animated />
            </div>
          )}
        </div>

        <div className="batch-thumbs">
          {thumbs.map((url) => (
            <FadeInImage
              key={url}
              className="batch-thumb"
              src={url}
              alt=""
              loading="lazy"
              onClick={onOpen}
            />
          ))}
          {thumbs.length === 0 && (
            <span className="batch-thumb-slot" aria-hidden="true">
              {done ? '—' : '…'}
            </span>
          )}
        </div>

        <div className="batch-card-actions">
          <GlassButton size="sm" variant="secondary" onClick={onOpen}>
            查看
          </GlassButton>
          <GlassButton size="sm" variant="ghost" onClick={onDelete} disabled={deleting}>
            删除
          </GlassButton>
        </div>
      </div>
    </div>
  )
}

/** 页码序列：总页数 ≤ 7 全展示，否则省略号折叠 */
function buildPageNumbers(current: number, total: number): (number | '…')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const pages: (number | '…')[] = [1]
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  if (start > 2) pages.push('…')
  for (let p = start; p <= end; p++) pages.push(p)
  if (end < total - 1) pages.push('…')
  pages.push(total)
  return pages
}

/**
 * 全选复选框（图例行首，紧贴批次勾选框上方）：
 * 全选 / 部分选中（indeterminate）/ 取消全选 三态。
 */
function SelectAllCheckbox({
  allSelected,
  someSelected,
  disabled,
  onToggle,
}: {
  allSelected: boolean
  someSelected: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = someSelected && !allSelected
    }
  }, [someSelected, allSelected])

  return (
    <label className="batch-select-all" title="全选 / 取消全选当前可见批次">
      <input
        ref={ref}
        type="checkbox"
        checked={allSelected}
        onChange={onToggle}
        disabled={disabled}
        aria-label="全选当前可见批次"
      />
      全选
    </label>
  )
}
