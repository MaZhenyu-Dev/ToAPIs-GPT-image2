import type { CropMeta } from '../types'

/** 字节数格式化为可读大小（如 3.21 MB / 512 KB） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(2)} MB`
}

/**
 * 裁剪统计摘要，如：
 * `1536×1024 → 1496×963 · PNG 3.21 MB → 2.92 MB · 裁掉 8.4% 面积`
 * 无白边时返回 `1536×1024 · PNG 3.21 MB · 未发现白边`
 */
export function formatCropSummary(meta: CropMeta): string {
  if (meta.error) return `裁剪失败：${meta.error}`
  const from = `${meta.orig_w}×${meta.orig_h}`
  if (meta.crop_w === meta.orig_w && meta.crop_h === meta.orig_h) {
    return `${from} · PNG ${formatBytes(meta.orig_size)} · 未发现白边`
  }
  return (
    `${from} → ${meta.crop_w}×${meta.crop_h}` +
    ` · PNG ${formatBytes(meta.orig_size)} → ${formatBytes(meta.crop_size)}` +
    ` · 裁掉 ${meta.area_pct}% 面积`
  )
}
