import { useCallback, useRef, useState } from 'react'
import JSZip from 'jszip'
import {
  deleteBatch,
  generateProductSwap,
  regenerateTask,
  retryBatch,
  downloadImage as downloadImageBlob,
  uploadImage,
} from '../api'
import {
  DEFAULT_RESOLUTION,
  DEFAULT_SIZE,
  getModelDisplayName,
  MAX_PRODUCT_SWAP_COUNT,
  MIN_PRODUCT_SWAP_COUNT,
} from '../constants'
import { useBatchPolling } from '../hooks/useBatchPolling'
import { useBatchPrefix } from '../hooks/useBatchPrefix'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { triggerDownload, sizeToAspectRatio } from '../lib/batchDownloads'
import {
  isFsAccessSupported,
  pickDirectory,
  saveTasksToDirectory,
} from '../lib/fsDownload'
import type {
  BatchStatusResponse,
  GenerationTaskItem,
  ImageModelId,
  ImageQuality,
} from '../types'
import { useConfirm } from './ui/ConfirmDialog'
import FadeInImage from './ui/FadeInImage'
import GlassButton from './ui/GlassButton'
import GlassCard from './ui/GlassCard'
import ImageUploader from './ImageUploader'
import Lightbox from './ui/Lightbox'
import type { LightboxItem } from './ui/Lightbox'
import PageHeader from './ui/PageHeader'
import ParameterSelector from './ParameterSelector'
import ProgressBar from './ui/ProgressBar'
import ProductThumbnailList, { type ProductItem } from './ProductThumbnailList'
import RegenerateDialog from './batch/RegenerateDialog'
import StatCard from './ui/StatCard'
import { useToast } from './ui/Toast'
import { IconRefresh } from './ui/Icon'

const POLL_INTERVAL_MS = 3000

const STATUS_TEXT: Record<string, string> = {
  pending: '待提交',
  queued: '排队中',
  in_progress: '生成中',
  completed: '已完成',
  failed: '生成失败',
}

export default function ProductSwapper() {
  const toast = useToast()
  const confirm = useConfirm()

  const [templateUrls, setTemplateUrls] = useState<string[]>([])
  const [products, setProducts] = useState<ProductItem[]>([])

  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState(DEFAULT_SIZE)
  const [resolution, setResolution] = useState(DEFAULT_RESOLUTION)
  const { prefix, handlePrefixChange, isPrefixValid, previewBatchId } = useBatchPrefix()

  const templateUrl = templateUrls[0] || ''
  const templateInProducts =
    !!templateUrl && products.some((p) => p.url === templateUrl)

  const [batch, setBatch] = useState<BatchStatusResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [regeneratingTaskId, setRegeneratingTaskId] = useState<number | null>(null)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)

  const [dirDownloading, setDirDownloading] = useState(false)
  const [dirProgress, setDirProgress] = useState<
    { done: number; total: number; current: number } | null
  >(null)

  const isOnline = useOnlineStatus()

  const { fetchOnce, startPolling, clearPolling } = useBatchPolling({
    intervalMs: POLL_INTERVAL_MS,
    onSuccess: (status) => setBatch(status),
  })

  const canSubmit =
    isOnline &&
    !loading &&
    !!templateUrl &&
    products.length >= MIN_PRODUCT_SWAP_COUNT &&
    products.length <= MAX_PRODUCT_SWAP_COUNT &&
    !!prompt.trim() &&
    isPrefixValid &&
    !templateInProducts

  // ---------- 提交流程 ----------
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return

    setLoading(true)
    clearPolling()
    try {
      const response = await generateProductSwap({
        template_image_url: templateUrl,
        product_image_urls: products.map((p) => p.url),
        prompt: prompt.trim(),
        size,
        resolution,
        prefix,
      })
      const status = await fetchOnce(response.batch_id)
      if (status) {
        setBatch(status)
        startPolling(response.batch_id)
      }
      toast.success(`已创建批次 ${response.batch_id}，共 ${response.task_count} 个任务`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '产品替换生成失败')
    } finally {
      setLoading(false)
    }
  }

  const handleRetry = async () => {
    if (!batch) return
    const ok = await confirm({
      title: '重试失败任务',
      message: `将重试该批次中 ${batch.failed} 个失败任务，确定继续吗？`,
      confirmLabel: '开始重试',
      tone: 'primary',
    })
    if (!ok) return
    try {
      const response = await retryBatch(batch.batch_id)
      const status = await fetchOnce(response.batch_id)
      if (status) {
        setBatch(status)
        startPolling(response.batch_id)
      }
      toast.success('已重新提交失败任务')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重试失败')
    }
  }

  // 重新生成：先弹模型/精度选择，确认后再提交（尺寸/分辨率沿用原配置）
  const [regenerateTarget, setRegenerateTarget] = useState<GenerationTaskItem | null>(null)

  const handleRegenerateTask = (task: GenerationTaskItem) => {
    setRegenerateTarget(task)
  }

  const handleRegenerateConfirm = async (
    model: ImageModelId,
    quality: ImageQuality | undefined
  ) => {
    if (!batch || !regenerateTarget) return
    setRegeneratingTaskId(regenerateTarget.id)
    setRegenerateTarget(null)
    try {
      await regenerateTask(batch.batch_id, regenerateTarget.id, {
        model,
        ...(quality ? { quality } : {}),
      })
      const status = await fetchOnce(batch.batch_id)
      if (status) {
        setBatch(status)
        startPolling(batch.batch_id)
      }
      toast.info(
        `已用 ${model}${quality ? `（精度 ${quality}）` : ''} 重新提交，等待生成结果`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重新生成失败')
    } finally {
      setRegeneratingTaskId(null)
    }
  }

  const handleDeleteBatch = async () => {
    if (!batch) return
    const ok = await confirm({
      title: '删除批次',
      message: `确定要删除批次 ${batch.batch_id} 及其所有任务吗？此操作不可恢复。`,
      confirmLabel: '删除',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await deleteBatch(batch.batch_id)
      setBatch(null)
      toast.success(`批次 ${batch.batch_id} 已删除`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  // ---------- 模板图处理 ----------
  const [templateUploadError, setTemplateUploadError] = useState<string | null>(null)
  const [templateUploading, setTemplateUploading] = useState(false)
  const templateInputRef = useRef<HTMLInputElement>(null)

  const handleProductsUploaded = useCallback(
    (urls: string[], _names?: string[]) => {
      setProducts((prev) => {
        const existing = new Set(prev.map((p) => p.url))
        const incoming: ProductItem[] = urls
          .filter((u) => !existing.has(u))
          .map((u) => ({ url: u }))
        const merged = [...prev, ...incoming].slice(0, MAX_PRODUCT_SWAP_COUNT)
        return merged
      })
    },
    []
  )

  const handleTemplateFile = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      setTemplateUploading(true)
      setTemplateUploadError(null)
      try {
        const file = files[0]
        if (!file.type.startsWith('image/')) {
          setTemplateUploadError('请选择图片文件')
          return
        }
        const res = await uploadImage(file)
        setTemplateUrls([res.url])
      } catch (err) {
        setTemplateUploadError(err instanceof Error ? err.message : '上传失败')
      } finally {
        setTemplateUploading(false)
        if (templateInputRef.current) templateInputRef.current.value = ''
      }
    },
    []
  )

  // 派生数据：按上传顺序的 N 个任务
  const productTasks: GenerationTaskItem[] = (() => {
    if (!batch) return []
    const urlToIndex = new Map(products.map((p, i) => [p.url, i]))
    return [...batch.tasks].sort((a, b) => {
      const ai = a.product_image_url ? urlToIndex.get(a.product_image_url) ?? 0 : 0
      const bi = b.product_image_url ? urlToIndex.get(b.product_image_url) ?? 0 : 0
      return ai - bi
    })
  })()

  // ---------- 导出 ----------
  const completedTasks = productTasks.filter((t) => t.status === 'completed')

  const handleDownloadZip = async () => {
    if (completedTasks.length === 0) return
    try {
      const zip = new JSZip()
      await Promise.all(
        completedTasks.map(async (t, i) => {
          if (!t.image_url) return
          const urlToIndex = products.findIndex((p) => p.url === t.product_image_url)
          const idx = urlToIndex >= 0 ? urlToIndex : i
          const blob = await downloadImageBlob(t.image_url)
          zip.file(`${idx + 1}.png`, blob)
        })
      )
      const content = await zip.generateAsync({ type: 'blob' })
      triggerDownload(content, `product_swap_${batch?.batch_id || 'batch'}.zip`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '打包下载失败')
    }
  }

  const handleDownloadToDir = async () => {
    if (!isFsAccessSupported()) {
      toast.warning('当前浏览器不支持文件夹直存，请改用 Chrome / Edge / Opera')
      return
    }
    if (completedTasks.length === 0) return
    let dirHandle
    try {
      dirHandle = await pickDirectory()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      toast.error(err instanceof Error ? err.message : '选择目录失败')
      return
    }
    if (!dirHandle) return

    const items = completedTasks.map((t, i) => {
      const urlToIndex = products.findIndex((p) => p.url === t.product_image_url)
      return { task: t, index: urlToIndex >= 0 ? urlToIndex : i }
    })

    setDirDownloading(true)
    setDirProgress({ done: 0, total: items.length, current: 0 })
    try {
      const result = await saveTasksToDirectory(
        items,
        dirHandle,
        (p) => setDirProgress({ done: p.done, total: p.total, current: p.current })
      )
      if (result.failed === 0) {
        toast.success(`已保存 ${result.success} 张到所选目录`)
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

  // Lightbox 条目：已完成任务（label 展示模型名；sourceId 用于精确定位）
  const lightboxItems: LightboxItem[] = productTasks
    .map((task, displayIdx) => ({ task, displayIdx }))
    .filter(({ task }) => task.status === 'completed' && task.image_url)
    .map(({ task, displayIdx }) => ({
      url: task.image_url as string,
      alt: `产品 ${displayIdx + 1} 生成结果`,
      sourceId: task.id,
      meta: {
        label: `#${displayIdx + 1} · ${getModelDisplayName(task.model, task.quality)}`,
        prompt: task.prompt ?? undefined,
        size,
        resolution,
        batchId: batch?.batch_id,
      },
    }))

  // 精确预览：按任务 ID 定位可预览列表中的真实位置（点哪张看哪张）
  const handlePreview = (task: GenerationTaskItem) => {
    const idx = lightboxItems.findIndex((item) => item.sourceId === task.id)
    if (idx >= 0) {
      setPreviewIndex(idx)
    } else if (task.status === 'failed') {
      toast.warning('该任务生成失败，暂无可预览的图片')
    } else {
      toast.info('图片尚未生成完成，请稍候')
    }
  }

  const overallPercent =
    batch && batch.total > 0
      ? Math.round((batch.completed / batch.total) * 100)
      : 0

  return (
    <GlassCard>
      <PageHeader
        title="产品替换"
        description="上传 1 张电商场景模板图，再上传 N 张你的产品图，按顺序生成 N 张结果图。"
      />

      <form onSubmit={handleSubmit}>
        {/* 模板图 */}
        <div className="form-group">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <label style={{ marginBottom: 0 }}>模板图（1 张，电商场景图）</label>
            {templateUrls.length > 0 && (
              <GlassButton
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setTemplateUrls([])}
                disabled={loading || !!batch}
              >
                重新上传
              </GlassButton>
            )}
          </div>
          {templateUrls.length === 0 ? (
            <div
              role="button"
              tabIndex={0}
              aria-label="上传模板图"
              onClick={() => !templateUploading && templateInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (!templateUploading) templateInputRef.current?.click()
                }
              }}
              style={{
                border: '1.5px dashed var(--input-border)',
                borderRadius: 'var(--radius-md)',
                padding: '1.25rem',
                textAlign: 'center',
                background: 'var(--input-bg)',
                cursor: templateUploading ? 'not-allowed' : 'pointer',
                opacity: templateUploading ? 0.6 : 1,
              }}
            >
              <input
                ref={templateInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => handleTemplateFile(e.target.files)}
                disabled={templateUploading}
                aria-label="选择模板图文件"
              />
              {templateUploading ? (
                <div style={{ color: 'var(--text-2)', fontSize: '0.9rem' }}>上传中...</div>
              ) : (
                <>
                  <div style={{ fontWeight: 500, marginBottom: '0.25rem', color: 'var(--text-1)' }}>
                    点击上传模板图（仅 1 张）
                  </div>
                  <div className="hint">支持 PNG / JPG / WEBP</div>
                </>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <img
                src={templateUrls[0]}
                alt="模板图"
                style={{
                  width: '120px',
                  height: '120px',
                  objectFit: 'cover',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--glass-border)',
                  boxShadow: 'var(--shadow-float)',
                }}
              />
              <div className="hint" style={{ flex: 1, wordBreak: 'break-all' }}>
                {templateUrls[0]}
              </div>
            </div>
          )}
          {templateUploadError && (
            <div className="hint" style={{ color: 'var(--danger)', marginTop: '0.5rem' }}>
              {templateUploadError}
            </div>
          )}
        </div>

        {/* 产品图 */}
        <div className="form-group">
          <label>产品图（最多 {MAX_PRODUCT_SWAP_COUNT} 张）</label>
          {(!batch || (batch && batch.completed + batch.failed < batch.total)) && (
            <ImageUploader
              urls={[]}
              onChange={(urls) => handleProductsUploaded(urls)}
              disabled={loading}
            />
          )}
          <div style={{ marginTop: '0.75rem' }}>
            <ProductThumbnailList
              products={products}
              onChange={setProducts}
              disabled={loading || (!!batch && batch.completed + batch.failed < batch.total)}
            />
          </div>
          {templateInProducts && (
            <div className="hint" style={{ color: 'var(--danger)', marginTop: '0.5rem' }}>
              模板图与产品图重复，请移除产品列表中相同的图片
            </div>
          )}
        </div>

        {/* Prompt */}
        <div className="form-group">
          <label htmlFor="swap-prompt">Prompt（所有 N 张图共用）</label>
          <textarea
            id="swap-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述如何把产品放进模板场景中..."
            required
            disabled={loading}
          />
        </div>

        {/* 参数 + 批次前缀 */}
        <ParameterSelector
          size={size}
          resolution={resolution}
          onChange={({ size, resolution }) => {
            setSize(size)
            setResolution(resolution)
          }}
        />

        <div className="form-group" style={{ marginTop: '0.5rem' }}>
          <label htmlFor="swap-prefix">批次号前缀</label>
          <input
            id="swap-prefix"
            type="text"
            value={prefix}
            onChange={(e) => handlePrefixChange(e.target.value)}
            maxLength={10}
            placeholder="MZY"
            disabled={loading}
            style={{
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase',
              ...(isPrefixValid ? {} : { borderColor: 'var(--danger)' }),
            }}
            title="批次号前缀，仅支持 A-Z / 0-9，1-10 位"
          />
          <div className="hint">
            格式：
            <code style={{ fontFamily: 'var(--font-mono)' }}>{prefix || '???'}</code>
            <code style={{ fontFamily: 'var(--font-mono)' }}>
              {batch?.batch_id ? batch.batch_id.slice(prefix.length, prefix.length + 4) : '????'}
            </code>
            <code style={{ fontFamily: 'var(--font-mono)' }}>??</code>
            {isPrefixValid && !batch && (
              <>
                {' · 下个 ID 预览：'}
                <code style={{ fontFamily: 'var(--font-mono)' }}>{previewBatchId}</code>
              </>
            )}
            {batch && <span style={{ color: 'var(--accent)' }}> · 当前批次：{batch.batch_id}</span>}
          </div>
        </div>

        <div className="config-actions">
          <GlassButton type="submit" variant="primary" loading={loading} disabled={!canSubmit}>
            {products.length === 0
              ? '请先上传产品图'
              : `为 ${products.length} 个产品生成 ${products.length} 张图片`}
          </GlassButton>
        </div>
      </form>

      {/* 结果区 */}
      {batch && (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
            <h3 style={{ margin: 0 }}>生成进度 · <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', color: 'var(--text-2)' }}>{batch.batch_id}</span></h3>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {batch.failed > 0 && (
                <GlassButton variant="warning" size="sm" onClick={handleRetry}>
                  重试失败任务 ({batch.failed})
                </GlassButton>
              )}
              {completedTasks.length > 0 && (
                <>
                  <GlassButton variant="secondary" size="sm" onClick={handleDownloadZip}>
                    下载全部 (zip)
                  </GlassButton>
                  <GlassButton
                    variant="secondary"
                    size="sm"
                    onClick={handleDownloadToDir}
                    disabled={dirDownloading}
                    title={
                      isFsAccessSupported()
                        ? '将所有已完成图片直接保存到本地文件夹'
                        : '当前浏览器不支持文件夹直存，请使用 Chrome / Edge / Opera'
                    }
                  >
                    {dirDownloading ? `导出中 ${dirProgress?.done}/${dirProgress?.total}` : '导出到文件夹'}
                  </GlassButton>
                </>
              )}
              <GlassButton variant="danger" size="sm" onClick={handleDeleteBatch}>
                删除批次
              </GlassButton>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
            <StatCard label="总计" value={batch.total} />
            <StatCard label="已完成" value={batch.completed} tone="success" />
            <StatCard label="失败" value={batch.failed} tone={batch.failed > 0 ? 'danger' : 'default'} />
            <StatCard label="进行中" value={batch.in_progress} tone={batch.in_progress > 0 ? 'accent' : 'default'} />
            <StatCard label="排队中" value={batch.queued + batch.pending} />
          </div>

          <div style={{ marginBottom: 'var(--space-4)' }}>
            <ProgressBar progress={overallPercent} animated={batch.in_progress > 0} />
          </div>

          {productTasks.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">该批次暂无任务</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {productTasks.map((task, displayIdx) => {
                const product = products.find((p) => p.url === task.product_image_url)
                return (
                  <SwapTaskRow
                    key={task.id}
                    index={displayIdx}
                    task={task}
                    productUrl={product?.url || task.product_image_url || ''}
                    templateUrl={templateUrl}
                    onPreview={() => handlePreview(task)}
                    onRegenerate={() => handleRegenerateTask(task)}
                    regenerating={regeneratingTaskId === task.id}
                    onDownload={() => {
                      if (!task.image_url) return
                      void downloadImageBlob(task.image_url)
                        .then((blob) => triggerDownload(blob, `${displayIdx + 1}.png`))
                        .catch((err) =>
                          toast.error(err instanceof Error ? err.message : '下载失败')
                        )
                    }}
                  />
                )
              })}
            </div>
          )}
        </div>
      )}

      <Lightbox
        open={previewIndex !== null && previewIndex >= 0}
        items={lightboxItems}
        initialIndex={Math.max(0, previewIndex ?? 0)}
        onClose={() => setPreviewIndex(null)}
      />

      {/* 重新生成：模型/精度选择弹窗 */}
      <RegenerateDialog
        task={regenerateTarget}
        onConfirm={(m, q) => void handleRegenerateConfirm(m, q)}
        onClose={() => setRegenerateTarget(null)}
      />
    </GlassCard>
  )
}

function SwapTaskRow({
  index,
  task,
  productUrl,
  templateUrl,
  onPreview,
  onRegenerate,
  onDownload,
  regenerating,
}: {
  index: number
  task: GenerationTaskItem
  productUrl: string
  templateUrl: string
  onPreview: () => void
  onRegenerate: () => void
  onDownload: () => void
  regenerating: boolean
}) {
  const isCompleted = task.status === 'completed'
  const isFailed = task.status === 'failed'
  const aspect = sizeToAspectRatio(task.size)

  return (
    <div
      className="swap-row"
      style={{
        display: 'grid',
        gridTemplateColumns: '36px 72px 72px minmax(0, 1fr) auto',
        gap: 'var(--space-3)',
        alignItems: 'center',
        padding: '0.75rem',
        background: isFailed ? 'var(--danger-soft)' : 'var(--glass-1-bg)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div
        style={{
          fontSize: '0.85rem',
          fontWeight: 650,
          color: isFailed ? 'var(--danger)' : 'var(--text-2)',
          textAlign: 'center',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        #{index + 1}
      </div>
      <Thumb url={productUrl} label={`产品 ${index + 1}`} />
      <Thumb url={templateUrl} label="模板" />
      <div style={{ minWidth: 0 }}>
        <div className="hint" style={{ marginBottom: '0.3rem', fontSize: '0.7rem' }}>
          生成结果
        </div>
        {task.image_url ? (
          <div style={{ width: '100%', aspectRatio: aspect }}>
            <FadeInImage
              src={task.image_url}
              alt={`结果 ${index + 1}`}
              onClick={onPreview}
              loading="lazy"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--glass-border)',
                cursor: 'zoom-in',
                background: 'var(--glass-1-bg)',
              }}
            />
          </div>
        ) : (
          <div
            style={{
              width: '100%',
              aspectRatio: aspect,
              display: 'grid',
              placeItems: 'center',
              background: 'var(--glass-1-bg)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-3)',
              fontSize: '0.82rem',
              border: '1px dashed var(--glass-border)',
            }}
          >
            {isFailed ? '生成失败' : `${STATUS_TEXT[task.status] ?? ''} · ${task.progress}%`}
          </div>
        )}
        {isFailed && task.error_msg && (
          <div style={{ fontSize: '0.72rem', color: 'var(--danger)', marginTop: '0.25rem' }} title={task.error_msg}>
            {task.error_msg.slice(0, 60)}
            {task.error_msg.length > 60 ? '...' : ''}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        <GlassButton size="sm" variant="secondary" onClick={onPreview} disabled={!task.image_url}>
          预览
        </GlassButton>
        {isCompleted && (
          <GlassButton size="sm" variant="secondary" onClick={onDownload} disabled={!task.image_url}>
            下载
          </GlassButton>
        )}
        {(isCompleted || isFailed) && (
          <GlassButton
            size="sm"
            variant="ghost"
            onClick={onRegenerate}
            disabled={regenerating}
            icon={<IconRefresh width={12} height={12} />}
            title="使用相同 prompt 重新生成"
          >
            {regenerating ? '生成中…' : '重新生成'}
          </GlassButton>
        )}
      </div>
    </div>
  )
}

function Thumb({ url, label }: { url: string; label: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div className="hint" style={{ marginBottom: '0.25rem', fontSize: '0.7rem' }}>
        {label}
      </div>
      {url ? (
        <FadeInImage
          src={url}
          alt={label}
          loading="lazy"
          style={{
            width: '64px',
            height: '64px',
            objectFit: 'cover',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--glass-border)',
          }}
        />
      ) : (
        <div
          style={{
            width: '64px',
            height: '64px',
            background: 'var(--glass-1-bg)',
            borderRadius: 'var(--radius-sm)',
            border: '1px dashed var(--glass-border)',
          }}
        />
      )}
    </div>
  )
}
