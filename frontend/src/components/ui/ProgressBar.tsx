interface ProgressBarProps {
  /** 0-100 */
  progress: number
  /** 进行中时呼吸动画 */
  animated?: boolean
  /** 自定义填充色（覆盖默认黄铜色） */
  color?: string
  className?: string
}

/** 渐变圆角进度条（黄铜默认色，可选呼吸动画） */
export default function ProgressBar({
  progress,
  animated = false,
  color,
  className,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, progress))
  return (
    <div
      className={`progress${className ? ` ${className}` : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <div
        className={`progress-fill${animated ? ' progress-fill--animated' : ''}`}
        style={{ width: `${clamped}%`, ...(color ? { background: color } : {}) }}
      />
    </div>
  )
}
