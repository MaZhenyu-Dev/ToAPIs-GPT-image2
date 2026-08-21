import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning'
export type ButtonSize = 'sm' | 'md'

interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** loading 态：禁用点击并显示旋转指示器 */
  loading?: boolean
  /** 前置图标（SVG 组件实例） */
  icon?: ReactNode
  children?: ReactNode
}

/**
 * 液态玻璃按钮（黄铜主色实底、无渐变）。
 * type 默认 button，避免表单内误触提交。
 */
const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  function GlassButton(
    {
      variant = 'secondary',
      size = 'md',
      loading = false,
      icon,
      className,
      children,
      disabled,
      type = 'button',
      ...rest
    },
    ref
  ) {
    const classes = [
      'btn',
      `btn-${variant}`,
      size === 'sm' ? 'btn-sm' : '',
      loading ? 'btn-loading' : '',
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <button
        ref={ref}
        type={type}
        className={classes}
        disabled={disabled || loading}
        {...rest}
      >
        {icon}
        {children}
      </button>
    )
  }
)

export default GlassButton
