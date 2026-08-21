import type { ReactNode } from 'react'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
  title?: string
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /** a11y：aria-label，如 "批量生成模式" */
  ariaLabel?: string
  className?: string
}

/**
 * 分段切换控件（胶囊形，液态玻璃质感）。
 * 用法：<SegmentedControl options={[{value:'a',label:'A'}]} value={v} onChange={setV} />
 */
export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={`segmented${className ? ` ${className}` : ''}`}
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={option.disabled}
            title={option.title}
            className={isActive ? 'segmented-item segmented-item--active' : 'segmented-item'}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
