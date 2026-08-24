import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { IconAlertTriangle } from './Icon'
import GlassButton from './GlassButton'

export interface ConfirmOptions {
  title: string
  /** 支持 ReactNode 与 \n 换行 */
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** danger = 红色危险操作（默认）；primary = 黄铜主操作 */
  tone?: 'danger' | 'primary'
}

type ConfirmApi = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmApi | null>(null)

interface DialogState {
  options: ConfirmOptions
  resolve: (ok: boolean) => void
}

/**
 * Promise 式确认弹窗：
 *
 *   const confirm = useConfirm()
 *   const ok = await confirm({ title: '删除批次', message: '...', tone: 'danger' })
 *   if (!ok) return
 *   // 执行删除
 *
 * 替换 window.confirm，全局仅挂载一个 <ConfirmDialogProvider>（已在 App 根挂载）。
 */
export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState | null>(null)
  const stateRef = useRef<DialogState | null>(null)
  stateRef.current = state

  const confirm = useCallback<ConfirmApi>((options) => {
    return new Promise<boolean>((resolve) => {
      setState({ options, resolve })
    })
  }, [])

  const close = useCallback((ok: boolean) => {
    const current = stateRef.current
    if (!current) return
    stateRef.current = null
    setState(null)
    current.resolve(ok)
  }, [])

  // Esc 关闭
  useEffect(() => {
    if (!state) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [state, close])

  const api = useMemo(() => confirm, [confirm])

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      {state && (
        <ConfirmDialog
          options={state.options}
          onClose={() => close(false)}
          onConfirm={() => close(true)}
        />
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmApi {
  const context = useContext(ConfirmContext)
  if (!context) {
    throw new Error('useConfirm 必须在 <ConfirmDialogProvider> 内使用')
  }
  return context
}

function ConfirmDialog({
  options,
  onClose,
  onConfirm,
}: {
  options: ConfirmOptions
  onClose: () => void
  onConfirm: () => void
}) {
  const tone = options.tone ?? 'danger'
  const confirmButtonRef = useRef<HTMLButtonElement>(null)

  // 打开时聚焦确认按钮 + 锁定背景滚动
  useEffect(() => {
    confirmButtonRef.current?.focus()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  // Portal 挂到 body：祖先容器的 backdrop-filter / transform 会破坏 fixed
  // 定位（成为 containing block），导致遮罩只覆盖容器区域而非全屏
  return createPortal(
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <h3 className="modal-title" id="confirm-dialog-title">
          <span
            className={`modal-title-icon${tone === 'danger' ? ' modal-title-icon--danger' : ''}`}
          >
            <IconAlertTriangle width={17} height={17} />
          </span>
          {options.title}
        </h3>
        {options.message && <div className="modal-body">{options.message}</div>}
        <div className="modal-actions">
          <GlassButton variant="ghost" onClick={onClose}>
            {options.cancelLabel ?? '取消'}
          </GlassButton>
          <GlassButton
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            ref={confirmButtonRef}
          >
            {options.confirmLabel ?? '确定'}
          </GlassButton>
        </div>
      </div>
    </div>,
    document.body
  )
}
