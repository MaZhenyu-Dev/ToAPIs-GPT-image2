import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { IconAlertTriangle, IconCheck, IconInfo, IconX } from './Icon'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastOptions {
  type?: ToastType
  message: string
  /** 自动关闭时长（毫秒），默认 3500 */
  duration?: number
}

interface ToastItem {
  id: number
  type: ToastType
  message: string
  /** 退场动画进行中（延迟移除） */
  leaving?: boolean
}

export interface ToastApi {
  push: (options: ToastOptions) => void
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
  warning: (message: string) => void
}

const DEFAULT_DURATION_MS = 3500
/** 同屏最多保留 5 条，超出后丢弃最旧的 */
const MAX_TOASTS = 5

const ToastContext = createContext<ToastApi | null>(null)

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: number) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, leaving: true } : t))
    )
    // 先播放退场动画（220ms）再移除 DOM
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
      timers.current.delete(id)
    }, 220)
  }, [])

  const push = useCallback(
    (options: ToastOptions) => {
      const id = nextId++
      const item: ToastItem = {
        id,
        type: options.type ?? 'info',
        message: options.message,
      }
      setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), item])
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), options.duration ?? DEFAULT_DURATION_MS)
      )
    },
    [dismiss]
  )

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (message) => push({ type: 'success', message }),
      error: (message) => push({ type: 'error', message }),
      info: (message) => push({ type: 'info', message }),
      warning: (message) => push({ type: 'warning', message }),
    }),
    [push]
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-viewport" role="region" aria-label="通知">
        {toasts.map((toast) => (
          <ToastCard
            key={toast.id}
            toast={toast}
            onDismiss={() => dismiss(toast.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast 必须在 <ToastProvider> 内使用')
  }
  return context
}

const TOAST_ICON: Record<ToastType, ReactNode> = {
  success: <IconCheck />,
  error: <IconX />,
  warning: <IconAlertTriangle />,
  info: <IconInfo />,
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastItem
  onDismiss: () => void
}) {
  return (
    <div
      className={
        toast.leaving
          ? `toast toast--${toast.type} toast--leaving`
          : `toast toast--${toast.type}`
      }
      role="status"
    >
      <span className="toast-icon">{TOAST_ICON[toast.type]}</span>
      <div className="toast-body">{toast.message}</div>
      <button
        type="button"
        className="toast-close"
        onClick={onDismiss}
        aria-label="关闭通知"
      >
        <IconX width={14} height={14} />
      </button>
    </div>
  )
}
