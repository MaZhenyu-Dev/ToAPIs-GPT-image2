import { useEffect, useRef, useState } from 'react'
import { getBatchThumbnails } from '../api'
import type { BatchSummary } from '../types'

export interface BatchThumbnailsResult {
  /** batch_id → 已完成图片 URL（最多 4 张） */
  thumbnails: Record<string, string[]>
  /** 当前是否仍有批次在拉取中 */
  loading: boolean
}

/**
 * 批次列表缩略图：为列表中的批次拉取已完成图片 URL。
 *
 * 设计约束（支撑大分页 100/200/300）：
 * - 仅对 completed_count > 0 的批次发起请求
 * - 一次批量接口（/api/batches/thumbnails）返回全部批次缩略图，
 *   替代逐批次调 status（N 次请求 → 1 次）
 * - 结果缓存在 ref（列表自动刷新不重拉）
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

    const ids = targets.map((b) => b.batch_id)
    ids.forEach((id) => fetched.current.add(id))
    setLoading(true)

    void getBatchThumbnails(ids)
      .then((result) => {
        if (!mounted.current) return
        cache.current = { ...cache.current, ...result }
        setThumbnails((prev) => ({ ...prev, ...result }))
      })
      .catch(() => {
        // 拉取失败静默：缩略图非关键信息，且不回填 fetched 避免立即重试
        ids.forEach((id) => fetched.current.delete(id))
      })
      .finally(() => {
        if (mounted.current) setLoading(false)
      })
  }, [batches])

  return { thumbnails, loading }
}
