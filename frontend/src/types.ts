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

// 生成模型（与后端 schemas.py IMAGE_MODEL 白名单对齐）
export type ImageModelId =
  | 'gpt-image-2'
  | 'gpt-image-2-vip'
  | 'gemini-3.1-flash-image-preview'

// 精度档位（low/medium/high；仅 gpt-image-2-vip 支持）
export type ImageQuality = 'low' | 'medium' | 'high'

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
  // 生图模型 + 精度档位（默认 gpt-image-2；quality 仅部分模型支持）
  model?: ImageModelId
  quality?: ImageQuality
  // 自动接力套图：裂变批次全部结束后，自动用其已完成图片创建套图批次（可选）
  relay?: AutoRelayConfig
}

// 自动接力套图配置（与后端 RelayConfig 对齐）
export interface AutoRelayConfig {
  group_id: number
  prefix?: string // 套图批次前缀，独立于裂变前缀，默认 "TAO"
  size: string
  resolution: string
  model?: ImageModelId
  quality?: ImageQuality
}

// 产品替换请求：上传 1 张模板图 + N 张产品图，生成 N 张结果图
export interface ProductSwapRequest {
  template_image_url: string
  product_image_urls: string[] // 长度 1-20，按上传顺序生成
  prompt: string
  size: string
  resolution: string
  prefix?: string // 默认 "MZY"
  model?: ImageModelId
  quality?: ImageQuality
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
  model: string
  quality: string | null
  auto_retry_count: number
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
  // 白边裁剪（extract 模式返回；其他模式为 null/undefined）
  crop_enabled?: boolean | null
  crop_threshold?: number | null
  crop_image_url?: string | null
  crop_meta?: CropMeta | null
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
  failed_count: number
  // 批次内任务的最大重试次数（>0 表示该批次被重试过，列表显示「重试 ×N」徽章）
  retried_count: number
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

// 批量重试失败任务响应（总览页「重试已选批次」）
export interface BatchRetryResponse {
  retried_batch_ids: string[]
  retried_task_count: number
  skipped_batch_ids: string[]
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
  model?: ImageModelId
  quality?: ImageQuality
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

// 支持的多模态模型 ID（与后端白名单对齐，顺序同失败重试切换顺序）
export type TitleModelId =
  | 'gemini-3.7-flash'
  | 'gpt-5.6-terra'
  | 'gpt-5.4-mini'
  | 'claude-haiku-4-5'
  | 'gpt-5.4-mini-official'
  | 'grok-4.6'
  | 'gemini-3.1-pro'
  | 'grok-4.5'
  | 'gpt-5.6-sol'
  | 'gpt-5.4-nano-official'

export interface TitleModelOption {
  id: TitleModelId
  label: string
  description: string
}

// 地毯类型：决定使用哪份内置 prompt（与后端 CARPET_TYPES 对齐）
export type CarpetType = 'corridor' | 'living_room' | 'general'

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
  carpet_type?: CarpetType // 新增：地毯类型（默认 'general'）
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
  carpet_type?: CarpetType // 新增：地毯类型（不传则沿用旧任务的 prompt）
  model?: TitleModelId
  system_prompt?: string
  max_tokens?: number | null
  temperature?: number | null
}

// 批量删除请求
export interface TitleBatchDeleteRequest {
  title_task_ids: number[]
}

// 地毯类型 → prompt 模板和中文标签（来自 GET /api/title-tasks/prompts）
export interface TitlePromptsResponse {
  prompts: Record<CarpetType, string>
  labels: Record<CarpetType, string>
}

// ---------- 提取产品图（工厂 ERP / 用户自定义） ----------

// 白边裁剪统计（后端 crop_meta JSON）
export interface CropMeta {
  orig_w: number
  orig_h: number
  crop_w: number
  crop_h: number
  orig_size: number
  crop_size: number
  /** 与纯白欧氏距离阈值 */
  threshold: number
  /** 裁掉面积百分比 0-100 */
  area_pct: number
  /** 裁剪失败原因（有值表示降级为原图） */
  error?: string
}

// 白边裁剪配置请求（开关 + 阈值）
export interface CropConfigRequest {
  enabled: boolean
  threshold: number
}

export interface CropConfigResponse {
  success: boolean
  crop_enabled: boolean
  crop_threshold: number
  crop_image_url: string | null
  crop_meta: CropMeta | null
}

// 工厂 ERP 店铺
export interface ErpStore {
  id: number
  name: string
}

// ERP 会话状态
export interface ErpSessionStatus {
  valid: boolean
  store_count: number
  last_error: string | null
}

// 生成单元（店铺 + 货号去重后）
export interface ErpExtractUnit {
  unit_key: string
  supplier_id: number
  store_name: string
  goods_sn: string
  order_item_ids: number[]
  representative_order_item_id: number
  input_image_url: string
  /** 工厂原始图（用户替换输入图后用于重置） */
  factory_image_url: string | null
  size: string
  material: string | null
  mapped_ratio: string
  batch_id: string | null
  generation_task_id: number | null
  status: 'pending' | 'generating' | 'completed' | 'failed' | 'uploaded'
  result_image_url: string | null
  error_msg: string | null
  created_at: string | null
  erp_uploaded_at: string | null
  /** 生成任务进度 0-100（ToAPIs 同步） */
  progress: number
  /** 白边裁剪：配置（单元级）+ 结果（任务级） */
  crop_enabled: boolean
  crop_threshold: number
  crop_image_url: string | null
  crop_meta: CropMeta | null
}

export interface ErpOrdersPreviewResponse {
  supplier_ids: number[]
  crawled_count: number
  units: ErpExtractUnit[]
}

// 生成历史记录（持久化查询，不依赖 ERP 同步）
export interface ErpHistoryResponse {
  units: ErpExtractUnit[]
  total: number
}

// 工厂自动化生成请求
export interface ErpGenerateRequest {
  supplier_ids: number[]
  /** 只生成指定单元（unit_key）；不传则生成全部待生成单元 */
  unit_keys?: string[]
  prompt: string
  size_mode: 'auto' | 'fixed'
  fixed_size?: string
  size_overrides?: Record<string, string>
  size: string
  resolution: string
  model?: ImageModelId
  quality?: ImageQuality
}

// 单个货号的生成结果
export interface ErpGenerateItem {
  batch_id: string
  store_name: string
  goods_sn: string
  generation_task_id: number | null
  success: boolean
  message: string
  /** 实际使用的模型（极端宽高比货号会自动切到 gemini） */
  model: string | null
}

// 工厂自动化生成响应（每个货号一个批次）
export interface ErpGenerateResponse {
  results: ErpGenerateItem[]
  succeeded: number
  failed: number
}

// 用户自定义提取请求
export interface ExtractGenerateRequest {
  image_urls: string[]
  prompt: string
  size: string
  resolution: string
  prefix?: string
  model?: ImageModelId
  quality?: ImageQuality
  /** 白边裁剪（本批次统一配置） */
  crop_enabled?: boolean
  crop_threshold?: number
}

// 上传结果（单条/批量通用）
export interface ErpUploadResult {
  order_item_id: number
  store_name: string
  goods_sn: string
  success: boolean
  message: string
}

export interface ErpUploadAllResponse {
  results: ErpUploadResult[]
  succeeded: number
  failed: number
}

// ---------- 用户自定义提取历史 ----------

export interface ExtractHistoryItem {
  task_id: number
  batch_id: string
  status: string
  model: string
  quality: string | null
  size: string
  resolution: string
  prompt: string | null
  input_image_url: string | null
  result_image_url: string | null
  error_msg: string | null
  created_at: string
  completed_at: string | null
  /** 生成任务进度 0-100（ToAPIs 同步） */
  progress: number
  /** 白边裁剪：配置快照 + 结果 */
  crop_enabled: boolean
  crop_threshold: number
  crop_image_url: string | null
  crop_meta: CropMeta | null
}

export interface ExtractHistoryResponse {
  items: ExtractHistoryItem[]
  total: number
}
