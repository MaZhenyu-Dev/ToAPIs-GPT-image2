import JSZip from 'jszip'
import { downloadImage } from '../api'
import type { GenerationTaskItem } from '../types'

export interface DownloadItem {
  task: GenerationTaskItem
  index: number
}

export function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 按变体序号命名（1-based，与卡片 "#N" 一致） */
export function buildFileName(index: number): string {
  return `${index + 1}.png`
}

/** 展示用批次号：新格式（PREFIX+MMDD+seq，9-12 字符）完整显示；旧 UUID 截前 8 位 */
export function displayBatchId(batchId: string): string {
  if (batchId.length <= 12) return batchId
  return batchId.slice(0, 8)
}

/**
 * 下载任务图片：
 * - 单张 → 直接下载（不打包）
 * - 多张 → 打包 ZIP
 * 失败信息通过 onError 回调上抛（调用方决定用 Toast 还是内联展示）。
 */
export async function downloadTasks(
  items: DownloadItem[],
  zipName: string,
  onError: (msg: string) => void
): Promise<void> {
  const valid = items.filter((item) => item.task.image_url)
  if (valid.length === 0) {
    onError('暂无可下载的已完成图片')
    return
  }

  if (valid.length === 1) {
    const { task, index } = valid[0]
    try {
      const blob = await downloadImage(task.image_url as string)
      triggerDownload(blob, buildFileName(index))
    } catch (err) {
      onError(err instanceof Error ? err.message : '下载失败')
    }
    return
  }

  try {
    const zip = new JSZip()
    await Promise.all(
      valid.map(async ({ task, index }) => {
        const blob = await downloadImage(task.image_url as string)
        zip.file(buildFileName(index), blob)
      })
    )
    const content = await zip.generateAsync({ type: 'blob' })
    triggerDownload(content, zipName)
  } catch (err) {
    onError(err instanceof Error ? err.message : '打包下载失败')
  }
}

/** 从尺寸串解析 CSS aspect-ratio（如 "4:3" → "4 / 3"），无效回退 "1 / 1" */
export function sizeToAspectRatio(size: string | null | undefined): string {
  const match = /^(\d+):(\d+)$/.exec(size ?? '')
  if (match) return `${match[1]} / ${match[2]}`
  return '1 / 1'
}
