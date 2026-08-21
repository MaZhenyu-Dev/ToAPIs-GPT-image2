import { useState } from 'react'
import type { ImgHTMLAttributes } from 'react'

interface FadeInImageProps extends ImgHTMLAttributes<HTMLImageElement> {}

/**
 * 图片加载完成后淡入（占位 → 图片平滑过渡，避免生硬跳变）。
 * onError 时也触发淡入（展示浏览器原生破图样式，而非永久空白）。
 */
export default function FadeInImage({
  onLoad,
  onError,
  className,
  ...rest
}: FadeInImageProps) {
  const [loaded, setLoaded] = useState(false)

  return (
    <img
      {...rest}
      className={`${className ?? ''} ${loaded ? 'img-fade-in' : 'img-fade-out'}`}
      onLoad={(e) => {
        setLoaded(true)
        onLoad?.(e)
      }}
      onError={(e) => {
        setLoaded(true)
        onError?.(e)
      }}
    />
  )
}
