import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  erpGenerate,
  erpHistory,
  erpListStores,
  erpLogin,
  erpOrdersList,
  erpOrdersSync,
  erpPrompts,
  erpResetInputImage,
  erpSessionStatus,
  erpSetCropConfig,
  erpSetInputImage,
  erpUploadAll,
  erpUploadOrder,
  regenerateTask,
  retryBatch,
  taskRecomputeCrop,
  uploadImage,
} from '../../api'
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_RESOLUTION,
  DEFAULT_SIZE,
  EXTREME_RATIO_MODEL,
  EXTREME_SIZES,
  SIZE_OPTIONS,
} from '../../constants'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import type { ReactNode } from 'react'
import type {
  ErpExtractUnit,
  ErpSessionStatus,
  ErpStore,
  GenerationTaskItem,
  ImageModelId,
  ImageQuality,
} from '../../types'
import { useConfirm } from '../ui/ConfirmDialog'
import FadeInImage from '../ui/FadeInImage'
import GlassButton from '../ui/GlassButton'
import { formatCropSummary } from '../../lib/cropFormat'
import ComparePreview from './ComparePreview'
import CropToggle from './CropToggle'
import ExtractPromptSelector from './ExtractPromptSelector'
import ModelSelector from './ModelSelector'
import PageHeader from '../ui/PageHeader'
import ParameterSelector from '../ParameterSelector'
import RegenerateDialog from '../batch/RegenerateDialog'
import { useToast } from '../ui/Toast'
import { IconZoomIn } from '../ui/Icon'

const UNIT_STATUS_TEXT: Record<string, string> = {
  pending: '待生成',
  generating: '生成中',
  completed: '已生成',
  failed: '生成失败',
  uploaded: '已上传',
}

const POLL_INTERVAL_MS = 3000

/** 工厂自动化：同步 ERP 图片缺失订单 → AI 生成产品图 → 前后对比 → 上传回 ERP。
 *
 * 批次号 = 店铺名-货号（每个货号一个批次），不占用 {prefix}{MMDD}{seq} 序号；
 * 单元状态通过定时刷新 erpOrdersList 获取（后台轮询器已同步 ToAPIs 状态）。
 */
export default function FactoryAutomation() {
  const toast = useToast()
  const confirm = useConfirm()
  const isOnline = useOnlineStatus()

  // ---------- ERP 会话 ----------
  const [session, setSession] = useState<ErpSessionStatus | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [loginUsername, setLoginUsername] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [showLoginForm, setShowLoginForm] = useState(false)

  // ---------- 店铺 ----------
  const [stores, setStores] = useState<ErpStore[]>([])
  const [storesLoading, setStoresLoading] = useState(false)
  const [selectedSupplierIds, setSelectedSupplierIds] = useState<number[]>([])

  // ---------- 生成参数 ----------
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<ImageModelId>(DEFAULT_IMAGE_MODEL)
  const [quality, setQuality] = useState<ImageQuality | undefined>(undefined)
  const [size, setSize] = useState(DEFAULT_SIZE)
  const [resolution, setResolution] = useState(DEFAULT_RESOLUTION)
  const [sizeMode, setSizeMode] = useState<'auto' | 'fixed'>('auto')
  const [fixedSize, setFixedSize] = useState(DEFAULT_SIZE)

  // ---------- 单元列表 ----------
  const [units, setUnits] = useState<ErpExtractUnit[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)
  const [sizeOverrides, setSizeOverrides] = useState<Record<string, string>>({})
  const [generatingKeys, setGeneratingKeys] = useState<Set<string>>(new Set())
  const [uploadingKey, setUploadingKey] = useState<string | null>(null)
  const [regenerateTarget, setRegenerateTarget] = useState<GenerationTaskItem | null>(null)
  const [regeneratingTaskId, setRegeneratingTaskId] = useState<number | null>(null)
  const [previewUnit, setPreviewUnit] = useState<ErpExtractUnit | null>(null)

  // 会话过期时重新探测（登录后刷新）
  const sessionExpiredRef = useRef(false)

  // ---------- 视图切换（待处理 / 生成历史） ----------
  const [view, setView] = useState<'pending' | 'history'>('pending')
  const [historyUnits, setHistoryUnits] = useState<ErpExtractUnit[]>([])
  const [historyQ, setHistoryQ] = useState('')
  const [historyStatus, setHistoryStatus] = useState('')
  const [historyVisible, setHistoryVisible] = useState(20)
  const [historyLoading, setHistoryLoading] = useState(false)

  const loadSession = useCallback(async () => {
    setSessionLoading(true)
    try {
      const status = await erpSessionStatus()
      setSession(status)
      if (status.valid) {
        await loadStores()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '查询 ERP 会话失败')
      setSession({ valid: false, store_count: 0, last_error: null })
    } finally {
      setSessionLoading(false)
    }
  }, [toast])

  const loadStores = useCallback(async () => {
    setStoresLoading(true)
    try {
      const list = await erpListStores()
      setStores(list)
      setSession((prev) => (prev ? { ...prev, store_count: list.length } : prev))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载店铺列表失败')
      setSession((prev) => (prev ? { ...prev, valid: false, last_error: 'ERP 登录已过期，请重新登录' } : prev))
    } finally {
      setStoresLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadSession()
    erpPrompts()
      .then((r) => {
        const general = r.prompts['corridor'] || r.prompts['living_room']
        if (general) setPrompt((prev) => prev || general)
      })
      .catch(() => {})
  }, [loadSession])

  const handleSessionError = (err: unknown) => {
    if (err instanceof Error && err.message.includes('登录已过期')) {
      sessionExpiredRef.current = true
      setSession({ valid: false, store_count: 0, last_error: 'ERP 登录已过期，请重新登录' })
    }
  }

  // ---------- 登录 ----------
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!loginUsername.trim() || !loginPassword) {
      toast.warning('请输入 ERP 账号和密码')
      return
    }
    setLoginLoading(true)
    try {
      const result = await erpLogin(loginUsername.trim(), loginPassword)
      setLoginPassword('')
      setStores(result.stores)
      setSession({ valid: true, store_count: result.stores.length, last_error: null })
      setShowLoginForm(false)
      toast.success('ERP 登录成功，已获取店铺列表')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'ERP 登录失败')
    } finally {
      setLoginLoading(false)
    }
  }

  // ---------- 店铺选择 ----------
  const toggleSupplier = (id: number) => {
    setSelectedSupplierIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  // ---------- 订单同步 ----------
  const handleSync = async () => {
    if (selectedSupplierIds.length === 0) {
      toast.warning('请先选择至少一个店铺')
      return
    }
    setPreviewLoading(true)
    try {
      const result = await erpOrdersSync(selectedSupplierIds)
      setUnits(result.units)
      setSizeOverrides({})
      toast.success(`已同步 ${result.crawled_count} 条订单，去重后 ${result.units.length} 个货号`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '同步订单失败')
      handleSessionError(err)
    } finally {
      setPreviewLoading(false)
    }
  }

  const refreshUnits = useCallback(async () => {
    if (selectedSupplierIds.length === 0) return
    try {
      // only_missing：只显示仍在 ERP 缺失列表中的订单，
      // 已上传/被人工补图的订单从待处理视图消失（历史视图仍可查）
      const result = await erpOrdersList(selectedSupplierIds, '', true)
      setUnits(result.units)
    } catch {
      /* 静默失败，保留当前列表 */
    }
  }, [selectedSupplierIds])

  // ---------- 生成 ----------
  const pendingUnits = useMemo(() => units.filter((u) => u.status === 'pending'), [units])
  const completedUnits = useMemo(
    () => units.filter((u) => u.status === 'completed'),
    [units]
  )
  const failedUnits = useMemo(() => units.filter((u) => u.status === 'failed'), [units])

  const handleGenerateUnits = async (targets: ErpExtractUnit[], supplierIds: number[]) => {
    if (targets.length === 0) {
      toast.warning('没有待生成的货号')
      return
    }
    const keys = targets.map((t) => t.unit_key)
    setGeneratingKeys((prev) => new Set([...prev, ...keys]))
    try {
      const response = await erpGenerate({
        supplier_ids: supplierIds,
        unit_keys: keys,
        prompt: prompt.trim(),
        size_mode: sizeMode,
        ...(sizeMode === 'fixed' ? { fixed_size: fixedSize } : {}),
        ...(Object.keys(sizeOverrides).length > 0 ? { size_overrides: sizeOverrides } : {}),
        size,
        resolution,
        model,
        ...(quality ? { quality } : {}),
      })
      if (response.succeeded > 0) {
        toast.success(`已提交 ${response.succeeded} 个货号的生成任务`)
      }
      response.results
        .filter((r) => !r.success)
        .forEach((r) => toast.error(`生成失败 ${r.goods_sn}: ${r.message}`))
      // 极端比例货号自动切模型的提示
      response.results
        .filter((r) => r.success && r.model === EXTREME_RATIO_MODEL && r.message)
        .forEach((r) => toast.info(`${r.goods_sn}: ${r.message}`))
      await refreshUnits()
      if (response.succeeded > 0) {
        startPolling()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建生成任务失败')
      handleSessionError(err)
    } finally {
      setGeneratingKeys((prev) => {
        const next = new Set(prev)
        keys.forEach((k) => next.delete(k))
        return next
      })
    }
  }

  const handleGenerateKeys = async (keys: string[]) => {
    const targets = units.filter((u) => keys.includes(u.unit_key) && u.status === 'pending')
    await handleGenerateUnits(targets, selectedSupplierIds)
  }

  // 历史视图：单独生成某个货号（不依赖当前选中的店铺）
  const handleGenerateHistoryUnit = async (unit: ErpExtractUnit) => {
    await handleGenerateUnits([unit], [unit.supplier_id])
  }

  const handleGenerateAll = async () => {
    const extremeCount = pendingUnits.filter((u) => {
      const size =
        sizeOverrides[String(u.representative_order_item_id)] ??
        (sizeMode === 'fixed' ? fixedSize : u.mapped_ratio)
      return EXTREME_SIZES.has(size)
    }).length
    const ok = await confirm({
      title: '确认开始生成',
      message: `将生成 ${pendingUnits.length} 张产品图（${selectedSupplierIds.length} 家店铺），
每个货号仅生成一张（同店铺同货号自动去重）。生成会消耗 ToAPIs 额度，确定继续吗？${
        extremeCount > 0
          ? `\n\n注意：其中 ${extremeCount} 个货号使用极端宽高比（4:1/8:1），将自动使用 Gemini 模型生成。`
          : ''
      }`,
      confirmLabel: '开始生成',
      tone: 'primary',
    })
    if (!ok) return
    await handleGenerateUnits(pendingUnits, selectedSupplierIds)
  }

  // ---------- 轮询：整体刷新单元状态 ----------
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    pollTimerRef.current = setInterval(async () => {
      try {
        const result = await erpOrdersList(selectedSupplierIds, '', true)
        setUnits(result.units)
        const active = result.units.filter(
          (u) => u.status === 'pending' || u.status === 'generating'
        )
        if (active.length === 0) {
          stopPolling()
        }
      } catch {
        /* 静默 */
      }
    }, POLL_INTERVAL_MS)
  }, [selectedSupplierIds, stopPolling])

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    }
  }, [])

  // ---------- 输入图替换 / 重置（工厂图被家具遮挡时换自定义清晰图） ----------
  const inputFileRef = useRef<HTMLInputElement>(null)
  const replaceTargetRef = useRef<ErpExtractUnit | null>(null)
  const [replacingKey, setReplacingKey] = useState<string | null>(null)

  const loadHistory = useCallback(async (q: string) => {
    setHistoryLoading(true)
    try {
      const result = await erpHistory(q)
      setHistoryUnits(result.units)
      setHistoryVisible(20)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载生成历史失败')
    } finally {
      setHistoryLoading(false)
    }
  }, [toast])

  // 按当前视图刷新数据源：历史视图重新加载历史（不依赖选中店铺），
  // 待处理视图刷新单元列表
  const refreshCurrentView = useCallback(async () => {
    if (view === 'history') {
      await loadHistory(historyQ)
    } else {
      await refreshUnits()
    }
  }, [view, loadHistory, historyQ, refreshUnits])

  const handleReplaceInputClick = (unit: ErpExtractUnit) => {
    replaceTargetRef.current = unit
    inputFileRef.current?.click()
  }

  const handleInputFile = async (files: FileList | null) => {
    const unit = replaceTargetRef.current
    replaceTargetRef.current = null
    if (inputFileRef.current) inputFileRef.current.value = ''
    if (!unit || !files || files.length === 0) return
    // files 是 live FileList，必须先取 file 再清空 input，否则清空后 length 变 0
    await handleReplaceInputFile(unit, files[0], files.length)
  }

  /** 拖拽与文件选择器共用的输入图替换流程 */
  const handleReplaceInputFile = async (
    unit: ErpExtractUnit,
    file: File,
    selectedCount = 1,
  ) => {
    if (!file.type.startsWith('image/')) {
      toast.warning('请选择图片文件')
      return
    }
    if (selectedCount > 1) {
      toast.warning('一次只能替换一张输入图')
      return
    }
    if (unit.status === 'uploaded') {
      const ok = await confirm({
        title: '替换已上传订单的输入图',
        message: `该订单已上传 ERP。替换输入图只影响后续生成，不会自动更新 ERP 中已有的生成图。确定继续吗？`,
        confirmLabel: '继续替换',
        tone: 'primary',
      })
      if (!ok) return
    }
    setReplacingKey(unit.unit_key)
    try {
      const res = await uploadImage(file)
      await erpSetInputImage(unit.representative_order_item_id, res.url)
      await refreshCurrentView()
      toast.success(`已替换 ${unit.goods_sn} 的输入图`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '替换输入图失败')
      handleSessionError(err)
    } finally {
      setReplacingKey(null)
    }
  }

  const handleResetInput = async (unit: ErpExtractUnit) => {
    setReplacingKey(unit.unit_key)
    try {
      await erpResetInputImage(unit.representative_order_item_id)
      await refreshCurrentView()
      toast.success(`已恢复 ${unit.goods_sn} 为工厂原图`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重置输入图失败')
      handleSessionError(err)
    } finally {
      setReplacingKey(null)
    }
  }

  // ---------- 白边裁剪配置（单元级：开关 + 阈值，改后即时生效） ----------
  const [cropSavingKey, setCropSavingKey] = useState<string | null>(null)

  const handleCropConfig = async (
    unit: ErpExtractUnit,
    enabled: boolean,
    threshold: number
  ) => {
    setCropSavingKey(unit.unit_key)
    try {
      const res = await erpSetCropConfig(
        unit.representative_order_item_id,
        enabled,
        threshold
      )
      // 开启且任务已完成但没有裁剪结果 → 立即补算（同步等结果，体验完整）
      if (enabled && !res.crop_image_url && unit.generation_task_id) {
        try {
          await taskRecomputeCrop(unit.generation_task_id)
        } catch {
          /* 补算失败静默：列表刷新后显示裁剪失败状态 */
        }
      }
      await refreshCurrentView()
      toast.success(
        enabled
          ? `已开启 ${unit.goods_sn} 的白边裁剪（阈值 ${threshold}）`
          : `已关闭 ${unit.goods_sn} 的白边裁剪`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存裁剪配置失败')
      handleSessionError(err)
    } finally {
      setCropSavingKey(null)
    }
  }

  // ---------- 上传 ----------
  const handleUploadUnit = async (unit: ErpExtractUnit) => {
    const ok = await confirm({
      title: '上传图片到 ERP',
      message: `将生成图上传到 ERP 订单 #${unit.representative_order_item_id}（${unit.store_name} · ${unit.goods_sn}）。
同货号的其他订单也会一起标记为已上传。确定继续吗？`,
      confirmLabel: '确认上传',
      tone: 'primary',
    })
    if (!ok) return
    setUploadingKey(unit.unit_key)
    try {
      const result = await erpUploadOrder(unit.representative_order_item_id)
      if (result.success) {
        toast.success(`上传成功：${result.message}`)
        // 已上传的订单从 ERP 缺失列表消失 → 刷新后从待处理视图移除
        await refreshUnits()
      } else {
        toast.error(result.message || '上传失败')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '上传失败')
      handleSessionError(err)
    } finally {
      setUploadingKey(null)
    }
  }

  const handleUploadAll = async () => {
    const ok = await confirm({
      title: '批量上传到 ERP（警告）',
      message: `将把 ${completedUnits.length} 张已生成的产品图上传到工厂 ERP。
上传后对应订单的「图片缺失」状态会被消除，请确认图片质量无误后再操作。确定继续吗？`,
      confirmLabel: '确认全部上传',
      tone: 'danger',
    })
    if (!ok) return
    setUploadingKey('all')
    try {
      const result = await erpUploadAll(selectedSupplierIds)
      if (result.succeeded > 0) {
        toast.success(`批量上传完成：成功 ${result.succeeded}，失败 ${result.failed}`)
        await refreshUnits()
      } else {
        toast.error(result.failed > 0 ? '批量上传失败' : '没有可上传的图片')
      }
      result.results
        .filter((r) => !r.success)
        .slice(0, 3)
        .forEach((r) => toast.error(`上传失败 #${r.order_item_id}: ${r.message}`))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量上传失败')
      handleSessionError(err)
    } finally {
      setUploadingKey(null)
    }
  }

  // ---------- 重试 / 重新生成（按单元批次：批次号 = 店铺名-货号） ----------
  const handleRetryUnit = async (unit: ErpExtractUnit) => {
    if (!unit.batch_id) return
    try {
      await retryBatch(unit.batch_id)
      toast.info(`已重新提交 ${unit.goods_sn} 的失败任务`)
      await refreshUnits()
      startPolling()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重试失败')
    }
  }

  const handleRegenerateConfirm = async (
    newModel: ImageModelId,
    newQuality: ImageQuality | undefined,
    newSize?: string,
    newResolution?: string
  ) => {
    if (!regenerateTarget?.batch_id || !regenerateTarget.id) return
    setRegeneratingTaskId(regenerateTarget.id)
    const target = regenerateTarget
    setRegenerateTarget(null)
    try {
      await regenerateTask(target.batch_id, target.id, {
        model: newModel,
        ...(newQuality ? { quality: newQuality } : {}),
        ...(newSize && newResolution ? { size: newSize, resolution: newResolution } : {}),
        // prompt 与前端文本框实时同步
        prompt: prompt.trim(),
      })
      await refreshUnits()
      startPolling()
      toast.info('已重新提交，等待生成结果')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重新生成失败')
    } finally {
      setRegeneratingTaskId(null)
    }
  }

  useEffect(() => {
    if (view === 'history') {
      void loadHistory(historyQ)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  const historyFiltered = useMemo(() => {
    if (!historyStatus) return historyUnits
    return historyUnits.filter((u) => u.status === historyStatus)
  }, [historyUnits, historyStatus])

  // ---------- 渲染 ----------
  return (
    <>
      <PageHeader
        title="工厂自动化"
        description="从工厂 ERP 同步「图片缺失」订单 → AI 生成产品图 → 前后对比 → 上传回 ERP。批次号即「店铺名-货号」。"
      />

      {/* 视图切换：待处理 / 生成历史 */}
      <div
        role="tablist"
        aria-label="工厂自动化视图"
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
            { key: 'pending', label: '待处理订单', hint: '同步 ERP 图片缺失订单并生成' },
            { key: 'history', label: '生成历史', hint: '本地持久化记录（含已上传 ERP 后消失的订单）' },
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

      {view === 'pending' && (
        <>
      {/* ERP 会话卡片 */}
      <div
        className="form-group"
        style={{
          padding: 'var(--space-3)',
          border: `1px solid ${
            session?.valid ? 'var(--glass-border)' : 'var(--danger-soft)'
          }`,
          borderRadius: 'var(--radius-md)',
          background: 'var(--glass-1-bg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <strong>工厂 ERP 会话：</strong>
          {sessionLoading ? (
            <span className="hint">检测中...</span>
          ) : session?.valid ? (
            <span style={{ color: 'var(--success)' }}>已登录（{session.store_count} 家店铺）</span>
          ) : (
            <span style={{ color: 'var(--danger)' }}>
              {session?.last_error || '未登录'}
            </span>
          )}
          {session?.valid && (
            <>
              <GlassButton size="sm" variant="ghost" onClick={() => void loadStores()}>
                刷新店铺
              </GlassButton>
              <GlassButton
                size="sm"
                variant="secondary"
                onClick={() => setShowLoginForm((v) => !v)}
                title="重新登录 ERP（换账号 / 刷新已过期的 cookie）"
              >
                {showLoginForm ? '取消重新登录' : '重新登录'}
              </GlassButton>
            </>
          )}
        </div>

        {(!session?.valid || showLoginForm) && (
          <form
            onSubmit={handleLogin}
            style={{
              display: 'flex',
              gap: '0.5rem',
              marginTop: '0.75rem',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <input
              type="text"
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
              placeholder="ERP 账号"
              autoComplete="username"
              style={{ width: '160px' }}
              disabled={loginLoading}
            />
            <input
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              placeholder="ERP 密码"
              autoComplete="current-password"
              style={{ width: '160px' }}
              disabled={loginLoading}
            />
            <GlassButton type="submit" variant="primary" loading={loginLoading}>
              登录并获取 Cookie
            </GlassButton>
            <span className="hint">账号密码仅用于本次登录，不会保存</span>
          </form>
        )}
      </div>

      {/* 店铺选择 */}
      <div className="form-group">
        <label>选择店铺（{selectedSupplierIds.length}/{stores.length}）</label>
        {storesLoading ? (
          <div className="hint">加载店铺列表...</div>
        ) : stores.length === 0 ? (
          <div className="hint">暂无店铺数据，请先完成 ERP 登录</div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: '0.35rem',
              maxHeight: '240px',
              overflowY: 'auto',
              padding: '0.5rem',
              border: '1px solid var(--input-border)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--input-bg)',
            }}
          >
            {stores.map((store) => {
              const checked = selectedSupplierIds.includes(store.id)
              return (
                <label
                  key={store.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    padding: '0.25rem 0.4rem',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    background: checked ? 'var(--accent-soft)' : 'transparent',
                    fontSize: '0.85rem',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSupplier(store.id)}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {store.name}
                  </span>
                </label>
              )
            })}
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <GlassButton
            size="sm"
            variant="secondary"
            onClick={() => setSelectedSupplierIds(stores.map((s) => s.id))}
            disabled={stores.length === 0}
          >
            全选
          </GlassButton>
          <GlassButton
            size="sm"
            variant="ghost"
            onClick={() => setSelectedSupplierIds([])}
            disabled={selectedSupplierIds.length === 0}
          >
            清空
          </GlassButton>
        </div>
      </div>

      {/* Prompt */}
      <div className="form-group">
        <label htmlFor="factory-prompt">Prompt（所有货号共用，可随时修改）</label>
        <ExtractPromptSelector value={prompt} onChange={setPrompt} />
        <textarea
          id="factory-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="描述如何根据参考图生成产品图..."
          rows={8}
          style={{ marginTop: '0.5rem' }}
        />
      </div>

      {/* 模型 / 参数 */}
      <ModelSelector
        model={model}
        quality={quality}
        onChange={({ model: m, quality: q }) => {
          setModel(m)
          setQuality(q)
        }}
      />
      <ParameterSelector
        size={size}
        resolution={resolution}
        onChange={({ size: s, resolution: r }) => {
          setSize(s)
          setResolution(r)
        }}
      />

      <div className="form-group">
        <label htmlFor="factory-size-mode">尺寸映射</label>
        <select
          id="factory-size-mode"
          value={sizeMode}
          onChange={(e) => setSizeMode(e.target.value as 'auto' | 'fixed')}
        >
          <option value="auto">自动映射（按订单实际尺寸匹配最近比例）</option>
          <option value="fixed">统一比例（所有货号同一比例）</option>
        </select>
        {sizeMode === 'fixed' && (
          <select
            value={fixedSize}
            onChange={(e) => setFixedSize(e.target.value)}
            style={{ marginTop: '0.4rem' }}
          >
            {SIZE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="config-actions">
        <GlassButton
          variant="secondary"
          onClick={() => void handleSync()}
          loading={previewLoading}
          disabled={!session?.valid || selectedSupplierIds.length === 0 || !isOnline}
        >
          同步订单
        </GlassButton>
        <GlassButton
          variant="primary"
          onClick={() => void handleGenerateAll()}
          disabled={
            !session?.valid ||
            pendingUnits.length === 0 ||
            !prompt.trim() ||
            !isOnline ||
            generatingKeys.size > 0
          }
        >
          {pendingUnits.length === 0
            ? '请先同步订单'
            : `为 ${pendingUnits.length} 个货号生成 ${pendingUnits.length} 张图片`}
        </GlassButton>
        <GlassButton
          variant="danger"
          onClick={() => void handleUploadAll()}
          loading={uploadingKey === 'all'}
          disabled={completedUnits.length === 0}
          title="把已生成的图片批量上传回 ERP（会弹窗警告）"
        >
          批量上传到 ERP ({completedUnits.length})
        </GlassButton>
        {failedUnits.length > 0 && (
          <span className="hint" style={{ color: 'var(--danger)' }}>
            {failedUnits.length} 个货号生成失败，可在下方单独重试
          </span>
        )}
      </div>

      {/* 单元列表 */}
      {units.length > 0 && (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '0.5rem',
              marginBottom: '0.75rem',
            }}
          >
            <h3 style={{ margin: 0 }}>
              生成单元（去重后 {units.length} 个货号）
            </h3>
            <GlassButton size="sm" variant="ghost" onClick={() => void refreshUnits()}>
              刷新状态
            </GlassButton>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {units.map((unit) => (
              <UnitRow
                key={unit.unit_key}
                unit={unit}
                sizeMode={sizeMode}
                sizeOverrides={sizeOverrides}
                onSizeOverride={(sizeKey) =>
                  setSizeOverrides((prev) => ({ ...prev, [String(unit.representative_order_item_id)]: sizeKey }))
                }
                generating={generatingKeys.has(unit.unit_key)}
                uploading={uploadingKey === unit.unit_key}
                onGenerate={() => void handleGenerateKeys([unit.unit_key])}
                onUpload={() => void handleUploadUnit(unit)}
                onRetry={() => void handleRetryUnit(unit)}
                onPreview={() => setPreviewUnit(unit)}
                onReplaceInput={() => handleReplaceInputClick(unit)}
                onReplaceInputFile={(file, fileCount) =>
                  void handleReplaceInputFile(unit, file, fileCount)
                }
                onResetInput={() => void handleResetInput(unit)}
                replacingInput={replacingKey === unit.unit_key}
                cropSaving={cropSavingKey === unit.unit_key}
                onCropConfig={(enabled, threshold) =>
                  void handleCropConfig(unit, enabled, threshold)
                }
                onRegenerate={() => {
                  if (!unit.batch_id || !unit.generation_task_id) return
                  setRegenerateTarget({
                    id: unit.generation_task_id,
                    batch_id: unit.batch_id,
                    status: unit.status,
                    model: model,
                    quality: quality ?? null,
                  } as GenerationTaskItem)
                }}
                regenerating={regeneratingTaskId === (unit.generation_task_id ?? 0)}
              />
            ))}
          </div>
        </div>
      )}
        </>
      )}

      {/* 生成历史：本地持久化记录（含已上传 ERP 后消失的订单） */}
      {view === 'history' && (
        <div>
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <input
              type="search"
              value={historyQ}
              onChange={(e) => setHistoryQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void loadHistory(historyQ)
              }}
              placeholder="搜索货号 / 店铺名称..."
              style={{ width: '240px' }}
            />
            <GlassButton size="sm" variant="secondary" onClick={() => void loadHistory(historyQ)}>
              搜索
            </GlassButton>
            <select
              value={historyStatus}
              onChange={(e) => setHistoryStatus(e.target.value)}
              style={{ width: 'auto' }}
              aria-label="按状态筛选"
            >
              <option value="">全部状态</option>
              <option value="pending">待生成</option>
              <option value="generating">生成中</option>
              <option value="completed">已生成</option>
              <option value="failed">失败</option>
              <option value="uploaded">已上传</option>
            </select>
            <span className="hint">
              共 {historyFiltered.length} 条记录（本地持久化，不受 ERP 订单状态影响）
            </span>
          </div>

          {historyLoading ? (
            <div className="hint" style={{ padding: '1rem 0', textAlign: 'center' }}>
              加载生成历史...
            </div>
          ) : historyFiltered.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">暂无生成历史</div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                {historyFiltered.slice(0, historyVisible).map((unit) => (
                  <UnitRow
                    key={unit.unit_key}
                    unit={unit}
                    sizeMode={sizeMode}
                    sizeOverrides={{}}
                    onSizeOverride={() => {}}
                    generating={generatingKeys.has(unit.unit_key)}
                    uploading={uploadingKey === unit.unit_key}
                    onGenerate={() => void handleGenerateHistoryUnit(unit)}
                    onUpload={() => void handleUploadUnit(unit)}
                    onRetry={() => void handleRetryUnit(unit)}
                    onPreview={() => setPreviewUnit(unit)}
                    onReplaceInput={() => handleReplaceInputClick(unit)}
                    onReplaceInputFile={(file, fileCount) =>
                      void handleReplaceInputFile(unit, file, fileCount)
                    }
                    onResetInput={() => void handleResetInput(unit)}
                    replacingInput={replacingKey === unit.unit_key}
                    cropSaving={cropSavingKey === unit.unit_key}
                    onCropConfig={(enabled, threshold) =>
                      void handleCropConfig(unit, enabled, threshold)
                    }
                    onRegenerate={() => {
                      if (!unit.batch_id || !unit.generation_task_id) return
                      setRegenerateTarget({
                        id: unit.generation_task_id,
                        batch_id: unit.batch_id,
                        status: unit.status,
                        model: model,
                        quality: quality ?? null,
                      } as GenerationTaskItem)
                    }}
                    regenerating={regeneratingTaskId === (unit.generation_task_id ?? 0)}
                    showTime
                  />
                ))}
              </div>
              {historyFiltered.length > historyVisible && (
                <div style={{ textAlign: 'center', marginTop: '0.75rem' }}>
                  <GlassButton
                    size="sm"
                    variant="ghost"
                    onClick={() => setHistoryVisible((v) => v + 20)}
                  >
                    加载更多（{historyFiltered.length - historyVisible} 条）
                  </GlassButton>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <RegenerateDialog
        task={regenerateTarget}
        onConfirm={(m, q, s, r) => void handleRegenerateConfirm(m, q, s, r)}
        onClose={() => setRegenerateTarget(null)}
        showSizeResolution
      />

      {/* 对比预览：输入图（工厂）⇄ 生成图（平台）双图同屏，各自可缩放 */}
      <ComparePreview unit={previewUnit} onClose={() => setPreviewUnit(null)} />

      {/* 替换输入图用的隐藏文件选择器（共享，配合 replaceTargetRef） */}
      <input
        ref={inputFileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => void handleInputFile(e.target.files)}
        aria-label="选择自定义输入图"
      />
    </>
  )
}

/** 输入图拖拽替换目标：包住缩略图/按钮列，拖入时显示替换遮罩 */
function InputDropTarget({
  replacing,
  onFile,
  children,
}: {
  replacing: boolean
  onFile: (file: File, fileCount?: number) => void
  children: ReactNode
}) {
  const [dragActive, setDragActive] = useState(false)
  const dragDepthRef = useRef(0)

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current += 1
    setDragActive(true)
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.dropEffect !== 'copy') e.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current -= 1
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0
      setDragActive(false)
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = 0
    setDragActive(false)
    const files = e.dataTransfer.files
    if (!files || files.length === 0) return
    onFile(files[0], files.length)
  }

  const active = dragActive && !replacing

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.3rem',
        borderRadius: 'var(--radius-md)',
      }}
    >
      {children}
      {active && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: '-2px',
            display: 'grid',
            placeItems: 'center',
            borderRadius: 'var(--radius-md)',
            background: 'color-mix(in srgb, var(--accent) 82%, transparent)',
            border: '1.5px dashed rgba(255,255,255,0.88)',
            color: '#fff',
            fontSize: '0.78rem',
            fontWeight: 700,
            textAlign: 'center',
            padding: '0.35rem',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          松开替换输入图
        </div>
      )}
      {replacing && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: '-2px',
            display: 'grid',
            placeItems: 'center',
            gap: '0.25rem',
            borderRadius: 'var(--radius-md)',
            background: 'rgba(0,0,0,0.48)',
            color: 'var(--text-1)',
            fontSize: '0.78rem',
            fontWeight: 700,
            textAlign: 'center',
            padding: '0.35rem',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          <span
            style={{
              width: '15px',
              height: '15px',
              borderRadius: '50%',
              border: '2px solid var(--text-2)',
              borderTopColor: 'transparent',
              animation: 'spin 0.8s linear infinite',
            }}
          />
          替换中
        </div>
      )}
    </div>
  )
}

function UnitRow({
  unit,
  sizeMode,
  sizeOverrides,
  onSizeOverride,
  generating,
  uploading,
  onGenerate,
  onUpload,
  onRetry,
  onPreview,
  onReplaceInput,
  onReplaceInputFile,
  onResetInput,
  replacingInput,
  cropSaving,
  onCropConfig,
  onRegenerate,
  regenerating,
  showTime = false,
}: {
  unit: ErpExtractUnit
  sizeMode: 'auto' | 'fixed'
  sizeOverrides: Record<string, string>
  onSizeOverride: (sizeKey: string) => void
  generating: boolean
  uploading: boolean
  onGenerate: () => void
  onUpload: () => void
  onRetry: () => void
  onPreview: () => void
  onReplaceInput: () => void
  onReplaceInputFile: (file: File, fileCount?: number) => void
  onResetInput: () => void
  replacingInput: boolean
  cropSaving: boolean
  onCropConfig: (enabled: boolean, threshold: number) => void
  onRegenerate: () => void
  regenerating: boolean
  showTime?: boolean
}) {
  const statusText = UNIT_STATUS_TEXT[unit.status] ?? unit.status
  const statusColor =
    unit.status === 'uploaded'
      ? 'var(--success)'
      : unit.status === 'completed'
        ? 'var(--accent)'
        : unit.status === 'failed'
          ? 'var(--danger)'
          : unit.status === 'generating'
            ? 'var(--warning)'
            : 'var(--text-3)'
  // 输入图是否被用户替换过（非工厂原图 → 显示"重置工厂图"）
  const inputOverridden =
    !!unit.factory_image_url && unit.input_image_url !== unit.factory_image_url
  // 白边裁剪：开启且有裁剪结果 → 显示裁剪图；否则显示 AI 原图
  const displayResultUrl =
    unit.crop_enabled && unit.crop_image_url
      ? unit.crop_image_url
      : unit.result_image_url
  const cropSummary =
    unit.crop_enabled && unit.crop_meta && !unit.crop_meta.error
      ? formatCropSummary(unit.crop_meta)
      : null

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gap: 'var(--space-4)',
        alignItems: 'center',
        padding: '0.85rem',
        background: 'var(--glass-1-bg)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      {/* 左：对比图区（输入图 ⇄ 生成图，点击放大对比） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', minWidth: 0 }}>
        <InputDropTarget
          replacing={replacingInput}
          onFile={onReplaceInputFile}
        >
          <CompareThumb
            url={unit.input_image_url}
            label="输入图"
            onClick={onPreview}
            enabled={!!unit.input_image_url}
          />
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            <GlassButton
              size="sm"
              variant="ghost"
              onClick={onReplaceInput}
              loading={replacingInput}
              title="点击选择或拖拽图片替换输入图（工厂图被家具遮挡时用清晰图）"
            >
              替换
            </GlassButton>
            {inputOverridden && (
              <GlassButton
                size="sm"
                variant="ghost"
                onClick={onResetInput}
                disabled={replacingInput}
                title="恢复为工厂原始图"
              >
                重置工厂图
              </GlassButton>
            )}
          </div>
        </InputDropTarget>
        <div
          style={{
            display: 'grid',
            placeItems: 'center',
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            background: 'var(--glass-2-bg)',
            border: '1px solid var(--glass-border)',
            color: 'var(--text-3)',
            fontSize: '0.85rem',
            flexShrink: 0,
          }}
          aria-hidden="true"
        >
          ⇄
        </div>
        <CompareThumb
          url={displayResultUrl}
          label="生成图 · 平台"
          onClick={onPreview}
          enabled={!!displayResultUrl}
          placeholder={unit.status === 'pending' ? '未生成' : undefined}
          loading={unit.status === 'generating'}
          progress={unit.progress}
        />

        {/* 信息区 */}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '1rem' }}>{unit.goods_sn}</strong>
            <span style={{ color: 'var(--text-2)', fontSize: '0.85rem' }}>{unit.store_name}</span>
            <span
              style={{
                color: statusColor,
                fontWeight: 600,
                fontSize: '0.8rem',
                padding: '0.15rem 0.55rem',
                borderRadius: '999px',
                background: 'var(--glass-2-bg)',
                border: '1px solid var(--glass-border)',
              }}
            >
              {statusText}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.35rem', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-3)', fontSize: '0.82rem' }}>
              {unit.size} · {unit.material || '无材质'}
            </span>
            {unit.batch_id && (
              <code
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.72rem',
                  color: 'var(--text-3)',
                  background: 'var(--glass-1-bg)',
                  padding: '0.1rem 0.35rem',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--glass-border)',
                }}
              >
                {unit.batch_id}
              </code>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.35rem', flexWrap: 'wrap' }}>
            <CropToggle
              enabled={unit.crop_enabled}
              threshold={unit.crop_threshold}
              saving={cropSaving}
              onSave={(enabled, threshold) => onCropConfig(enabled, threshold)}
            />
            {unit.status === 'pending' && sizeMode === 'auto' && (
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  fontSize: '0.8rem',
                  whiteSpace: 'nowrap',
                }}
              >
                <span>比例</span>
                <select
                  value={sizeOverrides[String(unit.representative_order_item_id)] ?? unit.mapped_ratio}
                  onChange={(e) => onSizeOverride(e.target.value)}
                  style={{ width: '76px', padding: '0.15rem 0.4rem', fontSize: '0.78rem' }}
                >
                  {SIZE_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <span
                  className="hint"
                  style={{ whiteSpace: 'nowrap', marginTop: 0 }}
                >
                  自动：{unit.mapped_ratio}
                </span>
              </label>
            )}
            {unit.status === 'failed' && unit.error_msg && (
              <span className="hint" style={{ color: 'var(--danger)' }} title={unit.error_msg}>
                {unit.error_msg.slice(0, 50)}
              </span>
            )}
            {unit.status === 'uploaded' && unit.order_item_ids.length > 1 && (
              <span className="hint">覆盖 {unit.order_item_ids.length} 条订单</span>
            )}
            {showTime && (
              <span className="hint" style={{ fontSize: '0.72rem' }}>
                {unit.created_at
                  ? `同步 ${new Date(unit.created_at).toLocaleString()}`
                  : ''}
                {unit.erp_uploaded_at
                  ? ` · 已上传 ${new Date(unit.erp_uploaded_at).toLocaleString()}`
                  : ''}
              </span>
            )}
          </div>
          {cropSummary && (
            <div className="hint" style={{ marginTop: '0.25rem', color: 'var(--text-3)' }}>
              {cropSummary}
            </div>
          )}
          {unit.crop_enabled && unit.crop_meta?.error && (
            <div
              className="hint"
              style={{ marginTop: '0.25rem', color: 'var(--danger)' }}
              title={unit.crop_meta.error}
            >
              裁剪失败，上传将回退原图
            </div>
          )}
          {unit.crop_enabled &&
            !unit.crop_meta &&
            unit.result_image_url &&
            unit.status === 'completed' && (
              <div
                className="hint"
                style={{ marginTop: '0.25rem', color: 'var(--warning)' }}
                title="切换开关或调整阈值后自动计算裁剪结果"
              >
                尚未裁剪
              </div>
            )}
        </div>
      </div>

      {/* 右：操作按钮 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', alignItems: 'stretch' }}>
        {(unit.input_image_url || unit.result_image_url) && (
          <GlassButton size="sm" variant="secondary" onClick={onPreview}>
            对比预览
          </GlassButton>
        )}
        {unit.status === 'pending' && (
          <GlassButton size="sm" variant="primary" loading={generating} onClick={onGenerate}>
            生成此货号
          </GlassButton>
        )}
        {unit.status === 'failed' && (
          <GlassButton size="sm" variant="warning" onClick={onRetry}>
            重试
          </GlassButton>
        )}
        {unit.status === 'completed' && (
          <GlassButton size="sm" variant="primary" loading={uploading} onClick={onUpload}>
            上传到 ERP
          </GlassButton>
        )}
        {(unit.status === 'completed' || unit.status === 'failed') && unit.generation_task_id && (
          <GlassButton size="sm" variant="ghost" loading={regenerating} onClick={onRegenerate}>
            重新生成
          </GlassButton>
        )}
      </div>
    </div>
  )
}

/** 对比缩略图：1:1 contain 完整展示，点击打开放大预览；
 *  loading 时显示骨架动画 + 实时进度百分比（生成中），完成后图片平滑淡入 */
function CompareThumb({
  url,
  label,
  onClick,
  enabled,
  placeholder,
  loading = false,
  progress = 0,
}: {
  url: string | null
  label: string
  onClick: () => void
  enabled: boolean
  placeholder?: string
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
        onClick={() => enabled && onClick()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (enabled) onClick()
          }
        }}
        style={{
          width: '132px',
          height: '132px',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--glass-1-bg)',
          borderRadius: 'var(--radius-md)',
          border: `1.5px solid ${loading ? 'var(--accent-soft)' : enabled ? 'var(--glass-border)' : 'var(--input-border)'}`,
          overflow: 'hidden',
          cursor: enabled ? 'zoom-in' : 'default',
          transition: 'border-color var(--dur)',
        }}
        title={enabled ? '点击放大预览' : undefined}
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
            {/* 底部细进度条 */}
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
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              display: 'block',
            }}
          />
        ) : (
          <div style={{ color: 'var(--text-3)', fontSize: '0.8rem', textAlign: 'center' }}>
            {placeholder ?? '无图'}
          </div>
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
        {enabled && !loading && <IconZoomIn width={11} height={11} />}
      </div>
    </div>
  )
}
