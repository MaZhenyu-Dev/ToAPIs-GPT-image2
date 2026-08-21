import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BATCH_PREFIX_PATTERN,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_RELAY_PREFIX,
  IMAGE_MODEL_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
  RELAY_PREFIX_STORAGE_KEY,
} from '../../constants'
import type {
  AutoRelayConfig,
  ImageModelId,
  ImageQuality,
  VariantGroupListItem,
} from '../../types'
import GlassButton from '../ui/GlassButton'
import ParameterSelector from '../ParameterSelector'
import SegmentedControl from '../ui/SegmentedControl'
import { IconLayers } from '../ui/Icon'

/** 手动接力：收集到的图片统计（显示在弹窗说明区） */
export interface RelayStats {
  /** 选中的源批次数量 */
  batchCount: number
  /** 收集到的已完成图片数量 */
  imageCount: number
  /** 无已完成图片、被跳过的批次数量 */
  skippedCount: number
}

interface AutoRelayDialogProps {
  /** 自动接力：已有配置（修改回填）；手动接力传 null */
  initial: AutoRelayConfig | null
  groups: VariantGroupListItem[]
  /** 手动接力：收集统计（存在则按手动模式渲染） */
  stats?: RelayStats | null
  /** 确认回调：参数校验通过 + 免责声明勾选后才触发 */
  onConfirm: (config: AutoRelayConfig) => void
  onClose: () => void
}

/**
 * 接力套图弹窗（手动 / 自动共用同一样式）：
 * 变体组（套图提示词）/ 独立前缀 / 尺寸参数 / 免责声明。
 *
 * - 自动模式（无 stats）：配置在裂变批次提交时随请求传给后端，
 *   批次全部结束后自动创建套图批次
 * - 手动模式（有 stats）：用已选批次收集到的已完成图片立即创建套图批次
 */
export default function AutoRelayDialog({
  initial,
  groups,
  stats,
  onConfirm,
  onClose,
}: AutoRelayDialogProps) {
  const isManual = stats != null

  const [groupId, setGroupId] = useState<number | ''>(initial?.group_id ?? '')
  const [prefix, setPrefix] = useState<string>(
    initial?.prefix || loadStoredRelayPrefix()
  )
  const [size, setSize] = useState(initial?.size ?? '1:1')
  const [resolution, setResolution] = useState(initial?.resolution ?? '1k')
  const [model, setModel] = useState<ImageModelId>(
    initial?.model ?? DEFAULT_IMAGE_MODEL
  )
  const [quality, setQuality] = useState<ImageQuality>(
    initial?.quality ?? DEFAULT_IMAGE_QUALITY
  )
  const [agreed, setAgreed] = useState(false)

  // 自动模式：打开时若带初始配置，回填并默认勾选免责声明（修改既有配置）
  useEffect(() => {
    if (!initial) return
    setGroupId(initial.group_id)
    if (initial.prefix) setPrefix(initial.prefix)
    setSize(initial.size)
    setResolution(initial.resolution)
    if (initial.model) setModel(initial.model)
    if (
      initial.quality === 'low' ||
      initial.quality === 'medium' ||
      initial.quality === 'high'
    ) {
      setQuality(initial.quality)
    }
    setAgreed(true)
  }, [initial])

  const selectedModel = IMAGE_MODEL_OPTIONS.find((m) => m.id === model)
  const qualitySupported = selectedModel?.qualitySupported ?? false
  const selectedGroup = groups.find((g) => g.id === groupId)
  const K = selectedGroup?.variant_count ?? 0

  const prefixValid = BATCH_PREFIX_PATTERN.test(prefix)
  const canConfirm =
    groupId !== '' && prefixValid && agreed && (!isManual || stats.imageCount > 0)

  const handlePrefixChange = (value: string) => {
    const upper = value.toUpperCase()
    setPrefix(upper)
    try {
      localStorage.setItem(RELAY_PREFIX_STORAGE_KEY, upper)
    } catch {
      // localStorage 写入失败时静默
    }
  }

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  // Portal 挂到 body：祖先容器的 backdrop-filter/transform 会破坏 fixed
  // 定位（成为 containing block），导致遮罩只覆盖容器区域而非全屏
  return createPortal(
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="relay-dialog-title"
      >
        <h3 className="modal-title" id="relay-dialog-title">
          <span className="modal-title-icon">
            <IconLayers width={17} height={17} />
          </span>
          {isManual ? '接力套图' : '自动接力套图'}
        </h3>
        <div className="modal-body">
          {isManual ? (
            <>
              将使用从 {stats.batchCount} 个批次中收集的{' '}
              <strong>{stats.imageCount}</strong> 张已完成图片创建套图批次：
              每张图一个批次
              {K > 0 && `（× ${K} 个变体 = ${stats.imageCount * K} 个任务）`}。
              {stats.skippedCount > 0 && (
                <div className="hint" style={{ color: 'var(--warning)', marginTop: '0.25rem' }}>
                  其中 {stats.skippedCount} 个批次无已完成图片，将跳过。
                </div>
              )}
            </>
          ) : (
            <>
              本批次全部生成结束后，将自动用其中的已完成图片创建套图批次：
              每张图一个批次
              {K > 0 && `（× ${K} 个变体）`}。
              无需下载再上传，失败任务自动跳过。
            </>
          )}
        </div>

        <div className="form-group" style={{ marginTop: 'var(--space-4)' }}>
          <label htmlFor="relay-group">套图变体组（套图提示词）</label>
          <select
            id="relay-group"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : '')}
            autoFocus
          >
            <option value="">请选择</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}（{g.variant_count} 个变体）
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="relay-prefix">套图批次前缀</label>
          <input
            id="relay-prefix"
            type="text"
            value={prefix}
            onChange={(e) => handlePrefixChange(e.target.value)}
            maxLength={10}
            placeholder={DEFAULT_RELAY_PREFIX}
            title="套图批次号前缀（独立于裂变前缀），仅支持 A-Z / 0-9，1-10 位；自动保存到浏览器本地"
            style={prefixValid ? undefined : { borderColor: 'var(--danger)' }}
          />
          {!prefixValid && (
            <div className="hint" style={{ color: 'var(--danger)' }}>
              前缀仅支持 1-10 位 A-Z / 0-9
            </div>
          )}
        </div>

        <ParameterSelector
          size={size}
          resolution={resolution}
          onChange={({ size: s, resolution: r }) => {
            setSize(s)
            setResolution(r)
          }}
        />

        <div className="row">
          <div className="form-group">
            <label htmlFor="relay-model">生图模型</label>
            <select
              id="relay-model"
              value={model}
              onChange={(e) => setModel(e.target.value as ImageModelId)}
            >
              {IMAGE_MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {qualitySupported && (
            <div className="form-group">
              <label>精度档位</label>
              <SegmentedControl<ImageQuality>
                ariaLabel="接力套图精度档位"
                value={quality}
                onChange={setQuality}
                options={IMAGE_QUALITY_OPTIONS.map((q) => ({
                  value: q.id,
                  label: q.label,
                  title:
                    q.id === 'low'
                      ? '快速省钱，适合草稿/预览'
                      : q.id === 'high'
                        ? '最高精度，适合正式出图'
                        : '平衡速度与质量',
                }))}
              />
            </div>
          )}
        </div>

        <label
          className="relay-disclaimer"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.5rem',
            marginTop: 'var(--space-4)',
            cursor: 'pointer',
            fontSize: '0.8rem',
          }}
        >
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            style={{ marginTop: '0.15rem' }}
          />
          <span>
            我已知晓：提交的提示词（prompt）不规范可能导致产品图畸形，
            由此产生的套图质量问题与本项目无关。
          </span>
        </label>

        <div className="modal-actions">
          <GlassButton variant="ghost" onClick={onClose}>
            取消
          </GlassButton>
          <GlassButton
            variant="primary"
            disabled={!canConfirm}
            onClick={() =>
              onConfirm({
                group_id: Number(groupId),
                prefix,
                size,
                resolution,
                model,
                quality: qualitySupported ? quality : undefined,
              })
            }
          >
            {isManual ? '开始接力' : '确认启用自动接力'}
          </GlassButton>
        </div>
      </div>
    </div>,
    document.body
  )
}

function loadStoredRelayPrefix(): string {
  try {
    const raw = localStorage.getItem(RELAY_PREFIX_STORAGE_KEY)
    if (raw && BATCH_PREFIX_PATTERN.test(raw.toUpperCase())) {
      return raw.toUpperCase()
    }
  } catch {
    // localStorage 不可用时静默回退
  }
  return DEFAULT_RELAY_PREFIX
}
