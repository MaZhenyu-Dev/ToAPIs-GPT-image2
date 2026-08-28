import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createI2iMulti, uploadImage } from '../api'
import { I2I_MULTI_IMAGE_EXTS, I2I_MULTI_MAX_FILE_SIZE, MAX_I2I_MULTI_COUNT } from '../constants'
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

/** 名称自然排序（数字感知）：1.png, 2.png, ..., 10.png，与 Windows 资源管理器默认排序一致 */
const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

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
  /**
   * 存在超过 I2I_MULTI_MAX_FILE_SIZE 的图片时，开始上传前确认（超限图片已被过滤，
   * 不会上传）；返回 false 中止本次创建。缺省时不弹确认直接跳过超限图片。
   */
  onOversizedConfirm?: (oversizedNames: string[], uploadCount: number) => Promise<boolean>
}

export interface UseFolderBatchReturn {
  /** 用户自定义图片数量（空字符串 = 全部；最大 MAX_I2I_MULTI_COUNT） */
  limit: string
  setLimit: (v: string) => void
  /** 目录扫描 */
  dirHandle: { name: string } | null
  scanning: boolean
  scanError: string | null
  scannedCount: number
  ignoredCount: number
  /** 超过大小上限、将被跳过的图片数 / 文件名列表（自然排序顺序） */
  oversizedCount: number
  oversizedNames: string[]
  handlePickFolder: () => Promise<void>
  /** 将使用的图片（自然排序后取前 N 张，上限 300） */
  selectedImages: ScannedImage[]
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
 * 1. showDirectoryPicker 选目录 → 扫描所有 png/jpg/jpeg 图片
 * 2. 按文件名自然排序（数字感知，同 Windows 资源管理器默认排序）
 * 3. 过滤超过 I2I_MULTI_MAX_FILE_SIZE 的图片（若存在则先经 onOversizedConfirm 确认）
 * 4. 用户自定义数量（不填 = 全部，上限 300），在过滤后的图片中取前 N 张
 * 5. runCreate：并发上传（信号量 5）→ /api/batches/i2i-multi 原子创建 N 个批次
 * 6. 任一上传失败 → 整批回滚，progress.phase = 'error'
 */
export function useFolderBatch(options: UseFolderBatchOptions): UseFolderBatchReturn {
  const {
    groupId,
    variantCount,
    size,
    resolution,
    prefix,
    refreshTodayCount,
    model,
    quality,
    onOversizedConfirm,
  } = options

  const [limit, setLimitState] = useState<string>('')
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

  const setLimit = useCallback((v: string) => {
    setLimitState(v.replace(/[^\d]/g, ''))
  }, [])

  // 超过大小上限的图片：整目录过滤，不参与选取（后端上传接口上限 10MB）
  const oversizedImages = useMemo(
    () => scanned.filter((s) => s.file.size > I2I_MULTI_MAX_FILE_SIZE),
    [scanned]
  )
  const validImages = useMemo(
    () => scanned.filter((s) => s.file.size <= I2I_MULTI_MAX_FILE_SIZE),
    [scanned]
  )

  // 实际使用的图片数量：先过滤超限，再取前 N（不填 = 全部，上限 MAX_I2I_MULTI_COUNT）
  const selectedCount = useMemo(() => {
    if (limit === '') return Math.min(validImages.length, MAX_I2I_MULTI_COUNT)
    const n = parseInt(limit, 10)
    if (!Number.isFinite(n) || n <= 0) return 0
    return Math.min(n, validImages.length, MAX_I2I_MULTI_COUNT)
  }, [limit, validImages.length])

  const selectedImages = useMemo(
    () => validImages.slice(0, selectedCount),
    [validImages, selectedCount]
  )

  const canStart =
    !!groupId &&
    variantCount > 0 &&
    selectedImages.length > 0 &&
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
        const ext = name.toLowerCase().split('.').pop() ?? ''
        if (!I2I_MULTI_IMAGE_EXTS.includes(ext as (typeof I2I_MULTI_IMAGE_EXTS)[number])) {
          ignored += 1
          continue
        }
        if (!entry.getFile) {
          ignored += 1
          continue
        }
        const file = await entry.getFile()
        found.push({ filename: name, file })
      }
      // 名称自然排序（数字感知）：1.png, 2.png, ..., 10.png（Windows 默认顺序）
      found.sort((a, b) => naturalCollator.compare(a.filename, b.filename))
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
    if (selectedImages.length === 0) return

    // 超限确认：点击开始时若有超过 10MB 的图片，先弹窗确认（超限图片已在选取阶段过滤）
    if (oversizedImages.length > 0 && onOversizedConfirm) {
      const ok = await onOversizedConfirm(
        oversizedImages.map((s) => s.filename),
        selectedImages.length
      )
      if (!ok) return
    }

    setProgress({
      phase: 'uploading',
      uploaded: 0,
      totalToUpload: selectedImages.length,
    })

    // Phase 1：并发上传（信号量 UPLOAD_CONCURRENCY），任一失败整批回滚
    const urls: string[] = new Array(selectedImages.length)
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
      selectedImages.map(async (img, idx) => {
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
          totalToUpload: selectedImages.length,
          errorMsg:
            firstError ||
            `已上传 ${uploaded}/${selectedImages.length} 张；任一失败将整体回滚`,
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
          uploaded: selectedImages.length,
          totalToUpload: selectedImages.length,
          result,
        })
        void refreshTodayCount(prefix)
      }
    } catch (err) {
      if (mountedRef.current) {
        setProgress({
          phase: 'error',
          uploaded: selectedImages.length,
          totalToUpload: selectedImages.length,
          errorMsg: err instanceof Error ? err.message : '创建批次失败',
        })
      }
    }
  }, [selectedImages, oversizedImages, onOversizedConfirm, groupId, size, resolution, prefix, refreshTodayCount])

  const resetRun = useCallback(() => {
    setProgress(null)
    setScanned([])
    setDirHandle(null)
    setIgnoredCount(0)
    setScanError(null)
  }, [])

  return {
    limit,
    setLimit,
    dirHandle,
    scanning,
    scanError,
    scannedCount: scanned.length,
    ignoredCount,
    oversizedCount: oversizedImages.length,
    oversizedNames: oversizedImages.map((s) => s.filename),
    handlePickFolder,
    selectedImages,
    canStart,
    progress,
    runCreate,
    resetRun,
  }
}

export { PREVIEW_MAX_ROWS }
