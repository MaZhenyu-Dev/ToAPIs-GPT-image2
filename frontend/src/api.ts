import type {
  BatchDeleteResponse,
  BatchGenerateRequest,
  BatchGenerateResponse,
  BatchListResponse,
  BatchStatusResponse,
  GenerationRequest,
  GenerationTask,
  GenerationTaskItem,
  I2iMultiCreateRequest,
  I2iMultiCreateResponse,
  ImageUploadResponse,
  ProductSwapRequest,
  TaskStatus,
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
    throw new Error(data.detail || data.message || `请求失败: ${response.status}`)
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

export function createGeneration(payload: GenerationRequest): Promise<GenerationTask> {
  return fetchJson<GenerationTask>('/api/generations/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getTaskStatus(taskId: string): Promise<TaskStatus> {
  return fetchJson<TaskStatus>(`/api/generations/tasks/${taskId}`)
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
  taskId: number
): Promise<GenerationTaskItem> {
  return fetchJson<GenerationTaskItem>(
    `/api/batches/${batchId}/tasks/${taskId}/regenerate`,
    { method: 'POST' }
  )
}

export interface BatchListParams {
  page?: number
  pageSize?: number
}

export function listRecentBatches(
  params: BatchListParams = {}
): Promise<BatchListResponse> {
  const page = params.page ?? 1
  const pageSize = params.pageSize ?? 10
  return fetchJson<BatchListResponse>(
    `/api/batches?page=${page}&page_size=${pageSize}`
  )
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

export function getTodayBatchCount(prefix: string): Promise<TodayBatchCount> {
  return fetchJson<TodayBatchCount>(
    `/api/batches/today-count?prefix=${encodeURIComponent(prefix)}`
  )
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
