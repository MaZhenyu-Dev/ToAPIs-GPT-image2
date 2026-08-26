import { useState } from 'react'
import CustomExtract from './CustomExtract'
import FactoryAutomation from './FactoryAutomation'
import GlassCard from '../ui/GlassCard'

type SubTab = 'factory' | 'custom'

/** 提取产品图工作区：工厂自动化 / 用户自定义 两个子功能 */
export default function ExtractWorkspace() {
  const [subTab, setSubTab] = useState<SubTab>('factory')

  return (
    <GlassCard>
      <div
        role="tablist"
        aria-label="提取产品图功能"
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: 'var(--space-4)',
          padding: '0.25rem',
          background: 'var(--glass-1-bg)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--glass-border)',
          width: 'fit-content',
        }}
      >
        {(
          [
            { key: 'factory', label: '工厂自动化', hint: '从工厂 ERP 爬取图片缺失订单 → 生成 → 上传回 ERP' },
            { key: 'custom', label: '用户自定义', hint: '手动传图 → 生成 → 自行下载 / 上传' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={subTab === tab.key}
            title={tab.hint}
            onClick={() => setSubTab(tab.key)}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: 'var(--radius-sm)',
              border: 'none',
              cursor: 'pointer',
              background: subTab === tab.key ? 'var(--accent)' : 'transparent',
              color: subTab === tab.key ? '#fff' : 'var(--text-2)',
              fontWeight: 600,
              fontSize: '0.9rem',
              transition: 'background var(--dur), color var(--dur)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {subTab === 'factory' ? <FactoryAutomation /> : <CustomExtract />}
    </GlassCard>
  )
}
