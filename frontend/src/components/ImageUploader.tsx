import { useCallback, useRef, useState } from 'react'
import { uploadImage } from '../api'
import GlassButton from './ui/GlassButton'
import { IconX } from './ui/Icon'

interface Props {
  urls: string[]
  onChange: (urls: string[]) => void
  disabled?: boolean
}

/**
 * 参考图上传器：拖拽/点击上传 → 转 URL；也支持粘贴网络 URL。
 * 统一液态玻璃风格。
 */
export default function ImageUploader({ urls, onChange, disabled }: Props) {
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)

  const handleAddUrl = useCallback(() => {
    setUrlError(null)
    const trimmed = urlInput.trim()
    if (!trimmed) {
      setUrlError('请输入 URL')
      return
    }
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      setUrlError('URL 格式不正确')
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setUrlError('仅支持 http / https 链接')
      return
    }
    if (urls.includes(trimmed)) {
      setUrlError('该 URL 已添加')
      return
    }
    onChange([...urls, trimmed])
    setUrlInput('')
  }, [urlInput, urls, onChange])

  const handleUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddUrl()
    }
  }

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      setUploading(true)
      setUploadError(null)

      const newUrls: string[] = []
      try {
        for (const file of Array.from(files)) {
          if (!file.type.startsWith('image/')) {
            setUploadError(`跳过非图片文件: ${file.name}`)
            continue
          }
          const response = await uploadImage(file)
          newUrls.push(response.url)
        }
        onChange([...urls, ...newUrls])
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : '上传失败')
      } finally {
        setUploading(false)
        if (inputRef.current) {
          inputRef.current.value = ''
        }
      }
    },
    [urls, onChange]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (disabled || uploading) return
      handleFiles(e.dataTransfer.files)
    },
    [disabled, uploading, handleFiles]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }, [])

  const removeUrl = (index: number) => {
    const next = urls.filter((_, i) => i !== index)
    onChange(next)
  }

  return (
    <div className="form-group">
      <label>参考图</label>

      <div
        role="button"
        tabIndex={0}
        aria-label="上传参考图（点击或拖拽）"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !disabled && !uploading && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (!disabled && !uploading) inputRef.current?.click()
          }
        }}
        style={{
          border: `1.5px dashed ${
            dragOver ? 'var(--accent)' : 'var(--input-border)'
          }`,
          borderRadius: 'var(--radius-md)',
          padding: '1.25rem',
          textAlign: 'center',
          background: dragOver ? 'var(--accent-soft)' : 'var(--input-bg)',
          cursor: disabled || uploading ? 'not-allowed' : 'pointer',
          opacity: disabled || uploading ? 0.6 : 1,
          transition: 'border-color var(--dur), background var(--dur)',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
          disabled={disabled || uploading}
          aria-label="选择参考图文件"
        />
        {uploading ? (
          <div style={{ color: 'var(--text-2)', fontSize: '0.9rem' }}>上传中...</div>
        ) : (
          <>
            <div style={{ fontWeight: 500, marginBottom: '0.25rem', color: 'var(--text-1)' }}>
              点击或拖拽上传参考图
            </div>
            <div className="hint">支持多张图片，上传后会自动转为 URL</div>
          </>
        )}
      </div>

      {uploadError && (
        <div className="hint" style={{ color: 'var(--danger)', marginTop: '0.5rem' }}>
          {uploadError}
        </div>
      )}

      <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
        <input
          ref={urlInputRef}
          type="url"
          value={urlInput}
          onChange={(e) => {
            setUrlInput(e.target.value)
            if (urlError) setUrlError(null)
          }}
          onKeyDown={handleUrlKeyDown}
          placeholder="或粘贴网络图片 URL（http/https）"
          disabled={disabled}
          aria-label="网络图片 URL"
        />
        <GlassButton
          type="button"
          size="sm"
          onClick={handleAddUrl}
          disabled={disabled || !urlInput.trim()}
        >
          添加
        </GlassButton>
      </div>

      {urlError && (
        <div className="hint" style={{ color: 'var(--danger)', marginTop: '0.5rem' }}>
          {urlError}
        </div>
      )}

      {urls.length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          <div className="hint" style={{ marginBottom: '0.5rem' }}>
            已上传 {urls.length} 张参考图
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {urls.map((url, index) => (
              <div
                key={`${url}-${index}`}
                style={{
                  position: 'relative',
                  width: '80px',
                  height: '80px',
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                  border: '1px solid var(--glass-border)',
                }}
              >
                <img
                  src={url}
                  alt={`参考图 ${index + 1}`}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />
                <button
                  type="button"
                  onClick={() => removeUrl(index)}
                  disabled={disabled || uploading}
                  aria-label={`移除参考图 ${index + 1}`}
                  style={{
                    position: 'absolute',
                    top: '3px',
                    right: '3px',
                    width: '20px',
                    height: '20px',
                    padding: 0,
                    borderRadius: '50%',
                    background: 'var(--glass-3-bg)',
                    color: 'var(--text-1)',
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  <IconX width={11} height={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
