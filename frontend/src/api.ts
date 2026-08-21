import type {
  BatchDeleteResponse,
  BatchGenerateRequest,
  BatchGenerateResponse,
  BatchListResponse,
  BatchRetryResponse,
  BatchStatusResponse,
  GenerationTaskItem,
  I2iMultiCreateRequest,
  I2iMultiCreateResponse,
  ImageUploadResponse,
  ProductSwapRequest,
  TitleBatchDeleteRequest,
  TitleBatchImagesResponse,
  TitleGenerateRequest,
  TitleGenerateResponse,
  TitlePromptsResponse,
  TitleRegenerateRequest,
  TitleTask,
  TodayBatchCount,
  VariantGroup,
  VariantGroupListItem,
} from './types'

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    // 错误信息提取兜底：
    // - FastAPI 校验错误：detail 是 list[{loc, msg, type}, ...]
    // - HTTPException：detail 是 string
    // - 其它：detail 可能是 dict 或缺失
    // 统一抽成可读字符串，避免被 toString 成 "[object Object]"
    const detail = (data as { detail?: unknown }).detail
    let msg: string
    if (typeof detail === 'string') {
      msg = detail
    } else if (Array.isArray(detail)) {
      // Pydantic 错误列表 → 把每个元素的 msg 拼出来
      msg = detail
        .map((d: any) => {
          if (typeof d === 'string') return d
          if (d && typeof d === 'object') {
            const loc = Array.isArray(d.loc) ? d.loc.join('.') : ''
            const m = d.msg ?? JSON.stringify(d)
            return loc ? `${loc}: ${m}` : m
          }
          return String(d)
        })
        .join('; ')
    } else if (detail && typeof detail === 'object') {
      msg = JSON.stringify(detail)
    } else {
      msg = `请求失败: ${response.status}`
    }
    throw new Error(msg)
  }
  return data as T
}

async function fetchBlob(url: string, options?: RequestInit): Promise<Blob> {
  const response = await fetch(url, options)
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || data.message || `请求失败: ${response.status}`)
  }
  return response.blob()
}

// ---------- 变体组 API ----------

export interface VariantGroupPayload {
  name: string
  description?: string | null
  variants: { prompt_content: string; sort_order: number }[]
}

export function listVariantGroups(): Promise<VariantGroupListItem[]> {
  return fetchJson<VariantGroupListItem[]>('/api/variant-groups')
}

export function getVariantGroup(groupId: number): Promise<VariantGroup> {
  return fetchJson<VariantGroup>(`/api/variant-groups/${groupId}`)
}

export function createVariantGroup(
  payload: VariantGroupPayload
): Promise<VariantGroup> {
  return fetchJson<VariantGroup>('/api/variant-groups', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateVariantGroup(
  groupId: number,
  payload: VariantGroupPayload
): Promise<VariantGroup> {
  return fetchJson<VariantGroup>(`/api/variant-groups/${groupId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function deleteVariantGroup(groupId: number): Promise<void> {
  return fetchJson<void>(`/api/variant-groups/${groupId}`, {
    method: 'DELETE',
  })
}

// ---------- 批量生成 API ----------

export function generateBatch(
  payload: BatchGenerateRequest
): Promise<BatchGenerateResponse> {
  return fetchJson<BatchGenerateResponse>('/api/batches/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

// ---------- 产品替换 API ----------
// 提交后复用现有 /api/batches/{batch_id}/{status,retry} 等端点管理批次
export function generateProductSwap(
  payload: ProductSwapRequest
): Promise<BatchGenerateResponse> {
  return fetchJson<BatchGenerateResponse>('/api/product-swap/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getBatchStatus(batchId: string): Promise<BatchStatusResponse> {
  return fetchJson<BatchStatusResponse>(`/api/batches/${batchId}/status`)
}

export function retryBatch(batchId: string): Promise<BatchGenerateResponse> {
  return fetchJson<BatchGenerateResponse>(`/api/batches/${batchId}/retry`, {
    method: 'POST',
  })
}

export function regenerateTask(
  batchId: string,
  taskId: number,
  payload?: { model?: string; quality?: string }
): Promise<GenerationTaskItem> {
  return fetchJson<GenerationTaskItem>(
    `/api/batches/${batchId}/tasks/${taskId}/regenerate`,
    {
      method: 'POST',
      body: payload ? JSON.stringify(payload) : undefined,
    }
  )
}

export interface BatchListParams {
  page?: number
  pageSize?: number
  /** 批次号模糊搜索（任意位置子串匹配，后端转义通配符） */
  q?: string
}

export function listRecentBatches(
  params: BatchListParams = {}
): Promise<BatchListResponse> {
  const page = params.page ?? 1
  const pageSize = params.pageSize ?? 20
  const q = params.q?.trim() ?? ''
  const query = q
    ? `?page=${page}&page_size=${pageSize}&q=${encodeURIComponent(q)}`
    : `?page=${page}&page_size=${pageSize}`
  return fetchJson<BatchListResponse>(`/api/batches${query}`)
}

export function deleteBatch(batchId: string): Promise<BatchDeleteResponse> {
  return fetchJson<BatchDeleteResponse>(`/api/batches/${batchId}`, {
    method: 'DELETE',
  })
}

export function deleteBatches(batchIds: string[]): Promise<BatchDeleteResponse> {
  return fetchJson<BatchDeleteResponse>('/api/batches', {
    method: 'DELETE',
    body: JSON.stringify({ batch_ids: batchIds }),
  })
}

// 一键重试多个批次中的失败任务（近期批次总览页「重试已选批次」）
export function retryFailedBatches(
  batchIds: string[]
): Promise<BatchRetryResponse> {
  return fetchJson<BatchRetryResponse>('/api/batches/retry-failed', {
    method: 'POST',
    body: JSON.stringify({ batch_ids: batchIds }),
  })
}

export function getTodayBatchCount(prefix: string): Promise<TodayBatchCount> {
  return fetchJson<TodayBatchCount>(
    `/api/batches/today-count?prefix=${encodeURIComponent(prefix)}`
  )
}

// 批量获取批次的已完成图片 URL（每批最多 4 张），列表缩略图用
// 一次请求替代 N 次 status 请求，支撑大分页（100/200/300）
export function getBatchThumbnails(
  batchIds: string[]
): Promise<Record<string, string[]>> {
  if (batchIds.length === 0) return Promise.resolve({})
  const qs = batchIds.map((id) => `batch_ids=${encodeURIComponent(id)}`).join('&')
  return fetchJson<Record<string, string[]>>(`/api/batches/thumbnails?${qs}`)
}

// ---------- 文件夹批量图生图（i2i_multi） ----------

export function createI2iMulti(
  payload: I2iMultiCreateRequest
): Promise<I2iMultiCreateResponse> {
  return fetchJson<I2iMultiCreateResponse>('/api/batches/i2i-multi', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function uploadImage(file: File): Promise<ImageUploadResponse> {
  const formData = new FormData()
  formData.append('file', file)
  const response = await fetch('/api/generations/uploads/images', {
    method: 'POST',
    body: formData,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.detail || data.message || `请求失败: ${response.status}`)
  }
  return data as ImageUploadResponse
}

export function downloadImage(url: string): Promise<Blob> {
  // ToAPIs 图片 CDN（如 files.toapis.com）不返回 CORS 头，
  // 浏览器直接 fetch 会因跨域失败（Failed to fetch），
  // 改为走后端 /api/generations/download 代理下载。
  const proxyUrl = `/api/generations/download?url=${encodeURIComponent(url)}`
  return fetchBlob(proxyUrl)
}

// ---------- 标题生成 API ----------

export function listTitleTasks(params: {
  batch_id?: string
  batch_ids?: string[]
  source_task_id?: number
  source_task_ids?: number[]
  status?: string
  page?: number
  pageSize?: number
} = {}): Promise<TitleTask[]> {
  const qs = new URLSearchParams()
  if (params.batch_id) qs.set('batch_id', params.batch_id)
  // 批次列表参数：append 重复 key，后端 list[str] 接收
  // ?batch_ids=MT080301&batch_ids=MT080302
  if (params.batch_ids && params.batch_ids.length > 0) {
    for (const id of params.batch_ids) {
      qs.append('batch_ids', id)
    }
  }
  if (params.source_task_id != null)
    qs.set('source_task_id', String(params.source_task_id))
  // 列表参数：append 重复 key，后端 list[int] 接收
  // ?source_task_ids=1&source_task_ids=2&source_task_ids=3
  if (params.source_task_ids && params.source_task_ids.length > 0) {
    for (const id of params.source_task_ids) {
      qs.append('source_task_ids', String(id))
    }
  }
  if (params.status) qs.set('status', params.status)
  if (params.page) qs.set('page', String(params.page))
  if (params.pageSize) qs.set('page_size', String(params.pageSize))
  const query = qs.toString()
  return fetchJson<TitleTask[]>(
    `/api/title-tasks${query ? `?${query}` : ''}`
  )
}

export function getBatchTitleImages(
  batchId: string
): Promise<TitleBatchImagesResponse> {
  return fetchJson<TitleBatchImagesResponse>(
    `/api/title-tasks/batches/${encodeURIComponent(batchId)}/images`
  )
}

export function generateTitles(
  payload: TitleGenerateRequest
): Promise<TitleGenerateResponse> {
  return fetchJson<TitleGenerateResponse>('/api/title-tasks/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function regenerateTitle(
  titleTaskId: number,
  payload: TitleRegenerateRequest
): Promise<TitleTask> {
  return fetchJson<TitleTask>(
    `/api/title-tasks/${titleTaskId}/regenerate`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  )
}

export function fetchTitlePrompts(): Promise<TitlePromptsResponse> {
  // 拉取 3 个地毯类型对应的 prompt 模板和中文标签
  // 失败兜底：返回空 dict，由调用方决定是否退化到内置默认
  return fetchJson<TitlePromptsResponse>('/api/title-tasks/prompts')
}

export function deleteTitleTask(titleTaskId: number): Promise<{ deleted: number; id: number }> {
  return fetchJson<{ deleted: number; id: number }>(
    `/api/title-tasks/${titleTaskId}`,
    { method: 'DELETE' }
  )
}

export function deleteTitleTasksBulk(
  payload: TitleBatchDeleteRequest
): Promise<{ deleted: number }> {
  return fetchJson<{ deleted: number }>('/api/title-tasks/batch-delete', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/**
 * 触发浏览器下载标题 CSV。
 *
 * - batchIds: 传空数组或 null 表示导出全部
 * - 走原生 fetch + Blob + a[download] 触发保存，
 *   不复用 fetchJson 是因为需要拿到 Blob + 自行解析 Content-Disposition
 *   解析失败时回退到默认文件名
 */
export async function exportTitlesCsv(batchIds?: string[] | null): Promise<void> {
  const params = new URLSearchParams()
  if (batchIds && batchIds.length > 0) {
    params.set('batch_ids', batchIds.join(','))
  }
  const query = params.toString()
  const url = `/api/title-tasks/export.csv${query ? `?${query}` : ''}`

  const res = await fetch(url, { method: 'GET' })
  if (!res.ok) {
    throw new Error(`导出失败：HTTP ${res.status}`)
  }

  // 尝试从 Content-Disposition 拿服务端建议的文件名
  const disposition = res.headers.get('Content-Disposition') || ''
  const m = /filename="?([^"]+)"?/i.exec(disposition)
  const filename = m?.[1] || `titles-${Date.now()}.csv`

  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 延迟释放，避免某些浏览器在 click 还没完成时回收 URL
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
}
