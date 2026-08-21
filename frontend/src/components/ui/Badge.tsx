import type { ReactNode } from 'react'

export type BadgeTone = 'success' | 'danger' | 'warning' | 'accent' | 'neutral'

interface BadgeProps {
  tone?: BadgeTone
  /** 前置呼吸光点（用于进行中状态） */
  pulse?: boolean
  title?: string
  children: ReactNode
}

/** 状态徽章（降饱和语义色 + 呼吸光点） */
export default function Badge({ tone = 'neutral', pulse = false, title, children }: BadgeProps) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {pulse && <span className="badge-dot badge-dot--pulse" aria-hidden="true" />}
      {children}
    </span>
  )
}
