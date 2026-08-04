import JSZip from 'jszip'
import { useCallback, useEffect, useState } from 'react'
import {
  deleteBatch,
  deleteBatches,
  downloadImage,
  generateBatch,
  getBatchStatus,
  listRecentBatches,
  regenerateTask,
  retryBatch,
} from '../api'
import {
  DEFAULT_RESOLUTION,
  DEFAULT_SIZE,
} from '../constants'
import { useBatchPolling } from '../hooks/useBatchPolling'
import { useBatchPrefix } from '../hooks/useBatchPrefix'
import type {
  BatchListResponse,
  BatchStatusResponse,
  BatchSummary,
  GenerationMode,
  GenerationTaskItem,
  VariantGroupListItem,
} from '../types'
import ImagePreview from './ImagePreview'
import ImageUploader from './ImageUploader'
import ParameterSelector from './ParameterSelector'
import {
  isFsAccessSupported,
  pickDirectory,
  saveTasksToDirectory,
  exportBatchesToDirectory,
} from '../lib/fsDownload'

const POLL_INTERVAL_MS = 3000

interface Props {
  groups: VariantGroupListItem[]
  selectedGroupId?: number | null
}

const statusText: Record<string, string> = {
  pending: '待提交',
  queued: '排队中',
  in_progress: '生成中...',
  completed: '已完成',
  failed: '生成失败',
}

const statusColor: Record<string, string> = {
  pending: '#9ca3af',
  queued: '#9ca3af',
  in_progress: '#2563eb',
  completed: '#16a34a',
  failed: '#dc2626',
}

export default function BatchGenerator({ groups, selectedGroupId }: Props) {
  const [groupId, setGroupId] = useState<number | ''>(selectedGroupId ?? '')
  const [mode, setMode] = useState<GenerationMode>('t2i')
  const [size, setSize] = useState(DEFAULT_SIZE)
  const [resolution, setResolution] = useState(DEFAULT_RESOLUTION)
  const [referenceUrls, setReferenceUrls] = useState<string[]>([])
  // 批次号 prefix：抽到 useBatchPrefix hook（持久化 + 预览 + 校验集中处理）
  const {
    prefix,
    handlePrefixChange,
    isPrefixValid,
    todayBatchInfo,
    previewBatchId,
    refreshTodayCount,
  } = useBatchPrefix()

  const [batch, setBatch] = useState<BatchStatusResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<'ok' | 'error'>('ok')

  const [selectedTasks, setSelectedTasks] = useState<Set<number>>(new Set())
  const [previewTask, setPreviewTask] = useState<GenerationTaskItem | null>(null)
  const [recentBatches, setRecentBatches] = useState<BatchSummary[]>([])
  const [selectedBatches, setSelectedBatches] = useState<Set<string>>(new Set())
  const [batchPage, setBatchPage] = useState(1)
  const [batchPageSize, setBatchPageSize] = useState(10)
  const [batchTotal, setBatchTotal] = useState(0)
  const [batchTotalPages, setBatchTotalPages] = useState(0)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [regeneratingTaskId, setRegeneratingTaskId] = useState<number | null>(null)
  const [dirDownloading, setDirDownloading] = useState(false)
  const [dirProgress, setDirProgress] = useState<
    { done: number; total: number; current: number } | null
  >(null)
  // 多批次批量导出到文件夹（每个批次一个子文件夹）
  type BatchExportProgressState = {
    done: number
    total: number
    currentBatch: string
    currentFile: number
    fileTotal: number
    skipped: boolean
  }
  const [batchesExporting, setBatchesExporting] = useState(false)
  const [batchesExportProgress, setBatchesExportProgress] =
    useState<BatchExportProgressState | null>(null)

  // 批次轮询抽到 useBatchPolling hook
  const { fetchOnce, startPolling, clearPolling } = useBatchPolling({
    intervalMs: POLL_INTERVAL_MS,
    onSuccess: (status) => {
      setBatch(status)
      setConnectionStatus('ok')
    },
    onError: (err) => {
      setConnectionStatus('error')
      setError(err.message || '查询批次状态失败')
    },
  })

  useEffect(() => {
    if (selectedGroupId) {
      setGroupId(selectedGroupId)
    }
  }, [selectedGroupId])

  // 下一个批次 ID 预览：直接使用后端权威计算的 next_batch_id
  // （最小未使用 seq + 填空隙），与后端实际分配完全一致
  // 实际值在 useBatchPrefix 内部已计算（previewBatchId）

  const loadRecentBatches = useCallback(
    async (page = batchPage, pageSize = batchPageSize) => {
      try {
        const response: BatchListResponse = await listRecentBatches({
          page,
          pageSize,
        })
        setRecentBatches(response.batches)
        setBatchTotal(response.total)
        setBatchTotalPages(response.total_pages)
        setBatchPage(response.page)
        setBatchPageSize(response.page_size)
        // 当前页数据变更后清掉已不存在的选中项
        setSelectedBatches((prev) => {
          const ids = new Set(response.batches.map((b) => b.batch_id))
          const next = new Set<string>()
          prev.forEach((id) => {
            if (ids.has(id)) next.add(id)
          })
          return next
        })
      } catch {
        // 近期批次为非关键信息，失败时静默处理
      }
    },
    [batchPage, batchPageSize]
  )

  useEffect(() => {
    loadRecentBatches(1, batchPageSize)
    // 初次挂载时拉取第 1 页；后续页码 / 页大小变化由 onClick 显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchPageSize])

  const refreshCurrentPage = useCallback(() => {
    void loadRecentBatches(batchPage, batchPageSize)
  }, [loadRecentBatches, batchPage, batchPageSize])

  const refreshToFirstPage = useCallback(() => {
    setBatchPage(1)
    void loadRecentBatches(1, batchPageSize)
  }, [loadRecentBatches, batchPageSize])

  // 轮询逻辑已抽到 useBatchPolling hook（fetchOnce / startPolling / clearPolling）

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!groupId) {
      setError('请先选择一个变体组')
      return
    }

    if (mode === 'i2i' && referenceUrls.length === 0) {
      setError('图生图模式必须提供参考图')
      return
    }

    if (!isPrefixValid) {
      setError('批次前缀仅支持 1-10 位 A-Z / 0-9 字符')
      return
    }

    setLoading(true)
    setError(null)
    setBatch(null)
    setSelectedTasks(new Set())
    clearPolling()

    try {
      const response = await generateBatch({
        group_id: Number(groupId),
        mode,
        size,
        resolution,
        reference_image_urls: mode === 'i2i' ? referenceUrls : undefined,
        prefix,
      })
      const status = await fetchOnce(response.batch_id)
      if (status) {
        // onSuccess 已 setBatch(status) + setConnectionStatus('ok')，无需再调
        startPolling(response.batch_id)
        refreshToFirstPage()
        // 新批次入库后立即刷新今日计数，避免预览停留在旧值
        void refreshTodayCount(prefix)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量生成失败')
    } finally {
      setLoading(false)
    }
  }

  const handleLoadBatch = async (batchId: string) => {
    setLoading(true)
    setError(null)
    clearPolling()
    setSelectedTasks(new Set())
    const status = await fetchOnce(batchId)
    if (status) {
      // onSuccess 已 setBatch(status) + setConnectionStatus('ok')，无需再调
      const done = status.completed + status.failed
      if (done < status.total) {
        startPolling(batchId)
      }
    }
    setLoading(false)
  }

  const handleBackToList = () => {
    clearPolling()
    setBatch(null)
    setSelectedTasks(new Set())
    setPreviewTask(null)
    setError(null)
  }

  const handleRetryFailed = async () => {
    if (!batch) return
    const hasFailed = batch.tasks.some((t) => t.status === 'failed')
    if (!hasFailed) return

    setLoading(true)
    setError(null)
    try {
      const response = await retryBatch(batch.batch_id)
      const status = await fetchOnce(response.batch_id)
      if (status) {
        // onSuccess 已 setBatch(status) + setConnectionStatus('ok')，无需再调
        startPolling(response.batch_id)
        refreshCurrentPage()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '重试失败任务失败')
    } finally {
      setLoading(false)
    }
  }

  const handleRegenerateTask = async (task: GenerationTaskItem) => {
    if (!batch) return
    if (!window.confirm('确定要重新生成该任务吗？当前图片将被新结果替换。')) {
      return
    }
    setRegeneratingTaskId(task.id)
    setError(null)
    // 取消任务级选中（重新生成后旧图失效，强行清空避免误选）
    setSelectedTasks((prev) => {
      if (!prev.has(task.id)) return prev
      const next = new Set(prev)
      next.delete(task.id)
      return next
    })
    try {
      const updated = await regenerateTask(batch.batch_id, task.id)
      // 用后端返回的最新任务替换本地数据
      setBatch((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          tasks: prev.tasks.map((t) => (t.id === updated.id ? updated : t)),
        }
      })
      // 重新进入轮询，等远端结果
      startPolling(batch.batch_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '重新生成失败')
    } finally {
      setRegeneratingTaskId(null)
    }
  }

  const toggleBatchSelection = (batchId: string) => {
    setSelectedBatches((prev) => {
      const next = new Set(prev)
      if (next.has(batchId)) {
        next.delete(batchId)
      } else {
        next.add(batchId)
      }
      return next
    })
  }

  const toggleSelectAllBatches = () => {
    const allSelected =
      recentBatches.length > 0 &&
      recentBatches.every((b) => selectedBatches.has(b.batch_id))
    if (allSelected) {
      setSelectedBatches(new Set())
    } else {
      setSelectedBatches(new Set(recentBatches.map((b) => b.batch_id)))
    }
  }

  const handleDeleteBatch = async (batchId: string) => {
    if (!window.confirm('确定要删除该批次及其所有任务吗？此操作不可恢复。')) {
      return
    }
    setBatchDeleting(true)
    setError(null)
    try {
      await deleteBatch(batchId)
      setSelectedBatches((prev) => {
        const next = new Set(prev)
        next.delete(batchId)
        return next
      })
      // 如果删除的是当前正在查看的批次，清空详情
      if (batch?.batch_id === batchId) {
        clearPolling()
        setBatch(null)
        setSelectedTasks(new Set())
      }
      await refreshCurrentPage()
      // 删除后批次总数可能变化，重拉今日计数
      void refreshTodayCount(prefix)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除批次失败')
    } finally {
      setBatchDeleting(false)
    }
  }

  const handleDeleteSelectedBatches = async () => {
    if (selectedBatches.size === 0) return
    const count = selectedBatches.size
    if (
      !window.confirm(
        `确定要删除已选中的 ${count} 个批次及其所有任务吗？此操作不可恢复。`
      )
    ) {
      return
    }
    setBatchDeleting(true)
    setError(null)
    const ids = Array.from(selectedBatches)
    try {
      await deleteBatches(ids)
      // 如果当前正在查看的批次在删除列表中，清空详情
      if (batch && selectedBatches.has(batch.batch_id)) {
        clearPolling()
        setBatch(null)
        setSelectedTasks(new Set())
      }
      setSelectedBatches(new Set())
      await refreshCurrentPage()
      // 批量删除后重拉今日计数
      void refreshTodayCount(prefix)
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量删除失败')
    } finally {
      setBatchDeleting(false)
    }
  }

  /**
   * 多批次批量导出到文件夹：每个批次一个子文件夹（子文件夹名 = batch_id）。
   *
   * 流程：
   *  1. 拉取每个 batch 的 completed 图片（按 batch.status 调用 getBatchStatus）
   *  2. 让用户选择父目录
   *  3. 顺序处理每个批次：检查子文件夹是否非空 → 弹窗询问 → 写入
   *  4. 汇总：成功 X 个 / 跳过 Y 个 / 失败 Z 个
   */
  const handleExportSelectedBatchesToDir = async () => {
    if (selectedBatches.size === 0) return
    if (!isFsAccessSupported()) {
      setError('当前浏览器不支持文件夹直存，请改用 Chrome / Edge / Opera')
      return
    }

    // 1. 让用户先选父目录（避免拉了一堆 batch 状态后用户取消）
    let dirHandle: FileSystemDirectoryHandle
    try {
      const picked = await pickDirectory()
      if (!picked) {
        setError('未选择目录')
        return
      }
      dirHandle = picked
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : '选择目录失败')
      return
    }

    const ids = Array.from(selectedBatches)
    setBatchesExporting(true)
    setBatchesExportProgress({ done: 0, total: ids.length, currentBatch: '', currentFile: 0, fileTotal: 0, skipped: false })
    setError(null)

    const lines: string[] = []
    let doneBatches = 0
    let conflictBatchNames: string[] = [] // 记录本轮被跳过的批次，避免用户重复触发

    try {
      for (const batchId of ids) {
        const batchName = displayBatchId(batchId)
        setBatchesExportProgress((p) =>
          p
            ? { ...p, currentBatch: batchName, currentFile: 0, fileTotal: 0, skipped: false }
            : p
        )

        // 2. 拉批次状态拿已完成图片
        let status: BatchStatusResponse
        try {
          status = await getBatchStatus(batchId)
        } catch (err) {
          const msg = err instanceof Error ? err.message : '查询批次状态失败'
          lines.push(`[${batchName}] 查询失败：${msg}`)
          doneBatches++
          setBatchesExportProgress((p) =>
            p ? { ...p, done: doneBatches } : p
          )
          continue
        }

        const items = status.tasks
          .map((task, index) => ({ task, index }))
          .filter(
            ({ task }) => task.status === 'completed' && task.image_url
          )

        setBatchesExportProgress((p) =>
          p
            ? { ...p, currentBatch: batchName, currentFile: 0, fileTotal: items.length }
            : p
        )

        // 3. 走 exportBatchesToDirectory（处理子文件夹创建 + 冲突询问 + 写入）
        const result = await exportBatchesToDirectory(
          [{ batchName, items }],
          dirHandle,
          {
            onConflict: (name) => {
              // per-batch confirm：是=覆盖，否=跳过
              // 注：window.confirm 不阻塞事件循环，但因为是同步 API，
              //     在 async 函数中表现为"立即 resolve"，UX 正常
              return window.confirm(
                `子文件夹 "${name}" 已存在且不为空，是否覆盖？\n\n` +
                  `点"确定" = 清空后下载\n点"取消" = 跳过该批次`
              )
                ? 'overwrite'
                : 'skip'
            },
            onProgress: (p) => {
              // 关键：保留外层的 total 和 done 累计，只更新当前批次内部信息
              // 原因：内层 exportBatchesToDirectory 每次只传 1 个 batch，
              //       它的 total 恒为 1、done 仅在 0~1 之间，会把外层累计的
              //       done/total 覆盖掉，导致进度条一直 0% 或闪 100%。
              // done 的推进交给外层循环 doneBatches++ 完成。
              setBatchesExportProgress((prev) =>
                prev
                  ? {
                      done: prev.done, // 外层累计，由 doneBatches++ 推进
                      total: prev.total, // 外层总批次数，循环开始时已固定
                      currentBatch: p.currentBatch,
                      currentFile: p.currentFile,
                      fileTotal: p.fileTotal,
                      skipped: p.skipped,
                    }
                  : prev
              )
            },
          }
        )

        // 4. 汇总本批结果
        const detail = result.details[0]
        if (detail) {
          if (detail.skipped) {
            lines.push(`[${detail.batchName}] 跳过（${detail.reason ?? ''}）`)
            if (detail.reason === '用户选择跳过') {
              conflictBatchNames.push(detail.batchName)
            }
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
        setBatchesExportProgress((p) =>
          p ? { ...p, done: doneBatches } : p
        )
      }

      // 5. 显示汇总
      const summary = `批量导出完成：共 ${ids.length} 个批次\n` + lines.join('\n')
      setError(summary)
      if (conflictBatchNames.length > 0) {
        // 额外追加一行提醒（用 setTimeout 避免覆盖前面的汇总）
        setTimeout(() => {
          setError(
            (prev) =>
              (prev ? prev + '\n' : '') +
              `被跳过的批次：${conflictBatchNames.join('、')}`
          )
        }, 50)
      }
    } finally {
      setBatchesExporting(false)
      setBatchesExportProgress(null)
    }
  }

  const toggleTaskSelection = (taskId: number) => {
    setSelectedTasks((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) {
        next.delete(taskId)
      } else {
        next.add(taskId)
      }
      return next
    })
  }

  const toggleSelectAll = () => {
    if (!batch) return
    const completed = batch.tasks.filter((t) => t.status === 'completed')
    const allSelected = completed.every((t) => selectedTasks.has(t.id))
    if (allSelected) {
      setSelectedTasks(new Set())
    } else {
      setSelectedTasks(new Set(completed.map((t) => t.id)))
    }
  }

  const handleDownloadSingle = (task: GenerationTaskItem, index: number) => {
    void downloadTasks(
      [{ task, index }],
      '',
      (msg) => setError(msg)
    )
  }

  const handleDownloadSelected = () => {
    if (!batch || selectedTasks.size === 0) return
    const items = batch.tasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => selectedTasks.has(task.id))
    void downloadTasks(
      items,
      `batch_${displayBatchId(batch.batch_id)}.zip`,
      (msg) => setError(msg)
    )
  }

  const handleDownloadAll = () => {
    if (!batch) return
    const items = batch.tasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => task.status === 'completed')
    void downloadTasks(
      items,
      `batch_${displayBatchId(batch.batch_id)}_all.zip`,
      (msg) => setError(msg)
    )
  }

  const runDirDownload = async (items: { task: GenerationTaskItem; index: number }[]) => {
    if (!isFsAccessSupported()) {
      setError('当前浏览器不支持文件夹直存，请改用 Chrome / Edge / Opera')
      return
    }
    let dirHandle: FileSystemDirectoryHandle | null
    try {
      dirHandle = await pickDirectory()
    } catch (err) {
      // 用户取消选择也会抛 AbortError，静默处理
      if (err instanceof Error && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : '选择目录失败')
      return
    }
    if (!dirHandle) {
      setError('未选择目录')
      return
    }

    const valid = items.filter((it) => it.task.image_url)
    if (valid.length === 0) {
      setError('暂无可下载的已完成图片')
      return
    }

    setDirDownloading(true)
    setDirProgress({ done: 0, total: valid.length, current: 0 })
    setError(null)

    const result = await saveTasksToDirectory(
      valid,
      dirHandle,
      (p) => setDirProgress({ done: p.done, total: p.total, current: p.current })
    )

    setDirDownloading(false)
    setDirProgress(null)

    if (result.failed === 0) {
      setError(`已保存 ${result.success} 张图片到所选目录`)
    } else {
      const head = result.errors.slice(0, 3).join('；')
      setError(
        `已保存 ${result.success}/${result.total} 张；失败 ${result.failed} 条。` +
          (head ? ` 例：${head}` : '')
      )
    }
  }

  const handleDownloadSelectedToDir = () => {
    if (!batch || selectedTasks.size === 0) return
    const items = batch.tasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => selectedTasks.has(task.id))
    void runDirDownload(items)
  }

  const handleDownloadAllToDir = () => {
    if (!batch) return
    const items = batch.tasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => task.status === 'completed')
    void runDirDownload(items)
  }

  const overallProgress = batch
    ? Math.round(
        (batch.tasks.reduce((sum, t) => sum + t.progress, 0) /
          (batch.total * 100)) *
          100
      )
    : 0

  const completedTasks = batch?.tasks.filter((t) => t.status === 'completed') ?? []
  const failedTasks = batch?.tasks.filter((t) => t.status === 'failed') ?? []

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>批量生成</h2>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="group">选择变体组</label>
          <select
            id="group"
            value={groupId}
            onChange={(e) =>
              setGroupId(e.target.value ? Number(e.target.value) : '')
            }
            required
          >
            <option value="">请选择</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.variant_count} 个变体)
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="batchPrefix">批次号前缀</label>
          <input
            id="batchPrefix"
            type="text"
            value={prefix}
            onChange={(e) => handlePrefixChange(e.target.value)}
            maxLength={10}
            placeholder="MZY"
            style={{
              fontFamily: 'monospace',
              textTransform: 'uppercase',
              ...(isPrefixValid ? {} : { borderColor: '#dc2626' }),
            }}
            title="批次号前缀，仅支持 A-Z / 0-9，1-10 位；保存到浏览器本地，跨会话保留"
          />
          <div className="hint" style={{ marginTop: '0.25rem' }}>
            格式：<code style={{ fontFamily: 'monospace' }}>{prefix || '???'}</code>
            <code style={{ fontFamily: 'monospace' }}>{todayBatchInfo?.date ?? '????'}</code>
            <code style={{ fontFamily: 'monospace' }}>??</code>
            （前缀可自定义 · 日期为服务端北京时间 · 序号由服务端分配，删除中间批次会自动填充）
            {isPrefixValid ? (
              <>
                {' · 下个 ID 预览：'}
                <code style={{ fontFamily: 'monospace' }}>{previewBatchId}</code>
              </>
            ) : (
              <span style={{ color: '#dc2626' }}> · 仅支持 1-10 位 A-Z / 0-9</span>
            )}
          </div>
        </div>

        <div className="form-group">
          <label>生成模式</label>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <input
                type="radio"
                value="t2i"
                checked={mode === 't2i'}
                onChange={() => setMode('t2i')}
              />
              文生图
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <input
                type="radio"
                value="i2i"
                checked={mode === 'i2i'}
                onChange={() => setMode('i2i')}
              />
              图生图
            </label>
          </div>
        </div>

        {mode === 'i2i' && (
          <ImageUploader
            urls={referenceUrls}
            onChange={setReferenceUrls}
            disabled={loading}
          />
        )}

        <ParameterSelector
          size={size}
          resolution={resolution}
          onChange={({ size, resolution }) => {
            setSize(size)
            setResolution(resolution)
          }}
        />

        <div style={{ marginTop: '1.25rem' }}>
          <button type="submit" disabled={loading || !groupId}>
            {loading ? '创建批量任务中...' : '开始批量生成'}
          </button>
        </div>
      </form>

      {(recentBatches.length > 0 || batchTotal > 0) && !batch && (
        <div style={{ marginTop: '1.5rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.5rem',
              marginBottom: '0.5rem',
            }}
          >
            <h3 style={{ margin: 0 }}>近期批次</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={toggleSelectAllBatches}
                style={{ padding: '0.4rem 0.8rem' }}
                disabled={recentBatches.length === 0}
              >
                {selectedBatches.size === recentBatches.length && recentBatches.length > 0
                  ? '取消全选'
                  : '全选'}
              </button>
              <button
                type="button"
                onClick={handleExportSelectedBatchesToDir}
                disabled={selectedBatches.size === 0 || batchesExporting}
                style={{
                  padding: '0.4rem 0.8rem',
                  background:
                    selectedBatches.size === 0 || batchesExporting
                      ? undefined
                      : '#2563eb',
                  color:
                    selectedBatches.size === 0 || batchesExporting
                      ? undefined
                      : '#fff',
                }}
                title={
                  isFsAccessSupported()
                    ? `将已选中的 ${selectedBatches.size} 个批次按 batch_id 分目录导出到本地`
                    : '当前浏览器不支持文件夹直存，请使用 Chrome / Edge / Opera'
                }
              >
                {batchesExporting
                  ? `导出中 ${
                      batchesExportProgress
                        ? `${batchesExportProgress.done}/${batchesExportProgress.total}`
                        : ''
                    }`
                  : `导出已选到文件夹 (${selectedBatches.size})`}
              </button>
              {batchesExporting && batchesExportProgress && (
                <BatchExportProgressView
                  progress={batchesExportProgress}
                />
              )}
              <button
                type="button"
                onClick={handleDeleteSelectedBatches}
                disabled={selectedBatches.size === 0 || batchDeleting}
                style={{
                  padding: '0.4rem 0.8rem',
                  background: selectedBatches.size === 0 ? undefined : '#dc2626',
                  color: selectedBatches.size === 0 ? undefined : '#fff',
                }}
              >
                {batchDeleting
                  ? '删除中...'
                  : `删除已选 (${selectedBatches.size})`}
              </button>
            </div>
          </div>

          {recentBatches.length === 0 ? (
            <div className="hint">当前页暂无批次数据。</div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {recentBatches.map((b) => (
                <li
                  key={b.batch_id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.5rem',
                    borderBottom: '1px solid #e5e7eb',
                    gap: '0.5rem',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedBatches.has(b.batch_id)}
                      onChange={() => toggleBatchSelection(b.batch_id)}
                      style={{ cursor: 'pointer' }}
                    />
                    <span className="hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {displayBatchId(b.batch_id)} · {b.completed_count}/{b.task_count} 完成 ·{' '}
                      {new Date(b.last_created_at).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={() => handleLoadBatch(b.batch_id)}
                      style={{ padding: '0.4rem 0.8rem' }}
                    >
                      查看
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteBatch(b.batch_id)}
                      disabled={batchDeleting}
                      style={{
                        padding: '0.4rem 0.8rem',
                        background: '#fee2e2',
                        color: '#991b1b',
                      }}
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {batchTotal > 0 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '0.5rem',
                marginTop: '0.75rem',
                fontSize: '0.85rem',
              }}
            >
              <span className="hint">
                共 {batchTotal} 条 · 第 {batchPage}/{Math.max(batchTotalPages, 1)} 页
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  每页
                  <select
                    value={batchPageSize}
                    onChange={(e) => {
                      const next = Number(e.target.value)
                      setBatchPageSize(next)
                      setBatchPage(1)
                      void loadRecentBatches(1, next)
                    }}
                    style={{ padding: '0.2rem 0.4rem' }}
                  >
                    <option value={5}>5</option>
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const next = Math.max(1, batchPage - 1)
                    setBatchPage(next)
                    void loadRecentBatches(next, batchPageSize)
                  }}
                  disabled={batchPage <= 1}
                  style={{ padding: '0.4rem 0.8rem' }}
                >
                  上一页
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = Math.min(batchTotalPages, batchPage + 1)
                    setBatchPage(next)
                    void loadRecentBatches(next, batchPageSize)
                  }}
                  disabled={batchPage >= batchTotalPages}
                  style={{ padding: '0.4rem 0.8rem' }}
                >
                  下一页
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {recentBatches.length === 0 && batchTotal === 0 && !batch && (
        <div className="hint" style={{ marginTop: '1.5rem' }}>
          暂无生成批次，选择变体组并开始批量生成后结果将显示在这里。
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {batch && batchTotal > 0 && (
        <div
          style={{
            marginTop: '1.5rem',
            padding: '0.75rem',
            background: '#f9fafb',
            borderRadius: '8px',
            border: '1px solid #e5e7eb',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.5rem',
              flexWrap: 'wrap',
              gap: '0.5rem',
            }}
          >
            <span
              style={{
                fontWeight: 500,
                fontSize: '0.9rem',
                color: '#374151',
              }}
            >
              近期批次（共 {batchTotal} 条）
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span className="hint" style={{ fontSize: '0.8rem' }}>
                第 {batchPage}/{Math.max(batchTotalPages, 1)} 页
              </span>
              <button
                type="button"
                onClick={() => {
                  const next = Math.max(1, batchPage - 1)
                  setBatchPage(next)
                  void loadRecentBatches(next, batchPageSize)
                }}
                disabled={batchPage <= 1}
                style={{ padding: '0.2rem 0.6rem', fontSize: '0.8rem' }}
              >
                上一页
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = Math.min(batchTotalPages, batchPage + 1)
                  setBatchPage(next)
                  void loadRecentBatches(next, batchPageSize)
                }}
                disabled={batchPage >= batchTotalPages}
                style={{ padding: '0.2rem 0.6rem', fontSize: '0.8rem' }}
              >
                下一页
              </button>
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              overflowX: 'auto',
              paddingBottom: '0.25rem',
            }}
          >
            {recentBatches.map((b) => {
              const isCurrent = b.batch_id === batch.batch_id
              return (
                <button
                  key={b.batch_id}
                  type="button"
                  onClick={() => {
                    if (!isCurrent) {
                      void handleLoadBatch(b.batch_id)
                    }
                  }}
                  style={{
                    flex: '0 0 auto',
                    padding: '0.4rem 0.75rem',
                    border: `1px solid ${
                      isCurrent ? '#2563eb' : '#e5e7eb'
                    }`,
                    background: isCurrent ? '#eff6ff' : '#fff',
                    color: isCurrent ? '#1d4ed8' : '#374151',
                    borderRadius: '6px',
                    fontSize: '0.8rem',
                    cursor: isCurrent ? 'default' : 'pointer',
                    textAlign: 'left',
                    minWidth: '180px',
                  }}
                  title={
                    isCurrent
                      ? '当前查看的批次'
                      : `切换到批次 ${b.batch_id}`
                  }
                >
                  <div
                    style={{
                      fontWeight: 500,
                      fontFamily: 'monospace',
                    }}
                  >
                    {displayBatchId(b.batch_id)}
                    {isCurrent && ' · 当前'}
                  </div>
                  <div className="hint" style={{ fontSize: '0.75rem' }}>
                    {b.completed_count}/{b.task_count} 完成
                  </div>
                </button>
              )
            })}
            {recentBatches.length === 0 && (
              <span className="hint">当前页无数据</span>
            )}
          </div>
        </div>
      )}

      {batch && (
        <div style={{ marginTop: '1.5rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.5rem',
              marginBottom: '0.75rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <button
                type="button"
                onClick={handleBackToList}
                style={{ padding: '0.4rem 0.8rem' }}
                title="返回近期批次列表"
              >
                ← 返回
              </button>
              <h3 style={{ margin: 0 }}>批次状态</h3>
              <span
                className="hint"
                style={{
                  fontFamily: 'monospace',
                  fontSize: '0.8rem',
                  color: '#6b7280',
                }}
              >
                {batch.batch_id}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <ConnectionBadge status={connectionStatus} />
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
              gap: '0.75rem',
              marginBottom: '1rem',
            }}
          >
            <Stat label="总计" value={batch.total} />
            <Stat label="已完成" value={batch.completed} color="#16a34a" />
            <Stat label="失败" value={batch.failed} color="#dc2626" />
            <Stat label="进行中" value={batch.in_progress} color="#2563eb" />
            <Stat label="排队中" value={batch.queued + batch.pending} />
          </div>

          <div className="form-group">
            <label>总体进度 ({overallProgress}%)</label>
            <ProgressBar progress={overallProgress} color="#2563eb" animated />
          </div>

          {completedTasks.length > 0 && (
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                marginBottom: '1rem',
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                onClick={toggleSelectAll}
                style={{ padding: '0.4rem 0.8rem' }}
              >
                全选/取消
              </button>
              <button
                type="button"
                onClick={handleDownloadSelected}
                disabled={selectedTasks.size === 0}
                style={{ padding: '0.4rem 0.8rem' }}
              >
                下载已选 ({selectedTasks.size})
              </button>
              <button
                type="button"
                onClick={handleDownloadAll}
                style={{ padding: '0.4rem 0.8rem' }}
              >
                下载全部
              </button>
              <button
                type="button"
                onClick={handleDownloadSelectedToDir}
                disabled={selectedTasks.size === 0 || dirDownloading}
                style={{ padding: '0.4rem 0.8rem' }}
                title={
                  isFsAccessSupported()
                    ? '将所选图片直接保存到本地文件夹（不压缩）'
                    : '当前浏览器不支持文件夹直存，请使用 Chrome / Edge / Opera'
                }
              >
                导出已选到文件夹
              </button>
              <button
                type="button"
                onClick={handleDownloadAllToDir}
                disabled={dirDownloading}
                style={{ padding: '0.4rem 0.8rem' }}
                title={
                  isFsAccessSupported()
                    ? '将该批次所有已完成图片直接保存到本地文件夹（不压缩）'
                    : '当前浏览器不支持文件夹直存，请使用 Chrome / Edge / Opera'
                }
              >
                导出全部到文件夹
              </button>
              {dirDownloading && dirProgress && (
                <span className="hint" style={{ fontSize: '0.8rem' }}>
                  写入中 {dirProgress.done}/{dirProgress.total}
                  {dirProgress.done > 0 && dirProgress.done <= dirProgress.total
                    ? ` · 当前 #${dirProgress.current}`
                    : ''}
                </span>
              )}
            </div>
          )}

          {failedTasks.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              <button
                type="button"
                onClick={handleRetryFailed}
                disabled={loading}
                style={{
                  padding: '0.4rem 0.8rem',
                  background: '#f59e0b',
                }}
              >
                {loading ? '重试中...' : `重试失败任务 (${failedTasks.length})`}
              </button>
            </div>
          )}

          {batch.tasks.length === 0 ? (
            <div className="hint">该批次暂无任务。</div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                gap: '1rem',
                marginTop: '1rem',
              }}
            >
              {batch.tasks.map((task, index) => (
                <TaskCard
                  key={task.id}
                  index={index}
                  task={task}
                  selected={selectedTasks.has(task.id)}
                  onToggle={() => toggleTaskSelection(task.id)}
                  onPreview={() => task.image_url && setPreviewTask(task)}
                  onDownload={() => handleDownloadSingle(task, index)}
                  onRegenerate={() => handleRegenerateTask(task)}
                  regenerating={regeneratingTaskId === task.id}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <ImagePreview
        url={previewTask?.image_url ?? null}
        onClose={() => setPreviewTask(null)}
        meta={
          previewTask
            ? {
                prompt: previewTask.variant_prompt ?? undefined,
                size: previewTask.size,
                resolution: previewTask.resolution,
              }
            : null
        }
      />
    </div>
  )
}

function TaskCard({
  index,
  task,
  selected,
  onToggle,
  onPreview,
  onDownload,
  onRegenerate,
  regenerating,
}: {
  index: number
  task: GenerationTaskItem
  selected: boolean
  onToggle: () => void
  onPreview: () => void
  onDownload: () => void
  onRegenerate: () => void
  regenerating: boolean
}) {
  const isCompleted = task.status === 'completed'
  const isFailed = task.status === 'failed'
  const [imageError, setImageError] = useState(false)

  return (
    <div
      style={{
        border: `1px solid ${selected ? '#2563eb' : '#e5e7eb'}`,
        borderRadius: '8px',
        padding: '0.75rem',
        background:
          task.status === 'failed'
            ? '#fef2f2'
            : task.status === 'completed'
            ? '#f0fdf4'
            : '#fff',
        transition: 'all 0.2s',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '0.5rem',
        }}
      >
        <div
          style={{
            fontSize: '0.85rem',
            fontWeight: 500,
            color: statusColor[task.status] || '#374151',
          }}
        >
          #{index + 1} {statusText[task.status] || task.status}
        </div>
        {isCompleted && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            style={{ cursor: 'pointer' }}
          />
        )}
      </div>

      <div
        className="hint"
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          marginBottom: '0.5rem',
          minHeight: '2.4rem',
        }}
      >
        {task.variant_prompt || '未知变体'}
      </div>

      <div style={{ fontSize: '0.8rem', marginBottom: '0.25rem' }}>
        进度：{task.progress}%
      </div>
      <ProgressBar
        progress={task.progress}
        color={statusColor[task.status] || '#9ca3af'}
      />

      {isCompleted && task.image_url && (
        <div style={{ marginTop: '0.5rem' }}>
          {imageError ? (
            <div
              style={{
                width: '100%',
                height: '120px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#fef2f2',
                color: '#991b1b',
                borderRadius: '6px',
                fontSize: '0.8rem',
                border: '1px solid #fecaca',
              }}
            >
              图片加载失败
            </div>
          ) : (
            <img
              src={task.image_url}
              alt="生成结果"
              onClick={onPreview}
              onError={() => setImageError(true)}
              style={{
                width: '100%',
                height: '120px',
                objectFit: 'cover',
                borderRadius: '6px',
                cursor: 'pointer',
                border: '1px solid #e5e7eb',
              }}
            />
          )}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: '0.4rem',
              marginTop: '0.5rem',
            }}
          >
            <button
              type="button"
              onClick={onPreview}
              disabled={imageError}
              style={{ padding: '0.4rem 0', fontSize: '0.8rem' }}
            >
              预览
            </button>
            <button
              type="button"
              onClick={onDownload}
              disabled={imageError}
              style={{ padding: '0.4rem 0', fontSize: '0.8rem' }}
            >
              下载
            </button>
            <button
              type="button"
              onClick={onRegenerate}
              disabled={regenerating}
              style={{
                padding: '0.4rem 0',
                fontSize: '0.8rem',
                background: regenerating ? '#f3f4f6' : '#fff7ed',
                color: regenerating ? '#9ca3af' : '#9a3412',
                border: `1px solid ${regenerating ? '#e5e7eb' : '#fed7aa'}`,
              }}
              title="使用相同 Prompt 重新生成图片"
            >
              {regenerating ? '生成中…' : '重新生成'}
            </button>
          </div>
        </div>
      )}

      {isFailed && (
        <div style={{ marginTop: '0.5rem' }}>
          <button
            type="button"
            onClick={onRegenerate}
            disabled={regenerating}
            style={{
              width: '100%',
              padding: '0.4rem 0',
              fontSize: '0.85rem',
              background: regenerating ? '#f3f4f6' : '#f59e0b',
              color: regenerating ? '#9ca3af' : '#fff',
            }}
          >
            {regenerating ? '重新提交中…' : '重新生成'}
          </button>
        </div>
      )}

      {task.error_msg && (
        <div
          style={{
            color: '#dc2626',
            fontSize: '0.75rem',
            marginTop: '0.5rem',
          }}
        >
          {task.error_msg}
        </div>
      )}
    </div>
  )
}

function ProgressBar({
  progress,
  color,
  animated,
}: {
  progress: number
  color: string
  animated?: boolean
}) {
  return (
    <div
      style={{
        height: '8px',
        background: '#e5e7eb',
        borderRadius: '4px',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${progress}%`,
          height: '100%',
          background: color,
          borderRadius: '4px',
          transition: 'width 0.4s ease-out',
          animation: animated ? 'pulse 1.5s infinite' : undefined,
        }}
      />
    </div>
  )
}

/**
 * 多批次批量导出进度视图。
 *
 * 双层进度：
 *  - 蓝色上层：批次总进度 done/total（百分比 + 文字）
 *  - 绿色下层：当前批次内的文件进度 currentFile/fileTotal（仅在 fileTotal > 0 时显示）
 *
 * 布局：在外层 flex 容器里用 ``flexBasis: '100%'`` 强制换行到按钮下方占满整行，
 *       进度文字与进度条各占一行，整体高度 < 80px，不影响列表布局。
 */
function BatchExportProgressView({
  progress,
}: {
  progress: {
    done: number
    total: number
    currentBatch: string
    currentFile: number
    fileTotal: number
    skipped: boolean
  }
}) {
  // 批次总进度：0-100 的整数百分比
  const totalPct =
    progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0
  // 当前批次文件进度：仅在有文件时计算
  const filePct =
    progress.fileTotal > 0
      ? Math.round((progress.currentFile / progress.fileTotal) * 100)
      : 0
  return (
    <div
      style={{
        flexBasis: '100%',
        marginTop: '0.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem',
      }}
    >
      {/* 上层：批次总进度 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '0.8rem',
        }}
      >
        <span className="hint">
          {progress.currentBatch || '准备中…'}
          {progress.skipped && (
            <span style={{ color: '#f59e0b', marginLeft: '0.4rem' }}>· 跳过</span>
          )}
        </span>
        <span className="hint">
          {progress.done}/{progress.total} 批次 · <strong>{totalPct}%</strong>
        </span>
      </div>
      <ProgressBar progress={totalPct} color="#2563eb" />

      {/* 下层：当前批次文件进度（仅在有文件时显示） */}
      {progress.fileTotal > 0 && (
        <>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: '0.75rem',
              marginTop: '0.2rem',
            }}
          >
            <span className="hint">当前批次文件</span>
            <span className="hint">
              {progress.currentFile}/{progress.fileTotal} ·{' '}
              <strong>{filePct}%</strong>
            </span>
          </div>
          <ProgressBar progress={filePct} color="#16a34a" />
        </>
      )}
    </div>
  )
}

function ConnectionBadge({ status }: { status: 'ok' | 'error' }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        padding: '0.25rem 0.5rem',
        borderRadius: '999px',
        fontSize: '0.75rem',
        background: status === 'ok' ? '#dcfce7' : '#fee2e2',
        color: status === 'ok' ? '#166534' : '#991b1b',
      }}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: status === 'ok' ? '#22c55e' : '#ef4444',
        }}
      />
      {status === 'ok' ? '连接正常' : '连接异常'}
    </span>
  )
}

function Stat({
  label,
  value,
  color,
}: {
  label: string
  value: number
  color?: string
}) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '0.5rem',
        background: '#f9fafb',
        borderRadius: '8px',
      }}
    >
      <div style={{ fontSize: '1.25rem', fontWeight: 600, color }}>{value}</div>
      <div className="hint">{label}</div>
    </div>
  )
}

function buildFileName(index: number): string {
  // 按变体序号命名,1-based,与卡片左上角 "#N" 保持一致
  return `${index + 1}.png`
}

// 展示用的 batch_id：新格式（PREFIX+MMDD+seq，9-12 字符）完整显示；
// 旧 UUID（36 字符）保留截取前 8 字符的旧行为。
function displayBatchId(batchId: string): string {
  if (batchId.length <= 12) return batchId
  return batchId.slice(0, 8)
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function downloadTasks(
  items: { task: GenerationTaskItem; index: number }[],
  zipName: string,
  onError: (msg: string) => void
) {
  const valid = items.filter((item) => item.task.image_url)
  if (valid.length === 0) {
    onError('暂无可下载的已完成图片')
    return
  }
  // 单张图片直接下载,不压缩成 zip
  if (valid.length === 1) {
    const { task, index } = valid[0]
    try {
      const blob = await downloadImage(task.image_url as string)
      triggerDownload(blob, buildFileName(index))
    } catch (err) {
      onError(err instanceof Error ? err.message : '下载失败')
    }
    return
  }
  // 多张打包成 zip
  try {
    const zip = new JSZip()
    await Promise.all(
      valid.map(async ({ task, index }) => {
        const blob = await downloadImage(task.image_url as string)
        zip.file(buildFileName(index), blob)
      })
    )
    const content = await zip.generateAsync({ type: 'blob' })
    triggerDownload(content, zipName)
  } catch (err) {
    onError(err instanceof Error ? err.message : '打包下载失败')
  }
}
