export interface GenerationRequest {
  prompt: string
  size: string
  resolution: string
  n: number
}

export interface GenerationTask {
  id: string
  object: string
  model: string
  status: 'queued' | 'in_progress' | 'completed' | 'failed'
  progress: number
  created_at: number
  metadata?: Record<string, unknown>
}

export interface TaskStatus extends GenerationTask {
  completed_at?: number
  url?: string
  expires_at?: number
  error?: {
    code?: string
    message: string
  }
}

// ---------- 变体组 ----------

export interface Variant {
  id: number
  group_id: number
  prompt_content: string
  sort_order: number
}

export interface VariantInput {
  prompt_content: string
  sort_order: number
}

export interface VariantGroup {
  id: number
  name: string
  description: string | null
  created_at: string
  variants: Variant[]
}

export interface VariantGroupListItem {
  id: number
  name: string
  description: string | null
  created_at: string
  variant_count: number
}

// ---------- 批量生成 ----------

// 生成模式：t2i（文生图）/ i2i（图生图，批次共享 reference）/ product_swap（产品替换，每任务独立 product）
// i2i_multi: 文件夹批量图生图，每张图一个批次，批次内 K 任务共享该图
export type GenerationMode = 't2i' | 'i2i' | 'product_swap' | 'i2i_multi'

// 产品图数量上下限的实际常量见 constants.ts 的 MIN_PRODUCT_SWAP_COUNT / MAX_PRODUCT_SWAP_COUNT

export interface BatchGenerateRequest {
  group_id: number
  mode: GenerationMode
  size: string
  resolution: string
  reference_image_urls?: string[]
  // 批次号前缀：1-10 位 A-Z / 0-9，默认 "MZY"
  // 最终 batch_id 格式：{prefix}{MMDD}{seq}，MMDD 为北京时间月日，seq 为当天该 prefix 下的序号
  prefix?: string
}

// 产品替换请求：上传 1 张模板图 + N 张产品图，生成 N 张结果图
export interface ProductSwapRequest {
  template_image_url: string
  product_image_urls: string[] // 长度 1-20，按上传顺序生成
  prompt: string
  size: string
  resolution: string
  prefix?: string // 默认 "MZY"
}

export interface BatchGenerateResponse {
  batch_id: string
  task_count: number
}

export interface GenerationTaskItem {
  id: number
  batch_id: string
  variant_id: number | null
  variant_prompt: string | null
  toapis_task_id: string | null
  mode: string
  size: string
  resolution: string
  status: string
  progress: number
  image_url: string | null
  error_msg: string | null
  // product_swap 模式专用字段：t2i/i2i 时为 null
  template_image_url: string | null
  product_image_url: string | null
  prompt: string | null
  created_at: string
  completed_at: string | null
}

export interface BatchStatusResponse {
  batch_id: string
  total: number
  completed: number
  failed: number
  in_progress: number
  queued: number
  pending: number
  tasks: GenerationTaskItem[]
}

export interface BatchSummary {
  batch_id: string
  task_count: number
  completed_count: number
  last_created_at: string
}

export interface BatchListResponse {
  batches: BatchSummary[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface BatchDeleteResponse {
  deleted_batch_ids: string[]
  deleted_task_count: number
}

// 今日批次计数（来自 GET /api/batches/today-count）
// 用于前端批次号预览：next_batch_id 由后端权威计算（最小未使用 seq），
// 预览 = 后端实际分配，避免分页漏算 + 删除空洞 + 跨日时区误差
export interface TodayBatchCount {
  count: number
  prefix: string
  date: string // 北京时间 MMDD，如 "0721"
  next_batch_id: string // 服务端即将分配给下一次创建的实际 ID
}

// ---------- 文件夹批量图生图（i2i_multi） ----------

// i2i_multi 请求：一次创建 N 个 i2i 批次（每张图一个批次，批次内 K 任务共享该图）
export interface I2iMultiCreateRequest {
  group_id: number
  image_urls: string[] // 长度 1-50，每张图对应一个批次
  size: string
  resolution: string
  prefix?: string // 默认 "MZY"
}

// i2i_multi 响应：创建成功的所有 batch_id
export interface I2iMultiCreateResponse {
  batch_ids: string[] // 按 seq 升序
  task_count: number // = batch_ids.length × 变体组大小 K
  base_batch_id: string // 起始批次 ID（next_batch_id 实际值）
}

export interface ImageUploadResponse {
  url: string
}

// ---------- 标题生成 ----------

// 支持的多模态模型 ID（与后端白名单对齐）
export type TitleModelId = 'gemini-3.6-flash' | 'grok-4.5' | 'gpt-5.6-sol'

export interface TitleModelOption {
  id: TitleModelId
  label: string
  description: string
}

// 单条 TitleTask
export interface TitleTask {
  id: number
  source_task_id: number | null
  batch_id: string
  source_image_url: string
  model: string
  extra_instructions: string | null
  max_tokens: number | null
  temperature: number | null
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  title: string | null
  error_msg: string | null
  regenerated_count: number
  created_at: string
  completed_at: string | null
}

// 批次中可作为底图的图片条目（用于"选第 K 张图"）
export interface TitleBatchImageItem {
  index: number
  task_id: number
  image_url: string
}

export interface TitleBatchImagesResponse {
  batch_id: string
  images: TitleBatchImageItem[]
}

// 批量生成请求
export interface TitleGenerateRequest {
  batch_ids: string[]
  image_index: number
  model: TitleModelId
  system_prompt?: string
  max_tokens?: number | null
  temperature?: number | null
}

// 批量生成响应
export interface TitleGenerateResponse {
  created: number
  skipped: number
  title_tasks: TitleTask[]
  errors: { batch_id: string; reason: string }[]
}

// 重新生成请求
export interface TitleRegenerateRequest {
  model?: TitleModelId
  system_prompt?: string
  max_tokens?: number | null
  temperature?: number | null
}

// 批量删除请求
export interface TitleBatchDeleteRequest {
  title_task_ids: number[]
}
