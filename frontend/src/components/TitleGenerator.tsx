import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteTitleTask,
  exportTitlesCsv,
  fetchTitlePrompts,
  generateTitles,
  getBatchTitleImages,
  listRecentBatches,
  listTitleTasks,
  regenerateTitle,
} from '../api'
import {
  CARPET_TYPE_FALLBACK_LABELS,
  DEFAULT_CARPET_TITLE_SYSTEM_PROMPT,
  DEFAULT_CARPET_TYPE,
  MAX_TOKENS_OPTIONS,
  TITLE_CARPET_TYPE_STORAGE_KEY,
  TITLE_MODEL_OPTIONS,
  TITLE_POLL_INTERVAL_MS,
  TITLE_PROMPT_DIRTY_STORAGE_KEY,
  TITLE_PROMPT_STORAGE_KEY,
} from '../constants'
import type {
  BatchListResponse,
  BatchSummary,
  CarpetType,
  TitleBatchImageItem,
  TitleModelId,
  TitleTask,
} from '../types'
import ImagePreview from './ImagePreview'

// 地毯类型候选值（与后端 CARPET_TYPES 对齐，用于遍历渲染单选按钮）
const CARPET_TYPE_OPTIONS: CarpetType[] = ['corridor', 'living_room', 'general']

const statusText: Record<string, string> = {
  pending: '排队中',
  in_progress: '生成中…',
  completed: '已完成',
  failed: '生成失败',
}

const statusColor: Record<string, string> = {
  pending: '#9ca3af',
  in_progress: '#2563eb',
  completed: '#16a34a',
  failed: '#dc2626',
}

// 单页加载上限（够用，500 是后端硬上限，给 200 留足余量）
const BATCH_PAGE_SIZE = 200
// 列表默认高度
const BATCH_LIST_MAX_HEIGHT = 320

interface BatchImagesCache {
  // batch_id -> 该批次已完成图（按 index 1-based）
  [batchId: string]: TitleBatchImageItem[]
}

export default function TitleGenerator() {
  // 1. 批次选择（支持分页 + 搜索）
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [batchesTotal, setBatchesTotal] = useState<number>(0)
  const [batchesTotalPages, setBatchesTotalPages] = useState<number>(0)
  const [batchesPage, setBatchesPage] = useState<number>(1)
  const [batchesLoading, setBatchesLoading] = useState(false)
  const [batchesError, setBatchesError] = useState<string | null>(null)
  const [batchSearch, setBatchSearch] = useState<string>('')
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(new Set())

  // 2. 选中的批次对应的图片缓存（用于"选第 K 张图"）
  const [imagesCache, setImagesCache] = useState<BatchImagesCache>({})
  const [imagesLoading, setImagesLoading] = useState(false)
  const [imageIndex, setImageIndex] = useState<number>(1)

  // 3. 模型 / 参数
  const [model, setModel] = useState<TitleModelId>('gemini-3.6-flash')
  const [systemPrompt, setSystemPrompt] = useState<string>(
    () => localStorage.getItem(TITLE_PROMPT_STORAGE_KEY) || DEFAULT_CARPET_TITLE_SYSTEM_PROMPT
  )
  const [maxTokens, setMaxTokens] = useState<string>('8192')
  const [temperature, setTemperature] = useState<string>('0.7')

  // 3.5 地毯类型 + 模板（决定使用哪份 prompt）
  // - carpetType: 用户当前选中的地毯类型，从 localStorage 恢复
  // - carpetPrompts: 后端 GET /api/title-tasks/prompts 返回的 3 份 prompt 模板
  // - carpetLabels: 后端返回的中文标签（前端展示）
  // - promptsLoading / promptsError: 拉取状态
  // - systemPromptDirty: 用户是否手动编辑过 systemPrompt；
  //   true 时切换地毯类型不会覆盖，false 时会自动套用对应类型的 prompt
  const [carpetType, setCarpetType] = useState<CarpetType>(() => {
    const stored = localStorage.getItem(TITLE_CARPET_TYPE_STORAGE_KEY)
    if (stored === 'corridor' || stored === 'living_room' || stored === 'general') {
      return stored
    }
    return DEFAULT_CARPET_TYPE
  })
  const [carpetPrompts, setCarpetPrompts] = useState<Partial<Record<CarpetType, string>>>({})
  const [carpetLabels, setCarpetLabels] = useState<Record<CarpetType, string>>(
    CARPET_TYPE_FALLBACK_LABELS as Record<CarpetType, string>
  )
  const [promptsLoading, setPromptsLoading] = useState(false)
  const [promptsError, setPromptsError] = useState<string | null>(null)
  const [systemPromptDirty, setSystemPromptDirty] = useState<boolean>(
    () => localStorage.getItem(TITLE_PROMPT_DIRTY_STORAGE_KEY) === '1'
  )

  // 4. 提交 / 结果
  const [submitting, setSubmitting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [titleTasks, setTitleTasks] = useState<TitleTask[]>([])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)
  // 已有标题确认弹窗：null 表示未弹出
  // - existing: 按 source_task_id 聚合后每条只保留最新一条 completed 标题
  // - planned: 本次计划要生成的 source_task_id 列表（用于回填"无标题"那些批次的标记）
  // - plannedBatchIds: 计划要生成的 batch_id 列表（用于显示 N 个待生成）
  const [confirmDialog, setConfirmDialog] = useState<{
    existing: TitleTask[]
    planned: number[]
    plannedBatchIds: string[]
  } | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  // 持久化 system prompt 到 localStorage
  useEffect(() => {
    localStorage.setItem(TITLE_PROMPT_STORAGE_KEY, systemPrompt)
  }, [systemPrompt])

  // 持久化 systemPromptDirty 标记
  // - dirty=true → 写 '1'，下次切换地毯类型时不会覆盖用户的自定义内容
  // - dirty=false → 删 key，恢复"未编辑"状态，切换地毯类型会自动套用对应 prompt
  useEffect(() => {
    if (systemPromptDirty) {
      localStorage.setItem(TITLE_PROMPT_DIRTY_STORAGE_KEY, '1')
    } else {
      localStorage.removeItem(TITLE_PROMPT_DIRTY_STORAGE_KEY)
    }
  }, [systemPromptDirty])

  // 挂载时拉取 3 个地毯类型对应的 prompt 模板和中文标签
  // - 失败不阻塞 UI：carpetLabels 有 fallback，carpetPrompts 为空时用 DEFAULT_CARPET_TITLE_SYSTEM_PROMPT
  // - 拉取成功后若用户没手动编辑过 systemPrompt，自动切到当前 carpetType 对应的 prompt
  useEffect(() => {
    let cancelled = false
    setPromptsLoading(true)
    setPromptsError(null)
    fetchTitlePrompts()
      .then((res) => {
        if (cancelled) return
        setCarpetPrompts(res.prompts || {})
        if (res.labels) setCarpetLabels(res.labels)
        // 拿到模板后，如果用户没编辑过 systemPrompt，
        // 立即把当前选中的地毯类型对应 prompt 写进 textarea
        // （注意这里用 functional update 读取最新 dirty，避免闭包过期）
        setSystemPrompt((current) => {
          const dirty = localStorage.getItem(TITLE_PROMPT_DIRTY_STORAGE_KEY) === '1'
          if (dirty) return current
          const target = res.prompts?.[carpetType]
          return target || current
        })
      })
      .catch((err) => {
        if (cancelled) return
        setPromptsError(err instanceof Error ? err.message : '加载 prompt 模板失败')
      })
      .finally(() => {
        if (!cancelled) setPromptsLoading(false)
      })
    return () => {
      cancelled = true
    }
    // 仅挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 加载批次（支持追加或重置）
  const loadBatches = useCallback(
    async (opts: { append?: boolean; page?: number } = {}) => {
      const targetPage = opts.page ?? (opts.append ? batchesPage + 1 : 1)
      setBatchesLoading(true)
      setBatchesError(null)
      try {
        const res: BatchListResponse = await listRecentBatches({
          page: targetPage,
          pageSize: BATCH_PAGE_SIZE,
        })
        setBatches((prev) => (opts.append ? [...prev, ...res.batches] : res.batches))
        setBatchesTotal(res.total)
        setBatchesTotalPages(res.total_pages)
        setBatchesPage(res.page)
        // 当前页/追加的数据变更后清掉已不存在的选中项
        if (!opts.append) {
          // 重置模式下仅保留仍然存在的选中
          setSelectedBatchIds((prev) => {
            const ids = new Set(res.batches.map((b) => b.batch_id))
            const next = new Set<string>()
            prev.forEach((id) => {
              if (ids.has(id)) next.add(id)
            })
            return next
          })
        }
      } catch (err) {
        setBatchesError(err instanceof Error ? err.message : '加载批次列表失败')
      } finally {
        setBatchesLoading(false)
      }
    },
    [batchesPage]
  )

  useEffect(() => {
    void loadBatches({ page: 1 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 选中批次变化时，加载每个选中批次的图片
  useEffect(() => {
    const need = Array.from(selectedBatchIds).filter((id) => !(id in imagesCache))
    if (need.length === 0) return
    let cancelled = false
    setImagesLoading(true)
    void Promise.all(
      need.map(async (id) => {
        try {
          const res = await getBatchTitleImages(id)
          return [id, res.images] as const
        } catch {
          return [id, [] as TitleBatchImageItem[]] as const
        }
      })
    ).then((entries) => {
      if (cancelled) return
      setImagesCache((prev) => {
        const next = { ...prev }
        for (const [id, imgs] of entries) next[id] = imgs
        return next
      })
      setImagesLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [selectedBatchIds, imagesCache])

  // 搜索过滤：基于 batch_id 子串匹配（不区分大小写）
  const filteredBatches = useMemo(() => {
    const q = batchSearch.trim().toLowerCase()
    if (!q) return batches
    return batches.filter((b) => b.batch_id.toLowerCase().includes(q))
  }, [batches, batchSearch])

  // 计算所有选中批次的最小图数 + 每个批次的图数
  const batchImageStats = useMemo(() => {
    const stats: { batchId: string; count: number }[] = []
    for (const id of selectedBatchIds) {
      const imgs = imagesCache[id]
      stats.push({
        batchId: id,
        count: imgs ? imgs.length : 0,
      })
    }
    return stats
  }, [selectedBatchIds, imagesCache])

  const minImageCount = useMemo(() => {
    if (batchImageStats.length === 0) return 0
    return Math.min(...batchImageStats.map((s) => s.count))
  }, [batchImageStats])

  // 当最小图数变化时，自动夹紧 imageIndex
  useEffect(() => {
    if (minImageCount === 0) {
      setImageIndex(1)
    } else if (imageIndex > minImageCount) {
      setImageIndex(minImageCount)
    } else if (imageIndex < 1) {
      setImageIndex(1)
    }
  }, [minImageCount, imageIndex])

  const toggleBatch = (batchId: string) => {
    setSelectedBatchIds((prev) => {
      const next = new Set(prev)
      if (next.has(batchId)) {
        next.delete(batchId)
      } else {
        next.add(batchId)
      }
      return next
    })
  }

  // 全选：仅作用于"当前可见（过滤后）"的批次，避免误选被搜索隐藏的项
  const toggleAllVisible = () => {
    const visibleIds = filteredBatches.map((b) => b.batch_id)
    const allSelected =
      visibleIds.length > 0 && visibleIds.every((id) => selectedBatchIds.has(id))
    setSelectedBatchIds((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        for (const id of visibleIds) next.delete(id)
      } else {
        for (const id of visibleIds) next.add(id)
      }
      return next
    })
  }

  // 切换地毯类型：
  // 1) 写 localStorage（持久化用户选择）
  // 2) 若用户没手动编辑过 systemPrompt，则自动套用新类型对应的 prompt
  //    否则保留用户已编辑的内容（避免误覆盖）
  const handleCarpetTypeChange = (next: CarpetType) => {
    if (next === carpetType) return
    setCarpetType(next)
    localStorage.setItem(TITLE_CARPET_TYPE_STORAGE_KEY, next)
    if (!systemPromptDirty) {
      const prompt = carpetPrompts[next]
      if (prompt) {
        setSystemPrompt(prompt)
        // 自动套用的不算用户编辑，保持 dirty=false
        setSystemPromptDirty(false)
      }
    }
  }

  // 把 systemPrompt 重置为"当前地毯类型"的默认模板
  // - 同时清掉 dirty 标记，让用户可以再次通过切换地毯类型来自动切换
  const handleResetSystemPrompt = () => {
    const fallback = carpetPrompts[carpetType] || DEFAULT_CARPET_TITLE_SYSTEM_PROMPT
    setSystemPrompt(fallback)
    setSystemPromptDirty(false)
  }

  // 轮询：把 pending/in_progress 的 TitleTask 拉最新状态
  const clearPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  const startPolling = useCallback(() => {
    clearPolling()
    pollTimer.current = setInterval(async () => {
      setTitleTasks((prev) => {
        const need = prev.filter((t) => t.status === 'pending' || t.status === 'in_progress')
        if (need.length === 0) {
          clearPolling()
          return prev
        }
        // 拉最新：按 source_task_id 过滤最新一组
        void Promise.all(
          need.map((t) =>
            listTitleTasks({ source_task_id: t.source_task_id ?? undefined, pageSize: 1 })
              .then((rows) => rows[0])
              .catch(() => null)
          )
        ).then((updates) => {
          setTitleTasks((curr) => {
            const next = [...curr]
            for (const u of updates) {
              if (!u) continue
              const idx = next.findIndex((x) => x.source_task_id === u.source_task_id)
              if (idx >= 0) {
                next[idx] = u
              }
            }
            return next
          })
        })
        return prev
      })
    }, TITLE_POLL_INTERVAL_MS)
  }, [clearPolling])

  useEffect(() => () => clearPolling(), [clearPolling])

  // 真正的生成逻辑（确认弹窗选「重新生成」或没有已有标题时调用）
  const doGenerate = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const fallbackPrompt = carpetPrompts[carpetType] || DEFAULT_CARPET_TITLE_SYSTEM_PROMPT
      const payload = {
        batch_ids: Array.from(selectedBatchIds),
        carpet_type: carpetType,
        image_index: imageIndex,
        model,
        system_prompt: systemPrompt.trim() || fallbackPrompt,
        max_tokens: maxTokens ? Number(maxTokens) : null,
        temperature: temperature ? Number(temperature) : null,
      }
      const res = await generateTitles(payload)
      setTitleTasks((prev) => {
        const map = new Map<number, TitleTask>()
        for (const t of prev) {
          if (t.source_task_id != null) map.set(t.source_task_id, t)
        }
        for (const t of res.title_tasks) {
          if (t.source_task_id != null) map.set(t.source_task_id, t)
        }
        return Array.from(map.values()).sort((a, b) => b.id - a.id)
      })
      if (res.skipped > 0) {
        const first = res.errors[0]?.reason ?? ''
        setError(`已生成 ${res.created} 条，跳过 ${res.skipped} 条。${first ? '原因：' + first : ''}`)
      }
      startPolling()
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setSubmitting(false)
    }
  }

  // 提交生成：先按 batch_id 查数据库是否有 completed 标题
  // - 有 → 弹 3 选 modal（重新生成 / 展示已有 / 取消）
  // - 没有 → 直接调 doGenerate
  // 注意：按 batch_id 而非 source_task_id 查询，
  // 是因为同一个批次可能之前用别的图位生成过标题，
  // 只要这个批次下任何图位已有标题就应该提示用户
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (selectedBatchIds.size === 0) {
      setError('请先选择至少一个批次')
      return
    }
    if (minImageCount < 1) {
      setError('所选批次中没有可用的已完成图片，请先在对应批次里生成图片')
      return
    }
    if (imageIndex < 1 || imageIndex > minImageCount) {
      setError(`图位必须在 1~${minImageCount} 之间`)
      return
    }

    // 计算本次要生成的 (batch_id, source_task_id) 对
    // - 跳过 images 还没加载好的批次（后端也会跳过，这里提前过滤以减少无效请求）
    const plannedPairs: { batchId: string; sourceTaskId: number }[] = []
    for (const batchId of Array.from(selectedBatchIds)) {
      const imgs = imagesCache[batchId]
      const target = imgs?.[imageIndex - 1]
      if (target) {
        plannedPairs.push({ batchId, sourceTaskId: target.task_id })
      }
    }

    if (plannedPairs.length === 0) {
      setError('本次没有可生成的任务，请检查批次图位')
      return
    }

    const plannedBatchIds = plannedPairs.map((p) => p.batchId)
    const plannedSourceIds = plannedPairs.map((p) => p.sourceTaskId)

    setError(null)
    // 按 batch_id 查这些批次是否已有 completed 标题
    // - 用 batch_ids 一次性 IN 查询，避免按每个 batch_id 单独请求
    // - status='completed' 只关心最终成功的标题，failed/in_progress 不算"已有"
    // - pageSize 给 1000：后端上限 2000，1000 留足余量同时不会一次拉太多
    let existingList: TitleTask[] = []
    try {
      existingList = await listTitleTasks({
        batch_ids: plannedBatchIds,
        status: 'completed',
        pageSize: 1000,
      })
    } catch (err) {
      // 查不到也允许继续生成（不影响主流程）
      existingList = []
      console.warn('查询已有标题失败：', err)
    }

    // 按 batch_id 取最新（id 最大）
    const latestByBatch = new Map<string, TitleTask>()
    for (const t of existingList) {
      if (!t.batch_id) continue
      const cur = latestByBatch.get(t.batch_id)
      if (!cur || t.id > cur.id) latestByBatch.set(t.batch_id, t)
    }
    const existingLatest = Array.from(latestByBatch.values())

    if (existingLatest.length > 0) {
      // 弹确认 modal
      setConfirmDialog({
        existing: existingLatest,
        planned: plannedSourceIds,
        plannedBatchIds: plannedBatchIds,
      })
      return
    }

    // 无已有标题，直接生成
    await doGenerate()
  }

  // Modal 三个选项的处理
  const handleConfirmOverwrite = async () => {
    if (!confirmDialog) return
    setConfirmDialog(null)
    await doGenerate()
  }
  const handleConfirmShowExisting = () => {
    if (!confirmDialog) return
    // 把已有标题塞进 titleTasks，按 source_task_id 合并
    setTitleTasks((prev) => {
      const map = new Map<number, TitleTask>()
      for (const t of prev) {
        if (t.source_task_id != null) map.set(t.source_task_id, t)
      }
      for (const t of confirmDialog.existing) {
        if (t.source_task_id != null) map.set(t.source_task_id, t)
      }
      return Array.from(map.values()).sort((a, b) => b.id - a.id)
    })
    setError(
      `已展示数据库中已有的 ${confirmDialog.existing.length} 条标题（共 ${confirmDialog.planned.length} 个待生成中已存在的部分）`
    )
    setConfirmDialog(null)
  }
  const handleConfirmCancel = () => {
    setConfirmDialog(null)
  }

  // 重新生成单条
  // - 传 carpet_type 让后端用当前选中的地毯类型对应 prompt
  // - 若用户编辑过 systemPrompt，则把当前内容一并传过去覆盖
  const handleRegenerate = async (task: TitleTask) => {
    setError(null)
    try {
      const fallbackPrompt = carpetPrompts[carpetType] || DEFAULT_CARPET_TITLE_SYSTEM_PROMPT
      const updated = await regenerateTitle(task.id, {
        carpet_type: carpetType,
        // dirty=true 时传用户当前编辑的 prompt；否则不传，让后端用 carpet_type 的内置 prompt
        system_prompt: systemPromptDirty
          ? systemPrompt.trim() || fallbackPrompt
          : undefined,
      })
      setTitleTasks((prev) => {
        const map = new Map<number, TitleTask>()
        for (const t of prev) {
          if (t.source_task_id != null) map.set(t.source_task_id, t)
        }
        if (updated.source_task_id != null) map.set(updated.source_task_id, updated)
        return Array.from(map.values()).sort((a, b) => b.id - a.id)
      })
      startPolling()
    } catch (err) {
      setError(err instanceof Error ? err.message : '重新生成失败')
    }
  }

  // 复制单条标题
  const handleCopy = async (task: TitleTask) => {
    if (!task.title) return
    try {
      await navigator.clipboard.writeText(task.title)
      setCopiedId(task.id)
      setTimeout(() => setCopiedId(null), 1500)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = task.title
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopiedId(task.id)
      setTimeout(() => setCopiedId(null), 1500)
    }
  }

  // 删除单条
  const handleDelete = async (task: TitleTask) => {
    if (!window.confirm('确定删除该标题记录？')) return
    try {
      await deleteTitleTask(task.id)
      setTitleTasks((prev) => prev.filter((t) => t.id !== task.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  // 导出 CSV
  // - 默认：导出当前选中的批次；如未选中任何批次则导出全部
  // - 文件格式：{batch_id},{title}（无列头，UTF-8 BOM，逗号/引号自动转义）
  const handleExportCsv = async (mode: 'selected' | 'all') => {
    setExporting(true)
    setError(null)
    try {
      let ids: string[] | null
      if (mode === 'selected') {
        if (selectedBatchIds.size === 0) {
          setError('请先选择要导出的批次')
          return
        }
        ids = Array.from(selectedBatchIds)
      } else {
        ids = null
      }
      await exportTitlesCsv(ids)
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  // 进度统计
  const counts = useMemo(() => {
    let completed = 0
    let failed = 0
    let running = 0
    for (const t of titleTasks) {
      if (t.status === 'completed') completed++
      else if (t.status === 'failed') failed++
      else running++
    }
    return { completed, failed, running, total: titleTasks.length }
  }, [titleTasks])

  const progressPercent = counts.total === 0 ? 0 : Math.round((counts.completed / counts.total) * 100)

  // 选中预览图
  const handlePreview = (url: string) => setPreviewUrl(url)

  // 预警：图数不足 / 完全没图的批次
  const insufficientBatches = batchImageStats.filter((s) => s.count === 0)
  const partialBatches = batchImageStats.filter((s) => s.count > 0 && s.count < imageIndex)

  // 全选按钮文案：根据"当前可见"是否全选中变化
  const visibleIds = filteredBatches.map((b) => b.batch_id)
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedBatchIds.has(id))

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>标题生成</h2>
      <div className="hint" style={{ marginBottom: '1rem' }}>
        从多个已完成批次中各取第 K 张图，调多模态模型生成电商标题。
        每个批次生成 1 个独立请求，支持重新生成、批量导出 CSV。
      </div>

      <form onSubmit={handleSubmit}>
        {/* ---------- 1. 批次选择 ---------- */}
        <div className="form-group">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.25rem',
              gap: '0.5rem',
              flexWrap: 'wrap',
            }}
          >
            <label>
              ① 选择批次（已选 {selectedBatchIds.size} / 共 {batchesTotal}，
              当前可见 {filteredBatches.length}）
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={toggleAllVisible}
                style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
                disabled={filteredBatches.length === 0}
              >
                {allVisibleSelected ? '取消全选（可见）' : '全选（可见）'}
              </button>
              <button
                type="button"
                onClick={() => void loadBatches({ page: 1 })}
                style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
                disabled={batchesLoading}
              >
                {batchesLoading ? '刷新中…' : '刷新'}
              </button>
            </div>
          </div>

          {/* 搜索框 + 加载更多 */}
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              marginBottom: '0.5rem',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <input
              type="text"
              value={batchSearch}
              onChange={(e) => setBatchSearch(e.target.value)}
              placeholder="搜索 batch_id（子串匹配，例：MT0803）"
              style={{
                flex: '1 1 220px',
                minWidth: '180px',
                padding: '0.3rem 0.5rem',
                fontSize: '0.85rem',
              }}
            />
            {batchesPage < batchesTotalPages && (
              <button
                type="button"
                onClick={() => void loadBatches({ append: true })}
                disabled={batchesLoading}
                style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
                title={`已加载 ${batches.length}，还剩 ${batchesTotal - batches.length} 个`}
              >
                {batchesLoading
                  ? '加载中…'
                  : `加载更多（${batchesTotal - batches.length}）`}
              </button>
            )}
            {batchSearch && (
              <button
                type="button"
                onClick={() => setBatchSearch('')}
                style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
              >
                清空搜索
              </button>
            )}
          </div>

          {batchesLoading && batches.length === 0 ? (
            <div className="hint">加载中…</div>
          ) : batchesError ? (
            <div className="error">{batchesError}</div>
          ) : batches.length === 0 ? (
            <div className="hint">暂无任何批次，请先到「批量生成」/「文件夹批量」/「产品替换」创建批次。</div>
          ) : filteredBatches.length === 0 ? (
            <div className="hint">没有匹配「{batchSearch}」的批次。</div>
          ) : (
            <div
              style={{
                maxHeight: `${BATCH_LIST_MAX_HEIGHT}px`,
                overflowY: 'auto',
                border: '1px solid #e5e7eb',
                borderRadius: '6px',
                padding: '0.5rem',
                background: '#fafafa',
              }}
            >
              {filteredBatches.map((b) => (
                <label
                  key={b.batch_id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.25rem 0.5rem',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                    borderRadius: '4px',
                    background: selectedBatchIds.has(b.batch_id) ? '#eff6ff' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedBatchIds.has(b.batch_id)}
                    onChange={() => toggleBatch(b.batch_id)}
                  />
                  <span style={{ fontFamily: 'monospace', flexShrink: 0 }}>{b.batch_id}</span>
                  <span className="hint" style={{ marginLeft: 'auto' }}>
                    {b.completed_count}/{b.task_count} 完成
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* ---------- 2. 图位选择 ---------- */}
        {selectedBatchIds.size > 0 && (
          <div className="form-group">
            <label>② 选择图位（从每个批次中取第 K 张已完成图）</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <input
                type="number"
                min={1}
                max={Math.max(minImageCount, 1)}
                value={imageIndex}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (!Number.isNaN(v) && v >= 1) setImageIndex(v)
                }}
                style={{ width: '80px' }}
                disabled={minImageCount === 0}
              />
              <span className="hint">
                可选范围：1 ~ {minImageCount || 0}
                {imagesLoading && '（加载图片中…）'}
              </span>
            </div>
            {/* 各批次图数：flex-wrap 容器 + chip 样式，避免单行溢出 */}
            {batchImageStats.length > 0 && (
              <div style={{ marginTop: '0.5rem' }}>
                <div className="hint" style={{ marginBottom: '0.25rem' }}>
                  各批次图数（共 {batchImageStats.length} 个，红色 = 图数不足 K）：
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.4rem',
                    maxHeight: '120px',
                    overflowY: 'auto',
                    padding: '0.4rem',
                    background: '#f9fafb',
                    border: '1px solid #f3f4f6',
                    borderRadius: '6px',
                  }}
                >
                  {batchImageStats.map((s) => {
                    const insufficient = s.count < imageIndex
                    return (
                      <span
                        key={s.batchId}
                        title={
                          insufficient
                            ? `该批次只有 ${s.count} 张图，少于图位 ${imageIndex}，将被跳过`
                            : `${s.batchId} 有 ${s.count} 张图`
                        }
                        style={{
                          fontFamily: 'monospace',
                          fontSize: '0.75rem',
                          padding: '0.15rem 0.5rem',
                          background: insufficient ? '#fee2e2' : '#fff',
                          color: insufficient ? '#991b1b' : '#374151',
                          border: `1px solid ${insufficient ? '#fecaca' : '#e5e7eb'}`,
                          borderRadius: '4px',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {s.batchId}:{s.count}
                      </span>
                    )
                  })}
                </div>
              </div>
            )}
            {insufficientBatches.length > 0 && (
              <div className="hint" style={{ color: '#dc2626', marginTop: '0.25rem' }}>
                ⚠ 以下批次暂无已完成图：{insufficientBatches.map((s) => s.batchId).join(', ')}
              </div>
            )}
            {partialBatches.length > 0 && (
              <div className="hint" style={{ color: '#f59e0b', marginTop: '0.25rem' }}>
                ⚠ 以下批次图数不足（将被跳过）：
                {partialBatches.map((s) => `${s.batchId}(${s.count})`).join(', ')}
              </div>
            )}
          </div>
        )}

        {/* ---------- 3. 模型 + 参数 ---------- */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '0.75rem',
          }}
        >
          <div className="form-group">
            <label htmlFor="model">③ 模型</label>
            <select
              id="model"
              value={model}
              onChange={(e) => setModel(e.target.value as TitleModelId)}
            >
              {TITLE_MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.description}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="maxTokens">max_tokens</label>
            <select
              id="maxTokens"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
            >
              {MAX_TOKENS_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="temperature">temperature</label>
            <input
              id="temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
              placeholder="0~2"
            />
          </div>
        </div>

        {/* ---------- 4. 地毯类型（决定使用哪份内置 prompt） ---------- */}
        <div className="form-group">
          <label style={{ marginBottom: '0.4rem', display: 'block' }}>
            ④ 地毯类型
            {promptsLoading && (
              <span className="hint" style={{ marginLeft: '0.5rem' }}>
                （模板加载中…）
              </span>
            )}
            {promptsError && (
              <span
                className="hint"
                style={{ marginLeft: '0.5rem', color: '#dc2626' }}
                title={promptsError}
              >
                ⚠ 模板加载失败，将使用内置默认 prompt
              </span>
            )}
          </label>
          <div
            style={{
              display: 'flex',
              gap: '0.4rem',
              flexWrap: 'wrap',
              padding: '0.4rem 0.5rem',
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: '6px',
            }}
          >
            {CARPET_TYPE_OPTIONS.map((ct) => {
              const checked = carpetType === ct
              const label = carpetLabels[ct] || CARPET_TYPE_FALLBACK_LABELS[ct] || ct
              const hasPrompt = !!carpetPrompts[ct]
              return (
                <label
                  key={ct}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    padding: '0.3rem 0.7rem',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                    borderRadius: '6px',
                    border: `1px solid ${checked ? '#2563eb' : '#e5e7eb'}`,
                    background: checked ? '#eff6ff' : '#fff',
                    color: checked ? '#1d4ed8' : '#374151',
                    fontWeight: checked ? 500 : 400,
                    transition: 'all 0.15s',
                  }}
                  title={
                    hasPrompt
                      ? `使用「${label}」对应的内置 prompt`
                      : `「${label}」模板未加载，将使用内置默认 prompt`
                  }
                >
                  <input
                    type="radio"
                    name="carpetType"
                    value={ct}
                    checked={checked}
                    onChange={() => handleCarpetTypeChange(ct)}
                    style={{ margin: 0 }}
                  />
                  {label}
                </label>
              )
            })}
          </div>
        </div>

        {/* ---------- 5. System Prompt ---------- */}
        <div className="form-group">
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: '0.5rem',
              flexWrap: 'wrap',
              marginBottom: '0.25rem',
            }}
          >
            <label htmlFor="systemPrompt">
              ⑤ System Prompt（可编辑；当前：{carpetLabels[carpetType] || '通用'}）
            </label>
            <span className="hint" style={{ fontSize: '0.75rem' }}>
              {systemPromptDirty ? (
                <span style={{ color: '#d97706' }}>● 已自定义，切换地毯类型不会覆盖</span>
              ) : (
                <span style={{ color: '#16a34a' }}>● 使用「{carpetLabels[carpetType] || '通用'}」内置模板</span>
              )}
            </span>
          </div>
          <textarea
            id="systemPrompt"
            value={systemPrompt}
            onChange={(e) => {
              setSystemPrompt(e.target.value)
              setSystemPromptDirty(true)
            }}
            rows={6}
            style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
            placeholder="留空则使用当前地毯类型对应的内置 prompt"
          />
          <button
            type="button"
            onClick={handleResetSystemPrompt}
            style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem', marginTop: '0.25rem' }}
            title={`把 prompt 重置为「${carpetLabels[carpetType] || '通用'}」内置模板`}
          >
            恢复「{carpetLabels[carpetType] || '通用'}」默认模板
          </button>
        </div>

        {/* ---------- 5. 提交 + 导出 ---------- */}
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="submit"
            disabled={
              submitting || selectedBatchIds.size === 0 || minImageCount === 0
            }
          >
            {submitting ? '创建中…' : `开始生成（${selectedBatchIds.size} 条）`}
          </button>
          <button
            type="button"
            onClick={() => void handleExportCsv('selected')}
            disabled={exporting || selectedBatchIds.size === 0}
            style={{ background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0' }}
            title={
              selectedBatchIds.size === 0
                ? '请先选择要导出的批次'
                : `导出已选 ${selectedBatchIds.size} 个批次的标题`
            }
          >
            {exporting ? '导出中…' : `导出选中批次 CSV（${selectedBatchIds.size}）`}
          </button>
          <button
            type="button"
            onClick={() => void handleExportCsv('all')}
            disabled={exporting}
            style={{ background: '#fff', color: '#374151' }}
            title="导出所有已完成标题"
          >
            导出全部 CSV
          </button>
        </div>
      </form>

      {error && <div className="error" style={{ marginTop: '1rem' }}>{error}</div>}

      {/* ---------- 6. 进度概览 ---------- */}
      {counts.total > 0 && (
        <div style={{ marginTop: '1.5rem' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
              gap: '0.5rem',
              marginBottom: '0.5rem',
            }}
          >
            <Stat label="总数" value={counts.total} />
            <Stat label="已完成" value={counts.completed} color="#16a34a" />
            <Stat label="生成中" value={counts.running} color="#2563eb" />
            <Stat label="失败" value={counts.failed} color="#dc2626" />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>总体进度（{progressPercent}%）</label>
            <ProgressBar progress={progressPercent} color="#2563eb" animated={counts.running > 0} />
          </div>
        </div>
      )}

      {/* ---------- 7. 标题结果列表 ---------- */}
      {titleTasks.length > 0 && (
        <div style={{ marginTop: '1.5rem' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(280px, 1fr) 80px 90px 1fr 220px',
              gap: '0.5rem',
              padding: '0.5rem',
              background: '#f3f4f6',
              borderRadius: '6px 6px 0 0',
              fontSize: '0.8rem',
              fontWeight: 500,
              color: '#374151',
            }}
          >
            <div>批次 / 底图</div>
            <div>源 ID</div>
            <div>模型</div>
            <div>标题</div>
            <div>操作</div>
          </div>
          {titleTasks.map((t) => (
            <TitleRow
              key={t.id}
              task={t}
              onPreview={() => handlePreview(t.source_image_url)}
              onRegenerate={() => handleRegenerate(t)}
              onCopy={() => handleCopy(t)}
              onDelete={() => handleDelete(t)}
              copied={copiedId === t.id}
            />
          ))}
        </div>
      )}

      {/* ---------- 8. 已有标题确认弹窗 ---------- */}
      {confirmDialog && (
        <ConfirmExistingDialog
          existing={confirmDialog.existing}
          plannedTotal={confirmDialog.planned.length}
          onOverwrite={handleConfirmOverwrite}
          onShowExisting={handleConfirmShowExisting}
          onCancel={handleConfirmCancel}
        />
      )}

      <ImagePreview url={previewUrl} onClose={() => setPreviewUrl(null)} />
    </div>
  )
}

// ---------- 确认弹窗子组件 ----------

interface ConfirmExistingDialogProps {
  existing: TitleTask[]
  plannedTotal: number
  onOverwrite: () => void
  onShowExisting: () => void
  onCancel: () => void
}

function ConfirmExistingDialog({
  existing,
  plannedTotal,
  onOverwrite,
  onShowExisting,
  onCancel,
}: ConfirmExistingDialogProps) {
  // 按 batch_id 聚合展示（一个批次可能多张图都有标题）
  const batchToTitles = new Map<string, TitleTask[]>()
  for (const t of existing) {
    const arr = batchToTitles.get(t.batch_id) ?? []
    arr.push(t)
    batchToTitles.set(t.batch_id, arr)
  }
  const batchCount = batchToTitles.size
  const newCount = plannedTotal - existing.length

  // 点击遮罩关闭 = 取消
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCancel()
  }

  return (
    <div
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem',
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: '10px',
          padding: '1.5rem',
          maxWidth: '560px',
          width: '100%',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
        }}
      >
        <h3 style={{ margin: '0 0 0.5rem 0', color: '#dc2626' }}>
          ⚠ 数据库中已有标题
        </h3>
        <p style={{ margin: '0 0 0.75rem 0', color: '#374151' }}>
          本次计划生成 <strong>{plannedTotal}</strong> 条，其中{' '}
          <strong style={{ color: '#dc2626' }}>{existing.length}</strong> 条
          （{batchCount} 个批次）已存在 completed 标题。
          {newCount > 0 && (
            <>另有 <strong style={{ color: '#16a34a' }}>{newCount}</strong> 条将作为新条目创建。</>
          )}
        </p>

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            background: '#f9fafb',
            border: '1px solid #e5e7eb',
            borderRadius: '6px',
            padding: '0.5rem 0.75rem',
            fontSize: '0.85rem',
            marginBottom: '1rem',
          }}
        >
          {Array.from(batchToTitles.entries()).map(([bid, list]) => (
            <div
              key={bid}
              style={{
                borderBottom: '1px solid #e5e7eb',
                padding: '0.4rem 0',
              }}
            >
              <div style={{ fontFamily: 'monospace', color: '#1f2937', fontWeight: 500 }}>
                {bid}（{list.length} 张图已有标题）
              </div>
              {list.map((t) => (
                <div
                  key={t.id}
                  style={{
                    color: '#6b7280',
                    marginTop: '0.2rem',
                    marginLeft: '0.5rem',
                    fontSize: '0.8rem',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={t.title ?? ''}
                >
                  · #{t.source_task_id} [{t.model}]{' '}
                  {t.title ? `：${t.title.slice(0, 60)}${t.title.length > 60 ? '…' : ''}` : ''}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '0.5rem 0.9rem',
              background: '#fff',
              border: '1px solid #d1d5db',
              color: '#374151',
            }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onShowExisting}
            style={{
              padding: '0.5rem 0.9rem',
              background: '#ecfdf5',
              border: '1px solid #a7f3d0',
              color: '#065f46',
            }}
            title="仅展示数据库中已有的标题，不发起新请求"
          >
            展示已有
          </button>
          <button
            type="button"
            onClick={onOverwrite}
            style={{
              padding: '0.5rem 0.9rem',
              background: '#dc2626',
              border: '1px solid #dc2626',
              color: '#fff',
              fontWeight: 500,
            }}
            title="重新生成所有计划条目，已有标题将被新生成的覆盖"
          >
            重新生成（覆盖已有）
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- 子组件 ----------

function TitleRow({
  task,
  onPreview,
  onRegenerate,
  onCopy,
  onDelete,
  copied,
}: {
  task: TitleTask
  onPreview: () => void
  onRegenerate: () => void
  onCopy: () => void
  onDelete: () => void
  copied: boolean
}) {
  const [imgError, setImgError] = useState(false)
  const isPending = task.status === 'pending' || task.status === 'in_progress'
  const isCompleted = task.status === 'completed'
  const isFailed = task.status === 'failed'

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(280px, 1fr) 80px 90px 1fr 220px',
        gap: '0.5rem',
        padding: '0.5rem',
        borderBottom: '1px solid #e5e7eb',
        background: isFailed ? '#fef2f2' : '#fff',
        alignItems: 'center',
        fontSize: '0.85rem',
      }}
    >
      {/* 批次 + 缩略图 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
        {imgError ? (
          <div
            style={{
              width: '48px',
              height: '48px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#fef2f2',
              color: '#991b1b',
              borderRadius: '4px',
              fontSize: '0.7rem',
              flexShrink: 0,
            }}
          >
            加载失败
          </div>
        ) : (
          <img
            src={task.source_image_url}
            alt="底图"
            onClick={onPreview}
            onError={() => setImgError(true)}
            style={{
              width: '48px',
              height: '48px',
              objectFit: 'cover',
              borderRadius: '4px',
              cursor: 'pointer',
              border: '1px solid #e5e7eb',
              flexShrink: 0,
            }}
          />
        )}
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={task.batch_id}
          >
            {task.batch_id}
          </div>
          {task.regenerated_count > 0 && (
            <div className="hint" style={{ fontSize: '0.7rem' }}>
              重新生成 ×{task.regenerated_count}
            </div>
          )}
        </div>
      </div>

      {/* 源任务 ID（用于追溯） */}
      <div style={{ fontFamily: 'monospace', color: '#6b7280' }}>
        #{task.source_task_id ?? '-'}
      </div>

      {/* 模型 + 状态 */}
      <div>
        <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>{task.model}</div>
        <div
          style={{
            fontSize: '0.75rem',
            color: statusColor[task.status] || '#6b7280',
            fontWeight: 500,
          }}
        >
          {statusText[task.status] || task.status}
        </div>
      </div>

      {/* 标题 */}
      <div style={{ minWidth: 0 }}>
        {isPending && <TitleSkeleton />}
        {isCompleted && task.title && (
          <div
            style={{
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              wordBreak: 'break-word',
            }}
            title={task.title}
          >
            {task.title}
          </div>
        )}
        {isFailed && (
          <div style={{ color: '#dc2626', fontSize: '0.8rem' }} title={task.error_msg || ''}>
            {task.error_msg || '生成失败'}
          </div>
        )}
      </div>

      {/* 操作 */}
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {isCompleted && (
          <button
            type="button"
            onClick={onCopy}
            style={{ padding: '0.3rem 0.5rem', fontSize: '0.75rem' }}
            title="复制标题"
          >
            {copied ? '已复制' : '复制'}
          </button>
        )}
        <button
          type="button"
          onClick={onRegenerate}
          disabled={isPending}
          style={{
            padding: '0.3rem 0.5rem',
            fontSize: '0.75rem',
            background: '#fff7ed',
            color: isPending ? '#9ca3af' : '#9a3412',
            border: `1px solid ${isPending ? '#e5e7eb' : '#fed7aa'}`,
          }}
          title="使用相同模型与 prompt 重新生成"
        >
          重新生成
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={isPending}
          style={{
            padding: '0.3rem 0.5rem',
            fontSize: '0.75rem',
            background: '#fee2e2',
            color: isPending ? '#9ca3af' : '#991b1b',
          }}
        >
          删除
        </button>
      </div>
    </div>
  )
}

function TitleSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <div
        style={{
          height: '0.9rem',
          background: 'linear-gradient(90deg, #e5e7eb 0%, #f3f4f6 50%, #e5e7eb 100%)',
          backgroundSize: '200% 100%',
          borderRadius: '4px',
          animation: 'shimmer 1.5s infinite',
          width: '90%',
        }}
      />
      <div
        style={{
          height: '0.9rem',
          background: 'linear-gradient(90deg, #e5e7eb 0%, #f3f4f6 50%, #e5e7eb 100%)',
          backgroundSize: '200% 100%',
          borderRadius: '4px',
          animation: 'shimmer 1.5s infinite',
          width: '60%',
        }}
      />
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

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
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
