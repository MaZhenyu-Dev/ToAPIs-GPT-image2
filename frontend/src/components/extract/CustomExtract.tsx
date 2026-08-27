import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  downloadImage,
  extractGenerate,
  extractHistory,
  taskRecomputeCrop,
  taskSetCropConfig,
} from '../../api'
import {
  DEFAULT_CROP_THRESHOLD,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_RESOLUTION,
  DEFAULT_SIZE,
  EXTREME_RATIO_MODEL,
  EXTREME_SIZES,
} from '../../constants'
import { useBatchPolling } from '../../hooks/useBatchPolling'
import { useBatchPrefix } from '../../hooks/useBatchPrefix'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { triggerDownload } from '../../lib/batchDownloads'
import { formatCropSummary } from '../../lib/cropFormat'
import type {
  BatchStatusResponse,
  CropMeta,
  ErpExtractUnit,
  ExtractHistoryItem,
  GenerationTaskItem,
  ImageModelId,
  ImageQuality,
} from '../../types'
import ComparePreview from './ComparePreview'
import CropToggle from './CropToggle'
import ExtractPromptSelector from './ExtractPromptSelector'
import FadeInImage from '../ui/FadeInImage'
import GlassButton from '../ui/GlassButton'
import ImageUploader from '../ImageUploader'
import ModelSelector from './ModelSelector'
import PageHeader from '../ui/PageHeader'
import ParameterSelector from '../ParameterSelector'
import RegenerateDialog from '../batch/RegenerateDialog'
import { useToast } from '../ui/Toast'
import { IconZoomIn } from '../ui/Icon'

const STATUS_TEXT: Record<string, string> = {
  pending: '待提交',
  queued: '排队中',
  in_progress: '生成中',
  completed: '已完成',
  failed: '生成失败',
}

/** 把历史任务/当前任务构造成 ComparePreview 需要的单元形状 */
function toPreviewUnit(
  input: string | null,
  result: string | null,
  goodsSn: string,
  size: string,
  batchId: string,
  taskId: number,
  status: string,
  createdAt: string | null,
  crop?: {
    enabled: boolean
    threshold: number
    imageUrl: string | null
    meta: CropMeta | null
  }
): ErpExtractUnit {
  return {
    unit_key: `${batchId}-${taskId}`,
    supplier_id: 0,
    store_name: '',
    goods_sn: goodsSn,
    order_item_ids: [],
    representative_order_item_id: taskId,
    input_image_url: input ?? '',
    factory_image_url: null,
    size,
    material: null,
    mapped_ratio: size,
    batch_id: batchId,
    generation_task_id: taskId,
    status: status as ErpExtractUnit['status'],
    result_image_url: result,
    error_msg: null,
    created_at: createdAt,
    erp_uploaded_at: null,
    progress: 0,
    crop_enabled: crop?.enabled ?? false,
    crop_threshold: crop?.threshold ?? DEFAULT_CROP_THRESHOLD,
    crop_image_url: crop?.imageUrl ?? null,
    crop_meta: crop?.meta ?? null,
  }
}

/** 从任务/历史项提取裁剪字段（ComparePreview 与摘要展示共用） */
function cropOf(task: GenerationTaskItem | ExtractHistoryItem): {
  enabled: boolean
  threshold: number
  imageUrl: string | null
  meta: CropMeta | null
} {
  return {
    enabled: task.crop_enabled ?? false,
    threshold: task.crop_threshold ?? DEFAULT_CROP_THRESHOLD,
    imageUrl: task.crop_image_url ?? null,
    meta: task.crop_meta ?? null,
  }
}

/** 用户自定义：手动传图 + 参数 → 生成产品图，后续下载/上传由用户自行处理 */
export default function CustomExtract() {
  const toast = useToast()
  const isOnline = useOnlineStatus()

  const [images, setImages] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<ImageModelId>(DEFAULT_IMAGE_MODEL)
  const [quality, setQuality] = useState<ImageQuality | undefined>(undefined)
  const [size, setSize] = useState(DEFAULT_SIZE)
  const [resolution, setResolution] = useState(DEFAULT_RESOLUTION)
  const { prefix, handlePrefixChange, isPrefixValid, previewBatchId } = useBatchPrefix()

  const [submitting, setSubmitting] = useState(false)
  const [batch, setBatch] = useState<BatchStatusResponse | null>(null)
  const [regenerateTarget, setRegenerateTarget] = useState<GenerationTaskItem | null>(null)
  const [regeneratingTaskId, setRegeneratingTaskId] = useState<number | null>(null)
  const [previewUnit, setPreviewUnit] = useState<ErpExtractUnit | null>(null)

  // ---------- 白边裁剪（表单统一配置 + 任务级切换/补算） ----------
  const [cropEnabled, setCropEnabled] = useState(true)
  const [cropThreshold, setCropThreshold] = useState(DEFAULT_CROP_THRESHOLD)
  const [cropSavingTaskId, setCropSavingTaskId] = useState<number | null>(null)

  // ---------- 视图切换（当前生成 / 生成历史） ----------
  const [view, setView] = useState<'current' | 'history'>('current')
  const [historyItems, setHistoryItems] = useState<ExtractHistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const result = await extractHistory(50)
      setHistoryItems(result.items)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载生成历史失败')
    } finally {
      setHistoryLoading(false)
    }
  }, [toast])

  useEffect(() => {
    if (view === 'history') {
      void loadHistory()
    }
  }, [view, loadHistory])

  const { fetchOnce, startPolling, clearPolling } = useBatchPolling({
    intervalMs: 3000,
    onSuccess: (status) => setBatch(status),
  })

  const canSubmit =
    isOnline &&
    !submitting &&
    images.length > 0 &&
    prompt.trim().length > 0 &&
    isPrefixValid

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    clearPolling()
    try {
      const response = await extractGenerate({
        image_urls: images,
        prompt: prompt.trim(),
        size,
        resolution,
        prefix,
        model,
        ...(quality ? { quality } : {}),
        crop_enabled: cropEnabled,
        crop_threshold: cropThreshold,
      })
      const status = await fetchOnce(response.batch_id)
      if (status) setBatch(status)
      startPolling(response.batch_id)
      toast.success(`已创建批次 ${response.batch_id}，共 ${response.task_count} 个任务`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建生成任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  // 任务级裁剪配置：开关/阈值修改 → 保存 + 补算 + 刷新当前批次/历史
  const handleTaskCropConfig = async (
    taskId: number,
    enabled: boolean,
    threshold: number
  ) => {
    setCropSavingTaskId(taskId)
    try {
      const res = await taskSetCropConfig(taskId, enabled, threshold)
      if (enabled && !res.crop_image_url) {
        try {
          await taskRecomputeCrop(taskId)
        } catch {
          /* 补算失败静默：刷新后显示裁剪失败状态 */
        }
      }
      if (view === 'current' && batch) {
        const status = await fetchOnce(batch.batch_id)
        if (status) setBatch(status)
      } else {
        await loadHistory()
      }
      toast.success(
        enabled
          ? `已开启白边裁剪（阈值 ${threshold}）`
          : '已关闭白边裁剪'
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存裁剪配置失败')
    } finally {
      setCropSavingTaskId(null)
    }
  }

  // 任务与输入图按 id 顺序一一对应（创建顺序 = 上传顺序）
  const orderedTasks = useMemo(() => {
    if (!batch) return []
    return [...batch.tasks].sort((a, b) => a.id - b.id)
  }, [batch])

  const handleRegenerateConfirm = async (
    newModel: ImageModelId,
    newQuality: ImageQuality | undefined,
    newSize?: string,
    newResolution?: string
  ) => {
    if (!batch || !regenerateTarget) return
    setRegeneratingTaskId(regenerateTarget.id)
    setRegenerateTarget(null)
    try {
      await extractRegenerate(
        batch.batch_id,
        regenerateTarget.id,
        newModel,
        newQuality,
        newSize,
        newResolution,
        prompt.trim()
      )
      const status = await fetchOnce(batch.batch_id)
      if (status) setBatch(status)
      startPolling(batch.batch_id)
      toast.info('已重新提交，等待生成结果')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重新生成失败')
    } finally {
      setRegeneratingTaskId(null)
    }
  }

  const handleDownload = async (task: GenerationTaskItem, index: number) => {
    if (!task.image_url) return
    try {
      const blob = await downloadImage(task.image_url)
      triggerDownload(blob, `extract_${index + 1}.png`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '下载失败')
    }
  }

  const completedTasks = orderedTasks.filter((t) => t.status === 'completed')

  return (
    <>
      <PageHeader
        title="用户自定义"
        description="手动上传产品图 → 设置参数生成 → 结果由你自行下载 / 上传到任意平台。"
      />

      {/* 视图切换 */}
      <div
        role="tablist"
        aria-label="用户自定义视图"
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: 'var(--space-4)',
          padding: '0.25rem',
          background: 'var(--glass-1-bg)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--glass-border)',
          width: 'fit-content',
        }}
      >
        {(
          [
            { key: 'current', label: '当前生成', hint: '上传图片并生成' },
            { key: 'history', label: '生成历史', hint: '本地持久化记录（按时间倒序）' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={view === tab.key}
            title={tab.hint}
            onClick={() => setView(tab.key)}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: 'var(--radius-sm)',
              border: 'none',
              cursor: 'pointer',
              background: view === tab.key ? 'var(--accent)' : 'transparent',
              color: view === tab.key ? '#fff' : 'var(--text-2)',
              fontWeight: 600,
              fontSize: '0.9rem',
              transition: 'background var(--dur), color var(--dur)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {view === 'current' && (
        <>
          <form onSubmit={handleSubmit}>
            <ImageUploader urls={images} onChange={setImages} disabled={submitting} />

            <div className="form-group">
              <label htmlFor="custom-prompt">Prompt（所有图片共用）</label>
              <ExtractPromptSelector value={prompt} onChange={setPrompt} disabled={submitting} />
              <textarea
                id="custom-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="描述如何根据参考图生成干净的产品图..."
                rows={8}
                required
                disabled={submitting}
                style={{ marginTop: '0.5rem' }}
              />
            </div>

            <ModelSelector
              model={model}
              quality={quality}
              onChange={({ model: m, quality: q }) => {
                setModel(m)
                setQuality(q)
              }}
              disabled={submitting}
            />

            <ParameterSelector
              size={size}
              resolution={resolution}
              onChange={({ size: s, resolution: r }) => {
                setSize(s)
                setResolution(r)
                // 极端宽高比只有 gemini 模型支持：自动切换并提示
                if (EXTREME_SIZES.has(s) && model !== EXTREME_RATIO_MODEL) {
                  setModel(EXTREME_RATIO_MODEL as ImageModelId)
                  setQuality(undefined)
                  toast.info(`比例 ${s} 为极端宽高比，已自动切换为 Gemini 模型`)
                }
              }}
            />

            <div className="form-group">
              <label>白边裁剪（生成时自动裁掉纯白边，可随时在结果卡上开关）</label>
              <CropToggle
                enabled={cropEnabled}
                threshold={cropThreshold}
                onSave={(enabled, threshold) => {
                  setCropEnabled(enabled)
                  setCropThreshold(threshold)
                }}
              />
              <div className="hint">
                默认开启；像素与纯白欧氏距离 ≤ 阈值即视为白边，阈值越大越激进
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="custom-prefix">批次号前缀</label>
              <input
                id="custom-prefix"
                type="text"
                value={prefix}
                onChange={(e) => handlePrefixChange(e.target.value)}
                maxLength={10}
                placeholder="MZY"
                disabled={submitting}
                style={{
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                  ...(isPrefixValid ? {} : { borderColor: 'var(--danger)' }),
                }}
              />
              <div className="hint">
                格式：
                <code style={{ fontFamily: 'var(--font-mono)' }}>{prefix || '???'}</code>
                <code style={{ fontFamily: 'var(--font-mono)' }}>????</code>
                <code style={{ fontFamily: 'var(--font-mono)' }}>??</code>
                {isPrefixValid && !batch && (
                  <>
                    {' · 下个 ID 预览：'}
                    <code style={{ fontFamily: 'var(--font-mono)' }}>{previewBatchId}</code>
                  </>
                )}
              </div>
            </div>

            <div className="config-actions">
              <GlassButton type="submit" variant="primary" loading={submitting} disabled={!canSubmit}>
                {images.length === 0
                  ? '请先上传图片'
                  : `为 ${images.length} 张图片生成 ${images.length} 张产品图`}
              </GlassButton>
            </div>
          </form>

          {batch && (
            <div style={{ marginTop: 'var(--space-5)' }}>
              <div style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0 }}>
                  生成进度 · <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>{batch.batch_id}</span>
                </h3>
                <span className="hint">
                  已完成 {batch.completed}/{batch.total} · 失败 {batch.failed}
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                {orderedTasks.map((task, index) => {
                  const inputUrl = images[index] ?? null
                  const isCompleted = task.status === 'completed'
                  const isFailed = task.status === 'failed'
                  const crop = cropOf(task)
                  const displayResultUrl =
                    crop.enabled && crop.imageUrl
                      ? crop.imageUrl
                      : task.image_url
                  return (
                    <div
                      key={task.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1fr) auto',
                        gap: 'var(--space-4)',
                        alignItems: 'center',
                        padding: '0.85rem',
                        background: isFailed ? 'var(--danger-soft)' : 'var(--glass-1-bg)',
                        border: '1px solid var(--glass-border)',
                        borderRadius: 'var(--radius-md)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', minWidth: 0 }}>
                        <CustomThumb
                          url={inputUrl}
                          label={`输入 ${index + 1}`}
                          onClick={() =>
                            setPreviewUnit(
                              toPreviewUnit(
                                inputUrl,
                                displayResultUrl,
                                `#${index + 1}`,
                                task.size,
                                task.batch_id,
                                task.id,
                                task.status,
                                task.created_at,
                                crop
                              )
                            )
                          }
                        />
                        <CustomThumb
                          url={displayResultUrl}
                          label={`结果 ${index + 1}`}
                          onClick={() =>
                            setPreviewUnit(
                              toPreviewUnit(
                                inputUrl,
                                displayResultUrl,
                                `#${index + 1}`,
                                task.size,
                                task.batch_id,
                                task.id,
                                task.status,
                                task.created_at,
                                crop
                              )
                            )
                          }
                          loading={
                            task.status === 'in_progress' || task.status === 'queued'
                          }
                          progress={task.progress}
                        />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-3)' }}>
                              {task.batch_id}
                            </code>
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-3)' }}>
                              {task.size} · {task.resolution}
                            </span>
                          </div>
                          <div style={{ marginTop: '0.3rem' }}>
                            <span style={{ fontSize: '0.82rem', color: 'var(--text-2)' }}>
                              {isCompleted
                                ? '已完成'
                                : isFailed
                                  ? task.error_msg?.slice(0, 60) || '生成失败'
                                  : `${STATUS_TEXT[task.status] ?? task.status} · ${task.progress}%`}
                            </span>
                          </div>
                          {isCompleted && (
                            <div style={{ marginTop: '0.3rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                              <CropToggle
                                enabled={crop.enabled}
                                threshold={crop.threshold}
                                saving={cropSavingTaskId === task.id}
                                onSave={(enabled, threshold) =>
                                  void handleTaskCropConfig(task.id, enabled, threshold)
                                }
                              />
                              {crop.enabled && crop.meta && !crop.meta.error && (
                                <span className="hint">{formatCropSummary(crop.meta)}</span>
                              )}
                              {crop.enabled && crop.meta?.error && (
                                <span className="hint" style={{ color: 'var(--danger)' }} title={crop.meta.error}>
                                  裁剪失败，显示原图
                                </span>
                              )}
                              {crop.enabled && !crop.meta && (
                                <span className="hint" style={{ color: 'var(--warning)' }}>
                                  裁剪计算中…
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', alignItems: 'stretch' }}>
                        {(inputUrl || task.image_url) && (
                          <GlassButton
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              setPreviewUnit(
                                toPreviewUnit(
                                  inputUrl,
                                  displayResultUrl,
                                  `#${index + 1}`,
                                  task.size,
                                  task.batch_id,
                                  task.id,
                                  task.status,
                                  task.created_at,
                                  crop
                                )
                              )
                            }
                          >
                            对比预览
                          </GlassButton>
                        )}
                        {isCompleted && (
                          <GlassButton
                            size="sm"
                            variant="secondary"
                            onClick={() => void handleDownload(task, index)}
                          >
                            下载
                          </GlassButton>
                        )}
                        {(isCompleted || isFailed) && (
                          <GlassButton
                            size="sm"
                            variant="ghost"
                            loading={regeneratingTaskId === task.id}
                            onClick={() => setRegenerateTarget(task)}
                          >
                            重新生成
                          </GlassButton>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              {completedTasks.length > 0 && (
                <div style={{ marginTop: '0.75rem' }}>
                  <GlassButton
                    variant="secondary"
                    onClick={async () => {
                      try {
                        for (let i = 0; i < completedTasks.length; i++) {
                          const task = completedTasks[i]
                          if (!task.image_url) continue
                          const blob = await downloadImage(task.image_url)
                          triggerDownload(blob, `extract_${i + 1}.png`)
                        }
                        toast.success(`已下载 ${completedTasks.length} 张图片`)
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : '批量下载失败')
                      }
                    }}
                  >
                    下载全部 ({completedTasks.length})
                  </GlassButton>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* 生成历史 */}
      {view === 'history' && (
        <div>
          <div style={{ marginBottom: '0.75rem' }}>
            <span className="hint">共 {historyItems.length} 条记录（本地持久化，可随时找回）</span>
          </div>
          {historyLoading ? (
            <div className="hint" style={{ padding: '1rem 0', textAlign: 'center' }}>
              加载生成历史...
            </div>
          ) : historyItems.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">暂无生成历史</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {historyItems.map((item) => {
                const isCompleted = item.status === 'completed'
                const isFailed = item.status === 'failed'
                const crop = cropOf(item)
                const displayResultUrl =
                  crop.enabled && crop.imageUrl
                    ? crop.imageUrl
                    : item.result_image_url
                return (
                  <div
                    key={item.task_id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) auto',
                      gap: 'var(--space-4)',
                      alignItems: 'center',
                      padding: '0.85rem',
                      background: isFailed ? 'var(--danger-soft)' : 'var(--glass-1-bg)',
                      border: '1px solid var(--glass-border)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', minWidth: 0 }}>
                      <CustomThumb
                        url={item.input_image_url}
                        label="输入图"
                        onClick={() =>
                          setPreviewUnit(
                            toPreviewUnit(
                              item.input_image_url,
                              displayResultUrl,
                              item.batch_id,
                              item.size,
                              item.batch_id,
                              item.task_id,
                              item.status,
                              item.created_at,
                              crop
                            )
                          )
                        }
                      />
                      <CustomThumb
                        url={displayResultUrl}
                        label="生成图"
                        onClick={() =>
                          setPreviewUnit(
                            toPreviewUnit(
                              item.input_image_url,
                              displayResultUrl,
                              item.batch_id,
                              item.size,
                              item.batch_id,
                              item.task_id,
                              item.status,
                              item.created_at,
                              crop
                            )
                          )
                        }
                      />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-3)' }}>
                            {item.batch_id}
                          </code>
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-3)' }}>
                            {item.size} · {item.resolution} · {item.model}
                          </span>
                        </div>
                        <div style={{ marginTop: '0.3rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '0.82rem', color: 'var(--text-2)' }}>
                            {isCompleted
                              ? '已完成'
                              : isFailed
                                ? item.error_msg?.slice(0, 60) || '生成失败'
                                : STATUS_TEXT[item.status] ?? item.status}
                          </span>
                          <span className="hint" style={{ fontSize: '0.72rem' }}>
                            {new Date(item.created_at).toLocaleString()}
                          </span>
                        </div>
                        {isCompleted && (
                          <div style={{ marginTop: '0.3rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <CropToggle
                              enabled={crop.enabled}
                              threshold={crop.threshold}
                              saving={cropSavingTaskId === item.task_id}
                              onSave={(enabled, threshold) =>
                                void handleTaskCropConfig(item.task_id, enabled, threshold)
                              }
                            />
                            {crop.enabled && crop.meta && !crop.meta.error && (
                              <span className="hint">{formatCropSummary(crop.meta)}</span>
                            )}
                            {crop.enabled && crop.meta?.error && (
                              <span className="hint" style={{ color: 'var(--danger)' }} title={crop.meta.error}>
                                裁剪失败，显示原图
                              </span>
                            )}
                            {crop.enabled && !crop.meta && (
                              <span className="hint" style={{ color: 'var(--warning)' }}>
                                裁剪计算中…
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', alignItems: 'stretch' }}>
                      {(item.input_image_url || item.result_image_url) && (
                        <GlassButton
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            setPreviewUnit(
                              toPreviewUnit(
                                item.input_image_url,
                                displayResultUrl,
                                item.batch_id,
                                item.size,
                                item.batch_id,
                                item.task_id,
                                item.status,
                                item.created_at,
                                crop
                              )
                            )
                          }
                        >
                          对比预览
                        </GlassButton>
                      )}
                      {isCompleted && item.result_image_url && (
                        <GlassButton
                          size="sm"
                          variant="secondary"
                          onClick={async () => {
                            try {
                              const blob = await downloadImage(item.result_image_url as string)
                              triggerDownload(blob, `extract_${item.task_id}.png`)
                            } catch (err) {
                              toast.error(err instanceof Error ? err.message : '下载失败')
                            }
                          }}
                        >
                          下载
                        </GlassButton>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <RegenerateDialog
        task={regenerateTarget}
        onConfirm={(m, q, s, r) => void handleRegenerateConfirm(m, q, s, r)}
        onClose={() => setRegenerateTarget(null)}
        showSizeResolution
      />

      <ComparePreview unit={previewUnit} onClose={() => setPreviewUnit(null)} />
    </>
  )
}

/** 重新生成单个任务（复用现有批次 regenerate 端点，支持尺寸/分辨率/prompt 覆盖） */
async function extractRegenerate(
  batchId: string,
  taskId: number,
  model: ImageModelId,
  quality: ImageQuality | undefined,
  size?: string,
  resolution?: string,
  prompt?: string
) {
  const response = await fetch(`/api/batches/${encodeURIComponent(batchId)}/tasks/${taskId}/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      ...(quality ? { quality } : {}),
      ...(size && resolution ? { size, resolution } : {}),
      ...(prompt ? { prompt } : {}),
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = (data as { detail?: unknown }).detail
    throw new Error(typeof detail === 'string' ? detail : `重新生成失败: HTTP ${response.status}`)
  }
  return data as GenerationTaskItem
}

function CustomThumb({
  url,
  label,
  onClick,
  loading = false,
  progress = 0,
}: {
  url: string | null
  label: string
  onClick: () => void
  loading?: boolean
  progress?: number
}) {
  const pct = Math.max(0, Math.min(100, progress))
  return (
    <div style={{ textAlign: 'center', flexShrink: 0 }}>
      <div
        role="button"
        tabIndex={0}
        aria-label={`${label}（点击放大预览）`}
        onClick={() => url && onClick()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (url) onClick()
          }
        }}
        style={{
          width: '132px',
          height: '132px',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--glass-1-bg)',
          borderRadius: 'var(--radius-md)',
          border: `1.5px solid ${loading ? 'var(--accent-soft)' : url ? 'var(--glass-border)' : 'var(--input-border)'}`,
          overflow: 'hidden',
          cursor: url ? 'zoom-in' : 'default',
        }}
      >
        {loading ? (
          <div
            className="skeleton"
            style={{
              width: '100%',
              height: '100%',
              borderRadius: 0,
              display: 'grid',
              placeItems: 'center',
              position: 'relative',
            }}
          >
            <div
              style={{
                color: 'var(--text-1)',
                fontSize: '1.05rem',
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: '14px',
                  height: '14px',
                  borderRadius: '50%',
                  border: '2px solid var(--text-2)',
                  borderTopColor: 'transparent',
                  animation: 'spin 0.8s linear infinite',
                }}
              />
              {pct > 0 ? `${pct}%` : '生成中'}
            </div>
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: '3px',
                background: 'rgba(255,255,255,0.1)',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${pct}%`,
                  background: 'var(--accent)',
                  transition: 'width 0.6s var(--ease-glass)',
                }}
              />
            </div>
          </div>
        ) : url ? (
          <FadeInImage
            src={url}
            alt={label}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <div style={{ color: 'var(--text-3)', fontSize: '0.8rem' }}>无图</div>
        )}
      </div>
      <div
        className="hint"
        style={{
          marginTop: '0.3rem',
          fontSize: '0.72rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.2rem',
        }}
      >
        {label}
        {url && !loading && <IconZoomIn width={11} height={11} />}
      </div>
    </div>
  )
}
