import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconArrowLeft,
  IconArrowRight,
  IconMaximize,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from './Icon'
import FadeInImage from './FadeInImage'

export interface LightboxMeta {
  /** 生成提示词 */
  prompt?: string
  size?: string
  resolution?: string
  batchId?: string
  /** 简短标题，如 "#3 · 客厅地毯爆品" */
  label?: string
}

export interface LightboxItem {
  url: string
  alt?: string
  meta?: LightboxMeta
  /** 源数据标识（如任务 ID）：调用方据此精确定位"点哪张看哪张" */
  sourceId?: number | string
}

interface LightboxProps {
  open: boolean
  items: LightboxItem[]
  /** 打开时定位到第几张（默认 0） */
  initialIndex?: number
  onClose: () => void
}

const MIN_SCALE = 1
const MAX_SCALE = 4
const ZOOM_STEP = 1.18
/** 饰件（工具栏/信息栏/导航）空闲自动隐藏时长 */
const CHROME_IDLE_MS = 2800

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 全屏图片预览（Lightbox）：
 * - 原图 contain 展示，不压缩裁切
 * - 滚轮 / 按钮缩放（1x–4x），按住拖拽平移，双击 1x ⇄ 2x
 * - ←/→ 在列表间切换，Esc / 遮罩 / 关闭按钮退出
 * - 饰件空闲自动淡出（鼠标/键盘唤醒），元信息压缩为单行条，
 *   Prompt 按需展开 —— 图片永远不被长期遮挡
 */
export default function Lightbox({
  open,
  items,
  initialIndex = 0,
  onClose,
}: LightboxProps) {
  const [index, setIndex] = useState(initialIndex)
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [chromeVisible, setChromeVisible] = useState(true)
  const [promptExpanded, setPromptExpanded] = useState(false)
  // 交叉淡入：当前显示图（切换中保持旧图）+ 待加载的新图
  const [displayItem, setDisplayItem] = useState<LightboxItem | null>(null)
  const [pendingItem, setPendingItem] = useState<LightboxItem | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const chromeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 打开时：定位条目、重置视图状态、锁定背景滚动
  useEffect(() => {
    if (!open) return
    const safeIndex = clamp(initialIndex, 0, Math.max(0, items.length - 1))
    setIndex(safeIndex)
    setScale(1)
    setTranslate({ x: 0, y: 0 })
    setLoading(true)
    setLoadError(false)
    setPromptExpanded(false)
    // 重置交叉淡入状态：首次打开没有"上一张"，显示骨架等待首图
    setDisplayItem(null)
    setPendingItem(null)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open, initialIndex, items.length])

  // 切换条目：旧图保留为背景（交叉淡入），新图进入 pending 等待加载
  useEffect(() => {
    if (!open) return
    const target = items[index]
    if (!target) return
    setScale(1)
    setTranslate({ x: 0, y: 0 })
    setLoadError(false)
    setPendingItem(target)
    // 首图（displayItem 为空）沿用 loading 骨架；后续切换走交叉淡入
    setLoading(displayItem === null)
  }, [index, items, open, displayItem === null])

  const resetView = useCallback(() => {
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }, [])

  const zoomBy = useCallback(
    (factor: number) => {
      setScale((current) => {
        const next = clamp(current * factor, MIN_SCALE, MAX_SCALE)
        if (next <= 1) {
          setTranslate({ x: 0, y: 0 })
        }
        return next
      })
    },
    []
  )

  const goTo = useCallback(
    (next: number) => {
      if (items.length === 0) return
      setIndex(((next % items.length) + items.length) % items.length)
    },
    [items.length]
  )

  // 键盘：Esc / ← / → / + / - / 0
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'ArrowLeft') {
        goTo(index - 1)
      } else if (e.key === 'ArrowRight') {
        goTo(index + 1)
      } else if (e.key === '+' || e.key === '=') {
        zoomBy(ZOOM_STEP)
      } else if (e.key === '-') {
        zoomBy(1 / ZOOM_STEP)
      } else if (e.key === '0') {
        resetView()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, index, items.length, goTo, zoomBy, resetView, onClose])

  // 滚轮缩放：原生非 passive 监听，阻止页面滚动
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || !open) return
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
    }
    stage.addEventListener('wheel', handleWheel, { passive: false })
    return () => stage.removeEventListener('wheel', handleWheel)
  }, [open, zoomBy])

  // 饰件空闲自动隐藏：鼠标/键盘唤醒，空闲 CHROME_IDLE_MS 后淡出
  useEffect(() => {
    if (!open) return
    const wake = () => {
      setChromeVisible(true)
      if (chromeTimer.current) clearTimeout(chromeTimer.current)
      chromeTimer.current = setTimeout(() => setChromeVisible(false), CHROME_IDLE_MS)
    }
    const handlePointerMove = () => wake()
    const handleKeyDown = () => wake()
    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('keydown', handleKeyDown)
    wake()
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('keydown', handleKeyDown)
      if (chromeTimer.current) clearTimeout(chromeTimer.current)
    }
  }, [open])

  // 拖拽平移时强制隐藏饰件，避免遮挡细节
  const chromeHidden = !chromeVisible || dragging

  // 拖拽平移（仅放大后）
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scale <= 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStart.current = { x: e.clientX, y: e.clientY, tx: translate.x, ty: translate.y }
    setDragging(true)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    setTranslate({ x: dragStart.current.tx + dx, y: dragStart.current.ty + dy })
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStart.current) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      dragStart.current = null
    }
    setDragging(false)
  }

  const handleDoubleClick = () => {
    if (scale > 1) {
      resetView()
    } else {
      setScale(2)
    }
  }

  if (!open) return null

  const current = items[index]
  if (!current) return null

  const meta = current.meta
  const canNavigate = items.length > 1

  // Portal 挂到 body：祖先容器的 backdrop-filter / transform 会破坏 fixed
  // 定位（成为 containing block），导致遮罩只覆盖容器区域而非全屏
  return createPortal(
    <div
      className={
        chromeHidden
          ? 'lightbox-overlay lightbox-overlay--chrome-hidden'
          : 'lightbox-overlay'
      }
      onClick={onClose}
    >
      {/* 顶部操作区 */}
      <div className="lightbox-toolbar">
        {canNavigate && (
          <div className="lightbox-counter" onClick={(e) => e.stopPropagation()}>
            <span className="lightbox-counter-index">{index + 1}</span>
            <span className="lightbox-counter-sep">/</span>
            <span>{items.length}</span>
          </div>
        )}
        <div className="lightbox-tools">
          <button
            type="button"
            className="lightbox-tool"
            onClick={(e) => {
              e.stopPropagation()
              zoomBy(ZOOM_STEP)
            }}
            aria-label="放大"
          >
            <IconZoomIn />
          </button>
          <button
            type="button"
            className="lightbox-tool"
            onClick={(e) => {
              e.stopPropagation()
              zoomBy(1 / ZOOM_STEP)
            }}
            aria-label="缩小"
          >
            <IconZoomOut />
          </button>
          <button
            type="button"
            className="lightbox-tool"
            onClick={(e) => {
              e.stopPropagation()
              resetView()
            }}
            aria-label="重置缩放"
          >
            <IconMaximize />
          </button>
          <span className="lightbox-zoom-level">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="lightbox-tool"
            onClick={onClose}
            aria-label="关闭预览"
          >
            <IconX />
          </button>
        </div>
      </div>

      {/* 左右切换 */}
      {canNavigate && (
        <>
          <button
            type="button"
            className="lightbox-nav lightbox-nav--prev"
            onClick={(e) => {
              e.stopPropagation()
              goTo(index - 1)
            }}
            aria-label="上一张"
          >
            <IconArrowLeft width={20} height={20} />
          </button>
          <button
            type="button"
            className="lightbox-nav lightbox-nav--next"
            onClick={(e) => {
              e.stopPropagation()
              goTo(index + 1)
            }}
            aria-label="下一张"
          >
            <IconArrowRight width={20} height={20} />
          </button>
        </>
      )}

      {/* 图片舞台 */}
      <div
        ref={stageRef}
        className={`lightbox-stage${dragging ? ' lightbox-stage--dragging' : ''}`}
        onClick={onClose}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={(e) => {
          e.stopPropagation()
          handleDoubleClick()
        }}
      >
        {/* 首图加载中：骨架（后续切换走交叉淡入，不显示骨架避免跳动） */}
        {loading && !displayItem && !loadError && (
          <div className="lightbox-hint" onClick={(e) => e.stopPropagation()}>
            <span className="skeleton lightbox-skeleton" />
          </div>
        )}
        {loadError && !displayItem && (
          <div className="lightbox-hint" onClick={(e) => e.stopPropagation()}>
            <div className="lightbox-error">图片加载失败，可能链接已失效。</div>
          </div>
        )}
        {/* 当前显示图：切换中保持显示并淡出（交叉淡入，内容区不塌缩） */}
        {displayItem && (
          <FadeInImage
            key={`display-${displayItem.url}`}
            src={displayItem.url}
            alt={displayItem.alt ?? '预览图片'}
            draggable={false}
            onClick={(e) => e.stopPropagation()}
            className={
              pendingItem
                ? 'lightbox-image lightbox-image--switching'
                : 'lightbox-image'
            }
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              cursor: scale > 1 ? 'grab' : 'zoom-in',
            }}
          />
        )}
        {/* 待加载新图：加载完成淡入并替换旧图 */}
        {pendingItem && (
          <FadeInImage
            key={`pending-${pendingItem.url}`}
            src={pendingItem.url}
            alt={pendingItem.alt ?? '预览图片'}
            draggable={false}
            onLoad={() => {
              if (pendingItem.url === displayItem?.url) {
                setPendingItem(null)
                return
              }
              setDisplayItem(pendingItem)
              setPendingItem(null)
              setLoading(false)
            }}
            onError={() => {
              setLoading(false)
              if (!displayItem) setLoadError(true)
              setPendingItem(null)
            }}
            onClick={(e) => e.stopPropagation()}
            className="lightbox-image lightbox-image--entering"
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              cursor: scale > 1 ? 'grab' : 'zoom-in',
            }}
          />
        )}
      </div>

      {/* 底部信息条：单行摘要 + Prompt 按需展开 */}
      {meta && (
        <div className="lightbox-meta" onClick={(e) => e.stopPropagation()}>
          <div className="lightbox-meta-row">
            {meta.label && <span className="lightbox-meta-label">{meta.label}</span>}
            {meta.size && <span>尺寸：{meta.size}</span>}
            {meta.resolution && <span>分辨率：{meta.resolution}</span>}
            {meta.batchId && (
              <span className="lightbox-meta-mono">{meta.batchId}</span>
            )}
            {meta.prompt && (
              <button
                type="button"
                className="lightbox-meta-toggle"
                onClick={() => setPromptExpanded((v) => !v)}
                aria-expanded={promptExpanded}
              >
                {promptExpanded ? '收起 Prompt' : '查看 Prompt'}
              </button>
            )}
          </div>
          {promptExpanded && meta.prompt && (
            <div className="lightbox-meta-prompt">{meta.prompt}</div>
          )}
        </div>
      )}
    </div>,
    document.body
  )
}
