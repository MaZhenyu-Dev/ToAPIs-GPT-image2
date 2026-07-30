import { downloadImage } from '../api'
import type { GenerationTaskItem, TaskStatus } from '../types'

interface Props {
  task: TaskStatus | GenerationTaskItem
  prompt?: string
  onPreview?: () => void
  onDownload?: () => void
}

export default function ResultActions({
  task,
  prompt,
  onPreview,
  onDownload,
}: Props) {
  const imageUrl = getImageUrl(task)
  const isCompleted = task.status === 'completed'

  const handleDownload = async () => {
    if (!imageUrl) return
    if (onDownload) {
      onDownload()
      return
    }
    try {
      const blob = await downloadImage(imageUrl)
      triggerDownload(blob, buildFileName(task, prompt))
    } catch (err) {
      alert(err instanceof Error ? err.message : '下载失败')
    }
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      {isCompleted && imageUrl && (
        <>
          <button
            type="button"
            onClick={onPreview}
            style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
          >
            预览
          </button>
          <button
            type="button"
            onClick={handleDownload}
            style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
          >
            下载
          </button>
        </>
      )}
    </div>
  )
}

function getImageUrl(
  task: TaskStatus | GenerationTaskItem
): string | null | undefined {
  if (isTaskStatus(task)) return task.url
  return task.image_url
}

function isTaskStatus(task: TaskStatus | GenerationTaskItem): task is TaskStatus {
  return !Object.prototype.hasOwnProperty.call(task, 'variant_id')
}

function buildFileName(
  task: TaskStatus | GenerationTaskItem,
  prompt?: string
): string {
  if (prompt) {
    const clean = prompt
      .replace(/[^\w\u4e00-\u9fa5]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30)
    return `${clean || 'image'}.png`
  }

  if (!isTaskStatus(task) && task.variant_prompt) {
    const clean = task.variant_prompt
      .replace(/[^\w\u4e00-\u9fa5]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30)
    return `${clean}_${task.size}_${task.resolution}.png`
  }

  const id = isTaskStatus(task) ? task.id : task.id
  return `task_${id}.png`
}

export function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
