// File System Access API 工具：将图片直接写入用户选择的本地目录，不压缩。
// 仅在 Chromium 内核浏览器（Chrome/Edge/Opera）可用。

export function isFsAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  )
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFsAccessSupported()) {
    throw new Error('当前浏览器不支持文件夹选择（需使用 Chrome / Edge / Opera）')
  }
  // FSA API 尚未纳入默认 TS lib（取决于 lib 版本），运行时存在即可
  const picker = (window as unknown as {
    showDirectoryPicker: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
  }).showDirectoryPicker
  return await picker({ mode: 'readwrite' })
}

export type ImageExt = 'png' | 'jpg' | 'webp' | 'gif'

/** 从 URL 推断图片后缀，无法识别时默认 png（与后端 download_image 一致）。 */
export function getExtensionFromUrl(url: string): ImageExt {
  const lower = url.toLowerCase().split('?', 1)[0].split('#', 1)[0]
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'jpg'
  if (lower.endsWith('.webp')) return 'webp'
  if (lower.endsWith('.gif')) return 'gif'
  return 'png'
}

export interface SaveItem {
  index: number
  task: { id: number | string; image_url?: string | null }
}

export interface SaveResult {
  total: number
  success: number
  failed: number
  errors: string[]
}

export interface SaveProgress {
  done: number
  total: number
  current: number
  ok: boolean
}

/**
 * 将多张图片流式写入用户指定的目录。
 * - 命名规则：`<index+1>.<ext>`，若同名已存在则改为 `<index+1>_<taskId>.<ext>`。
 * - 并发度 4，避免一次开太多连接拖垮后端代理。
 * - 通过 `fetch` + `ReadableStream.pipeTo(WritableStream)` 边下边写，内存友好。
 * - 失败不中断整批，最终在 `errors` 里返回每条失败的简要原因。
 */
export async function saveTasksToDirectory(
  items: SaveItem[],
  dirHandle: FileSystemDirectoryHandle,
  onProgress?: (p: SaveProgress) => void,
  abortSignal?: AbortSignal
): Promise<SaveResult> {
  const valid = items.filter((it) => it.task.image_url)
  const total = valid.length
  if (total === 0) {
    return { total: 0, success: 0, failed: 0, errors: [] }
  }

  const concurrency = 8
  let cursor = 0
  let success = 0
  const errors: string[] = []

  async function writeOne(item: SaveItem): Promise<void> {
    const { task, index } = item
    const imageUrl = task.image_url as string
    const ext = getExtensionFromUrl(imageUrl)
    const baseName = `${index + 1}`
    let name = `${baseName}.${ext}`

    // 若同名已存在，回退到带 taskId 的命名，避免覆盖
    try {
      await dirHandle.getFileHandle(name, { create: false })
      name = `${baseName}_${task.id}.${ext}`
    } catch {
      // 不存在，使用原名
    }

    const proxyUrl = `/api/generations/download?url=${encodeURIComponent(imageUrl)}`
    const fileHandle = await dirHandle.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    try {
      const resp = await fetch(proxyUrl, { signal: abortSignal })
      if (!resp.ok || !resp.body) {
        throw new Error(`HTTP ${resp.status}`)
      }
      await resp.body.pipeTo(writable)
    } catch (err) {
      // pipeTo 失败时可能已经部分写入，主动关闭流并删除空/残缺文件
      try { await writable.close() } catch { /* ignore */ }
      // best-effort 清理（如果 createWritable 时已经创建了空文件）
      try { await dirHandle.removeEntry(name, { recursive: false }) } catch { /* ignore */ }
      throw err
    }
  }

  async function worker(): Promise<void> {
    while (cursor < total) {
      if (abortSignal?.aborted) return
      const i = cursor++
      const item = valid[i]
      try {
        await writeOne(item)
        success++
        onProgress?.({ done: i + 1, total, current: item.index + 1, ok: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`#${item.index + 1}: ${msg}`)
        onProgress?.({ done: i + 1, total, current: item.index + 1, ok: false })
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker())
  )

  return { total, success, failed: total - success, errors }
}
