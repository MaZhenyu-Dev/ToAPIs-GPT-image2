import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteBatch,
  generateBatch,
  listRecentBatches,
  regenerateTask,
  retryBatch,
} from '../../api'
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_RESOLUTION,
  DEFAULT_SIZE,
  IMAGE_MODEL_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
  MAX_I2I_MULTI_COUNT,
  MIN_I2I_MULTI_COUNT,
  SIZE_RESOLUTION_MAP,
} from '../../constants'
import { useBatchPolling } from '../../hooks/useBatchPolling'
import { useBatchPrefix } from '../../hooks/useBatchPrefix'
import { useFolderBatch } from '../../hooks/useFolderBatch'
import { PREVIEW_MAX_ROWS } from '../../hooks/useFolderBatch'
import type {
  AutoRelayConfig,
  BatchStatusResponse,
  BatchSummary,
  GenerationTaskItem,
  GenerationMode,
  ImageModelId,
  ImageQuality,
  VariantGroupListItem,
} from '../../types'
import GlassButton from '../ui/GlassButton'
import GlassCard from '../ui/GlassCard'
import ImageUploader from '../ImageUploader'
import ParameterSelector from '../ParameterSelector'
import RegenerateDialog from './RegenerateDialog'
import SegmentedControl from '../ui/SegmentedControl'
import { useToast } from '../ui/Toast'
import BatchDetailPanel from './BatchDetailPanel'
import BatchListPanel from './BatchListPanel'
import AutoRelayDialog from './AutoRelayDialog'
import { displayBatchId } from '../../lib/batchDownloads'

const POLL_INTERVAL_MS = 3000

type BatchMode = 'variant' | 'folder'

interface BatchWorkspaceProps {
  groups: VariantGroupListItem[]
  selectedGroupId?: number | null
}

/**
 * 批量生成工作台（合并 变体组批量 / 文件夹批量）。
 *
 * 布局（工作流条）：模式切换 → 单行配置条（变体组/前缀/尺寸/模式 + 主操作锚定右侧）
 * → 单行 meta 摘要 → 批次详情 或 近期批次列表。
 */
export default function BatchWorkspace({ groups, selectedGroupId }: BatchWorkspaceProps) {
  const toast = useToast()

  // ---------- 共用配置 ----------
  const [mode, setMode] = useState<BatchMode>('variant')
  const [groupId, setGroupId] = useState<number | ''>(selectedGroupId ?? '')
  const [genMode, setGenMode] = useState<GenerationMode>('t2i')
  const [size, setSize] = useState(DEFAULT_SIZE)
  const [resolution, setResolution] = useState(DEFAULT_RESOLUTION)
  const [referenceUrls, setReferenceUrls] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  // 自动接力套图配置（非空 = 已启用；裂变批次完成后自动创建套图批次）
  const [relayConfig, setRelayConfig] = useState<AutoRelayConfig | null>(null)
  const [relayDialogOpen, setRelayDialogOpen] = useState(false)
  // 生图模型 + 精度（默认 gpt-image-2；quality 仅部分模型支持）
  const [imageModel, setImageModel] = useState<ImageModelId>(DEFAULT_IMAGE_MODEL)
  const [quality, setQuality] = useState<ImageQuality>(DEFAULT_IMAGE_QUALITY)
  const {
    prefix,
    handlePrefixChange,
    isPrefixValid,
    todayBatchInfo,
    previewBatchId,
    refreshTodayCount,
  } = useBatchPrefix()

  // ---------- 当前查看的批次 ----------
  const [batch, setBatch] = useState<BatchStatusResponse | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<'ok' | 'error'>('ok')
  const [regeneratingTaskId, setRegeneratingTaskId] = useState<number | null>(null)
  const [listRefreshKey, setListRefreshKey] = useState(0)
  // 详情页批次快速切换条的数据源（最近 50 个批次的状态摘要）
  const [switchBatches, setSwitchBatches] = useState<BatchSummary[]>([])
  const [switchingBatchId, setSwitchingBatchId] = useState<string | null>(null)

  const { fetchOnce, startPolling, clearPolling } = useBatchPolling({
    intervalMs: POLL_INTERVAL_MS,
    onSuccess: (status) => {
      setBatch(status)
      setConnectionStatus('ok')
    },
    onError: () => setConnectionStatus('error'),
  })

  useEffect(() => {
    if (selectedGroupId) setGroupId(selectedGroupId)
  }, [selectedGroupId])

  // ---------- 文件夹批量（独立 hook，状态随模式切换保留） ----------
  const selectedGroup = groups.find((g) => g.id === groupId) ?? null
  const K = selectedGroup?.variant_count ?? 0
  const relayGroupName = relayConfig
    ? (groups.find((g) => g.id === relayConfig.group_id)?.name ?? null)
    : null

  const selectedModel = IMAGE_MODEL_OPTIONS.find((m) => m.id === imageModel)
  const qualitySupported = selectedModel?.qualitySupported ?? false

  const folder = useFolderBatch({
    groupId,
    variantCount: K,
    size,
    resolution,
    prefix,
    todayBatchInfo,
    refreshTodayCount,
    model: imageModel,
    quality: qualitySupported ? quality : undefined,
  })

  const folderRunning =
    folder.progress?.phase === 'uploading' || folder.progress?.phase === 'creating'

  // 文件夹批量创建成功 → 提示 + 刷新列表 + 重置表单
  useEffect(() => {
    if (folder.progress?.phase !== 'done' || !folder.progress.result) return
    const { result } = folder.progress
    toast.success(
      `成功创建 ${result.batch_ids.length} 个批次，共 ${result.task_count} 个任务`
    )
    setListRefreshKey((k) => k + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder.progress?.phase])

  // ---------- 变体组批量：创建 ----------
  const handleSubmitVariant = async () => {
    if (!groupId) {
      toast.warning('请先选择一个变体组')
      return
    }
    if (genMode === 'i2i' && referenceUrls.length === 0) {
      toast.warning('图生图模式必须提供参考图')
      return
    }
    if (!isPrefixValid) {
      toast.warning('批次前缀仅支持 1-10 位 A-Z / 0-9 字符')
      return
    }

    setSubmitting(true)
    clearPolling()
    try {
      const response = await generateBatch({
        group_id: Number(groupId),
        mode: genMode,
        size,
        resolution,
        reference_image_urls: genMode === 'i2i' ? referenceUrls : undefined,
        prefix,
        model: imageModel,
        quality: qualitySupported ? quality : undefined,
        relay: relayConfig ?? undefined,
      })
      const status = await fetchOnce(response.batch_id)
      if (status) {
        setBatch(status)
        startPolling(response.batch_id)
      }
      toast.success(
        `已创建批次 ${displayBatchId(response.batch_id)}，共 ${response.task_count} 个任务`
      )
      void refreshTodayCount(prefix)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量生成失败')
    } finally {
      setSubmitting(false)
    }
  }

  // ---------- 批次操作 ----------
  const handleLoadBatch = async (batchId: string) => {
    clearPolling()
    const status = await fetchOnce(batchId)
    if (status) {
      setBatch(status)
      const done = status.completed + status.failed
      if (done < status.total) startPolling(batchId)
    }
  }

  const handleBackToList = () => {
    clearPolling()
    setBatch(null)
    setRegeneratingTaskId(null)
    setListRefreshKey((k) => k + 1)
  }

  const handleRetryFailed = async () => {
    if (!batch) return
    const hasFailed = batch.tasks.some((t) => t.status === 'failed')
    if (!hasFailed) return
    try {
      const response = await retryBatch(batch.batch_id)
      const status = await fetchOnce(response.batch_id)
      if (status) {
        setBatch(status)
        startPolling(response.batch_id)
      }
      toast.success('已重新提交失败任务')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重试失败任务失败')
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
      const updated = await regenerateTask(batch.batch_id, regenerateTarget.id, {
        model,
        ...(quality ? { quality } : {}),
      })
      setBatch((prev) =>
        prev
          ? {
              ...prev,
              tasks: prev.tasks.map((t) => (t.id === updated.id ? updated : t)),
            }
          : prev
      )
      startPolling(batch.batch_id)
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
    try {
      await deleteBatch(batch.batch_id)
      clearPolling()
      setBatch(null)
      toast.success(`批次 ${displayBatchId(batch.batch_id)} 已删除`)
      setListRefreshKey((k) => k + 1)
      void refreshTodayCount(prefix)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除批次失败')
    }
  }

  const handleDataChanged = useCallback(() => {
    void refreshTodayCount(prefix)
  }, [prefix, refreshTodayCount])

  // ---------- 批次快速切换 ----------
  // 默认展示最近 50 个批次；切换条支持搜索（q 全库模糊查询），
  // 任意批次（超过 50 条/更早的）都能搜到并切换
  const switchSearchRef = useRef('')

  const loadSwitchBatches = useCallback(async (q?: string) => {
    try {
      const response = await listRecentBatches({
        page: 1,
        pageSize: 50,
        q: q || undefined,
      })
      setSwitchBatches(response.batches)
    } catch {
      // 切换条非关键信息，失败静默
    }
  }, [])

  // 打开/切换详情时刷新切换条（无搜索词 = 最近 50 条）
  useEffect(() => {
    if (!batch) return
    void loadSwitchBatches()
  }, [batch?.batch_id, loadSwitchBatches])

  // 切换条内有未完成批次时静默轮询，保持状态点实时（轮询沿用当前搜索词）
  const hasIncompleteInStrip = switchBatches.some(
    (b) => b.completed_count < b.task_count
  )
  useEffect(() => {
    if (!batch || !hasIncompleteInStrip) return
    const timer = setInterval(() => {
      void loadSwitchBatches(switchSearchRef.current || undefined)
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [batch, hasIncompleteInStrip, loadSwitchBatches])

  const handleSwitchBatch = async (batchId: string) => {
    if (!batch || batchId === batch.batch_id || switchingBatchId) return
    setSwitchingBatchId(batchId)
    try {
      await handleLoadBatch(batchId)
    } finally {
      setSwitchingBatchId(null)
    }
  }

  const dimensions = SIZE_RESOLUTION_MAP[size]?.[resolution] ?? ''

  return (
    <div>
      <SegmentedControl<BatchMode>
        ariaLabel="批量生成模式"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'variant', label: '变体组批量' },
          { value: 'folder', label: '文件夹批量' },
        ]}
      />

      <GlassCard className="workspace-config">
        <div className="config-inner">
          {/* 工作流条：配置 + 主操作同流线 */}
          <div className="config-bar">
            <div className="config-field config-field--grow">
              <label htmlFor="workspace-group">变体组</label>
              <select
                id="workspace-group"
                value={groupId}
                onChange={(e) =>
                  setGroupId(e.target.value ? Number(e.target.value) : '')
                }
              >
                <option value="">请选择</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}（{g.variant_count} 个变体）
                  </option>
                ))}
              </select>
            </div>

            <div className="config-field config-field--prefix">
              <label htmlFor="workspace-prefix">批次前缀</label>
              <div className="config-prefix">
                <input
                  id="workspace-prefix"
                  type="text"
                  value={prefix}
                  onChange={(e) => handlePrefixChange(e.target.value)}
                  maxLength={10}
                  placeholder="MZY"
                  title="批次号前缀，仅支持 A-Z / 0-9，1-10 位；保存到浏览器本地"
                  style={isPrefixValid ? undefined : { borderColor: 'var(--danger)' }}
                />
                {isPrefixValid && todayBatchInfo && (
                  <span className="config-prefix-next" title="服务端分配的下一个批次号">
                    → {previewBatchId}
                  </span>
                )}
              </div>
            </div>

            <ParameterSelector
              compact
              size={size}
              resolution={resolution}
              onChange={({ size: s, resolution: r }) => {
                setSize(s)
                setResolution(r)
              }}
            />

            {mode === 'variant' && (
              <div className="config-field">
                <label>生成模式</label>
                <SegmentedControl<GenerationMode>
                  ariaLabel="生成模式"
                  value={genMode}
                  onChange={setGenMode}
                  options={[
                    { value: 't2i', label: '文生图' },
                    { value: 'i2i', label: '图生图' },
                  ]}
                />
              </div>
            )}

            <div className="config-bar-action">
              <GlassButton
                variant="primary"
                loading={mode === 'variant' ? submitting : folderRunning}
                disabled={mode === 'variant' ? !groupId : !folder.canStart}
                onClick={() =>
                  mode === 'variant'
                    ? void handleSubmitVariant()
                    : void folder.runCreate()
                }
              >
                {mode === 'variant'
                  ? submitting
                    ? '创建中…'
                    : '开始批量生成'
                  : folder.progress?.phase === 'uploading'
                    ? `上传图片中 ${folder.progress.uploaded}/${folder.progress.totalToUpload}…`
                    : folder.progress?.phase === 'creating'
                      ? '创建批次中…'
                      : `开始创建 ${folder.selectedImages.length} 个批次`}
              </GlassButton>
            </div>
          </div>

          {/* 模型与精度配置行 */}
          <div className="config-bar" style={{ marginTop: 'var(--space-4)' }}>
            <div className="config-field config-field--model">
              <label htmlFor="workspace-model">生图模型</label>
              <select
                id="workspace-model"
                value={imageModel}
                onChange={(e) => setImageModel(e.target.value as ImageModelId)}
              >
                {IMAGE_MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            {qualitySupported && (
              <div className="config-field">
                <label>精度档位</label>
                <SegmentedControl<ImageQuality>
                  ariaLabel="精度档位"
                  value={quality}
                  onChange={setQuality}
                  options={IMAGE_QUALITY_OPTIONS.map((q) => ({
                    value: q.id,
                    label: q.label,
                    title: q.id === 'low' ? '快速省钱，适合草稿/预览' : q.id === 'high' ? '最高精度，适合正式出图' : '平衡速度与质量',
                  }))}
                />
              </div>
            )}

            {selectedModel && (
              <span className="config-meta" style={{ alignSelf: 'center', paddingBottom: '0.35rem' }}>
                {selectedModel.description}
                {qualitySupported
                  ? ' · 精度：低=草稿 / 中=均衡 / 高=正式'
                  : ' · 该模型固定默认精度'}
              </span>
            )}
          </div>

          {/* 单行摘要 */}
          <div className="config-meta-row">
            <span>
              下个 ID：
              <code className="config-mono">{isPrefixValid ? previewBatchId : '—'}</code>
            </span>
            <span>
              每批 <strong>{K || '—'}</strong> 个任务
            </span>
            <span>
              输出 <code className="config-mono">{dimensions || '—'}</code>
            </span>
            {!isPrefixValid && (
              <span style={{ color: 'var(--danger)' }}>
                前缀仅支持 1-10 位 A-Z / 0-9
              </span>
            )}
            {mode === 'variant' && genMode === 'i2i' && referenceUrls.length === 0 && (
              <span style={{ color: 'var(--warning)' }}>图生图模式需上传参考图</span>
            )}
          </div>

          {/* 变体组模式：自动接力套图 */}
          {mode === 'variant' && (
            <div className="config-bar" style={{ marginTop: 'var(--space-4)' }}>
              <label
                className="auto-relay-toggle"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={relayConfig !== null}
                  onChange={(e) => {
                    if (e.target.checked) setRelayDialogOpen(true)
                    else setRelayConfig(null)
                  }}
                />
                <span>生成完成后自动接力套图</span>
              </label>
              {relayConfig && (
                <span
                  className="config-meta"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                >
                  裂变完成后自动用其图片创建套图批次
                  （{relayGroupName ?? '变体组'} · {relayConfig.prefix} 前缀）
                  <GlassButton
                    size="sm"
                    variant="ghost"
                    onClick={() => setRelayDialogOpen(true)}
                  >
                    修改
                  </GlassButton>
                </span>
              )}
            </div>
          )}

          {/* 变体组模式：图生图参考图 */}
          {mode === 'variant' && genMode === 'i2i' && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <ImageUploader
                urls={referenceUrls}
                onChange={setReferenceUrls}
                disabled={submitting}
              />
            </div>
          )}

          {/* 文件夹模式：数量 + 选目录 + 匹配预览 */}
          {mode === 'folder' && (
            <FolderModeSection folder={folder} variantCount={K} />
          )}
        </div>
      </GlassCard>

      {batch ? (
        <BatchDetailPanel
          batch={batch}
          connectionStatus={connectionStatus}
          busy={submitting}
          regeneratingTaskId={regeneratingTaskId}
          recentBatches={switchBatches}
          switchingBatchId={switchingBatchId}
          onSwitchBatch={(batchId) => void handleSwitchBatch(batchId)}
          onSearchSwitchBatches={(q) => {
            switchSearchRef.current = q
            void loadSwitchBatches(q || undefined)
          }}
          onBack={handleBackToList}
          onRetryFailed={handleRetryFailed}
          onRegenerateTask={handleRegenerateTask}
          onDeleteBatch={handleDeleteBatch}
        />
      ) : (
        <BatchListPanel
          refreshKey={listRefreshKey}
          onOpenBatch={(batchId) => void handleLoadBatch(batchId)}
          onDataChanged={handleDataChanged}
          groups={groups}
        />
      )}

      {/* 重新生成：模型/精度选择弹窗 */}
      <RegenerateDialog
        task={regenerateTarget}
        onConfirm={(m, q) => void handleRegenerateConfirm(m, q)}
        onClose={() => setRegenerateTarget(null)}
      />

      {/* 自动接力套图：配置弹窗 */}
      {relayDialogOpen && (
        <AutoRelayDialog
          initial={relayConfig}
          groups={groups}
          onConfirm={(config) => {
            setRelayConfig(config)
            setRelayDialogOpen(false)
            toast.success(
              `已启用自动接力：完成后用 ${config.prefix} 前缀创建套图批次`
            )
          }}
          onClose={() => setRelayDialogOpen(false)}
        />
      )}
    </div>
  )
}

// ---------- 文件夹模式区块 ----------

function FolderModeSection({
  folder,
  variantCount,
}: {
  folder: ReturnType<typeof useFolderBatch>
  variantCount: number
}) {
  const running =
    folder.progress?.phase === 'uploading' || folder.progress?.phase === 'creating'
  const { selectedImages, scannedCount } = folder
  // 数量输入合法判定：空 = 全部；否则 1-300
  const limitValid =
    folder.limit === '' ||
    (Number.isInteger(Number(folder.limit)) &&
      Number(folder.limit) >= MIN_I2I_MULTI_COUNT &&
      Number(folder.limit) <= MAX_I2I_MULTI_COUNT)
  const truncated = scannedCount > MAX_I2I_MULTI_COUNT

  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      <div className="config-bar">
        <div className="config-field config-field--grow">
          <label htmlFor="folder-limit">图片数量（每张图 → 1 个批次）</label>
          <div className="config-row">
            <input
              id="folder-limit"
              type="text"
              inputMode="numeric"
              value={folder.limit}
              placeholder="不填默认全部"
              onChange={(e) => folder.setLimit(e.target.value)}
              style={{
                width: '120px',
                ...(limitValid ? undefined : { borderColor: 'var(--danger)' }),
              }}
              aria-label="图片数量（不填默认全部）"
              disabled={running}
            />
            <span className="config-meta">最多 {MAX_I2I_MULTI_COUNT} 张</span>
          </div>
          {!limitValid && (
            <div className="hint" style={{ color: 'var(--danger)' }}>
              数量需为 1-{MAX_I2I_MULTI_COUNT} 的整数，留空则使用全部
            </div>
          )}
        </div>

        <div className="config-field config-field--grow">
          <label>图片文件夹</label>
          <div className="config-row">
            <GlassButton
              variant="secondary"
              size="sm"
              onClick={() => void folder.handlePickFolder()}
              disabled={running || folder.scanning}
            >
              {folder.scanning
                ? '扫描中…'
                : folder.dirHandle
                  ? '重新选择文件夹'
                  : '选择图片文件夹'}
            </GlassButton>
            {folder.dirHandle && (
              <span className="config-meta" title="支持 png/jpg/jpeg，按名称自然排序">
                {folder.dirHandle.name}（{folder.scannedCount} 张图片
                {folder.ignoredCount > 0 ? `，跳过 ${folder.ignoredCount} 个非图片` : ''}
                {truncated ? `，超过上限仅使用前 ${MAX_I2I_MULTI_COUNT} 张` : ''}）
              </span>
            )}
          </div>
          {folder.scanError && (
            <div className="hint" style={{ color: 'var(--danger)', marginTop: '0.25rem' }}>
              {folder.scanError}
            </div>
          )}
        </div>
      </div>

      {/* 使用预览 */}
      {folder.dirHandle && scannedCount > 0 && (
        <div className="folder-match-box" style={{ marginTop: 'var(--space-4)' }}>
          <div>
            将使用 <strong>{selectedImages.length}</strong> 张图片
            {folder.limit !== '' && scannedCount > selectedImages.length
              ? `（文件夹共 ${scannedCount} 张，按名称排序取前 ${selectedImages.length} 张）`
              : `（文件夹共 ${scannedCount} 张）`}
            ，创建 <strong>{selectedImages.length}</strong> 个批次
            （每批 {variantCount} 个任务，共约{' '}
            <strong>{selectedImages.length * variantCount}</strong> 个任务）
          </div>
          {selectedImages.length > 0 && (
            <details style={{ marginTop: '0.4rem' }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.76rem' }}>
                查看前 {Math.min(PREVIEW_MAX_ROWS, selectedImages.length)} 张图
              </summary>
              <div className="folder-match-detail">
                {selectedImages.slice(0, PREVIEW_MAX_ROWS).map((img) => (
                  <span key={img.filename}>{img.filename}</span>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {folder.dirHandle && scannedCount === 0 && (
        <div
          className="folder-match-box folder-match-box--warn"
          style={{ marginTop: 'var(--space-4)' }}
        >
          文件夹中没有可用的图片（支持 png / jpg / jpeg）
        </div>
      )}

      {/* 错误 / 结果 */}
      {folder.progress?.phase === 'error' && folder.progress.errorMsg && (
        <div
          className="folder-match-box"
          style={{ marginTop: 'var(--space-3)', borderColor: 'var(--danger-soft)', color: 'var(--danger)', whiteSpace: 'pre-wrap' }}
        >
          {folder.progress.errorMsg}
        </div>
      )}

      {folder.progress?.phase === 'done' && folder.progress.result && (
        <div className="folder-match-box" style={{ marginTop: 'var(--space-3)' }}>
          <div>
            成功创建 {folder.progress.result.batch_ids.length} 个批次，共{' '}
            {folder.progress.result.task_count} 个任务
          </div>
          <details style={{ marginTop: '0.4rem' }}>
            <summary style={{ cursor: 'pointer', fontSize: '0.76rem' }}>
              查看 batch_id 列表
            </summary>
            <div className="folder-match-detail">
              {folder.progress.result.batch_ids.map((bid) => (
                <span key={bid}>{bid}</span>
              ))}
            </div>
          </details>
          <div style={{ marginTop: '0.6rem' }}>
            <GlassButton size="sm" variant="secondary" onClick={folder.resetRun}>
              再来一次
            </GlassButton>
          </div>
        </div>
      )}
    </div>
  )
}
