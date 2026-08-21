import type { ReactNode } from 'react'

interface EmptyStateProps {
  /** 图标组件实例（可选） */
  icon?: ReactNode
  title: string
  description?: ReactNode
  /** 行动按钮（可选） */
  action?: ReactNode
}

/** 空状态引导：图标 + 标题 + 说明 + 行动按钮 */
export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}
      <div className="empty-state-title">{title}</div>
      {description && <div className="empty-state-description">{description}</div>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
