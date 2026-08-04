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

// ---------- 多批次批量导出到文件夹（每个批次一个子文件夹） ----------

export interface BatchExportItem {
  /** 子文件夹名（=displayBatchId(batch_id)），纯字母数字、文件系统安全 */
  batchName: string
  /** 该批次的已完成图片，index 用于文件命名 */
  items: SaveItem[]
}

export type BatchConflictStrategy = 'overwrite' | 'skip'

export interface BatchExportProgress {
  /** 已处理完的批次数（跳过也算 done） */
  done: number
  /** 总批次数 */
  total: number
  /** 当前正在处理的批次名 */
  currentBatch: string
  /** 当前批次内正在写的图编号（0 = 还没开始） */
  currentFile: number
  /** 当前批次的图片总数 */
  fileTotal: number
  /** 当前批次是否成功（false = 失败或部分失败） */
  ok: boolean
  /** 当前批次是否被用户跳过 */
  skipped: boolean
}

export interface BatchExportItemResult {
  batchName: string
  total: number
  success: number
  failed: number
  errors: string[]
  /** true = 用户主动跳过 / 无可导出图片 */
  skipped: boolean
  /** 跳过的原因（如 "用户选择跳过" / "无已完成图片"） */
  reason?: string
}

export interface BatchExportResult {
  total: number
  /** 完全成功的批次数 */
  success: number
  /** 部分失败或整批失败的批次数 */
  failed: number
  /** 被跳过的批次数（用户跳过 + 无图片） */
  skipped: number
  details: BatchExportItemResult[]
}

export interface ExportBatchesOptions {
  /** 子文件夹已存在且非空时调用，返回用户决定 */
  onConflict: (batchName: string) => Promise<BatchConflictStrategy> | BatchConflictStrategy
  onProgress?: (p: BatchExportProgress) => void
  abortSignal?: AbortSignal
}

/**
 * 检查目录是否为空（无任何 entry）。
 * 一次性看到第一个 entry 就 return false，避免遍历大目录。
 */
export async function isDirectoryEmpty(
  dirHandle: FileSystemDirectoryHandle
): Promise<boolean> {
  // DOM lib 未包含 File System Access API 的 values() 类型（运行时支持）
  // 沿用文件顶部的 as-unknown-as 模式做局部类型增强
  const values = (dirHandle as unknown as {
    values: () => AsyncIterable<FileSystemHandle>
  }).values.bind(dirHandle)
  for await (const _entry of values()) {
    return false
  }
  return true
}

/**
 * 清空目录中的所有 entries（不删除目录本身）。
 *
 * 注意：不能在迭代时直接 removeEntry（迭代器会失效），所以先收集 name 再删。
 * 用 recursive: true 兼容可能存在的子目录（虽然本场景只会有图片文件）。
 */
export async function clearDirectory(
  dirHandle: FileSystemDirectoryHandle
): Promise<void> {
  const values = (dirHandle as unknown as {
    values: () => AsyncIterable<FileSystemHandle>
  }).values.bind(dirHandle)
  const names: string[] = []
  for await (const entry of values()) {
    names.push(entry.name)
  }
  for (const name of names) {
    try {
      await dirHandle.removeEntry(name, { recursive: true })
    } catch {
      // 某些浏览器/旧版本不支持 recursive，退化为单条删除
      try {
        await dirHandle.removeEntry(name)
      } catch {
        // best-effort：单个文件删不掉就跳过，最终由用户感知到
      }
    }
  }
}

/**
 * 批量导出多个批次到指定目录，每个批次一个子文件夹。
 *
 * 流程（每个批次）：
 *  1. 在父目录下 getDirectoryHandle(batchName, {create: true}) 获取/创建子文件夹
 *  2. 若该子文件夹非空 → 调用 ``onConflict`` 询问用户
 *     - 'overwrite' → 清空子文件夹
 *     - 'skip'      → 跳过该批次
 *  3. 复用 ``saveTasksToDirectory`` 把图片流式写入子文件夹
 *
 * - 批次数 > 1 时**顺序**处理：避免多个 ``window.confirm`` 同时弹出导致 UX 混乱
 *   （用户在选 A 的 confirm 时，B 的也弹了，用户不知道 B 属于哪个）
 * - 批次内单张图并发 8（来自 ``saveTasksToDirectory``）
 * - 任何子文件夹创建/清空失败都会单独捕获并计入 details，不会中断整批
 */
export async function exportBatchesToDirectory(
  batches: BatchExportItem[],
  parentDir: FileSystemDirectoryHandle,
  options: ExportBatchesOptions
): Promise<BatchExportResult> {
  const total = batches.length
  const details: BatchExportItemResult[] = []
  let successBatches = 0
  let failedBatches = 0
  let skippedBatches = 0

  for (let i = 0; i < batches.length; i++) {
    if (options.abortSignal?.aborted) break
    const batch = batches[i]

    // 进入新批次时先发一条 progress（让 UI 立即看到"开始处理 X"）
    options.onProgress?.({
      done: i,
      total,
      currentBatch: batch.batchName,
      currentFile: 0,
      fileTotal: batch.items.length,
      ok: false,
      skipped: false,
    })

    // 0. 无可导出图片 → 直接跳过（不创建空子文件夹，保持目录干净）
    if (batch.items.length === 0) {
      details.push({
        batchName: batch.batchName,
        total: 0,
        success: 0,
        failed: 0,
        errors: [],
        skipped: true,
        reason: '该批次无已完成图片',
      })
      skippedBatches++
      options.onProgress?.({
        done: i + 1,
        total,
        currentBatch: batch.batchName,
        currentFile: 0,
        fileTotal: 0,
        ok: true,
        skipped: true,
      })
      continue
    }

    // 1. 获取/创建子文件夹
    let subDirHandle: FileSystemDirectoryHandle
    try {
      subDirHandle = await parentDir.getDirectoryHandle(batch.batchName, {
        create: true,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      details.push({
        batchName: batch.batchName,
        total: batch.items.length,
        success: 0,
        failed: batch.items.length,
        errors: [`创建子文件夹失败: ${msg}`],
        skipped: false,
      })
      failedBatches++
      options.onProgress?.({
        done: i + 1,
        total,
        currentBatch: batch.batchName,
        currentFile: 0,
        fileTotal: batch.items.length,
        ok: false,
        skipped: false,
      })
      continue
    }

    // 2. 检查冲突
    const empty = await isDirectoryEmpty(subDirHandle)
    if (!empty) {
      const strategy = await options.onConflict(batch.batchName)
      if (strategy === 'skip') {
        details.push({
          batchName: batch.batchName,
          total: 0,
          success: 0,
          failed: 0,
          errors: [],
          skipped: true,
          reason: '用户选择跳过',
        })
        skippedBatches++
        options.onProgress?.({
          done: i + 1,
          total,
          currentBatch: batch.batchName,
          currentFile: 0,
          fileTotal: 0,
          ok: true,
          skipped: true,
        })
        continue
      }
      // overwrite: 先清空
      try {
        await clearDirectory(subDirHandle)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        details.push({
          batchName: batch.batchName,
          total: batch.items.length,
          success: 0,
          failed: batch.items.length,
          errors: [`清空子文件夹失败: ${msg}`],
          skipped: false,
        })
        failedBatches++
        options.onProgress?.({
          done: i + 1,
          total,
          currentBatch: batch.batchName,
          currentFile: 0,
          fileTotal: batch.items.length,
          ok: false,
          skipped: false,
        })
        continue
      }
    }

    // 3. 写文件（复用 saveTasksToDirectory 的并发/流式下载/错误聚合）
    const result = await saveTasksToDirectory(
      batch.items,
      subDirHandle,
      (p) => {
        options.onProgress?.({
          done: i,
          total,
          currentBatch: batch.batchName,
          currentFile: p.current,
          fileTotal: p.total,
          ok: p.ok,
          skipped: false,
        })
      },
      options.abortSignal
    )

    details.push({
      batchName: batch.batchName,
      total: result.total,
      success: result.success,
      failed: result.failed,
      errors: result.errors,
      skipped: false,
    })
    if (result.failed === 0) successBatches++
    else failedBatches++

    options.onProgress?.({
      done: i + 1,
      total,
      currentBatch: batch.batchName,
      currentFile: result.total,
      fileTotal: result.total,
      ok: result.failed === 0,
      skipped: false,
    })
  }

  return {
    total,
    success: successBatches,
    failed: failedBatches,
    skipped: skippedBatches,
    details,
  }
}
