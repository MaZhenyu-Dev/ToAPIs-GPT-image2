export type StatTone = 'default' | 'success' | 'danger' | 'accent'

interface StatCardProps {
  label: string
  value: number | string
  tone?: StatTone
}

/** 统计卡：大数字（等宽数字）+ 标签，用于批次/任务状态统计 */
export default function StatCard({ label, value, tone = 'default' }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className={`stat-card-value${tone !== 'default' ? ` stat-card-value--${tone}` : ''}`}>
        {value}
      </div>
      <div className="stat-card-label">{label}</div>
    </div>
  )
}
