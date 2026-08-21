import type { ReactNode } from 'react'

interface PageHeaderProps {
  /** 小号眉标（编辑排版细节，如 "BATCH WORKSPACE"） */
  eyebrow?: string
  title: string
  description?: ReactNode
  actions?: ReactNode
}

/** 页面头：眉标 + 标题 + 描述 + 右侧操作区 */
export default function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: PageHeaderProps) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <p className="page-head-eyebrow">{eyebrow}</p>}
        <h2 className="page-head-title">{title}</h2>
        {description && <p className="page-head-description">{description}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  )
}
