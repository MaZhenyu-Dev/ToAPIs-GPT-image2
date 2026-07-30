import { useCallback, useEffect, useState } from 'react'
import { getTodayBatchCount } from '../api'
import {
  BATCH_PREFIX_PATTERN,
  BATCH_PREFIX_STORAGE_KEY,
  DEFAULT_BATCH_PREFIX,
} from '../constants'
import type { TodayBatchCount } from '../types'

/**
 * 批次号前缀管理：持久化 + 校验 + 实时预览 next_batch_id。
 *
 * - 从 localStorage 读取历史 prefix（不存在则回退默认）
 * - 输入时自动转大写、即时写回 localStorage
 * - 通过后端权威接口（GET /api/batches/today-count）计算 next_batch_id，
 *   保证前端预览 = 后端实际分配（处理删除空洞、跨日时区等场景）
 *
 * 抽出来给 BatchGenerator 和 ProductSwapper 共用，避免重复实现。
 */
export function useBatchPrefix() {
  const [prefix, setPrefix] = useState<string>(loadStoredPrefix)
  const [todayBatchInfo, setTodayBatchInfo] = useState<TodayBatchCount | null>(null)

  const isPrefixValid = BATCH_PREFIX_PATTERN.test(prefix)

  // 拉取今天的批次计数（用于预览），失败时清空（不影响真实创建）
  const refreshTodayCount = useCallback(async (targetPrefix: string) => {
    if (!BATCH_PREFIX_PATTERN.test(targetPrefix)) {
      setTodayBatchInfo(null)
      return
    }
    try {
      const info = await getTodayBatchCount(targetPrefix)
      setTodayBatchInfo(info)
    } catch {
      setTodayBatchInfo(null)
    }
  }, [])

  // prefix 变化时重新拉取计数
  useEffect(() => {
    void refreshTodayCount(prefix)
  }, [prefix, refreshTodayCount])

  // prefix 变化时立即持久化（小写自动转大写）
  const handlePrefixChange = useCallback((value: string) => {
    const upper = value.toUpperCase()
    setPrefix(upper)
    try {
      localStorage.setItem(BATCH_PREFIX_STORAGE_KEY, upper)
    } catch {
      // localStorage 写入失败时静默
    }
  }, [])

  // 预览下一个批次号（todayBatchInfo 拉取失败时降级为 "—"）
  const previewBatchId = todayBatchInfo ? todayBatchInfo.next_batch_id : '—'

  return {
    prefix,
    setPrefix,
    handlePrefixChange,
    isPrefixValid,
    todayBatchInfo,
    previewBatchId,
    refreshTodayCount,
  }
}

function loadStoredPrefix(): string {
  try {
    const raw = localStorage.getItem(BATCH_PREFIX_STORAGE_KEY)
    if (raw && BATCH_PREFIX_PATTERN.test(raw.toUpperCase())) {
      return raw.toUpperCase()
    }
  } catch {
    // localStorage 不可用时静默回退
  }
  return DEFAULT_BATCH_PREFIX
}
