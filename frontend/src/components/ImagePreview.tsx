import { useEffect, useState } from 'react'

interface ImageMeta {
  prompt?: string
  size?: string
  resolution?: string
}

interface Props {
  url: string | null
  alt?: string
  meta?: ImageMeta | null
  onClose: () => void
}

export default function ImagePreview({ url, alt = '预览', meta, onClose }: Props) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    if (!url) {
      setLoading(false)
      setLoadError(false)
      return
    }
    setLoading(true)
    setLoadError(false)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [url, onClose])

  if (!url) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.9)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem',
      }}
    >
      <button
        type="button"
        onClick={onClose}
        style={{
          position: 'absolute',
          top: '1rem',
          right: '1rem',
          background: 'rgba(255, 255, 255, 0.2)',
          borderRadius: '50%',
          width: '40px',
          height: '40px',
          fontSize: '1.25rem',
          padding: 0,
          color: '#fff',
        }}
      >
        ×
      </button>

      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          maxWidth: '100%',
          maxHeight: '80vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {loading && !loadError && (
          <div
            style={{
              position: 'absolute',
              color: '#fff',
              fontSize: '0.9rem',
            }}
          >
            图片加载中...
          </div>
        )}
        {loadError ? (
          <div
            style={{
              color: '#fff',
              background: 'rgba(220, 38, 38, 0.8)',
              padding: '1rem 1.5rem',
              borderRadius: '8px',
              maxWidth: '400px',
              textAlign: 'center',
            }}
          >
            图片加载失败，可能链接已失效。
          </div>
        ) : (
          <img
            src={url}
            alt={alt}
            onLoad={() => setLoading(false)}
            onError={() => {
              setLoading(false)
              setLoadError(true)
            }}
            style={{
              maxWidth: '100%',
              maxHeight: '80vh',
              borderRadius: '8px',
              boxShadow: '0 12px 40px rgba(0, 0, 0, 0.4)',
              opacity: loading ? 0 : 1,
              transition: 'opacity 0.3s',
            }}
          />
        )}
      </div>

      {meta && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            marginTop: '1rem',
            color: '#e5e7eb',
            fontSize: '0.85rem',
            maxWidth: '600px',
            textAlign: 'center',
            background: 'rgba(0, 0, 0, 0.5)',
            padding: '0.75rem 1rem',
            borderRadius: '8px',
          }}
        >
          {meta.size && meta.resolution && (
            <div style={{ marginBottom: '0.25rem' }}>
              尺寸：{meta.size} · 分辨率：{meta.resolution}
            </div>
          )}
          {meta.prompt && (
            <div
              style={{
                maxHeight: '4.5rem',
                overflow: 'auto',
                wordBreak: 'break-word',
              }}
            >
              Prompt：{meta.prompt}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
