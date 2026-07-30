import { useCallback, useEffect, useRef } from 'react'
import { getBatchStatus } from '../api'
import type { BatchStatusResponse } from '../types'

const DEFAULT_POLL_INTERVAL_MS = 3000

interface UseBatchPollingOptions {
  /** 轮询间隔（毫秒），默认 3000 */
  intervalMs?: number
  /** 查询到已完成/全部完成时是否自动停止，默认 true */
  autoStopOnComplete?: boolean
  /** 拉取失败回调（用于显示连接异常） */
  onError?: (err: Error) => void
  /** 拉取成功回调（用于刷新上层状态） */
  onSuccess?: (status: BatchStatusResponse) => void
}

interface UseBatchPollingReturn {
  /** 立即拉取一次（不通过定时器），返回最新状态 */
  fetchOnce: (batchId: string, silent?: boolean) => Promise<BatchStatusResponse | null>
  /** 启动定时轮询（如果已经在跑则先清掉） */
  startPolling: (batchId: string) => void
  /** 停止轮询 */
  clearPolling: () => void
}

/**
 * 通用批次状态轮询 hook。
 *
 * 抽出来给 BatchGenerator 和 ProductSwapper 共用。
 * 用 ref 持有定时器 ID，避免在 unmount 时泄漏。
 */
export function useBatchPolling(options: UseBatchPollingOptions = {}): UseBatchPollingReturn {
  const {
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    autoStopOnComplete = true,
    onError,
    onSuccess,
  } = options

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentBatchId = useRef<string | null>(null)

  const clearPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
    currentBatchId.current = null
  }, [])

  const fetchOnce = useCallback(
    async (batchId: string, silent = false): Promise<BatchStatusResponse | null> => {
      try {
        const status = await getBatchStatus(batchId)
        onSuccess?.(status)
        return status
      } catch (err) {
        if (!silent) {
          onError?.(err instanceof Error ? err : new Error(String(err)))
        }
        return null
      }
    },
    [onSuccess, onError]
  )

  const startPolling = useCallback(
    (batchId: string) => {
      clearPolling()
      currentBatchId.current = batchId
      pollTimer.current = setInterval(async () => {
        const target = currentBatchId.current
        if (!target) return
        const status = await fetchOnce(target, true)
        if (!status) {
          onError?.(new Error('查询批次状态失败'))
          return
        }
        if (autoStopOnComplete) {
          const done = status.completed + status.failed
          if (done === status.total) {
            clearPolling()
          }
        }
      }, intervalMs)
    },
    [clearPolling, fetchOnce, intervalMs, autoStopOnComplete, onError]
  )

  // 卸载时自动清理定时器
  useEffect(() => {
    return () => clearPolling()
  }, [clearPolling])

  return { fetchOnce, startPolling, clearPolling }
}
