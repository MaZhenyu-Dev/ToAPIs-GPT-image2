import type { ReactNode } from 'react'
import { getTabMeta, TAB_META } from '../../config/navigation'
import type { TabKey } from '../../config/navigation'
import type { Theme } from '../../hooks/useTheme'
import { IconLayers, IconMoon, IconSun } from '../ui/Icon'

interface AppLayoutProps {
  activeTab: TabKey
  onTabChange: (tab: TabKey) => void
  isOnline: boolean
  theme: Theme
  onToggleTheme: () => void
  children: ReactNode
}

export default function AppLayout({
  activeTab,
  onTabChange,
  isOnline,
  theme,
  onToggleTheme,
  children,
}: AppLayoutProps) {
  const current = getTabMeta(activeTab)

  return (
    <>
      {/* 环境背景：影棚灯光 + 胶片噪点，为玻璃材质提供可模糊的内容 */}
      <div className="ambient" aria-hidden="true">
        <div className="ambient-noise" />
      </div>

      <div className="app-shell">
        <aside className="app-sidebar">
          <div className="sidebar-brand">
            <span className="sidebar-brand-icon">
              <IconLayers width={18} height={18} />
            </span>
            <span>
              <span className="sidebar-brand-title">图灵</span>
              <br />
              <span className="sidebar-brand-sub">批量变体生成工作台</span>
            </span>
          </div>

          <nav className="sidebar-nav" aria-label="主导航">
            {TAB_META.map((item) => {
              const Icon = item.icon
              const isActive = item.key === activeTab
              return (
                <button
                  key={item.key}
                  type="button"
                  className={isActive ? 'nav-item nav-item--active' : 'nav-item'}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => onTabChange(item.key)}
                >
                  <span className="nav-item-icon">
                    <Icon width={17} height={17} />
                  </span>
                  <span className="nav-item-label">{item.label}</span>
                </button>
              )
            })}
          </nav>

          <div className="sidebar-footer">
            <span
              className={isOnline ? 'badge badge--success' : 'badge badge--danger'}
              title={isOnline ? '后端服务连接正常' : '网络已断开，恢复后自动重连'}
            >
              <span className={isOnline ? 'badge-dot' : 'badge-dot badge-dot--pulse'} />
              <span className="badge-text">{isOnline ? '服务连接正常' : '网络已断开'}</span>
            </span>
          </div>
        </aside>

        <main className="app-main">
          <div className="app-main-inner">
            <header className="app-header">
              <div>
                <h1 className="page-title">{current.label}</h1>
                <p className="page-description">{current.description}</p>
              </div>
              <div className="header-actions">
                <button
                  type="button"
                  className="icon-button"
                  onClick={onToggleTheme}
                  title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
                  aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
                >
                  {theme === 'dark' ? <IconSun /> : <IconMoon />}
                </button>
              </div>
            </header>

            {children}
          </div>
        </main>
      </div>
    </>
  )
}
