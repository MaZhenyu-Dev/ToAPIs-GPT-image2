import { useCallback, useEffect, useRef, useState } from 'react'
import BatchGenerator from './components/BatchGenerator'
import ErrorBoundary from './components/ErrorBoundary'
import FolderBatchGenerator from './components/FolderBatchGenerator'
import ImagePreview from './components/ImagePreview'
import ParameterSelector from './components/ParameterSelector'
import ProductSwapper from './components/ProductSwapper'
import ResultActions from './components/ResultActions'
import TitleGenerator from './components/TitleGenerator'
import VariantGroupManager from './components/VariantGroupManager'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { createGeneration, getTaskStatus, listVariantGroups } from './api'
import { DEFAULT_RESOLUTION, DEFAULT_SIZE } from './constants'
import type { TaskStatus, VariantGroupListItem } from './types'

const POLL_INTERVAL_MS = 3000

type TabKey = 'single' | 'groups' | 'batch' | 'product_swap' | 'folder_batch' | 'title'

const statusText: Record<string, string> = {
  queued: '排队中',
  in_progress: '生成中...',
  completed: '已完成',
  failed: '生成失败',
}

export default function App() {
  const isOnline = useOnlineStatus()
  const [activeTab, setActiveTab] = useState<TabKey>('single')
  const [groups, setGroups] = useState<VariantGroupListItem[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)

  // 单次生成状态
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState(DEFAULT_SIZE)
  const [resolution, setResolution] = useState(DEFAULT_RESOLUTION)
  const [task, setTask] = useState<TaskStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

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
    if (activeTab === 'batch' || activeTab === 'folder_batch') {
      loadGroups()
    }
  }, [activeTab, loadGroups])

  const clearPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  const startPolling = useCallback(
    (taskId: string) => {
      clearPolling()
      pollTimer.current = setInterval(async () => {
        try {
          const status = await getTaskStatus(taskId)
          setTask(status)
          if (status.status === 'completed' || status.status === 'failed') {
            clearPolling()
          }
        } catch (err) {
          if (err instanceof Error) {
            setError(`轮询状态失败: ${err.message}`)
          }
        }
      }, POLL_INTERVAL_MS)
    },
    [clearPolling]
  )

  useEffect(() => {
    return () => clearPolling()
  }, [clearPolling])

  const handleSingleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!prompt.trim()) return

    setLoading(true)
    setError(null)
    setTask(null)
    clearPolling()

    try {
      const newTask = await createGeneration({
        prompt: prompt.trim(),
        size,
        resolution,
        n: 1,
      })
      setTask(newTask)
      startPolling(newTask.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成任务创建失败')
    } finally {
      setLoading(false)
    }
  }

  const handleSelectGroup = (group: VariantGroupListItem) => {
    setSelectedGroupId(group.id)
    setActiveTab('batch')
  }

  return (
    <div>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1>GPT-Image-2 批量变体生成平台</h1>
        {!isOnline && (
          <div
            style={{
              marginBottom: '0.75rem',
              padding: '0.5rem 0.75rem',
              background: '#fef2f2',
              color: '#991b1b',
              borderRadius: '8px',
              fontSize: '0.85rem',
            }}
          >
            网络已断开，请检查网络连接。恢复后将自动重连。
          </div>
        )}
        <nav
          style={{
            display: 'flex',
            gap: '0.5rem',
            borderBottom: '2px solid #e5e7eb',
            paddingBottom: '0.5rem',
          }}
        >
          <TabButton
            active={activeTab === 'single'}
            onClick={() => setActiveTab('single')}
          >
            单次生成
          </TabButton>
          <TabButton
            active={activeTab === 'groups'}
            onClick={() => setActiveTab('groups')}
          >
            变体组管理
          </TabButton>
          <TabButton
            active={activeTab === 'batch'}
            onClick={() => setActiveTab('batch')}
          >
            批量生成
          </TabButton>
          <TabButton
            active={activeTab === 'product_swap'}
            onClick={() => setActiveTab('product_swap')}
          >
            产品替换
          </TabButton>
          <TabButton
            active={activeTab === 'folder_batch'}
            onClick={() => setActiveTab('folder_batch')}
          >
            文件夹批量
          </TabButton>
          <TabButton
            active={activeTab === 'title'}
            onClick={() => setActiveTab('title')}
          >
            标题生成
          </TabButton>
        </nav>
      </header>

      <ErrorBoundary>
        {activeTab === 'single' && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>单次文生图</h2>
            <form onSubmit={handleSingleSubmit}>
              <div className="form-group">
                <label htmlFor="prompt">Prompt</label>
                <textarea
                  id="prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="描述你想生成的图像..."
                  required
                />
              </div>

              <ParameterSelector
                size={size}
                resolution={resolution}
                onChange={({ size, resolution }) => {
                  setSize(size)
                  setResolution(resolution)
                }}
              />

              <div style={{ marginTop: '1.25rem' }}>
                <button type="submit" disabled={loading || !prompt.trim()}>
                  {loading ? '创建任务中...' : '开始生成'}
                </button>
              </div>
            </form>

            {error && <div className="error">{error}</div>}

            {task && (
              <div style={{ marginTop: '1.5rem' }}>
                <div
                  className={`status ${
                    task.status === 'completed'
                      ? 'completed'
                      : task.status === 'failed'
                      ? 'failed'
                      : ''
                  }`}
                >
                  <div>
                    <strong>状态：</strong>
                    {statusText[task.status] || task.status}
                  </div>
                  <div>
                    <strong>进度：</strong>
                    {task.progress}%
                  </div>
                  <div>
                    <strong>任务 ID：</strong>
                    {task.id}
                  </div>
                </div>

                {task.status === 'completed' && task.url && (
                  <div className="result-image">
                    <ResultImage
                      url={task.url}
                      prompt={prompt}
                      onPreview={() => setPreviewUrl(task.url ?? null)}
                    />
                    <div style={{ marginTop: '0.75rem' }}>
                      <ResultActions
                        task={task}
                        prompt={prompt}
                        onPreview={() => setPreviewUrl(task.url ?? null)}
                      />
                    </div>
                  </div>
                )}

                {task.status === 'failed' && task.error && (
                  <div className="error">{task.error.message}</div>
                )}
              </div>
            )}
          </div>
        )}
      </ErrorBoundary>

      <ErrorBoundary>
        {activeTab === 'groups' && (
          <VariantGroupManager
            onSelect={handleSelectGroup}
            selectedGroupId={selectedGroupId ?? null}
          />
        )}
      </ErrorBoundary>

      <ErrorBoundary>
        {activeTab === 'batch' && (
          <>
            {groupsLoading ? (
              <div className="card">加载变体组列表...</div>
            ) : groupsError ? (
              <div className="card error">{groupsError}</div>
            ) : (
              <BatchGenerator
                groups={groups}
                selectedGroupId={selectedGroupId ?? null}
              />
            )}
          </>
        )}
      </ErrorBoundary>

      <ErrorBoundary>
        {activeTab === 'product_swap' && <ProductSwapper />}
      </ErrorBoundary>

      <ErrorBoundary>
        {activeTab === 'folder_batch' && (
          <>
            {groupsLoading ? (
              <div className="card">加载变体组列表...</div>
            ) : groupsError ? (
              <div className="card error">{groupsError}</div>
            ) : (
              <FolderBatchGenerator
                groups={groups}
                selectedGroupId={selectedGroupId ?? null}
              />
            )}
          </>
        )}
      </ErrorBoundary>

      <ErrorBoundary>
        {activeTab === 'title' && <TitleGenerator />}
      </ErrorBoundary>

      <ImagePreview
        url={previewUrl}
        onClose={() => setPreviewUrl(null)}
      />
    </div>
  )
}

function ResultImage({
  url,
  prompt,
  onPreview,
}: {
  url: string
  prompt: string
  onPreview: () => void
}) {
  const [error, setError] = useState(false)

  if (error) {
    return (
      <div className="error" style={{ marginTop: '1rem' }}>
        图片加载失败，可能链接已失效。
      </div>
    )
  }

  return (
    <img
      src={url}
      alt={prompt || '生成的图像'}
      onClick={onPreview}
      onError={() => setError(true)}
      style={{
        maxWidth: '100%',
        borderRadius: '8px',
        border: '1px solid #e5e7eb',
        cursor: 'pointer',
      }}
    />
  )
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? '#2563eb' : 'transparent',
        color: active ? '#fff' : '#374151',
        padding: '0.5rem 1rem',
        borderRadius: '8px 8px 0 0',
        borderBottom: active ? '2px solid #2563eb' : 'none',
        marginBottom: '-0.5rem',
      }}
    >
      {children}
    </button>
  )
}
