import type { CSSProperties } from 'react'

interface SkeletonProps {
  /** 宽度：number 视为 px */
  width?: number | string
  /** 高度：number 视为 px */
  height?: number | string
  borderRadius?: number | string
  className?: string
  style?: CSSProperties
}

/** 骨架占位（shimmer 扫描动画） */
export default function Skeleton({
  width = '100%',
  height = 14,
  borderRadius,
  className,
  style,
}: SkeletonProps) {
  return (
    <div
      className={`skeleton${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      style={{
        width,
        height,
        ...(borderRadius != null ? { borderRadius } : {}),
        ...style,
      }}
    />
  )
}
