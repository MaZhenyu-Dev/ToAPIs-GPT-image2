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
