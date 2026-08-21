import { useEffect, useRef, useState } from 'react'
import { getBatchStatus } from '../api'
import type { BatchSummary } from '../types'

const MAX_THUMBS_PER_BATCH = 4
const FETCH_CONCURRENCY = 4

export interface BatchThumbnailsResult {
  /** batch_id → 已完成图片 URL（最多 4 张） */
  thumbnails: Record<string, string[]>
  /** 当前是否仍有批次在拉取中 */
  loading: boolean
}

/**
 * 批次列表缩略图：为列表中的批次拉取已完成图片 URL。
 *
 * 设计约束（避免给后端造成压力）：
 * - 仅对 completed_count > 0 的批次发起请求
 * - 每个 batch_id 只拉取一次，结果缓存在 ref（列表自动刷新不重拉）
 * - 并发限制 4
 * - 拉取失败静默跳过，不重试
 */
export function useBatchThumbnails(batches: BatchSummary[]): BatchThumbnailsResult {
  const [thumbnails, setThumbnails] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(false)
  const cache = useRef<Record<string, string[]>>({})
  const fetched = useRef<Set<string>>(new Set())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const targets = batches.filter(
      (b) => b.completed_count > 0 && !fetched.current.has(b.batch_id)
    )
    if (targets.length === 0) return

    setLoading(true)
    let cursor = 0
    let finished = 0
    const pending = targets.length

    async function worker(): Promise<void> {
      while (cursor < targets.length) {
        const batch = targets[cursor++]
        fetched.current.add(batch.batch_id)
        try {
          const status = await getBatchStatus(batch.batch_id)
          const urls = status.tasks
            .filter((t) => t.status === 'completed' && t.image_url)
            .slice(0, MAX_THUMBS_PER_BATCH)
            .map((t) => t.image_url as string)
          cache.current[batch.batch_id] = urls
          if (mounted.current) {
            setThumbnails((prev) => ({ ...prev, [batch.batch_id]: urls }))
          }
        } catch {
          // 拉取失败静默：缩略图非关键信息，且不回填 cache 避免重试
        } finally {
          finished += 1
          if (finished === pending && mounted.current) {
            setLoading(false)
          }
        }
      }
    }

    void Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, targets.length) }, () => worker())
    )
  }, [batches])

  return { thumbnails, loading }
}
