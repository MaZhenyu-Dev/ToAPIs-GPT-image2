import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createI2iMulti,
  uploadImage,
} from '../api'
import {
  DEFAULT_RESOLUTION,
  DEFAULT_SIZE,
  I2I_MULTI_FILENAME_PATTERN,
  I2I_MULTI_QUICK_PICKS,
  MAX_I2I_MULTI_COUNT,
  MIN_I2I_MULTI_COUNT,
} from '../constants'
import { useBatchPrefix } from '../hooks/useBatchPrefix'
import type {
  I2iMultiCreateResponse,
  VariantGroupListItem,
} from '../types'
import ParameterSelector from './ParameterSelector'

const UPLOAD_CONCURRENCY = 5
// 一个批次的最大任务数 = variants 数量；这里只是给个直观的"几行字"渲染
const PREVIEW_MAX_ROWS = 20

interface Props {
  groups: VariantGroupListItem[]
  selectedGroupId?: number | null
  /** 选完 variant group 后回填 detail（用于让用户在变体组 Tab 选完后跳到这） */
  onGroupChange?: (groupId: number | null) => void
}

interface ScannedImage {
  seq: number
  filename: string
  file: File
}

type Phase = 'idle' | 'uploading' | 'creating' | 'done' | 'error'

interface RunProgress {
  phase: Phase
  uploaded: number
  totalToUpload: number
  currentFile?: string
  errorMsg?: string
  result?: I2iMultiCreateResponse
}

// File System Access API 的最小类型声明（lib.dom.d.ts 暂未完整覆盖）
interface FSAccessWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}
interface FSAccessDirectoryHandle {
  name: string
  entries(): AsyncIterable<[string, FSAccessFileSystemHandle]>
}
interface FSAccessFileSystemHandle {
  kind: 'file' | 'directory'
  getFile?(): Promise<File>
}

function isFsAccessSupported(): boolean {
  if (typeof window === 'undefined') return false
  return typeof (window as unknown as FSAccessWindow).showDirectoryPicker === 'function'
}

/**
 * 文件夹批量图生图：一次创建 N 个 i2i 批次。
 *
 * 用户流程：
 * 1. 选择变体组（决定每批几个任务 = K）
 * 2. 选择 prefix（默认 MZY，从 localStorage 读）
 * 3. 选择 size / resolution
 * 4. 选择批量数量（10/20/50/自定义 1-50）
 * 5. 点击"选择图片文件夹"→ 浏览器原生目录选择器（File System Access API）
 * 6. 扫描目录：仅保留命名符合 `<数字>.png|jpg|jpeg` 的文件
 * 7. 预览匹配结果：哪些 seq 会被使用、哪些缺失
 * 8. 点击"开始创建"：
 *    - Phase 1：并发上传所有图片到 ToAPIs（信号量 5）
 *    - Phase 2：调用后端 /api/batches/i2i-multi，原子创建 N 个批次
 * 9. 显示结果：成功创建的 batch_ids 列表 + 总任务数
 *
 * 错误处理：任一图片上传失败 → 整批回滚（不创建任何批次），提示"重试"
 */
export default function FolderBatchGenerator({
  groups,
  selectedGroupId,
  onGroupChange,
}: Props) {
  const [groupId, setGroupId] = useState<number | ''>(selectedGroupId ?? '')
  const [size, setSize] = useState(DEFAULT_SIZE)
  const [resolution, setResolution] = useState(DEFAULT_RESOLUTION)
  const [count, setCount] = useState<number>(10)
  const [customCount, setCustomCount] = useState<string>('')
  const {
    prefix,
    handlePrefixChange,
    isPrefixValid,
    todayBatchInfo,
    previewBatchId,
    refreshTodayCount,
  } = useBatchPrefix()

  // 扫描结果
  const [scanned, setScanned] = useState<ScannedImage[]>([])
  const [dirHandle, setDirHandle] =
    useState<FSAccessDirectoryHandle | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [ignoredCount, setIgnoredCount] = useState(0)

  // 进度 + 结果
  const [progress, setProgress] = useState<RunProgress | null>(null)

  // 防止组件卸载后 setState 触发警告
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (selectedGroupId) {
      setGroupId(selectedGroupId)
    }
  }, [selectedGroupId])

  // 选中的变体组对象（用于展示 K = variants 数量）
  const selectedGroup: VariantGroupListItem | null = useMemo(() => {
    if (!groupId) return null
    return groups.find((g) => g.id === groupId) ?? null
  }, [groupId, groups])
  const K = selectedGroup?.variant_count ?? 0

  // 期望 seq 范围：[nextSeq, nextSeq + count - 1]
  // batch_id 格式 = {prefix}{MMDD}{seq}，例如 MZY073161 → prefix=MZY, date=0731, seq=61
  // 重要：必须跳过 prefix + 4 位日期，只取尾部 seq 部分。
  // 如果直接用 /(\d+)$/ 抓末尾数字，会把日期里的 0731 和 seq 61 拼成 73161，
  // 导致图片 seq=61 落不进 [73161, 73161+count-1] 区间 → 0 张匹配。
  const nextSeq = useMemo(() => {
    if (!todayBatchInfo) return null
    const { next_batch_id, prefix: pfx } = todayBatchInfo
    if (next_batch_id.length <= pfx.length + 4) return null
    const seqStr = next_batch_id.slice(pfx.length + 4)
    const n = parseInt(seqStr, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }, [todayBatchInfo])

  // 在扫描结果中按 seq 范围过滤
  const rangeMatched = useMemo(() => {
    if (nextSeq === null) return []
    const start = nextSeq
    const end = nextSeq + count - 1
    return scanned
      .filter((img) => img.seq >= start && img.seq <= end)
      .sort((a, b) => a.seq - b.seq)
  }, [scanned, nextSeq, count])

  // 缺失的 seq（用于提示用户"哪些图没找到"）
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
    K > 0 &&
    isPrefixValid &&
    nextSeq !== null &&
    rangeMatched.length > 0 &&
    progress?.phase !== 'uploading' &&
    progress?.phase !== 'creating'

  // ---------- 选目录 + 扫描 ----------
  const handlePickFolder = useCallback(async () => {
    setScanError(null)
    if (!isFsAccessSupported()) {
      setScanError(
        '当前浏览器不支持文件夹直读，请改用 Chrome / Edge / Opera 最新版'
      )
      return
    }
    let handle: FSAccessDirectoryHandle
    try {
      const picker = (window as unknown as FSAccessWindow).showDirectoryPicker
      if (!picker) throw new Error('当前浏览器不支持 showDirectoryPicker')
      // showDirectoryPicker 实际返回的是全局 FileSystemDirectoryHandle，
      // 但 lib.dom.d.ts 中该类型暂未声明 entries() 方法（运行时实际存在）。
      // 显式断言为我们自己的 FSAccessDirectoryHandle 即可。
      handle = (await picker({
        mode: 'read',
      })) as unknown as FSAccessDirectoryHandle
    } catch (err) {
      // 用户主动取消选择时静默
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
        if (!m) {
          ignored += 1
          continue
        }
        if (!entry.getFile) {
          // 理论上 kind === 'file' 一定有 getFile，防御性兜底
          ignored += 1
          continue
        }
        const file = await entry.getFile()
        found.push({ seq: parseInt(m[1], 10), filename: name, file })
      }
      // 按 seq 升序排序（展示用，上传时也按这个顺序走）
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

  // ---------- 上传 + 创建 ----------
  const runCreate = useCallback(async () => {
    if (rangeMatched.length === 0) return
    setProgress({
      phase: 'uploading',
      uploaded: 0,
      totalToUpload: rangeMatched.length,
    })

    // Phase 1：并发上传所有图片
    const urls: string[] = new Array(rangeMatched.length)
    let uploaded = 0
    let firstError: string | null = null

    async function uploadOne(idx: number, img: ScannedImage): Promise<void> {
      try {
        const res = await uploadImage(img.file)
        urls[idx] = res.url
        uploaded += 1
        if (mountedRef.current) {
          setProgress((p) =>
            p
              ? {
                  ...p,
                  uploaded,
                  currentFile: img.filename,
                }
              : p
          )
        }
      } catch (err) {
        // 记录第一个错误，继续尝试其他图片（保持进度可见）
        if (!firstError) {
          firstError = err instanceof Error ? err.message : '上传失败'
        }
        throw err
      }
    }

    // 信号量：UPLOAD_CONCURRENCY 个并发上传
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
      if (next) {
        next()
      } else {
        sem.count -= 1
      }
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
      // 整批回滚（不调用 createI2iMulti）
      if (mountedRef.current) {
        setProgress({
          phase: 'error',
          uploaded,
          totalToUpload: rangeMatched.length,
          errorMsg:
            firstError ||
            `已上传 ${uploaded}/${rangeMatched.length} 张；任一失败将整体回滚`,
        })
      }
      return
    }

    // Phase 2：原子创建所有批次
    if (mountedRef.current) {
      setProgress((p) =>
        p ? { ...p, phase: 'creating' } : p
      )
    }

    try {
      const result = await createI2iMulti({
        group_id: Number(groupId),
        image_urls: urls,
        size,
        resolution,
        prefix,
      })
      if (mountedRef.current) {
        setProgress({
          phase: 'done',
          uploaded: rangeMatched.length,
          totalToUpload: rangeMatched.length,
          result,
        })
        // 创建后立刻刷新今日计数，避免下次预览还停在旧值
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
  }, [
    rangeMatched,
    groupId,
    size,
    resolution,
    prefix,
    refreshTodayCount,
  ])

  // ---------- 渲染 ----------
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>文件夹批量图生图</h2>

      {!isFsAccessSupported() && (
        <div
          className="error"
          style={{
            marginBottom: '1rem',
            padding: '0.75rem',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '6px',
            color: '#991b1b',
          }}
        >
          ⚠️ 当前浏览器不支持 File System Access API，无法读取本地文件夹。
          请使用 Chrome / Edge / Opera 最新版。
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void runCreate()
        }}
      >
        {/* 变体组选择 */}
        <div className="form-group">
          <label htmlFor="i2i-multi-group">变体组（决定每批几个任务 K）</label>
          <select
            id="i2i-multi-group"
            value={groupId}
            onChange={(e) => {
              const v = e.target.value ? Number(e.target.value) : ''
              setGroupId(v)
              onGroupChange?.(v === '' ? null : (v as number))
            }}
            required
          >
            <option value="">请选择</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}（{g.variant_count} 个变体）
              </option>
            ))}
          </select>
        </div>

        {/* 批次号 prefix */}
        <div className="form-group">
          <label htmlFor="i2i-multi-prefix">批次号前缀</label>
          <input
            id="i2i-multi-prefix"
            type="text"
            value={prefix}
            onChange={(e) => handlePrefixChange(e.target.value)}
            maxLength={10}
            placeholder="MZY"
            style={{
              fontFamily: 'monospace',
              textTransform: 'uppercase',
              ...(isPrefixValid ? {} : { borderColor: '#dc2626' }),
            }}
          />
          <div className="hint" style={{ marginTop: '0.25rem' }}>
            预览下个 ID：<code style={{ fontFamily: 'monospace' }}>{previewBatchId}</code>
            {nextSeq !== null && (
              <>
                {' · seq 范围：'}
                <code style={{ fontFamily: 'monospace' }}>
                  {nextSeq} ~ {nextSeq + count - 1}
                </code>
              </>
            )}
            {!isPrefixValid && (
              <span style={{ color: '#dc2626' }}> · 仅支持 1-10 位 A-Z / 0-9</span>
            )}
          </div>
        </div>

        {/* 数量选择 */}
        <div className="form-group">
          <label>批量创建对话数（每张图 → 1 个对话）</label>
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            {I2I_MULTI_QUICK_PICKS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  setCount(n)
                  setCustomCount('')
                }}
                style={{
                  padding: '0.4rem 0.8rem',
                  background: count === n && customCount === '' ? '#2563eb' : '#fff',
                  color: count === n && customCount === '' ? '#fff' : '#374151',
                  border: `1px solid ${
                    count === n && customCount === '' ? '#2563eb' : '#d1d5db'
                  }`,
                  borderRadius: '6px',
                  cursor: 'pointer',
                }}
              >
                {n}
              </button>
            ))}
            <input
              type="number"
              min={MIN_I2I_MULTI_COUNT}
              max={MAX_I2I_MULTI_COUNT}
              value={customCount}
              placeholder="自定义"
              onChange={(e) => {
                const v = e.target.value
                setCustomCount(v)
                if (v === '') return
                const n = parseInt(v, 10)
                if (
                  Number.isFinite(n) &&
                  n >= MIN_I2I_MULTI_COUNT &&
                  n <= MAX_I2I_MULTI_COUNT
                ) {
                  setCount(n)
                }
              }}
              style={{
                width: '100px',
                padding: '0.4rem 0.6rem',
                border: '1px solid #d1d5db',
                borderRadius: '6px',
              }}
            />
            <span className="hint">
              范围 {MIN_I2I_MULTI_COUNT}-{MAX_I2I_MULTI_COUNT}
            </span>
          </div>
          <div className="hint" style={{ marginTop: '0.25rem' }}>
            每个对话会创建 {K || '—'} 个任务，共{' '}
            <strong>{K * count || '—'}</strong> 个任务
          </div>
        </div>

        {/* 参数选择 */}
        <ParameterSelector
          size={size}
          resolution={resolution}
          onChange={({ size: s, resolution: r }) => {
            setSize(s)
            setResolution(r)
          }}
        />

        {/* 选目录按钮 */}
        <div className="form-group">
          <label>图片文件夹</label>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => void handlePickFolder()}
              disabled={!isFsAccessSupported() || scanning}
              style={{ padding: '0.5rem 1rem' }}
            >
              {scanning
                ? '扫描中...'
                : dirHandle
                ? '重新选择文件夹'
                : '选择图片文件夹'}
            </button>
            {dirHandle && (
              <span className="hint" style={{ fontFamily: 'monospace' }}>
                {dirHandle.name}（共扫描到 {scanned.length} 张有效图
                {ignoredCount > 0 && `，跳过 ${ignoredCount} 个非规范文件`}）
              </span>
            )}
          </div>
          {scanError && (
            <div className="error" style={{ marginTop: '0.5rem' }}>
              {scanError}
            </div>
          )}
          <div className="hint" style={{ marginTop: '0.25rem' }}>
            文件名必须为 <code>阿拉伯数字.png/jpg/jpeg</code>，如{' '}
            <code>1.png</code>、<code>23.jpg</code>
          </div>
        </div>

        {/* 范围匹配预览 */}
        {scanned.length > 0 && nextSeq !== null && (
          <div className="form-group">
            <label>匹配预览</label>
            <div
              style={{
                padding: '0.75rem',
                background: missingSeqs.length > 0 ? '#fffbeb' : '#f0fdf4',
                border: `1px solid ${
                  missingSeqs.length > 0 ? '#fde68a' : '#bbf7d0'
                }`,
                borderRadius: '6px',
                fontSize: '0.85rem',
              }}
            >
              <div>
                将使用{' '}
                <strong>{rangeMatched.length}</strong> / {count} 张图片，
                生成 <strong>{rangeMatched.length}</strong> 个对话
                {missingSeqs.length > 0 && (
                  <>
                    （缺失 {missingSeqs.length} 张，按实际可用数量创建）：
                    {missingSeqs.length <= 5
                      ? ` seq ${missingSeqs.join(', ')}`
                      : ` seq ${missingSeqs
                          .slice(0, 3)
                          .join(', ')} 等 ${missingSeqs.length} 个`}
                  </>
                )}
              </div>
              {rangeMatched.length > 0 && (
                <details style={{ marginTop: '0.5rem' }}>
                  <summary
                    style={{ cursor: 'pointer', color: '#6b7280' }}
                  >
                    查看前{' '}
                    {Math.min(PREVIEW_MAX_ROWS, rangeMatched.length)} /
                    {' '}
                    {rangeMatched.length} 行匹配明细
                  </summary>
                  <table
                    style={{
                      width: '100%',
                      marginTop: '0.5rem',
                      borderCollapse: 'collapse',
                      fontFamily: 'monospace',
                      fontSize: '0.8rem',
                    }}
                  >
                    <thead>
                      <tr style={{ textAlign: 'left', color: '#6b7280' }}>
                        <th style={{ padding: '0.25rem' }}>seq</th>
                        <th style={{ padding: '0.25rem' }}>文件名</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rangeMatched.slice(0, PREVIEW_MAX_ROWS).map((r) => (
                        <tr key={`${r.seq}-${r.filename}`}>
                          <td style={{ padding: '0.25rem' }}>{r.seq}</td>
                          <td style={{ padding: '0.25rem' }}>
                            {r.filename}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          </div>
        )}

        {/* 提交 */}
        <div style={{ marginTop: '1.25rem' }}>
          <button
            type="submit"
            disabled={!canStart}
            title={
              !groupId
                ? '请选择变体组'
                : K === 0
                ? '变体组为空'
                : !isPrefixValid
                ? 'prefix 非法'
                : rangeMatched.length === 0
                ? '无匹配图片'
                : ''
            }
          >
            {progress?.phase === 'uploading'
              ? `上传图片中 ${progress.uploaded}/${progress.totalToUpload}...`
              : progress?.phase === 'creating'
              ? '创建对话中...'
              : `开始创建 ${rangeMatched.length} 个对话`}
          </button>
        </div>
      </form>

      {/* 错误提示 */}
      {progress?.phase === 'error' && progress.errorMsg && (
        <div
          className="error"
          style={{
            marginTop: '1rem',
            padding: '0.75rem',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '6px',
          }}
        >
          ❌ {progress.errorMsg}
          <div style={{ marginTop: '0.5rem' }}>
            <button
              type="button"
              onClick={() => void runCreate()}
              style={{ padding: '0.3rem 0.8rem' }}
            >
              重试
            </button>
            <button
              type="button"
              onClick={() => setProgress(null)}
              style={{
                marginLeft: '0.5rem',
                padding: '0.3rem 0.8rem',
                background: '#fff',
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 成功结果 */}
      {progress?.phase === 'done' && progress.result && (
        <div
          style={{
            marginTop: '1rem',
            padding: '0.75rem',
            background: '#f0fdf4',
            border: '1px solid #bbf7d0',
            borderRadius: '6px',
            color: '#166534',
          }}
        >
          ✅ 成功创建 {progress.result.batch_ids.length} 个对话，共{' '}
          {progress.result.task_count} 个任务
          <details style={{ marginTop: '0.5rem' }}>
            <summary style={{ cursor: 'pointer' }}>查看 batch_id 列表</summary>
            <div
              style={{
                marginTop: '0.5rem',
                fontFamily: 'monospace',
                fontSize: '0.8rem',
                maxHeight: '200px',
                overflowY: 'auto',
              }}
            >
              {progress.result.batch_ids.map((bid) => (
                <div key={bid} style={{ padding: '0.15rem 0' }}>
                  {bid}
                </div>
              ))}
            </div>
          </details>
          <div style={{ marginTop: '0.5rem' }}>
            <button
              type="button"
              onClick={() => {
                setProgress(null)
                setScanned([])
                setDirHandle(null)
                setIgnoredCount(0)
              }}
              style={{ padding: '0.3rem 0.8rem' }}
            >
              再来一次
            </button>
          </div>
        </div>
      )}

      {/* 提示信息 */}
      {progress?.phase === 'idle' || !progress ? null : null}
    </div>
  )
}
