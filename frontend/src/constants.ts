export const SIZE_RESOLUTION_MAP: Record<string, Record<string, string>> = {
  '1:1': { '1k': '1024x1024', '2k': '2048x2048', '4k': '2880x2880' },
  '3:2': { '1k': '1536x1024', '2k': '2048x1360', '4k': '3520x2336' },
  '2:3': { '1k': '1024x1536', '2k': '1360x2048', '4k': '2336x3520' },
  '4:3': { '1k': '1024x768', '2k': '2048x1536', '4k': '3312x2480' },
  '3:4': { '1k': '768x1024', '2k': '1536x2048', '4k': '2480x3312' },
  '5:4': { '1k': '1280x1024', '2k': '2560x2048', '4k': '3216x2576' },
  '4:5': { '1k': '1024x1280', '2k': '2048x2560', '4k': '2576x3216' },
  '16:9': { '1k': '1536x864', '2k': '2048x1152', '4k': '3840x2160' },
  '9:16': { '1k': '864x1536', '2k': '1152x2048', '4k': '2160x3840' },
  '2:1': { '1k': '2048x1024', '2k': '2688x1344', '4k': '3840x1920' },
  '1:2': { '1k': '1024x2048', '2k': '1344x2688', '4k': '1920x3840' },
  '21:9': { '1k': '2016x864', '2k': '2688x1152', '4k': '3840x1648' },
  '9:21': { '1k': '864x2016', '2k': '1152x2688', '4k': '1648x3840' },
}

export const SIZE_OPTIONS = Object.keys(SIZE_RESOLUTION_MAP)
export const DEFAULT_SIZE = '1:1'
export const DEFAULT_RESOLUTION = '1k'

// 批次号前缀：用户可自定义，仅允许 A-Z / 0-9，1-10 位
export const DEFAULT_BATCH_PREFIX = 'MZY'
export const BATCH_PREFIX_PATTERN = /^[A-Z0-9]{1,10}$/
export const BATCH_PREFIX_STORAGE_KEY = 'gpt2.batchPrefix'

// 产品替换模式：产品图数量上下限（与后端 MIN/MAX_PRODUCT_SWAP_COUNT 同步）
export const MIN_PRODUCT_SWAP_COUNT = 1
export const MAX_PRODUCT_SWAP_COUNT = 20

// 文件夹批量图生图（i2i_multi）模式：一次请求创建的批次数量上下限
// 与后端 MIN/MAX_I2I_MULTI_COUNT 同步；前端预设 10/20/50 三个快捷选项
export const MIN_I2I_MULTI_COUNT = 1
export const MAX_I2I_MULTI_COUNT = 50
export const I2I_MULTI_QUICK_PICKS = [10, 20, 50] as const

// 文件夹批量图生图：接受的图片扩展名（小写）
// 用户图片文件名规范：`阿拉伯数字 + 扩展名`，如 1.png / 23.jpg
export const I2I_MULTI_IMAGE_EXTS = ['png', 'jpg', 'jpeg'] as const
export const I2I_MULTI_FILENAME_PATTERN = /^(\d+)\.(png|jpg|jpeg)$/i

// ---------- 标题生成 ----------

// 支持的多模态模型清单（与后端 SUPPORTED_TITLE_MODELS 对齐）
export const TITLE_MODEL_OPTIONS = [
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    description: '默认 / 速度快 / 性价比高',
  },
  {
    id: 'grok-4.5',
    label: 'Grok 4.5',
    description: '风格灵活，适合创意润色',
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description: '推理强，适合复杂长标题',
  },
] as const

// max_tokens 选项（电商标题一般不超过 200 字，但留足余量方便长标题/特殊需求）
export const MAX_TOKENS_OPTIONS = [4096, 8192, 16384, 32768] as const

// 标题生成 localStorage 键
export const TITLE_PROMPT_STORAGE_KEY = 'gpt2.title.systemPrompt'

// 默认地毯标题 system prompt（与后端 DEFAULT_CARPET_TITLE_SYSTEM_PROMPT 同步）
// 用户可在前端编辑，存到 localStorage。
export const DEFAULT_CARPET_TITLE_SYSTEM_PROMPT =
  '你是一名专业的电商店铺标题优化专家。请根据用户提供的商品图片，' +
  '生成 1 条适合 temu 平台全托模式的电商标题，要求：\n' +
  '1. 开头固定为「JIT 天鹅绒 850g」；\n' +
  '2. 后续依次覆盖：地毯图案描述 + 材质特点 + 地毯卖点 + 使用场景 + 推荐购买词；\n' +
  '3. 用优秀的电商标题特点（卖点前置、节奏感强、关键词密度高）润色；\n' +
  '4. 严禁使用以下 temu 平台高风险词：Best, Top, No.1, The Cheapest, #1, ' +
  'Ultimate, The Only, Perfect, All-Time Favorite, Most Popular, Best Seller, ' +
  '100% Waterproof, Never Fade, Anti-Allergy, Hypoallergenic, Medical Grade, ' +
  'Cure, Treat, Heal, Miracle, 3D；\n' +
  '5. 严禁出现「儿童」「宝宝」等任何与儿童相关的内容；\n' +
  '6. 不要输出任何解释、编号、引号或前后缀，只输出最终标题文本本身。'

export const TITLE_POLL_INTERVAL_MS = 3000
