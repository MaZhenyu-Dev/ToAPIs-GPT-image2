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
  MAX_PRODUCT_SWAP_COUNT,
  MIN_PRODUCT_SWAP_COUNT,
} from '../constants'
import { useBatchPolling } from '../hooks/useBatchPolling'
import { useBatchPrefix } from '../hooks/useBatchPrefix'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import {
  isFsAccessSupported,
  pickDirectory,
  saveTasksToDirectory,
} from '../lib/fsDownload'
import type {
  BatchStatusResponse,
  GenerationTaskItem,
} from '../types'
import ImagePreview from './ImagePreview'
import ImageUploader from './ImageUploader'
import ParameterSelector from './ParameterSelector'
import ProductThumbnailList, { type ProductItem } from './ProductThumbnailList'

const POLL_INTERVAL_MS = 3000

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

export default function ProductSwapper() {
  // 模板图：单图，只保留第一个 URL
  const [templateUrls, setTemplateUrls] = useState<string[]>([])
  // 产品图：多图，带顺序
  const [products, setProducts] = useState<ProductItem[]>([])

  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState(DEFAULT_SIZE)
  const [resolution, setResolution] = useState(DEFAULT_RESOLUTION)
  const { prefix, handlePrefixChange, isPrefixValid, previewBatchId } = useBatchPrefix()

  // 防止「模板图 = 产品图」误操作
  const templateUrl = templateUrls[0] || ''
  const templateInProducts =
    !!templateUrl && products.some((p) => p.url === templateUrl)

  // 提交流程状态
  const [batch, setBatch] = useState<BatchStatusResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [regeneratingTaskId, setRegeneratingTaskId] = useState<number | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewMeta, setPreviewMeta] = useState<{
    prompt?: string
    productIndex?: number
  } | null>(null)

  // 导出到文件夹
  const [dirDownloading, setDirDownloading] = useState(false)
  const [dirProgress, setDirProgress] = useState<
    { done: number; total: number; current: number } | null
  >(null)

  const isOnline = useOnlineStatus()

  // 轮询 hook
  const { fetchOnce, startPolling, clearPolling } = useBatchPolling({
    intervalMs: POLL_INTERVAL_MS,
    onSuccess: (status) => setBatch(status),
  })

  // ---------- 提交流程 ----------
  const canSubmit =
    isOnline &&
    !loading &&
    !!templateUrl &&
    products.length >= MIN_PRODUCT_SWAP_COUNT &&
    products.length <= MAX_PRODUCT_SWAP_COUNT &&
    !!prompt.trim() &&
    isPrefixValid &&
    !templateInProducts

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return

    setLoading(true)
    setError(null)
    setBatch(null)
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
        startPolling(response.batch_id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '产品替换生成失败')
    } finally {
      setLoading(false)
    }
  }

  const handleRetry = async () => {
    if (!batch) return
    setError(null)
    try {
      const response = await retryBatch(batch.batch_id)
      const status = await fetchOnce(response.batch_id)
      if (status) {
        startPolling(response.batch_id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '重试失败')
    }
  }

  const handleRegenerateTask = async (task: GenerationTaskItem) => {
    if (!batch) return
    if (!window.confirm('确定要重新生成该任务吗？当前图片将被新结果替换。')) return
    setRegeneratingTaskId(task.id)
    setError(null)
    try {
      await regenerateTask(batch.batch_id, task.id)
      const status = await fetchOnce(batch.batch_id)
      if (status) {
        startPolling(batch.batch_id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '重新生成失败')
    } finally {
      setRegeneratingTaskId(null)
    }
  }

  const handleDeleteBatch = async () => {
    if (!batch) return
    if (!window.confirm(`确定要删除批次 ${batch.batch_id} 及其所有任务吗？此操作不可恢复。`))
      return
    try {
      await deleteBatch(batch.batch_id)
      setBatch(null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  // ---------- 模板图处理（只取第一张） ----------
  // 模板图用一个 max=1 的 ImageUploader 子集：直接读 input.files，丢弃多余张
  const [templateUploadError, setTemplateUploadError] = useState<string | null>(null)
  const [templateUploading, setTemplateUploading] = useState(false)
  const templateInputRef = useRef<HTMLInputElement | null>(null)

  // ---------- 产品图处理（带去重 + 上限） ----------
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
    // product_swap 模式下，每个 task 的 product_image_url 顺序就是用户上传的顺序
    // 但后端返回的 tasks 可能是按 id 排序的；为安全起见，按 product_image_url 在 products 列表中的位置排序
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
      setError(err instanceof Error ? err.message : '打包下载失败')
    }
  }

  const handleDownloadToDir = async () => {
    if (!isFsAccessSupported()) {
      setError('当前浏览器不支持文件夹直存，请改用 Chrome / Edge / Opera')
      return
    }
    if (completedTasks.length === 0) return
    let dirHandle
    try {
      dirHandle = await pickDirectory()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : '选择目录失败')
      return
    }
    if (!dirHandle) return

    // 按产品顺序构建 items（fsDownload 内部按 index+1 命名）
    const items = completedTasks.map((t, i) => {
      const urlToIndex = products.findIndex((p) => p.url === t.product_image_url)
      return { task: t, index: urlToIndex >= 0 ? urlToIndex : i }
    })

    setDirDownloading(true)
    setDirProgress({ done: 0, total: items.length, current: 0 })
    setError(null)

    const result = await saveTasksToDirectory(
      items,
      dirHandle,
      (p) => setDirProgress({ done: p.done, total: p.total, current: p.current })
    )

    setDirDownloading(false)
    setDirProgress(null)

    if (result.failed === 0) {
      setError(`已保存 ${result.success} 张到所选目录`)
    } else {
      const head = result.errors.slice(0, 3).join('；')
      setError(
        `已保存 ${result.success}/${result.total} 张；失败 ${result.failed} 条。` +
          (head ? ` 例：${head}` : '')
      )
    }
  }

  // ---------- 渲染 ----------
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>产品替换</h2>
      <div className="hint" style={{ marginBottom: '1rem' }}>
        上传 1 张电商场景模板图（待替换的产品在图中），再上传 N 张你的产品图。
        系统会按顺序生成 N 张结果图，每张用 [模板图, 产品图] 作为参考。
      </div>

      <form onSubmit={handleSubmit}>
        {/* Section 1: 模板图 */}
        <div className="form-group">
          <label>
            模板图（1 张，电商场景图）
            {templateUrls.length > 0 && (
              <button
                type="button"
                onClick={() => setTemplateUrls([])}
                disabled={loading || !!batch}
                style={{
                  marginLeft: '0.5rem',
                  padding: '0.2rem 0.5rem',
                  fontSize: '0.75rem',
                  background: '#6b7280',
                }}
              >
                重新上传
              </button>
            )}
          </label>
          {templateUrls.length === 0 ? (
            <div
              onClick={() => !templateUploading && templateInputRef.current?.click()}
              style={{
                border: '2px dashed #d1d5db',
                borderRadius: '8px',
                padding: '1.25rem',
                textAlign: 'center',
                background: '#f9fafb',
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
              />
              {templateUploading ? (
                <div>上传中...</div>
              ) : (
                <>
                  <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>
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
                onClick={() => {
                  setPreviewUrl(templateUrls[0])
                  setPreviewMeta({})
                }}
                style={{
                  width: '120px',
                  height: '120px',
                  objectFit: 'cover',
                  borderRadius: '8px',
                  border: '1px solid #e5e7eb',
                  cursor: 'pointer',
                }}
              />
              <div className="hint" style={{ flex: 1, wordBreak: 'break-all' }}>
                {templateUrls[0]}
              </div>
            </div>
          )}
          {templateUploadError && (
            <div className="error" style={{ marginTop: '0.5rem' }}>
              {templateUploadError}
            </div>
          )}
        </div>

        {/* Section 2: 产品图 */}
        <div className="form-group">
          <label>
            产品图（最多 {MAX_PRODUCT_SWAP_COUNT} 张）
          </label>
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
            <div className="error" style={{ marginTop: '0.5rem' }}>
              模板图与产品图重复，请移除产品列表中相同的图片
            </div>
          )}
        </div>

        {/* Section 3: Prompt */}
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

        {/* Section 4: 参数 + 批次前缀 */}
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
              fontFamily: 'monospace',
              textTransform: 'uppercase',
              ...(isPrefixValid ? {} : { borderColor: '#dc2626' }),
            }}
            title="批次号前缀，仅支持 A-Z / 0-9，1-10 位"
          />
          <div className="hint" style={{ marginTop: '0.25rem' }}>
            格式：<code style={{ fontFamily: 'monospace' }}>{prefix || '???'}</code>
            <code style={{ fontFamily: 'monospace' }}>
              {batch?.batch_id ? batch.batch_id.slice(prefix.length, prefix.length + 4) : '????'}
            </code>
            <code style={{ fontFamily: 'monospace' }}>??</code>
            （日期为服务端北京时间 · 序号由服务端分配）
            {isPrefixValid && !batch && (
              <>
                {' · 下个 ID 预览：'}
                <code style={{ fontFamily: 'monospace' }}>{previewBatchId}</code>
              </>
            )}
            {batch && (
              <span style={{ color: '#2563eb' }}> · 当前批次：{batch.batch_id}</span>
            )}
          </div>
        </div>

        <div style={{ marginTop: '1.25rem' }}>
          <button type="submit" disabled={!canSubmit}>
            {loading
              ? '创建任务中...'
              : products.length === 0
                ? '请先上传产品图'
                : `为 ${products.length} 个产品生成 ${products.length} 张图片`}
          </button>
        </div>
      </form>

      {error && <div className="error">{error}</div>}

      {/* 结果区 */}
      {batch && (
        <div style={{ marginTop: '1.5rem' }}>
          <h3>生成进度</h3>
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

          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              marginBottom: '1rem',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            {batch.failed > 0 && (
              <button
                type="button"
                onClick={handleRetry}
                style={{ background: '#f59e0b' }}
              >
                重试失败任务 ({batch.failed})
              </button>
            )}
            {completedTasks.length > 0 && (
              <>
                <button type="button" onClick={handleDownloadZip}>
                  下载全部 (zip)
                </button>
                <button
                  type="button"
                  onClick={handleDownloadToDir}
                  disabled={dirDownloading}
                  title={
                    isFsAccessSupported()
                      ? '将所有已完成图片直接保存到本地文件夹'
                      : '当前浏览器不支持文件夹直存，请使用 Chrome / Edge / Opera'
                  }
                >
                  导出全部到文件夹
                </button>
              </>
            )}
            {dirDownloading && dirProgress && (
              <span className="hint" style={{ fontSize: '0.8rem' }}>
                写入中 {dirProgress.done}/{dirProgress.total}
              </span>
            )}
            <button
              type="button"
              onClick={handleDeleteBatch}
              style={{ background: '#dc2626', marginLeft: 'auto' }}
            >
              删除批次
            </button>
          </div>

          {productTasks.length === 0 ? (
            <div className="hint">该批次暂无任务。</div>
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
                    onPreview={() => {
                      if (task.image_url) {
                        setPreviewUrl(task.image_url)
                        setPreviewMeta({
                          prompt: task.prompt ?? undefined,
                          productIndex: displayIdx,
                        })
                      }
                    }}
                    onRegenerate={() => handleRegenerateTask(task)}
                    regenerating={regeneratingTaskId === task.id}
                  />
                )
              })}
            </div>
          )}
        </div>
      )}

      <ImagePreview
        url={previewUrl}
        onClose={() => {
          setPreviewUrl(null)
          setPreviewMeta(null)
        }}
        meta={
          previewMeta
            ? {
                prompt: previewMeta.prompt,
                size,
                resolution,
              }
            : null
        }
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

function SwapTaskRow({
  index,
  task,
  productUrl,
  templateUrl,
  onPreview,
  onRegenerate,
  regenerating,
}: {
  index: number
  task: GenerationTaskItem
  productUrl: string
  templateUrl: string
  onPreview: () => void
  onRegenerate: () => void
  regenerating: boolean
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '32px 80px 80px 1fr auto',
        gap: '0.75rem',
        alignItems: 'center',
        padding: '0.5rem',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        background: task.status === 'failed' ? '#fef2f2' : '#fff',
      }}
    >
      <div
        style={{
          fontSize: '0.85rem',
          fontWeight: 600,
          color: statusColor[task.status] || '#374151',
          textAlign: 'center',
        }}
      >
        #{index + 1}
      </div>
      <div style={{ textAlign: 'center' }}>
        <div className="hint" style={{ marginBottom: '0.25rem', fontSize: '0.7rem' }}>
          产品
        </div>
        {productUrl ? (
          <img
            src={productUrl}
            alt={`产品 ${index + 1}`}
            style={{
              width: '80px',
              height: '80px',
              objectFit: 'cover',
              borderRadius: '6px',
              border: '1px solid #e5e7eb',
            }}
          />
        ) : (
          <div
            style={{
              width: '80px',
              height: '80px',
              background: '#f3f4f6',
              borderRadius: '6px',
            }}
          />
        )}
      </div>
      <div style={{ textAlign: 'center' }}>
        <div className="hint" style={{ marginBottom: '0.25rem', fontSize: '0.7rem' }}>
          模板
        </div>
        {templateUrl ? (
          <img
            src={templateUrl}
            alt="模板"
            style={{
              width: '80px',
              height: '80px',
              objectFit: 'cover',
              borderRadius: '6px',
              border: '1px solid #e5e7eb',
            }}
          />
        ) : (
          <div
            style={{
              width: '80px',
              height: '80px',
              background: '#f3f4f6',
              borderRadius: '6px',
            }}
          />
        )}
      </div>
      <div>
        <div className="hint" style={{ marginBottom: '0.25rem', fontSize: '0.7rem' }}>
          生成结果
        </div>
        {task.image_url ? (
          <img
            src={task.image_url}
            alt={`结果 ${index + 1}`}
            onClick={onPreview}
            style={{
              width: '180px',
              height: '120px',
              objectFit: 'cover',
              borderRadius: '6px',
              border: '1px solid #e5e7eb',
              cursor: 'pointer',
            }}
          />
        ) : (
          <div
            style={{
              width: '180px',
              height: '120px',
              background: '#f3f4f6',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#9ca3af',
              fontSize: '0.85rem',
            }}
          >
            {task.status === 'failed' ? '生成失败' : '生成中...'}
          </div>
        )}
        {task.status !== 'completed' && task.status !== 'failed' && (
          <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '0.25rem' }}>
            {statusText[task.status] || task.status} · {task.progress}%
          </div>
        )}
        {task.status === 'failed' && task.error_msg && (
          <div
            style={{
              fontSize: '0.75rem',
              color: '#dc2626',
              marginTop: '0.25rem',
              maxWidth: '180px',
            }}
            title={task.error_msg}
          >
            {task.error_msg.slice(0, 50)}
            {task.error_msg.length > 50 ? '...' : ''}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <button
          type="button"
          onClick={onPreview}
          disabled={!task.image_url}
          style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
        >
          预览
        </button>
        {task.status === 'completed' && task.image_url && (
          <button
            type="button"
            onClick={async () => {
              try {
                const blob = await downloadImageBlob(task.image_url!)
                triggerDownload(blob, `${index + 1}.png`)
              } catch (err) {
                alert(err instanceof Error ? err.message : '下载失败')
              }
            }}
            style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
          >
            下载
          </button>
        )}
        {(task.status === 'completed' || task.status === 'failed') && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={regenerating}
            style={{
              padding: '0.3rem 0.6rem',
              fontSize: '0.8rem',
              background: regenerating ? '#f3f4f6' : '#fff7ed',
              color: regenerating ? '#9ca3af' : '#9a3412',
            }}
            title="使用相同 prompt 重新生成"
          >
            {regenerating ? '生成中…' : '重新生成'}
          </button>
        )}
      </div>
    </div>
  )
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
