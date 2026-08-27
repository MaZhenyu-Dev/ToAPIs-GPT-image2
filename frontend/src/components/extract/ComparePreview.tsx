import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconMaximize, IconX, IconZoomIn, IconZoomOut } from '../ui/Icon'
import { formatCropSummary } from '../../lib/cropFormat'
import type { ErpExtractUnit } from '../../types'

const MIN_SCALE = 1
const MAX_SCALE = 4
const ZOOM_STEP = 1.18

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 双图同屏对比预览：输入图（工厂）⇄ 生成图（平台）并排显示，
 * 两张图各自支持滚轮/按钮缩放（1x-4x）、拖拽平移、双击 1x⇄2x。
 */
export default function ComparePreview({
  unit,
  onClose,
}: {
  unit: ErpExtractUnit | null
  onClose: () => void
}) {
  // Esc 关闭 + 锁定背景滚动
  useEffect(() => {
    if (!unit) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previous
    }
  }, [unit, onClose])

  if (!unit) return null

  // 白边裁剪：开启且有裁剪结果 → 展示裁剪图；统计信息条随 meta 渲染
  const resultUrl =
    unit.crop_enabled && unit.crop_image_url
      ? unit.crop_image_url
      : unit.result_image_url
  const resultNote =
    unit.crop_enabled && unit.crop_meta ? formatCropSummary(unit.crop_meta) : null

  return createPortal(
    <div className="lightbox-overlay" onClick={onClose}>
      {/* 顶部信息条 */}
      <div className="lightbox-toolbar" style={{ justifyContent: 'space-between' }}>
        <div
          className="lightbox-counter"
          onClick={(e) => e.stopPropagation()}
          style={{ cursor: 'default' }}
        >
          <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
            对比预览 · {unit.goods_sn}
            {unit.store_name ? ` · ${unit.store_name}` : ''}
          </span>
        </div>
        <div className="lightbox-tools">
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

      {/* 双图并排舞台 */}
      <div
        style={{
          position: 'absolute',
          inset: '64px 24px 32px',
          display: 'flex',
          alignItems: 'stretch',
          gap: '20px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <ComparePane key={`input-${unit.unit_key}`} url={unit.input_image_url} label="输入图 · 工厂" />
        <div
          style={{
            display: 'grid',
            placeItems: 'center',
            width: '36px',
            height: '36px',
            alignSelf: 'center',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.18)',
            color: 'rgba(255,255,255,0.75)',
            fontSize: '1.1rem',
            flexShrink: 0,
            userSelect: 'none',
          }}
          aria-hidden="true"
        >
          ⇄
        </div>
        <ComparePane key={`result-${unit.unit_key}`} url={resultUrl} label="生成图 · 平台" note={resultNote} />
      </div>

      {/* 底部操作提示 */}
      <div
        style={{
          position: 'absolute',
          bottom: '10px',
          left: 0,
          right: 0,
          textAlign: 'center',
          color: 'rgba(255,255,255,0.5)',
          fontSize: '0.75rem',
          pointerEvents: 'none',
        }}
      >
        滚轮 / 按钮缩放 · 拖拽移动 · 双击 1x ⇄ 2x
      </div>
    </div>,
    document.body
  )
}

/** 单张图的缩放/拖拽面板 */
function ComparePane({
  url,
  label,
  note,
}: {
  url: string | null
  label: string
  note?: string | null
}) {
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  /** 边界钳制：放大后的图不能拖出视野（用图片实际布局尺寸 × scale 计算溢出量） */
  const clampTranslate = useCallback(
    (tx: number, ty: number): { x: number; y: number } => {
      const stage = stageRef.current
      if (!stage) return { x: tx, y: ty }
      const img = imgRef.current
      const imgW = img ? img.offsetWidth : stage.clientWidth
      const imgH = img ? img.offsetHeight : stage.clientHeight
      const maxX = Math.max(0, (imgW * scale - stage.clientWidth) / 2)
      const maxY = Math.max(0, (imgH * scale - stage.clientHeight) / 2)
      return { x: clamp(tx, -maxX, maxX), y: clamp(ty, -maxY, maxY) }
    },
    [scale]
  )

  const zoomBy = useCallback(
    (factor: number) => {
      setScale((current) => {
        const next = clamp(current * factor, MIN_SCALE, MAX_SCALE)
        if (next <= 1) {
          setTranslate({ x: 0, y: 0 })
        } else {
          // 放大后把已有偏移钳制到新边界内
          setTranslate((prev) => clampTranslate(prev.x, prev.y))
        }
        return next
      })
    },
    [clampTranslate]
  )

  const resetView = useCallback(() => {
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }, [])

  // 滚轮缩放（阻止页面滚动）
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
    }
    stage.addEventListener('wheel', handleWheel, { passive: false })
    return () => stage.removeEventListener('wheel', handleWheel)
  }, [zoomBy])

  // 拖拽平移（仅放大后，带边界约束）
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
    setTranslate(clampTranslate(dragStart.current.tx + dx, dragStart.current.ty + dy))
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStart.current) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      dragStart.current = null
    }
    setDragging(false)
  }

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      <div
        ref={stageRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (scale > 1) resetView()
          else setScale(2)
        }}
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          borderRadius: '12px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.1)',
          cursor: url ? (scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in') : 'default',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        {url ? (
          <img
            ref={imgRef}
            src={url}
            alt={label}
            draggable={false}
            style={{
              // 与 Lightbox 完全一致的完整显示方案：
              // absolute + inset:0 + margin:auto + max-width/height:100%，
              // 图片按比例适配面板、绝不溢出裁剪（width/height:100% 的
              // 百分比高度在 flex/grid 容器中对替换元素解析会失效导致截断）
              position: 'absolute',
              inset: 0,
              margin: 'auto',
              maxWidth: '100%',
              maxHeight: '100%',
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              transition: dragging ? 'none' : 'transform 0.1s var(--ease-glass)',
              pointerEvents: 'none',
              userSelect: 'none',
              willChange: 'transform',
            }}
          />
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              color: 'rgba(255,255,255,0.4)',
              fontSize: '0.85rem',
            }}
          >
            未生成
          </div>
        )}
      </div>

      {/* 面板工具条：标签 + 缩放控制 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
        }}
      >
        <span
          style={{
            color: 'rgba(255,255,255,0.85)',
            fontSize: '0.8rem',
            fontWeight: 600,
            marginRight: '6px',
          }}
        >
          {label}
        </span>
        <button
          type="button"
          className="lightbox-tool"
          onClick={() => zoomBy(ZOOM_STEP)}
          aria-label={`${label} 放大`}
        >
          <IconZoomIn />
        </button>
        <button
          type="button"
          className="lightbox-tool"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          aria-label={`${label} 缩小`}
        >
          <IconZoomOut />
        </button>
        <button
          type="button"
          className="lightbox-tool"
          onClick={resetView}
          aria-label={`${label} 重置缩放`}
        >
          <IconMaximize />
        </button>
        <span
          style={{
            color: 'rgba(255,255,255,0.5)',
            fontSize: '0.72rem',
            fontVariantNumeric: 'tabular-nums',
            minWidth: '40px',
            textAlign: 'left',
          }}
        >
          {Math.round(scale * 100)}%
        </span>
        {note && (
          <span
            style={{
              color: 'rgba(255,255,255,0.65)',
              fontSize: '0.72rem',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '46%',
              marginLeft: '8px',
            }}
            title={note}
          >
            {note}
          </span>
        )}
      </div>
    </div>
  )
}
