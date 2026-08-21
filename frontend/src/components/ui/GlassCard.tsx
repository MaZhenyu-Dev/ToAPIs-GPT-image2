import type { HTMLAttributes, ReactNode } from 'react'

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  /** 悬浮形变：hover 轻微上浮 + 按压回弹 */
  hoverable?: boolean
  /** 内边距档位 */
  padding?: 'sm' | 'md' | 'lg' | 'none'
  children: ReactNode
}

/**
 * 液态玻璃卡片容器。
 * 新代码统一使用本组件承载面板，替代旧代码的 `.card` 类。
 */
export default function GlassCard({
  hoverable = false,
  padding = 'md',
  className,
  children,
  ...rest
}: GlassCardProps) {
  const classes = [
    'glass',
    hoverable ? 'glass-hover' : '',
    padding !== 'none' ? `glass-card-padding--${padding}` : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  )
}
