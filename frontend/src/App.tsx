import { useCallback, useEffect, useState } from 'react'
import { listVariantGroups } from './api'
import BatchWorkspace from './components/batch/BatchWorkspace'
import { ConfirmDialogProvider } from './components/ui/ConfirmDialog'
import ErrorBoundary from './components/ErrorBoundary'
import ExtractWorkspace from './components/extract/ExtractWorkspace'
import GlassCard from './components/ui/GlassCard'
import AppLayout from './components/layout/AppLayout'
import type { TabKey } from './config/navigation'
import ProductSwapper from './components/ProductSwapper'
import TitleGenerator from './components/TitleGenerator'
import { ToastProvider } from './components/ui/Toast'
import VariantGroupManager from './components/VariantGroupManager'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { useTheme } from './hooks/useTheme'
import type { VariantGroupListItem } from './types'

export default function App() {
  const isOnline = useOnlineStatus()
  const { theme, toggleTheme } = useTheme()
  const [activeTab, setActiveTab] = useState<TabKey>('generate')

  const [groups, setGroups] = useState<VariantGroupListItem[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true)
    setGroupsError(null)
    try {
      const data = await listVariantGroups()
      setGroups(data)
    } catch (err) {
      setGroupsError(err instanceof Error ? err.message : '加载变体组失败')
    } finally {
      setGroupsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'generate') {
      void loadGroups()
    }
  }, [activeTab, loadGroups])

  const handleSelectGroup = (group: VariantGroupListItem) => {
    setSelectedGroupId(group.id)
    setActiveTab('generate')
  }

  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <AppLayout
          activeTab={activeTab}
          onTabChange={setActiveTab}
          isOnline={isOnline}
          theme={theme}
          onToggleTheme={toggleTheme}
        >
          <ErrorBoundary>
            {activeTab === 'generate' && (
              <div className="tab-pane">
                {groupsLoading ? (
                  <GlassCard>
                    <div className="hint" style={{ padding: '1rem 0', textAlign: 'center' }}>
                      加载变体组列表...
                    </div>
                  </GlassCard>
                ) : groupsError ? (
                  <GlassCard>
                    <div className="error">{groupsError}</div>
                  </GlassCard>
                ) : (
                  <BatchWorkspace
                    groups={groups}
                    selectedGroupId={selectedGroupId ?? null}
                  />
                )}
              </div>
            )}
          </ErrorBoundary>

          <ErrorBoundary>
            {activeTab === 'extract' && (
              <div className="tab-pane">
                <ExtractWorkspace />
              </div>
            )}
          </ErrorBoundary>

          <ErrorBoundary>
            {activeTab === 'groups' && (
              <div className="tab-pane">
                <VariantGroupManager
                  onSelect={handleSelectGroup}
                  selectedGroupId={selectedGroupId ?? null}
                />
              </div>
            )}
          </ErrorBoundary>

          <ErrorBoundary>
            {activeTab === 'product_swap' && (
              <div className="tab-pane">
                <ProductSwapper />
              </div>
            )}
          </ErrorBoundary>

          <ErrorBoundary>
            {activeTab === 'title' && (
              <div className="tab-pane">
                <TitleGenerator />
              </div>
            )}
          </ErrorBoundary>
        </AppLayout>
      </ConfirmDialogProvider>
    </ToastProvider>
  )
}
