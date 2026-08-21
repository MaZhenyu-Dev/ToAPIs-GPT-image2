import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createI2iMulti, uploadImage } from '../api'
import { I2I_MULTI_FILENAME_PATTERN } from '../constants'
import type {
  I2iMultiCreateResponse,
  ImageModelId,
  ImageQuality,
  TodayBatchCount,
} from '../types'

const UPLOAD_CONCURRENCY = 5
const PREVIEW_MAX_ROWS = 20

export type FolderRunPhase = 'idle' | 'uploading' | 'creating' | 'done' | 'error'

export interface FolderRunProgress {
  phase: FolderRunPhase
  uploaded: number
  totalToUpload: number
  currentFile?: string
  errorMsg?: string
  result?: I2iMultiCreateResponse
}

interface ScannedImage {
  seq: number
  filename: string
  file: File
}

// File System Access API 的最小类型声明（lib.dom.d.ts 暂未完整覆盖）
interface FSAccessWindow {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite'
  }) => Promise<FileSystemDirectoryHandle>
}
interface FSAccessDirectoryHandle {
  name: string
  entries(): AsyncIterable<[string, FSAccessFileSystemHandle]>
}
interface FSAccessFileSystemHandle {
  kind: 'file' | 'directory'
  getFile?(): Promise<File>
}

export function isFsAccessSupported(): boolean {
  if (typeof window === 'undefined') return false
  return (
    typeof (window as unknown as FSAccessWindow).showDirectoryPicker === 'function'
  )
}

interface UseFolderBatchOptions {
  groupId: number | ''
  /** 选中变体组的变体数量 K（决定每批任务数） */
  variantCount: number
  size: string
  resolution: string
  prefix: string
  todayBatchInfo: TodayBatchCount | null
  refreshTodayCount: (prefix: string) => Promise<void>
  /** 生图模型（默认 gpt-image-2）与精度档位（可选） */
  model?: ImageModelId
  quality?: ImageQuality
}

export interface UseFolderBatchReturn {
  /** 批量创建数量（快捷档位 + 自定义） */
  count: number
  setCount: (n: number) => void
  customCount: string
  setCustomCount: (v: string) => void
  /** 目录扫描 */
  dirHandle: { name: string } | null
  scanning: boolean
  scanError: string | null
  scannedCount: number
  ignoredCount: number
  handlePickFolder: () => Promise<void>
  /** seq 匹配 */
  nextSeq: number | null
  rangeMatched: { seq: number; filename: string }[]
  missingSeqs: number[]
  canStart: boolean
  /** 运行 */
  progress: FolderRunProgress | null
  runCreate: () => Promise<void>
  /** 完成后清理（再来一次） */
  resetRun: () => void
}

/**
 * 文件夹批量图生图逻辑（扫描 / 上传 / 创建），与 UI 解耦。
 *
 * 流程：
 * 1. showDirectoryPicker 选目录 → 扫描命名符合 `<数字>.png|jpg|jpeg` 的文件
 * 2. 按「下个批次号 seq 区间」过滤出实际匹配的图片（rangeMatched）
 * 3. runCreate：并发上传（信号量 5）→ /api/batches/i2i-multi 原子创建 N 个批次
 * 4. 任一上传失败 → 整批回滚，progress.phase = 'error'
 */
export function useFolderBatch(options: UseFolderBatchOptions): UseFolderBatchReturn {
  const {
    groupId,
    variantCount,
    size,
    resolution,
    prefix,
    todayBatchInfo,
    refreshTodayCount,
    model,
    quality,
  } = options

  const [count, setCountState] = useState<number>(10)
  const [customCount, setCustomCount] = useState<string>('')
  const [scanned, setScanned] = useState<ScannedImage[]>([])
  const [dirHandle, setDirHandle] = useState<FSAccessDirectoryHandle | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [ignoredCount, setIgnoredCount] = useState(0)
  const [progress, setProgress] = useState<FolderRunProgress | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setCount = useCallback((n: number) => {
    setCountState(n)
    setCustomCount('')
  }, [])

  // 期望 seq 起点：batch_id = {prefix}{MMDD}{seq}，跳过 prefix + 4 位日期只取尾部 seq
  const nextSeq = useMemo(() => {
    if (!todayBatchInfo) return null
    const { next_batch_id, prefix: pfx } = todayBatchInfo
    if (next_batch_id.length <= pfx.length + 4) return null
    const seqStr = next_batch_id.slice(pfx.length + 4)
    const n = parseInt(seqStr, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }, [todayBatchInfo])

  const rangeMatched = useMemo(() => {
    if (nextSeq === null) return []
    const start = nextSeq
    const end = nextSeq + count - 1
    return scanned
      .filter((img) => img.seq >= start && img.seq <= end)
      .sort((a, b) => a.seq - b.seq)
  }, [scanned, nextSeq, count])

  const missingSeqs = useMemo(() => {
    if (nextSeq === null) return [] as number[]
    const start = nextSeq
    const end = nextSeq + count - 1
    const have = new Set(rangeMatched.map((r) => r.seq))
    const missing: number[] = []
    for (let s = start; s <= end; s++) {
      if (!have.has(s)) missing.push(s)
    }
    return missing
  }, [nextSeq, count, rangeMatched])

  const canStart =
    !!groupId &&
    variantCount > 0 &&
    nextSeq !== null &&
    rangeMatched.length > 0 &&
    progress?.phase !== 'uploading' &&
    progress?.phase !== 'creating'

  const handlePickFolder = useCallback(async () => {
    setScanError(null)
    if (!isFsAccessSupported()) {
      setScanError('当前浏览器不支持文件夹直读，请改用 Chrome / Edge / Opera 最新版')
      return
    }
    let handle: FSAccessDirectoryHandle
    try {
      const picker = (window as unknown as FSAccessWindow).showDirectoryPicker
      if (!picker) throw new Error('当前浏览器不支持 showDirectoryPicker')
      handle = (await picker({ mode: 'read' })) as unknown as FSAccessDirectoryHandle
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      setScanError(err instanceof Error ? err.message : '选择目录失败')
      return
    }

    setScanning(true)
    setDirHandle(handle)
    setScanned([])
    setIgnoredCount(0)
    setProgress(null)

    const found: ScannedImage[] = []
    let ignored = 0
    try {
      for await (const [name, entry] of handle.entries()) {
        if (entry.kind !== 'file') continue
        const m = I2I_MULTI_FILENAME_PATTERN.exec(name)
        if (!m || !entry.getFile) {
          ignored += 1
          continue
        }
        const file = await entry.getFile()
        found.push({ seq: parseInt(m[1], 10), filename: name, file })
      }
      found.sort((a, b) => a.seq - b.seq)
      if (mountedRef.current) {
        setScanned(found)
        setIgnoredCount(ignored)
      }
    } catch (err) {
      if (mountedRef.current) {
        setScanError(err instanceof Error ? err.message : '扫描目录失败')
        setScanned([])
        setIgnoredCount(0)
      }
    } finally {
      if (mountedRef.current) setScanning(false)
    }
  }, [])

  const runCreate = useCallback(async () => {
    if (rangeMatched.length === 0) return
    setProgress({
      phase: 'uploading',
      uploaded: 0,
      totalToUpload: rangeMatched.length,
    })

    // Phase 1：并发上传（信号量 UPLOAD_CONCURRENCY），任一失败整批回滚
    const urls: string[] = new Array(rangeMatched.length)
    let uploaded = 0
    let firstError: string | null = null

    async function uploadOne(idx: number, img: ScannedImage): Promise<void> {
      try {
        const res = await uploadImage(img.file)
        urls[idx] = res.url
        uploaded += 1
        if (mountedRef.current) {
          setProgress((p) => (p ? { ...p, uploaded, currentFile: img.filename } : p))
        }
      } catch (err) {
        if (!firstError) {
          firstError = err instanceof Error ? err.message : '上传失败'
        }
        throw err
      }
    }

    const sem = { count: 0, queue: [] as Array<() => void> }
    const acquire = () =>
      new Promise<void>((resolve) => {
        if (sem.count < UPLOAD_CONCURRENCY) {
          sem.count += 1
          resolve()
        } else {
          sem.queue.push(resolve)
        }
      })
    const release = () => {
      const next = sem.queue.shift()
      if (next) next()
      else sem.count -= 1
    }

    let uploadFailed = false
    await Promise.all(
      rangeMatched.map(async (img, idx) => {
        await acquire()
        try {
          await uploadOne(idx, img)
        } catch {
          uploadFailed = true
        } finally {
          release()
        }
      })
    )

    if (uploadFailed) {
      if (mountedRef.current) {
        setProgress({
          phase: 'error',
          uploaded,
          totalToUpload: rangeMatched.length,
          errorMsg:
            firstError || `已上传 ${uploaded}/${rangeMatched.length} 张；任一失败将整体回滚`,
        })
      }
      return
    }

    // Phase 2：原子创建所有批次
    if (mountedRef.current) {
      setProgress((p) => (p ? { ...p, phase: 'creating' } : p))
    }

    try {
      const result = await createI2iMulti({
        group_id: Number(groupId),
        image_urls: urls,
        size,
        resolution,
        prefix,
        model,
        quality,
      })
      if (mountedRef.current) {
        setProgress({
          phase: 'done',
          uploaded: rangeMatched.length,
          totalToUpload: rangeMatched.length,
          result,
        })
        void refreshTodayCount(prefix)
      }
    } catch (err) {
      if (mountedRef.current) {
        setProgress({
          phase: 'error',
          uploaded: rangeMatched.length,
          totalToUpload: rangeMatched.length,
          errorMsg: err instanceof Error ? err.message : '创建批次失败',
        })
      }
    }
  }, [rangeMatched, groupId, size, resolution, prefix, refreshTodayCount])

  const resetRun = useCallback(() => {
    setProgress(null)
    setScanned([])
    setDirHandle(null)
    setIgnoredCount(0)
    setScanError(null)
  }, [])

  return {
    count,
    setCount,
    customCount,
    setCustomCount,
    dirHandle,
    scanning,
    scanError,
    scannedCount: scanned.length,
    ignoredCount,
    handlePickFolder,
    nextSeq,
    rangeMatched,
    missingSeqs,
    canStart,
    progress,
    runCreate,
    resetRun,
  }
}

export { PREVIEW_MAX_ROWS }
