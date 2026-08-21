# 前端重构方案：液态玻璃工作台（Liquid Glass Workbench）

> 版本：v1.0 ｜ 日期：2026-08-20 ｜ 范围：`frontend/` 全部 UI
> 目标：提升质感与体验，将「批量图像生成工作台」做成一个现代、有辨识度的工具型产品。

---

## 1. 背景与目标

当前前端是 Vite + React 18 + 原生 CSS（大量内联样式），功能完善但视觉与体验停留在数年前：

- 灰底 `#f6f8fa` + 白色卡片 + 系统默认蓝色按钮，无设计语言
- 6 个 Tab 功能堆叠，导航负担重
- 多处使用 `window.confirm / alert` 与"错误提示区当成功消息用"的原始交互
- 批次详情图片被固定高度 + `cover` 裁切，看不到全貌

本次重构目标：

1. **删功能**：移除"单次生成"
2. **改结构**：批量生成与文件夹批量合并为一个 Tab（内部双模式切换）
3. **加质感**：引入 iOS 26 Liquid Glass 风格的液态玻璃设计系统
4. **修体验**：批次详情图片全貌清晰展示，细节通过全屏预览查看

---

## 2. 用户反馈 → 需求转化

| # | 用户反馈 | 转化需求 | 落地位置 |
|---|---------|---------|---------|
| 1 | 单次生成几乎没用，可以删除 | 删除"单次生成"Tab 及相关前端逻辑 | `App.tsx`、`api.ts` 清理 |
| 2 | 页面结构样式没质感，体验不好 | 全站重构 + 液态玻璃设计系统 | 全局 CSS 重写 + 组件 UI Kit |
| 3 | 文件夹批量与批量生成融为一个 Tab | 合并为"批量生成"Tab，内部 segmented 切换模式 | 新建 `BatchWorkspace`，合并两个生成器 |
| 4 | 批次详情图片占位太小、被裁切，全貌必须清晰 | 详情网格按批次宽高比展示整图（contain，不裁切）；点击进全屏 Lightbox 看细节 | `BatchDetailPanel` + 新版 `Lightbox` |

---

## 3. 现状诊断（代码级）

### 3.1 结构问题

| 文件 | 行数 | 问题 |
|------|------|------|
| `src/App.tsx` | 394 | 6 个 Tab 全量渲染判断 + 单次生成残留逻辑（轮询、表单、ResultImage） |
| `src/components/BatchGenerator.tsx` | 2144 | 一个组件承担了「生成表单 + 批次列表 + 批次详情 + 导出/重试/删除 + 5 个辅助组件」，严重过载 |
| `src/components/FolderBatchGenerator.tsx` | 764 | 与 BatchGenerator 大量重复（变体组选择、prefix、参数选择） |
| `src/index.css` | 155 | 无 token、无主题变量，仅基础表单样式，其余全靠内联样式 |
| 全部组件 | — | 几乎无 class 化样式，1000+ 处内联 style，无法统一主题与动效 |

### 3.2 体验问题

1. **图片全貌被裁切**：`BatchGenerator.tsx:1682` 用 `height:120px + object-fit:cover`，产品替换 `SwapTaskRow` 用 `180x120 cover`，标题行缩略图 `48x48`。`cover` 会截掉画面主体，用户看不到完整构图。
2. **原生弹窗**：`window.confirm` 出现在删除、重试、覆盖导出、重新生成等 8+ 处；样式无法定制且打断感强。
3. **成功消息走错误通道**：`setError(...)` 同时被用来显示"已保存 N 张""已重试 N 个"等成功信息（BatchGenerator 多处），语义错误。
4. **无状态反馈**：无 Toast、无骨架屏、空状态是干巴巴一行 hint。
5. **导航过密**：6 个 Tab 平铺，信息架构没有层级。
6. **键盘支持差**：Lightbox 仅支持 Esc；无 ← → 切换、无缩放。

---

## 4. 新的信息架构

### 4.1 Tab 结构（6 → 4）

```
┌────────────────────────────────────────────────────────┐
│  头像/Logo  批量图像生成工作台        [主题切换] [●在线]   │
├──────────────┬─────────────────────────────────────────┤
│  左侧导航     │  内容区（Glass 面板）                      │
│  ◆ 批量生成   │                                          │
│  ◆ 产品替换   │      （默认进入「批量生成」）                │
│  ◆ 标题生成   │                                          │
│  ◆ 变体组     │                                          │
└──────────────┴─────────────────────────────────────────┘
```

| Tab | 内容 | 说明 |
|-----|------|------|
| **批量生成**（默认） | `变体组批量 ⇄ 文件夹批量` 双模式 + 批次列表 + 批次详情 | 合并原 批量生成 + 文件夹批量 |
| **产品替换** | 模板图 + N 产品图 → 结果列表 | 保留独立（流程差异大） |
| **标题生成** | 批次选择 → 图位 → 模型参数 → 标题结果 | 保留独立 |
| **变体组** | 组/变体 CRUD | 保留独立 |

布局改为 **左侧固定导航（宽 200px 左右）+ 右侧内容区**，而非顶部平铺 Tab——减少导航密度、给头部留出在线状态/主题切换位，更接近专业工具型产品（如 Midjourney / Figma 类工作台）。

`App.tsx` 中的 `TabKey` 改为：

```ts
type TabKey = 'generate' | 'product_swap' | 'title' | 'groups'
```

### 4.2 批量生成 Tab 内部结构（合并方案）

```
┌─ 批量生成 ────────────────────────────────────────────────┐
│ [ 变体组批量 | 文件夹批量 ]   ← SegmentedControl 切换模式    │
│                                                           │
│ ┌─ 配置面板（Glass Card）──────────────────────────────┐  │
│ │ 变体组 ▾（决定 K=每组任务数）                          │  │
│ │ 批次前缀 [MZY] · 下个ID预览 MZY0820001               │  │
│ │ 模式：文生图 / 图生图     宽高比 ▾   分辨率 ▾          │  │
│ │ ── 仅文件夹模式 ───────────────────────────────      │  │
│ │ │ 选择图片文件夹 → 扫描匹配预览（seq 区间/缺失提示）    │  │
│ │ └────────────────────────────────────────────────  │  │
│ │ [ 开始生成 ]   （文件夹模式按钮文案带任务数预估）        │  │
│ └─────────────────────────────────────────────────────┘  │
│                                                           │
│ ┌─ 批次列表（Glass Card）──────────────────────────────┐  │
│ │ 搜索 [MZY08…]  全选 重试失败 导出到文件夹 删除  分页    │  │
│ │ ┌─────────────────────────────────────────────┐     │  │
│ │ │MZY0820001 ✓ 12/12   [迷你缩略图带]   查看 删除 │     │  │
│ │ └─────────────────────────────────────────────┘     │  │
│ └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

- **双模式共用**：变体组、前缀、尺寸/分辨率、提交按钮
- **文件夹模式追加**：`选择图片文件夹` → 扫描（沿用现有 `I2I_MULTI_FILENAME_PATTERN` 逻辑）→ 匹配预览
- **模式切换保留各自状态**（参考图 URL、扫描结果等），切换不丢
- 默认落地模式：`变体组批量`（高频场景）

### 4.3 批次详情结构（图片全貌问题核心）

```
┌─ 批次详情  MZY0820001 ──────────────── [返回列表] ────────┐
│ 进度环 12/12   统计卡×5（总计/完成/失败/进行中/排队）        │
│ [重试失败(2)] [全选] [下载已选] [下载全部] [导出到文件夹]    │
│                                                           │
│ ┌─ 任务网格 ──────────────────────────────────────────┐  │
│ │ ┌────────┐ ┌────────┐ ┌────────┐                   │  │
│ │ │ #1 ✓完成 │ │ #2 生成中│ │ #3 ✗失败 │   ← 状态徽章    │  │
│ │ │  整图    │ │ 骨架占位  │ │ 错误说明  │                │  │
│ │ │ contain │ │  动画    │ │          │                │  │
│ │ │ 不裁切   │ │         │ │          │                │  │
│ │ │  [预览][下载][重生成] │ │         │ │                │  │
│ │ └────────┘ └────────┘ └────────┘                   │  │
│ └──────────────────────────────────────────────────────┘ │
│  点击图片 → Lightbox：原图全尺寸 + 缩放/平移 + ←→切换       │
└──────────────────────────────────────────────────────────┘
```

**图片展示规则（核心约束）**：
1. 单元格使用 `aspect-ratio`（取该批次 `size` 参数，如 `4:3`；未知时 `1:1`），不写死高度
2. 图片 `object-fit: contain` + `width/height: 100%`，**永远展示全貌，禁止 cover 裁切**
3. 图下方信息条：序号 + 状态徽章 + 进度 + prompt（2 行截断，可展开）
4. 操作按钮（预览/下载/重新生成）hover 时浮现或常驻图下方，点击图片本身 → Lightbox

**Lightbox（ImagePreview v2）能力清单**：
- 全屏显示原图（不压缩，`max-width/max-height: 100%` 等比例缩放）
- 滚轮 / 按钮缩放（0.5x–4x），按住拖拽平移
- `←`/`→` 在批内任务间切换（配合 1/N 计数）
- `Esc` 关闭、点击遮罩关闭、右上角玻璃关闭按钮
- 底部玻璃信息栏：prompt、尺寸、分辨率、批次号、任务序号
- 支持从「批量详情 / 产品替换 / 标题生成」三处共用

---

## 5. 液态玻璃设计系统

参考 iOS 26 Liquid Glass 设计语言（Apple 2025 WWDC 发布，含 Figma 设计套件）：
**动态玻璃材质** = 背景模糊 + 通透半透明 + 镜面高光 + 边缘光折射 + 交互形变。

### 5.1 设计基调（本项目的具体化选择）

- **深色「影棚」基调**：内容区为深蓝灰（`#0b1120` 系）渐变环境光背景，生成的图片像在展台上，最突出
- **环境光斑**：3~4 个固定定位的柔光大色块（靛蓝 / 青 / 品红），缓慢流动动画，为毛玻璃提供"可模糊的内容"
- **玻璃面层级**：导航 / 卡片 / 浮层三级玻璃，透明度与模糊度逐级变化
- **品牌渐变**：靛蓝 `#6366f1 → 青 `#22d3ee`，用于主按钮、进度条、选中态

> 主题策略：`prefers-color-scheme` 跟随系统 + 手动切换按钮（二期做浅色主题；一期先做深色，但 token 结构必须支持换肤）。

### 5.2 Token 表（写入 `index.css` 的 `:root`）

```css
:root {
  /* 环境背景 */
  --bg-base: #0b1120;            /* 页面底色 */
  --bg-blob-1: rgba(99, 102, 241, .35);  /* 靛蓝光斑 */
  --bg-blob-2: rgba(34, 211, 238, .28);  /* 青光斑   */
  --bg-blob-3: rgba(217, 70, 239, .22);  /* 品红光斑 */

  /* 玻璃面 */
  --glass-1-bg: rgba(255, 255, 255, .06);   /* 导航/大面 */
  --glass-2-bg: rgba(255, 255, 255, .09);   /* 卡片     */
  --glass-3-bg: rgba(17, 24, 39, .72);      /* 浮层/弹窗(更实, 保证文字可读) */
  --glass-blur: blur(20px) saturate(160%);
  --glass-border: rgba(255, 255, 255, .14);
  --glass-highlight: inset 0 1px 0 rgba(255, 255, 255, .18); /* 顶部镜面高光 */

  /* 文字 */
  --text-1: rgba(248, 250, 252, .95);
  --text-2: rgba(148, 163, 184, .9);
  --text-3: rgba(100, 116, 139, .9);

  /* 语义色 */
  --accent: #6366f1;   --accent-2: #22d3ee;
  --success: #34d399;  --danger: #f87171;  --warning: #fbbf24;

  /* 圆角 / 间距 / 阴影 */
  --radius-sm: 10px; --radius-md: 16px; --radius-lg: 24px; --radius-pill: 999px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px;
  --shadow-float: 0 8px 32px rgba(2, 6, 23, .45);

  /* 字体 */
  --font-ui: -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
  --font-mono: "SF Mono", "Cascadia Code", Consolas, monospace;  /* 批次号/prompt/数字 */

  /* 动效 */
  --ease-glass: cubic-bezier(.22, 1, .36, 1);
  --dur: .28s;
}
```

### 5.3 玻璃面核心配方（CSS 工具类）

```css
.glass {
  background: var(--glass-2-bg);
  -webkit-backdrop-filter: var(--glass-blur);  /* Safari 必需前缀 */
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-highlight), var(--shadow-float);
}

.glass-hover { transition: transform var(--dur) var(--ease-glass), box-shadow var(--dur); }
.glass-hover:hover { transform: translateY(-2px) scale(1.005); box-shadow: var(--glass-highlight), 0 16px 48px rgba(2,6,23,.55); }
/* press 形变：scale(.985) —— 模仿 Liquid Glass 的按压弹性 */
.glass-hover:active { transform: scale(.985); }
```

**性能与降级**：
- 毛玻璃只用于卡片与导航等有限层级，不在页面内滥用（滚动中的大面积 blur 会导致卡顿）
- `@supports not (backdrop-filter: blur(1px))`（Firefox 旧版）：退化为 `rgba(17,24,39,.86)` 近实底 + 保留高光描边，保证可读
- 环境光斑用 `position: fixed` + 极低频率 `@keyframes` 位移，并 `prefers-reduced-motion: reduce` 时静止

### 5.4 字体与细节

- UI 字体走系统栈（中文场景避免引入大字体文件），**等宽字体**用于批次号/前缀/进度数字，形成"工具面板"识别度
- 状态徽章：半透明圆角 pill + 语义色，完成 `✓` / 进行中呼吸光点 / 失败红
- 进度条：品牌渐变（靛→青）圆角条，进行中加 shimmer 高光扫过
- 主按钮：品牌渐变底 + 顶部高光 + hover 提亮 2px；危险按钮：玫瑰红玻璃面

---

## 6. 组件重构清单

### 6.1 新建组件（UI Kit，`src/components/ui/`）

| 组件 | 职责 |
|------|------|
| `GlassCard.tsx` | 玻璃卡片容器（含 hover 形变变体） |
| `GlassButton.tsx` | 按钮（primary/secondary/ghost/danger，loading 态） |
| `SegmentedControl.tsx` | 批量模式切换等 pill 分段控件 |
| `Badge.tsx` | 状态徽章（status 驱动：queued/in_progress/completed/failed/pending） |
| `ProgressBar.tsx` | 渐变进度条（animated 变体） |
| `StatCard.tsx` | 统计卡（大数字 + 标签） |
| `Toast.tsx` + `ToastProvider` | 全局消息（success/error/info/warning，自动消失） |
| `ConfirmDialog.tsx` | 替换全部 `window.confirm` 的玻璃确认弹窗（危险操作红强调、支持异步 loading） |
| `Lightbox.tsx` | 全屏图片预览（见 4.3） |
| `EmptyState.tsx` | 空状态（图标 + 引导文案 + 行动按钮） |
| `Skeleton.tsx` | 骨架屏 |
| `GlassInput.tsx` | 输入框/下拉/多行文本框的玻璃样式统一 |
| `PageHeader.tsx` | 面板标题行（标题 + 描述 + 右侧操作） |

### 6.2 业务组件重构

| 现有文件 | 动作 | 说明 |
|---------|------|------|
| `App.tsx` | **重写** | 4 Tab 导航 + 侧边栏布局 + ToastProvider + 在线状态 + 主题切换；删除单次生成全部逻辑 |
| `BatchGenerator.tsx` | **拆分重写** | 拆为 `BatchWorkspace.tsx`（表单+模式切换）、`BatchListPanel.tsx`（列表/搜索/分页/批量操作）、`BatchDetailPanel.tsx`（统计/进度环/任务网格/Lightbox） |
| `FolderBatchGenerator.tsx` | **合并** | 扫描/上传/创建逻辑抽成 `useFolderBatch` hook，表单并入 `BatchWorkspace` 的文件夹模式 |
| `ProductSwapper.tsx` | 重构 | 表单与结果区拆分；结果行改 contain 大图；接入 Lightbox；确认弹窗化 |
| `TitleGenerator.tsx` | 重构 | 批次选择列表视觉升级；标题结果从表格行改为玻璃卡片列表；接入 Lightbox |
| `VariantGroupManager.tsx` | 重构 | 视觉对齐；确认弹窗化 |
| `ImagePreview.tsx` | **升级为 Lightbox** | 见 4.3 能力清单 |
| `ImageUploader.tsx` | 重构 | 玻璃拖拽区 + 上传进度 + 缩略图圆角统一 |
| `ParameterSelector.tsx` | 重构 | SegmentedControl 化（宽高比/分辨率）+ 输出尺寸提示 |
| `ProductThumbnailList.tsx` | 重构 | 缩略图统一圆角/间距，拖拽排序 UI 化 |
| `ResultActions.tsx` | 精简/删除 | 单次生成删除后仅 ProductSwapper 用，内联进结果卡片 |
| `ErrorBoundary.tsx` | 保留 | 视觉对齐 |

### 6.3 需要删除的代码（单次生成）

- `App.tsx`：`createGeneration`、`getTaskStatus`、`startPolling`、`ResultImage`、`statusText` 等单次生成状态
- `api.ts`：`createGeneration`、`getTaskStatus` 可删（后端 `/api/generations/generate` 端点保留，不破坏 API 兼容，README 标注"已弃用"）
- `types.ts`：`GenerationRequest`、`GenerationTask`、`TaskStatus`（确认无其他引用后）
- 注意：`ImagePreview`、`ParameterSelector`、`ResultActions` 仍被其他页面使用，**不能**随单次生成删除

---

## 7. 交互细节优化清单

1. **Toast 替换 alert / 错误区成功消息**：所有成功/失败反馈走 Toast；轮询连接异常用顶部横幅
2. **确认弹窗统一**：删除批次/批量删除/重试/覆盖导出/重新生成 → `ConfirmDialog`（红色危险按钮 + 具体数量文案，沿用现有中文文案）
3. **批次列表卡片化**：每行显示完成缩略图带（最多 4 张已完成图的小预览）+ 状态徽章 + 进度条 + 时间，替代纯文本行
4. **批次列表搜索**：batch_id 子串过滤（复用标题生成页已有交互模式）
5. **分页组件化**：数字分页（1 2 3 … N）+ 每页数量选择
6. **轮询状态可视化**：批次详情页进行中时，标题旁显示呼吸光点 + "自动刷新中"；连接异常显示红色徽章
7. **进度环**：批次详情用 SVG 圆环进度（整体完成率），比横条更精致
8. **键盘支持**：全局 `1/2/3/4` 切 Tab；Lightbox `←→Esc`
9. **空状态引导**：首次进入批量页无批次时，显示带"去创建第一批"引导的 EmptyState
10. **响应式**：侧边栏 < 900px 收起为底部 Tab 栏；网格自适应列数
11. **`prefers-reduced-motion`**：所有动画（光斑流动、shimmer、悬浮）降级为静态

---

## 8. 实施计划

### Phase 1 —— 地基（约 1 天）
- `index.css` 重写：token、玻璃配方、表单/按钮/徽章基础样式
- `index.html`：标题、favicon、主题色 meta
- `App.tsx` 布局骨架：侧边栏 + 内容区 + ToastProvider + 主题切换
- 删除单次生成（Tab、逻辑、无用 API 函数）
- 验收：4 Tab 可切换，旧功能不回归，深色玻璃基调生效

### Phase 2 —— UI Kit（约 1.5 天）
- `ui/` 全部基础组件 + `Lightbox` + `Toast` + `ConfirmDialog`
- 关键验收：Lightbox 缩放/平移/方向键可用；确认弹窗覆盖删除/重试场景

### Phase 3 —— 批量工作台（约 2 天，核心）
- `BatchWorkspace` 合并表单（双模式）
- `BatchListPanel`（搜索/缩略图带/分页/批量操作）
- `BatchDetailPanel`（进度环/统计/任务网格 contain 整图/Lightbox 集成）
- `useFolderBatch` hook 抽取
- 验收：对照用户反馈 #3 #4 —— 模式切换顺畅、图片全貌清晰

### Phase 4 —— 其余页面（约 1.5 天）
- ProductSwapper / TitleGenerator / VariantGroupManager 视觉对齐 + Lightbox/ConfirmDialog 接入

### Phase 5 —— 打磨（约 1 天）
- 空状态、骨架屏、动效节奏、响应式、键盘快捷键、`prefers-reduced-motion`
- `npm run build` 通过（`tsc && vite build`），无 TS 错误、无 unused 导入
- 浏览器自测：Chrome + Safari（验证 `-webkit-backdrop-filter`）

---

## 9. 风险与注意点

| 风险 | 应对 |
|------|------|
| `backdrop-filter` 大面积滥用导致滚动卡顿 | 仅卡片/导航使用；环境光斑 fixed 且低频动画；监听 `@supports` 降级 |
| 重构 2144 行 BatchGenerator 引入状态回归 | 拆组件时保持现有 hook（`useBatchPolling`/`useBatchPrefix`）与 API 调用不变，只动渲染层；分批提交 |
| 图片 contain 后 4K 大图网格加载慢 | 网格内使用 `loading="lazy"`；Lightbox 加载原图时骨架遮罩 |
| 删除单次生成误伤共用组件 | 重构前 grep 确认 `ImagePreview/ParameterSelector/ResultActions` 的其他引用（文档 6.3 已列） |
| 深色主题下玻璃文字对比度不足 | 浮层玻璃用更实底色（`--glass-3-bg`），文字层级不低于 `--text-2` |

---

## 10. 验收标准（对齐用户反馈）

1. ❌ 单次生成入口消失，无相关死代码（`npm run build` 无未使用警告）
2. ✅ 页面为液态玻璃风格：毛玻璃卡片 + 高光描边 + 环境光背景 + 平滑动效
3. ✅ 「批量生成」一个 Tab 内可切换「变体组批量 / 文件夹批量」，共用配置区
4. ✅ 批次详情图片按宽高比完整展示（contain 不裁切），点击进入全屏预览，可缩放看细节
5. ✅ 所有 `window.confirm/alert` 已替换为玻璃确认弹窗与 Toast

---

## 11. 设计修正记录（v2 · 规避 AIGC 味）

> 2026-08-20 用户补充要求："页面所有配色及样式风格，避免 AIGC 味"。

### 11.1 被淘汰的 AIGC 默认元素

| 原方案 | 问题 | 修正 |
|--------|------|------|
| 靛蓝 `#6366f1` → 青色 `#22d3ee` 渐变（主按钮/进度/选中态） | AI 生成物最典型的"AI 紫"渐变 | 实色黄铜 `#c9a35c`（深色文字），无渐变 |
| 三团漂浮彩色光斑（靛/青/品红）+ 缓慢流动动画 | 玻璃拟态模板化装饰，且是 AI 感重灾区 | 影棚布光（顶部暖光 + 右下极淡冷光）+ 细颗粒胶片噪点，静止无动画 |
| 高饱和语义色（`#16a34a`/`#dc2626`/`#f59e0b`） | 默认色板感 | 全部降饱和（莫兰迪向）：`#8fbf8c`/`#dd7f72`/`#cfaa5e` |
| 品牌火花图标（sparkles） | "AI 生成"符号化联想 | 层叠图像图标（批量生成语义） |
| 蓝紫品牌渐变 Logo | 同上 | 石墨底 + 黄铜层叠 |
| 大面积高强度 blur | 廉价玻璃感 | 降为 `blur(16px) saturate(130%)`，阴影收窄 |

### 11.2 现在的设计基线

- **基底**：暖石墨 `#0f1115`（近中性，不偏蓝紫）
- **强调**：黄铜 `#c9a35c`（贴合纺织/地毯行业工艺气质；浅色主题下加深为 `#9a7a2f` 保证对比度）
- **文字**：暖纸白 `rgba(244,242,237,…)` 三级层次
- **数字**：`font-variant-numeric: tabular-nums` 等宽数字（统计卡/计数）
- **细节**：眉标（eyebrow）小号字母间距排版、顶部 1px 镜面高光、无装饰性动画
- **降级**：`prefers-reduced-motion` 全动效静止；无 backdrop-filter 浏览器回退近实底

### 11.3 遗留项（Phase 3/4 处理）

- 存量组件（BatchGenerator/ProductSwapper/TitleGenerator 等）内联的 `#2563eb` 等旧色会在各自重构阶段替换，届时统一走 token
- 存量组件中的 emoji 状态符号（✓ ✕ ◐ ↻ ⚠）在重构时替换为 SVG 图标

### 11.4 Phase 2 交付物

- UI Kit（`src/components/ui/`）：`GlassCard / GlassButton / SegmentedControl / Badge / ProgressBar / StatCard / ConfirmDialog(Provider+useConfirm) / Lightbox / EmptyState / Skeleton / GlassInput(Input/Select/Textarea) / PageHeader` + `Icon` 图标库
- `ConfirmDialog` 为 Promise 式（`const ok = await confirm({...})`），全局挂载一次
- `Lightbox` 支持缩放（滚轮/按钮/双击，1x–4x）、拖拽平移、←/→ 切换、Esc 退出、元信息玻璃栏
- 浏览器实测：弹窗开关/Toast 出现与消失/计数器切换/缩放百分比/Esc 关闭全部通过

---

## 12. Phase 3 交付记录（批量工作台）

> 2026-08-20 完成。用户反馈 #3（合并 Tab）、#4（图片全貌）在此阶段落地。

### 12.1 新架构（`src/components/batch/`）

| 文件 | 职责 |
|------|------|
| `BatchWorkspace.tsx` | 双模式合并工作台：模式切换 + 共用配置表单 + 批次详情/列表切换、轮询、创建/重试/重新生成/删除编排 |
| `BatchListPanel.tsx` | 近期批次：搜索 / 状态卡片（含缩略图带）/ 全选批量操作（重试/导出/删除）/ 数字分页 / 未完成自动刷新 |
| `BatchDetailPanel.tsx` | 批次详情：SVG 进度环 + 统计卡 + 操作栏 + 任务网格 + Lightbox + 目录导出进度 |
| `BatchTaskCard.tsx` | 任务卡：按批次宽高比 `aspect-ratio` 单元格 + contain 整图（**零裁切**） |
| `hooks/useFolderBatch.ts` | 文件夹批量逻辑（扫描/上传/创建）与 UI 解耦 |
| `hooks/useBatchThumbnails.ts` | 列表缩略图：每 batch 只拉一次 + 并发 4 + 失败静默，避免给后端增压 |
| `lib/batchDownloads.ts` | 单张直下/多张 ZIP/文件命名/批次号展示/aspect-ratio 解析 |

删除：`BatchGenerator.tsx`（2144 行）、`FolderBatchGenerator.tsx`（764 行）。

### 12.2 用户反馈落地情况

- **反馈 #3**：批量生成/文件夹批量合并为一个 Tab，内部 SegmentedControl 切换；共用变体组/前缀/尺寸配置；文件夹模式仅追加数量选择 + 选目录 + 匹配预览（含 seq 缺失提示、明细展开、成功结果 + 再来一次）
- **反馈 #4**：详情网格按批次 `size`（如 4:3）的 `aspect-ratio` 单元格 contain 整图，点击进 Lightbox 看细节；列表卡片带完成图缩略带

### 12.3 交互升级

- 全部 `window.confirm` 替换为 `ConfirmDialog`（删除=危险红 / 重试·重新生成·导出覆盖=黄铜主操作）；导出目录冲突提示也接入（`fsDownload.onConflict` 已支持 Promise）
- 成功/失败反馈全部走 Toast（创建批次/删除/重试/导出汇总/下载错误）
- 分页升级为数字页码（≤7 页全显，超出省略号折叠）+ 每页数量选择
- 批次卡片：状态徽章（已完成/进行中呼吸/待开始/重试过）+ 4 张缩略图带 + 内联进度条
- 搜索：batch_id 子串过滤（复用标题生成页模式）

### 12.4 已知遗留

- `ImageUploader / ParameterSelector` 仍为旧组件（Phase 4 随产品替换页统一重构）
- 列表缩略图依赖 `getBatchStatus`（含 ToAPIs 同步），对已完成批次为只读 DB 查询，已用"每批次仅拉一次"约束

---

## 13. Phase 4 交付记录（其余页面对齐）

> 2026-08-20 完成。全部页面完成液态玻璃视觉对齐，旧 `ImagePreview` 退役。

### 13.1 页面级重构

| 页面 | 动作 |
|------|------|
| `ProductSwapper.tsx` | 全量重构：GlassCard/PageHeader/StatCard/ProgressBar/Lightbox/ConfirmDialog/Toast；结果行改为按宽高比 contain 整图（不再 180×120 cover）；删除本地 Stat/ProgressBar 重复实现 |
| `TitleGenerator.tsx` | 视觉对齐：标题结果表格 → 玻璃行卡（圆角裁剪容器）；统计/进度换 UI Kit；`window.confirm` → ConfirmDialog；ImagePreview → Lightbox；本地 Skeleton/Stat/ProgressBar 删除；地毯类型 chips 黄铜化 |
| `VariantGroupManager.tsx` | 全量重构：玻璃组卡片、创建/编辑表单、ConfirmDialog 删除、Toast 反馈 |
| `ImageUploader.tsx` | 玻璃拖拽区 + URL 输入与隐藏 file input 补 `aria-label`（修复 a11y） |
| `ErrorBoundary.tsx` | GlassCard + GlassButton |
| `ImagePreview.tsx` | **删除**（全部迁移到 Lightbox） |

### 13.2 清理

- `legacy.css` 删除 `.status` / `.result-image`（无引用）；`.card` 在 App 的加载/错误态替换为 GlassCard
- `public/robots.txt` 补充（SEO）

### 13.3 质量验证

- `npm run build`（tsc strict）通过
- Lighthouse snapshot：**Accessibility 100 / Best Practices 100**（此前 a11y 提示全部修复，含 ImageUploader URL 输入、模板/参考图隐藏 file input、批次搜索框等）
- 浏览器实测：产品替换（PageHeader/模板上传/提交按钮）、标题生成（200 批次加载/搜索/地毯 chips）、变体组（6 组卡片）全部正常
- 遗留：`robots-txt`（dev 环境无）、`llms.txt`（实验性 Agentic Browsing 审计）可选补充

---

## 14. 配置区优化（工作流条布局）

> 2026-08-20 按用户反馈"批量配置留白过多"完成。

### 14.1 问题诊断

- `config-grid`（`repeat(auto-fit, minmax(200px, 1fr))`）在 1180px 容器中把 3 个控件各拉宽到 ~350px，控件宽度跟随容器而非内容
- 标题行 / 配置行 / 模式行 / 提交按钮行共 4 行，仅承载 4 个信息块
- 卡片内 h3 "批量配置" 与页面头重复

### 14.2 方案：单行工作流条

```
[变体组批量 | 文件夹批量]
┌─ 批量配置（内容 max-width 900px）───────────────────────────┐
│ 变体组▾▾▾▾▾▾  前缀[MZY]→MZY082001  宽高比▾ 分辨率▾  生成模式 │
│ [文生图|图生图]                                [开始批量生成]│
│ 下个ID：MZY082001 · 每批 10 个任务 · 输出 1024x1024         │
│ ── 文件夹模式追加：数量 chips + 选文件夹 ────────────────────│
└────────────────────────────────────────────────────────────┘
```

关键决策（均已在 `workspace.css` 落地）：

| 项 | 做法 |
|---|---|
| 控件宽度适配内容 | 变体组 `flex:1 1 160px` 可伸缩；前缀输入 96px；宽高比/分辨率固定 104px |
| 前缀预览内联 | `→ MZY082001` 紧跟输入框右侧，删除整行 hint |
| 主操作锚定右侧 | 提交按钮 `margin-left:auto`，与输入框底边对齐（`align-items:flex-end`），两个模式共用一个按钮（文件夹模式动态切换文案/loading） |
| 提示压缩为单行 meta | 下个 ID · 每批 K 任务 · 输出尺寸 · 校验警告（边框红色 + meta 行红字） |
| 删除卡片标题 | 页面头已含"批量生成" |
| 生成模式 | 移入主条（Segmented 压缩 padding），i2i 时参考图上传器仍按需展开 |
| 文件夹模式 | 数量 chips（quick-chip 胶囊）+ 选文件夹同一行；匹配预览/结果折叠为摘要 + `<details>` 明细 |
| 容器约束 | `.config-inner { max-width: 900px }`，表单不随列表全宽拉伸 |

### 14.3 实测结果

- 变体组模式 6 控件 + 按钮单行（841px + 间距 = 900px），底边完全对齐（`aligned: true`）
- 文件夹模式主条 5 控件单行；文件夹区块 2 列单行
- 选中变体组后 meta 行实时联动"每批 10 个任务"；提交按钮禁用态/文案随模式切换
- 窄屏自动换行（flex-wrap），无回归；`npm run build` 通过

---

## 15. Lightbox 遮挡优化（元信息条重构 + 饰件自动隐藏）

> 2026-08-20 按用户反馈"批次详情点开图片后 prompt 遮盖大部分区域"完成。

### 15.1 问题诊断

- 元信息栏静态常驻底部，且 prompt 全文直接渲染（地毯类 prompt 数百字），最高占 30vh，直接盖住画面下半部
- 图片查看场景中 UI 饰件无"退场机制"，与 macOS 照片 / Google Photos 等行业惯例相悖

### 15.2 方案

1. **元信息压缩为单行条**：`#3 · 尺寸 · 分辨率 · 批次号`（40px 高），label 超长省略号截断
2. **Prompt 按需展开**：默认折叠，`查看 Prompt / 收起 Prompt` 切换（aria-expanded），展开区内部滚动（max-height 20vh），打开 Lightbox 时重置为折叠
3. **饰件空闲自动淡出**：工具栏 / 导航箭头 / 信息条在 2.8s 无鼠标键盘活动后 opacity→0（pointer-events:none），任意鼠标移动或按键立即唤醒；`prefers-reduced-motion` 下过渡被全局禁用
4. **拖拽平移时强制隐藏**：缩放 > 1 查看细节时拖拽即隐藏全部饰件，避免边看边被遮

### 15.3 实测结果

- 单行条 40px（原数百 px）；Prompt 展开 137px 内部滚动，按钮文案/状态联动
- 空闲 3.3s 自动隐藏（opacity 0），指针移动唤醒，Esc 关闭正常
- 影响面：批量详情 / 产品替换 / 标题生成三处 Lightbox 共用，一处修改全站生效

### 15.4 浅色主题可读性修复（lightbox 专用 token）

**根因**：Lightbox 遮罩/饰件表面永远深色（图片查看器惯例），但文字/图标沿用随主题切换的 `--text-*`/`--accent` token —— 浅色主题下变成"深字配深底"不可读。

**修复**：`tokens.css` 新增**不随主题切换**的 `--lightbox-*` 令牌组（深色面 + 浅色文字 + 亮金强调），`glass.css` 全部 Lightbox 样式改用它：

| token | 值 | 用途 |
|---|---|---|
| `--lightbox-bg` | `rgba(12,14,18,.82)` | 计数器/工具条/导航/信息条表面 |
| `--lightbox-text-1/2/3` | 暖白三级 | 标题 / 正文 / 次要 |
| `--lightbox-accent` | `#d8b572` | 批次号等强调文字 |
| `--lightbox-danger` | `#e0857a` | 加载失败提示 |

实测：浅色主题下 meta 文字 `rgba(181,177,168)`、label 近白、批次号亮金，对比度显著提升；深色主题无回归。

### 15.5 浅色主题悬停变全白修复

**根因**：`glass.css` 曾有一条浅色主题全局按钮 hover 规则
`:root[data-theme='light'] button:hover:not(:disabled) { background: rgba(255,255,255,.95) }`，
特异性 `(0,4,1)` 高于所有组件的专属 hover（Lightbox 饰件仅 `(0,3,1)`），
浅色主题下悬停 Lightbox 工具/信息条按钮时背景直接变 95% 白。

**修复**：删除该全局规则（浅色主题 hover 增亮收回各组件自己的规则，主按钮已有专属浅色 hover），
并加注释说明特异性泄漏教训。实测：浅色主题下 hover 放大按钮背景为 `rgba(255,255,255,.12)` + 近白图标，可读正常。

---

## 16. 批次快速切换条

> 2026-08-20 按用户需求"批次之间快速切换"完成（旧版雏形在 Phase 3 重构中被精简，现以升级形态回归）。

### 16.1 设计

详情页顶部横向切换条，支撑"连续审查多个批次"（文件夹批量一次建 50-500 批次后逐个检查）：

```
‹ │ ●MZY082001 │ ✓TQ081623 │ ◐MZY082010 42% │ ✕2MZY082011 │ ›
```

- **状态一目了然**：chip 左侧状态点（✓ 完成绿 / 呼吸光点进行中 + 百分比 / ✕N 红色失败数 / 灰待开始），title 提示完整摘要
- **‹ › 相邻切换**：逐批审查比"返回列表再查看"少两次点击；边界自动禁用
- **点击 chip 跳任意批次**：当前 chip 黄铜高亮 + `aria-current`，切换时 chip 加载脉冲态，完成后自动 `scrollIntoView` 居中
- **状态实时刷新**：切换条内有未完成批次时按 3s 静默轮询（与列表自动刷新同模式），当前批次由详情轮询覆盖
- 数据源：最近 50 个批次摘要（`listRecentBatches pageSize=50`），打开/切换详情时刷新

### 16.2 实现

- `BatchWorkspace`：`switchBatches` 数据源 + 打开/切换时刷新 + 未完成静默轮询 + `handleSwitchBatch`（防重入）
- `BatchDetailPanel`：切换条渲染（chip refs Map + 自动滚动）、‹ › 边界计算
- `workspace.css`：`.batch-switcher / .batch-switch-chip(-current/-loading) / .batch-switch-dot(-running) / .batch-switcher-arrow`

### 16.3 实测

- 50 chips 渲染，当前 chip 高亮同步；‹ 首条禁用、› 可用
- › 切换 TQ081623 → TQ081622，详情与 chip 状态同步，‹ 恢复可用
- 点击第 10 个 chip 跳转 TQ081614，chip/详情一致；切换期间 chips 禁用防重入

---

## 19. 多生图模型支持（gpt-image-2-vip / gemini-3.1-flash-image-preview）

> 2026-08-20 完成。三个模型：gpt-image-2（默认）/ gpt-image-2-vip / gemini-3.1-flash-image-preview。
> 依据 ToAPIs 开发文档调研（浏览器 MCP 直读 docs.toapis.com）。

### 19.1 模型差异与映射（文档调研结论）

| 模型 | 精度参数 | 分辨率位置 |
|---|---|---|
| gpt-image-2（默认） | 不支持 | 顶层 `resolution: 1k/2k/4k` |
| gpt-image-2-vip | 顶层 `quality: low/medium/high` | 顶层 `resolution` |
| gemini-3.1-flash-image-preview | **不支持**（与 gpt-image-2 同逻辑，用户确认） | `metadata.resolution: 1K/2K/4K`（大写） |

### 19.2 后端

- `models.py`：`generation_tasks` 加 `model`（VARCHAR 64，默认 gpt-image-2）/ `quality`（VARCHAR 10，可空）——**持久化到任务**，重试/重新生成原样复用
- `schemas.py`：`IMAGE_MODEL` / `IMAGE_QUALITY` 白名单 + `ModelQualityMixin`；三个请求（批量/产品替换/文件夹批量）统一加 `model`/`quality`；**校验**：不支持 quality 的模型传 quality → 422（避免"选了没用上"）
- `batch_generator._build_payload`：按模型分支（VIP→顶层 quality；Gemini→metadata.resolution 大写）；task 上持久化的值为权威，缺失回退 request（旧数据兼容）
- `task_poller` / `batch.regenerate`：手动构造 `GenerationTaskOut` 处补 `model`/`quality`（**曾漏掉导致 API 返回默认值**，已修复并验证）
- `init.sql` 同步加列；**MySQL 迁移**：`ALTER TABLE generation_tasks ADD COLUMN model ... / ADD COLUMN quality ...`（已执行）

### 19.3 前端

- `constants.ts`：`IMAGE_MODEL_OPTIONS`（3 个模型 + qualitySupported 标记）/ `IMAGE_QUALITY_OPTIONS`（低/中/高）
- `types.ts`：`ImageModelId` / `ImageQuality` + 请求类型 + `GenerationTaskItem.model/quality`
- `BatchWorkspace`：工作流条下方新增**模型与精度配置行**——模型下拉（220px）+ 精度 Segmented（仅支持精度的模型显示，低=草稿/中=均衡/高=正式提示文案）；两种批量模式共用
- 任务卡：非默认模型显示徽章（`VIP·H` / `Gemini`，title 展示完整模型与精度）；Lightbox meta 不重复展示

### 19.4 实测

- 422 校验：gpt-image-2 + quality → 明确报错文案 ✓
- payload 单测：三模型 + 旧数据兼容分支全过 ✓
- 端到端：创建 MZY082001（vip+high，10 任务全部落库 model/quality 并提交 ToAPIs）、MZY082002（gemini，metadata 大写 2K）✓
- 前端联动：默认隐藏精度 → 切 VIP 显示低/中/高 → 切 Gemini 隐藏 ✓；任务卡徽章 `VIP·H` / `Gemini` ✓；文件夹模式共用配置 ✓
- 注：验证产生的 MZY082001 / MZY082002 两个真实批次（各 10 任务）消耗了少量 ToAPIs 额度，可在前端删除

### 19.5 已知边界

- `gpt-image-2-vip` 文档标注"支持全部常用宽高比"，gemini 支持极端比例（4:1/8:1）——当前 `SUPPORTED_SIZES` 白名单未扩展，按需再加
- 产品替换页前端暂未暴露模型选择（后端已兼容，默认 gpt-image-2）

### 19.6 Lightbox 标签优化（模型名替代截断 prompt）

> 2026-08-20 按用户建议完成：图片预览序号后展示**模型名 + 精度**（如 `#1 · GPT-Image-2 VIP · 高`），
> 替代原先截断 24 字符的 prompt（无实际作用）；Prompt 全文仍可通过「查看 Prompt」展开。

- 新增 `getModelDisplayName(model, quality, variant)` helper（constants.ts）：full（Lightbox 标签）/ short（任务卡徽章）
- 批量详情 + 产品替换两处 Lightbox label 统一改为模型名；任务卡徽章复用该 helper（`VIP · 高` / `Gemini Preview`）
- 实测：`#1 · Gemini 3.1 Flash Image Preview`、`#1 · GPT-Image-2 VIP · 高` 均正确显示

### 19.7 模型配置行布局修复

**根因**：模型字段复用了 `.config-field--select`（`flex: 0 0 104px`，为宽高比/分辨率设计的紧凑宽度），
但内部 select 设了 `min-width: 220px` → 外层 div 仅 104px，select 溢出（overflow 可见）盖住相邻的精度 Segmented。

**修复**：新增 `.config-field--model { flex: 0 0 240px }` 独立宽度类，模型 select 不再溢出。
实测：字段/select 均 240px（无溢出），切 VIP 后精度 Segmented 与模型框间距 12px、无重叠。

### 19.8 Lightbox 精确预览修复（点哪张看哪张）

**根因**：`onPreview` 传的是任务在 `batch.tasks` 里的序号，但 Lightbox 的 `items` 是
**过滤后**（仅 completed）的数组，两个下标错位——点击第 N 张卡打开的是过滤后列表第 N 项，
且失败/进行中任务点击占位区无任何反馈。

**修复**：
- `LightboxItem` 新增 `sourceId`（任务 ID）；点击时按 `sourceId` 查找可预览列表中的真实位置
- 失败任务 → Toast「该任务生成失败，暂无可预览的图片」；进行中 → Toast「图片尚未生成完成」；
  失败/进行中占位区改为可点击（cursor + title 提示）
- 批量详情 + 产品替换两处统一修复

**实测**：MZY082002（6 完成 + 4 失败）点击 #4 卡片 → Lightbox 显示 `#4 · Gemini ...`、计数 3/6
（精确跳过失败占位）；点击失败卡片 #2 → warning Toast 正确弹出。

### 19.9 Lightbox 切换跳动修复（交叉淡入）

**现象**：切换图片时"按钮下移"。实测定位：nav 按钮为绝对定位（top 50%），
切换任意比例图片时位置恒定（三比例图实测 nav 中心 Y 始终 365px）。
真实跳动源是**切换瞬间内容区塌缩**：新图未加载完成时高度为 0，
加载完成后才"长"满——视觉上内容/按钮相对关系突变。

**修复**：
- **交叉淡入**：切换时旧图保持显示并 0.3s 淡出，新图加载完成淡入替换——内容区永不塌缩
  （Lightbox 引入 `displayItem` / `pendingItem` 双图状态；图片改为 absolute + inset + margin auto 叠放居中）
- 首图仍走骨架（skeleton 尺寸放大至 `min(720px, 76vh)`，接近真实显示区域）
- 实测：切换瞬间/完成后图片高度恒 730（无塌缩）、nav top 恒定 343（前后一致）、新图淡入过渡正常

### 19.10 Lightbox 导航按钮按压下移修复

**根因**（用户澄清：是"上一张/下一张"按钮**按下时**下移，非图片切换）：导航按钮用
`transform: translateY(-50%)` 垂直居中，但全局按压反馈规则
`button:active:not(:disabled) { transform: scale(0.985) }` 特异性 `(0,2,1)` 高于
`button.lightbox-nav` 的 `(0,1,1)`——按下瞬间 `translateY(-50%)` 被覆盖，
按钮从居中位置跳回未平移位置，下移约半个自身高度（~22px）。

**修复**：`button.lightbox-nav:active:not(:disabled) { transform: translateY(-50%) scale(0.96) }`
——按压反馈保留垂直居中。全站按钮类排查：仅 `lightbox-nav` 使用 transform 定位，无其他同类隐患。

---

## 20. 失败自动重试（模型阶梯）

> 2026-08-20 按用户需求完成：任务失败后自动重试 3 次，逐级换模型；3 次全失败后停止，保留用户手动重试。

### 20.1 重试阶梯（AUTO_RETRY_MODELS）

| 次数 | 模型 | 精度 | 其他参数 |
|---|---|---|---|
| 第 1 次 | gpt-image-2 | — | 原配置（尺寸/分辨率/参考图） |
| 第 2 次 | gpt-image-2-vip | medium | 原配置 |
| 第 3 次 | gemini-3.1-flash-image-preview | — | 原配置 |

### 20.2 实现要点

- **数据**：`generation_tasks.auto_retry_count`（0-3，与 `retried_count` 语义分离——后者是用户手动重试计数，批次列表"重试过"标记依赖）
- **触发**：轮询同步到 failed 的三条路径统一接入（后台轮询：本地超时/查询异常/远端失败；用户查看时同步）
- **防重入**：进程内锁 + 锁内重读（仅 failed 且未达上限才触发），递增计数后重置为 pending——pending 状态不会再触发
- **模型持久化**：换模型后更新 `task.model/quality`——任务卡徽章自动显示新模型（"升级重试"过程可见），用户手动重试跟随最新模型
- **手动重试不清零** `auto_retry_count`：自动链只走一轮，"停止重试"语义成立，避免失败→自动3次→手动→自动3次…无限循环
- **重置时刷新 created_at**：轮询器 5 分钟本地超时从重试时刻重新计时
- **UI**：3 次全失败后任务卡显示"已自动重试 3 次，仍失败 · 可手动重试"

### 20.3 测试

6 个 case 单测通过：阶梯模型顺序与 quality 映射、3 次后停止、非 failed 不触发、提交调度一次、
carrier/payload 与阶梯模型一致。MySQL 已 ALTER 加列；`npm run build` 通过。

### 20.4 重新生成前选择模型/精度

> 2026-08-20 按用户需求完成：点击"重新生成"先弹模型/精度选择，确认后提交；尺寸/分辨率沿用原配置。

- **弹窗**（`batch/RegenerateDialog.tsx`，批量详情 + 产品替换共用）：模型下拉（3 模型，预填任务当前模型）
  + 精度 Segmented（仅支持精度的模型显示，低=草稿/中=均衡/高=正式）+ 确认/取消
- **后端**：`TaskRegenerateRequest(ModelQualityMixin)` 请求体（model/quality 可选）；
  `regenerate_task` 支持覆盖——**换到不支持精度的模型时清空 quality**（防残留导致后续
  手动重试重建请求时 schema 校验 422）；换到支持精度的模型且未传 quality 时默认 medium
- **实测**：接口带 body `{model: vip, quality: medium}` → 任务从 gemini 切换为 vip/medium 并重置提交；
  `{model: gpt-image-2}` → quality 清空为 None；弹窗默认预填当前模型、模型切换精度区联动、取消正常关闭

---

## 17. 动效增强（平滑过渡）

> 2026-08-20 按用户需求"缺少平滑过渡动画"完成。原则：克制而有目的——全部为状态变化服务，遵守 `prefers-reduced-motion` 降级，无装饰性动画（避免 AIGC 味）。

### 17.1 新增动画清单

| 动画 | 实现 | 时长 |
|---|---|---|
| 主题切换全局平滑 | `base.css` 全局兜底：`transition-property: color/background-color/border-color/box-shadow`（仅 `no-preference` 下生效；已有专属 transition 的组件特异性更高不受影响） | 300ms |
| Tab/页面内容切换 | `.tab-pane` 条件渲染触发 `pane-in`（淡入 + 6px 上浮）；批次详情复用 `.panel-in` | 220ms |
| 图片加载淡入 | 新组件 `ui/FadeInImage`：加载完成前 `img-fade-out`（opacity 0），onLoad/onError 后播放 `img-in` 淡入；接入任务卡/列表缩略图/Lightbox/产品替换结果与参考图/标题行底图 | 400ms |
| 列表条目入场 | `.batch-card` / `.task-card` 挂载时 `item-in`（淡入 + 4px 下沉），配合已有进度条过渡 | 280ms |
| Toast 退场 | `Toast.tsx` dismiss 先打 `toast--leaving`（淡出 + 上移 8px），220ms 后移除 DOM | 220ms |
| 卡片 hover 微提升 | `.batch-card:hover` 上浮 -1px（原有 border 过渡保留） | 280ms |

### 17.2 验证

- `.tab-pane` 切换时 `getAnimations()` 正在播放 `pane-in`；批次卡片播放 `item-in`
- 缩略图初始 `img-fade-out`，加载完成后过渡到淡入
- 变体组表单触发 Toast → 点关闭 → `toast--leaving` class 出现，220ms 后移除
- 主题切换时 `document.body.getAnimations()` 正在过渡 `background-color`/`color`
- `prefers-reduced-motion` 下全部动画被 `base.css` 全局降级为瞬变

### 17.3 明确不做

- 数字滚动计数（3s 轮询会反复触发，反效果）
- 导航滑块滑动指示（工程量大、收益一般）
- 装饰性粒子/背景流动（AIGC 味，与「克制」原则冲突）

---

## 18. 批次列表工具栏优化（全选归位图例行）

> 2026-08-20 按用户建议完成。原则：控件靠近它所作用的对象。

### 18.1 调整

- **全选**：从工具栏移入图例行首（`已完成` 之前），紧贴批次勾选框上方——视线从按钮到勾选框零距离；升级为**三态复选框**（全选 ✓ / 部分选中 indeterminate ─ / 取消全选），`aria-label` 可访问
- **工具栏**：`搜索 | 重试失败任务 | 导出到文件夹 | 删除已选`（删除已选紧跟在导出之后，与批量操作语义聚合）
- 图例行加 1px 分隔线区分"全选"与状态图例

### 18.2 实测

- 工具栏仅剩 3 个批量操作按钮；图例行顺序：`全选 | 已完成 进行中 待开始 重试过`
- 三态验证：未选 `indeterminate:false` → 勾 2 条 `indeterminate:true` → 点全选 `checked:true, indeterminate:false`

### 18.3 修复：删除已选换行问题

**根因**：`.batch-list-actions` 未设 `flex: 1`，宽度按 fit-content 计算（仅 ~577px），
而内容总宽（搜索框 + 3 按钮）约 720px → 容器内部 `flex-wrap` 把最后一个按钮挤到第二行。
与窗口宽度无关（1536px 视口下同样复现）。

**修复**：`.batch-list-actions { flex: 1; justify-content: flex-end }` 占满标题剩余空间，
搜索框 `flex: 1 1 220px; min-width: 0` 负责吸收弹性空隙（触达 340px 上限）。
窄屏时搜索框先收缩，按钮保持同行，仅极窄（<560px）才整体换行。

**实测**：actions 997px，重试失败任务 / 导出到文件夹 / 删除已选三按钮 `top` 一致同行。
