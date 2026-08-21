import { forwardRef } from 'react'
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

/**
 * 液态玻璃表单控件（样式见 glass.css 原生元素规则）。
 * 相比裸元素仅提供统一 className 注入与 label 快捷组合。
 */

interface FieldWrapProps {
  label?: ReactNode
  hint?: ReactNode
  error?: string
  children: ReactNode
}

function FieldWrap({ label, hint, error, children }: FieldWrapProps) {
  return (
    <div className="form-group">
      {label && <label>{label}</label>}
      {children}
      {error ? <div className="hint" style={{ color: 'var(--danger)' }}>{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  )
}

export interface GlassInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode
  hint?: ReactNode
  error?: string
}

export const GlassInput = forwardRef<HTMLInputElement, GlassInputProps>(
  function GlassInput({ label, hint, error, className, ...rest }, ref) {
    return (
      <FieldWrap label={label} hint={hint} error={error}>
        <input ref={ref} className={className} {...rest} />
      </FieldWrap>
    )
  }
)

export interface GlassSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode
  hint?: ReactNode
  error?: string
}

export const GlassSelect = forwardRef<HTMLSelectElement, GlassSelectProps>(
  function GlassSelect({ label, hint, error, className, children, ...rest }, ref) {
    return (
      <FieldWrap label={label} hint={hint} error={error}>
        <select ref={ref} className={className} {...rest}>
          {children}
        </select>
      </FieldWrap>
    )
  }
)

export interface GlassTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode
  hint?: ReactNode
  error?: string
}

export const GlassTextarea = forwardRef<HTMLTextAreaElement, GlassTextareaProps>(
  function GlassTextarea({ label, hint, error, className, ...rest }, ref) {
    return (
      <FieldWrap label={label} hint={hint} error={error}>
        <textarea ref={ref} className={className} {...rest} />
      </FieldWrap>
    )
  }
)
