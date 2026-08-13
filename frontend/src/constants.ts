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
// 与后端 MIN/MAX_I2I_MULTI_COUNT 同步；ToAPIs 官方并发升级后放开到 500
export const MIN_I2I_MULTI_COUNT = 1
export const MAX_I2I_MULTI_COUNT = 500
export const I2I_MULTI_QUICK_PICKS = [10, 50, 100, 200, 500] as const

// 文件夹批量图生图：接受的图片扩展名（小写）
// 用户图片文件名规范：`阿拉伯数字 + 扩展名`，如 1.png / 23.jpg
export const I2I_MULTI_IMAGE_EXTS = ['png', 'jpg', 'jpeg'] as const
export const I2I_MULTI_FILENAME_PATTERN = /^(\d+)\.(png|jpg|jpeg)$/i

// ---------- 标题生成 ----------

// 支持的多模态模型清单（与后端 SUPPORTED_TITLE_MODELS 对齐）
// 顺序即失败重试的切换顺序：性价比高、稳定的模型排前面；贵的/弱的排后面。
export const TITLE_MODEL_OPTIONS = [
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    description: '默认 / 速度快 / 性价比高',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: '低价主力，速度与质量均衡',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: '低价，日常标题够用',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    description: 'Anthropic 轻量级，稳定',
  },
  {
    id: 'gpt-5.4-mini-official',
    label: 'GPT-5.4 Mini (Official)',
    description: '官方渠道，稳定性优先',
  },
  {
    id: 'grok-4.6',
    label: 'Grok 4.6',
    description: 'xAI 新款，风格灵活',
  },
  {
    id: 'gemini-3.1-pro',
    label: 'Gemini 3.1 Pro',
    description: 'Pro 级，长标题质量好',
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
  {
    id: 'gpt-5.4-nano-official',
    label: 'GPT-5.4 Nano (Official)',
    description: '最便宜，兜底用',
  },
] as const

// max_tokens 选项（电商标题一般不超过 200 字，但留足余量方便长标题/特殊需求）
export const MAX_TOKENS_OPTIONS = [4096, 8192, 16384, 32768] as const

// 标题生成 localStorage 键
export const TITLE_PROMPT_STORAGE_KEY = 'gpt2.title.systemPrompt'

// systemPrompt 是否被用户手动编辑过（决定切换地毯类型时是否覆盖）
// '1' = 已编辑（不再被自动覆盖）；不存在 = 未编辑（地毯类型切换时自动套用对应 prompt）
export const TITLE_PROMPT_DIRTY_STORAGE_KEY = 'gpt2.title.systemPromptDirty'

// 用户选择的地毯类型 localStorage 键（corridor / living_room / general）
export const TITLE_CARPET_TYPE_STORAGE_KEY = 'gpt2.title.carpetType'

// 默认地毯标题 system prompt（fallback）
// - 正常路径下，prompt 由后端 GET /api/title-tasks/prompts 提供（更权威、可热更新）
// - 此处仅作为 API 调用失败 / 加载中时的兜底
// - 与后端 backend/app/prompts/__init__.py 的 DEFAULT_CARPET_TITLE_SYSTEM_PROMPT 同步
export const DEFAULT_CARPET_TITLE_SYSTEM_PROMPT = `你是一名专业的电商店铺标题优化专家。请根据用户提供的商品图片，生成 1 条适合 Temu 平台全托模式的电商标题，要求：

开头固定为「JIT 天鹅绒 850g」；

后续依次覆盖：地毯图案描述 + 材质特点 + 地毯卖点 + 使用场景 + 推荐购买词 + 秋冬字眼；

用优秀的电商店铺标题特点（卖点前置、节奏感强、关键词密度高）润色；

【地毯卖点】只能从以下白名单中选取组合，不得自造：
厚实 / 加厚 / 绒面 / 脚感柔软舒适 / 回弹好 / 可折叠 / 易打理 / 不掉绒 / 不掉色 / 耐踩耐磨 / 加绒保暖。
【严禁出现】防滑、抓地、止滑、non-slip、skid（会触发防滑资质）；
阻燃、防火、flame retardant（触发阻燃标识/资质）；
抗菌、抑菌、防螨、除螨（触发功能资质）；
防水、100% waterproof（强宣称触发资质）；
隔音、降噪（功能资质）。

【推荐购买词】只能从以下中性利益词中选 1 个，不得自造：
居家优选 / 换季推荐 / 室内必备 / 装修搭配 / 应季好物。
【严禁任何促销炒作词】：爆款、热卖、热销、秒杀、抢购、疯抢、限量、
销量第一、人气、首选、必买、断货。

【秋冬字眼】用中性保暖描述：秋冬保暖 / 加绒御寒 / 冬季暖足 / 秋冬适用，不得与促销词混搭；

严禁使用以下高风险词（中英双语）：

绝对化：Best、Top、No.1、The Cheapest、#1、Ultimate、The Only、Perfect、
All-Time Favorite、Most Popular、Best Seller、最、第一、顶级、极品、
全网最低、百分百、100%、永不、永不褪色；
功能夸大/医疗/迷信：Never Fade、Anti-Allergy、Hypoallergenic、Medical Grade、
Cure、Treat、Heal、Miracle、治疗、预防、改善、招财、辟邪；
其他：3D；
严禁出现「儿童」「宝宝」「婴儿」「童」及 kids、baby、infant、nursery、toddler
等任何与儿童相关的内容（无儿童资质，红线）；

格式要求：【不使用任何标点符号】（无逗号、顿号、斜杠、感叹号、破折号、
emoji 等，避免触发平台"特殊符号"风控）；但【必须用空格分隔每个语义段落】——
开头规格、图案描述、材质特点、卖点、使用场景、推荐购买词、秋冬字眼，
相邻两段之间各用 1 个空格隔开，保证可读性，禁止整句连写无空格；

不要输出任何解释、编号、引号或前后缀，只输出最终标题文本本身。`

// 地毯类型默认值（与后端 CARPET_TYPES 默认值对齐）
export const DEFAULT_CARPET_TYPE = 'general' as const

// 全部地毯类型 + 中文标签（静态 fallback，主要用于初次渲染避免空白）
// 实际展示以 GET /api/title-tasks/prompts 返回的 labels 为准
export const CARPET_TYPE_FALLBACK_LABELS: Record<string, string> = {
  corridor: '走廊地毯',
  living_room: '客厅地毯',
  general: '通用地毯',
}

export const TITLE_POLL_INTERVAL_MS = 3000
