import type { ComponentType, SVGProps } from 'react'
import {
  IconFolder,
  IconImage,
  IconLayers,
  IconRepeat,
  IconType,
} from '../components/ui/Icon'

export type TabKey = 'generate' | 'extract' | 'product_swap' | 'title' | 'groups'

export interface TabMeta {
  key: TabKey
  label: string
  description: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

/** 导航元数据：顺序即侧边栏展示顺序 */
export const TAB_META: TabMeta[] = [
  {
    key: 'generate',
    label: '批量生成',
    description: '变体组批量 / 文件夹批量',
    icon: IconLayers,
  },
  {
    key: 'extract',
    label: '提取产品图',
    description: '工厂自动化 / 用户自定义',
    icon: IconImage,
  },
  {
    key: 'product_swap',
    label: '产品替换',
    description: '模板图 × 产品图批量合成',
    icon: IconRepeat,
  },
  {
    key: 'title',
    label: '标题生成',
    description: '基于生成图的电商标题',
    icon: IconType,
  },
  {
    key: 'groups',
    label: '变体组',
    description: '管理 Prompt 变体组',
    icon: IconFolder,
  },
]

export function getTabMeta(key: TabKey): TabMeta {
  return TAB_META.find((item) => item.key === key) ?? TAB_META[0]
}
