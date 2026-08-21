# GPT-Image-2 批量变体生成平台

> 基于 ToAPIs（gpt-image-2 模型）的批量图像变体生成 / 产品替换 Web 平台。
> 后端 FastAPI + SQLAlchemy 异步，前端 Vite + React + TypeScript。

[![Python](https://img.shields.io/badge/Python-3.13%2B-blue)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.139-009688)](https://fastapi.tiangolo.com/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-5-646cff)](https://vitejs.dev/)
[![License](https://img.shields.io/badge/license-MIT-green)](#许可证)

---

## 目录

- [项目简介](#项目简介)
- [核心功能](#核心功能)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
  - [1. 准备环境](#1-准备环境)
  - [2. 克隆与安装](#2-克隆与安装)
  - [3. 配置环境变量](#3-配置环境变量)
  - [4. 初始化数据库](#4-初始化数据库)
  - [5. 启动后端](#5-启动后端)
  - [6. 启动前端](#6-启动前端)
- [环境变量说明](#环境变量说明)
- [数据库](#数据库)
- [后端开发](#后端开发)
- [前端开发](#前端开发)
- [API 概览](#api-概览)
- [部署建议](#部署建议)
- [常见问题](#常见问题)
- [路线图](#路线图)
- [许可证](#许可证)

---

## 项目简介

本项目是一个面向运营 / 设计的 **批量图像变体生成工作台**。围绕 ToAPIs 提供的
`gpt-image-2` 模型，提供 4 类典型场景：

- **变体组管理**：把同一主题的多个 prompt 维护成"组"，便于重复使用
- **批量生成**：选定一个变体组，一键发起 N 个 ToAPIs 任务，平台负责并发提交、
  状态轮询、结果聚合（含文件夹批量图生图模式）
- **产品替换（product_swap）**：上传 1 张场景模板图 + N 张产品图，自动生成 N
  张"产品融入场景"的结果图
- **标题生成**：从多个已完成批次中各取第 K 张图，调多模态模型批量生成电商标题

> 注：**单次生成**功能已于 2026-08 前端重构中移除（用户反馈无实际价值），
> 后端 `/api/generations/generate` 等端点暂保留以兼容旧调用，属弃用状态。

后端不存储生成图片本身，只存元数据与远端 URL；用户可在前端预览、单张/批量
打包下载（ZIP / 文件夹），并对失败任务进行重试或对已完成任务重新生成。

---

## 核心功能

| 模块 | 功能 |
| ---- | ---- |
| 变体组 | 增删改查变体组及组内 prompt 变体（最多 20 条） |
| 批量生成 | 基于变体组一次创建 N 个任务，后台并发提交，支持信号量限流 |
| 产品替换 | 1 张模板图 + 1..N 张产品图 → N 个任务，prompt 共用 |
| 文件夹批量图生图 | N 张图各自独立批次，每张图 × 变体组 = N×K 个任务 |
| 标题生成 | 选中 N 个批次 → 各取第 K 张已完成图 → 多模态模型（gemini-3.6-flash / grok-4.5 / gpt-5.6-sol）生成电商标题，支持重新生成；CSV 导出（即将推出） |
| 批次管理 | 分页列表、状态统计、删除、批量删除 |
| 失败重试 | 仅重置失败任务为 pending 并重新提交 |
| 任务重生 | 对已完成 / 已失败任务重新生成（复用 task_id） |
| 批次号 | 形如 `{PREFIX}{MMDD}{SEQ}`，自动填空隙、支持自定义前缀 |
| 后台轮询 | 进程内异步轮询器，定时同步未完成任务状态，本地 5 分钟超时兜底 |
| 文件下载 | 浏览器端 ZIP 打包 / 走 File System Access API 直接写入文件夹 |
| 图片代理 | 后端中转下载远端图片，绕过浏览器 CORS 限制 |

---

## 技术栈

### 后端

- **Python** ≥ 3.13
- **FastAPI** 0.139+（Web 框架）
- **SQLAlchemy 2.x async**（ORM）
- **aiomysql**（MySQL 异步驱动）
- **pydantic-settings**（配置加载）
- **httpx**（异步 HTTP 客户端，含 429 / 5xx 指数退避重试）
- **uvicorn**（ASGI 服务器）

### 前端

- **React 18** + **TypeScript 5**
- **Vite 5**（构建 / 开发服务器）
- **JSZip**（浏览器端 ZIP 打包）
- **File System Access API**（可选：直接写入本地目录）

### 依赖管理

- 后端使用 [`uv`](https://github.com/astral-sh/uv)（`uv.lock` 已纳入版本控制）
- 前端使用 **npm**（`package-lock.json` 已纳入版本控制）

### 第三方服务

- **ToAPIs**（`https://toapis.com`）—— gpt-image-2 模型的中转 API

---

## 项目结构

```
GPT2/
├── .env.example                # 环境变量模板（提交到仓库）
├── .gitignore                  # Git 忽略规则
├── pyproject.toml              # Python 项目元数据与依赖
├── uv.lock                     # 依赖锁（uv 生成）
│
├── backend/                    # FastAPI 后端
│   ├── app/
│   │   ├── main.py             # FastAPI 入口、路由注册、生命周期
│   │   ├── config.py           # pydantic-settings 配置加载
│   │   ├── database.py         # 异步 SQLAlchemy 引擎 / Session
│   │   ├── models.py           # ORM 模型：VariantGroup / Variant / GenerationTask
│   │   ├── schemas.py          # Pydantic Schema（含 size/resolution 联合校验）
│   │   ├── toapis_client.py    # ToAPIs HTTP 客户端（带重试 / 图片代理）
│   │   ├── crud/               # 通用数据访问层
│   │   │   ├── generation_tasks.py
│   │   │   └── variant_groups.py
│   │   ├── routers/            # 路由层
│   │   │   ├── generations.py
│   │   │   ├── variant_groups.py
│   │   │   ├── batch.py
│   │   │   └── product_swap.py
│   │   └── services/           # 业务服务
│   │       ├── batch_generator.py
│   │       ├── task_poller.py
│   │       └── background_poller.py
│   ├── sql/
│   │   └── init.sql            # MySQL 建表脚本（utf8mb4）
│   └── tests/                  # 端到端单元测试（mock，无外部依赖）
│       ├── test_batch_id_gap.py
│       └── test_product_swap.py
│
└── frontend/                   # Vite + React 前端
    ├── index.html
    ├── package.json
    ├── package-lock.json
    ├── tsconfig.json
    ├── vite.config.ts          # /api 反代到 http://localhost:8000
    └── src/
        ├── main.tsx
        ├── App.tsx             # Tab 容器：单次 / 变体组 / 批量 / 产品替换
        ├── api.ts              # 后端 API 客户端
        ├── types.ts
        ├── constants.ts        # size / resolution 对照、批次号规则
        ├── components/         # 业务组件
        │   ├── BatchGenerator.tsx
        │   ├── ProductSwapper.tsx
        │   ├── VariantGroupManager.tsx
        │   ├── ImageUploader.tsx
        │   ├── ImagePreview.tsx
        │   ├── ResultActions.tsx
        │   ├── ParameterSelector.tsx
        │   ├── ProductThumbnailList.tsx
        │   └── ErrorBoundary.tsx
        ├── hooks/              # 通用 hooks
        │   ├── useBatchPolling.ts
        │   ├── useBatchPrefix.ts
        │   └── useOnlineStatus.ts
        └── lib/
            └── fsDownload.ts   # File System Access API 封装
```

---

## 快速开始

### 1. 准备环境

| 工具 | 最低版本 | 用途 |
| ---- | -------- | ---- |
| Python | 3.13 | 运行后端 |
| [uv](https://github.com/astral-sh/uv) | 任意最新版 | 后端依赖管理（也可换 pip + venv） |
| Node.js | ≥ 18 | 运行前端 |
| npm | 跟随 Node | 前端依赖管理 |
| MySQL | 8.0+（可选） | 生产数据库；本地可用 SQLite |

### 2. 克隆与安装

```bash
# 克隆仓库
git clone https://github.com/MaZhenyu-Dev/ToAPIs-GPT-image2.git
cd GPT2

# 后端依赖
uv sync
# 或：python -m venv .venv && source .venv/bin/activate && pip install -e .

# 前端依赖
cd frontend
npm install
cd ..
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

然后编辑 `.env`：

```ini
TOAPIS_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
TOAPIS_BASE_URL=https://toapis.com
TOAPIS_TIMEOUT=300

# 前端开发服务器地址（多源用 JSON 数组）
CORS_ORIGINS=["http://localhost:5173"]

# MySQL（任选其一；不填则使用默认 SQLite）
DATABASE_URL=mysql+aiomysql://root:your_password@localhost:3306/gpt_image2_platform
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_USER=root
DATABASE_PASSWORD=your_password
DATABASE_NAME=gpt_image2_platform

# 并发 / 轮询调优
MAX_CONCURRENT_GENERATIONS=50
POLL_INTERVAL_SECONDS=5
```

### 4. 初始化数据库

任选其一：

```bash
# 方式 A：MySQL（推荐用于生产 / 多用户）
mysql -uroot -p < backend/sql/init.sql

# 方式 B：直接用 SQLite（默认）
# 无需操作，首次启动时 SQLAlchemy 会自动建表（create_all）
```

### 5. 启动后端

```bash
uv run uvicorn backend.app.main:app --reload --port 8000
```

启动后可访问：

- Swagger UI：<http://localhost:8000/docs>
- ReDoc：<http://localhost:8000/redoc>
- 健康检查：<http://localhost:8000/health>

### 6. 启动前端

```bash
cd frontend
npm run dev
```

开发服务器默认监听 <http://localhost:5173>，已通过 Vite 把 `/api/*` 反代到后端 8000。

---

## 环境变量说明

| 变量 | 必填 | 默认 | 说明 |
| ---- | ---- | ---- | ---- |
| `TOAPIS_API_KEY` | ✅（生产） | 空 | ToAPIs 鉴权 Bearer Token |
| `TOAPIS_BASE_URL` | ❌ | `https://toapis.com` | ToAPIs 服务地址 |
| `TOAPIS_TIMEOUT` | ❌ | `300` | ToAPIs 单次请求超时（秒） |
| `CORS_ORIGINS` | ❌ | `["http://localhost:5173"]` | 允许的跨域来源（JSON 数组） |
| `DATABASE_URL` | ❌ | SQLite | SQLAlchemy 异步 URL |
| `DATABASE_HOST` | ❌ | `localhost` | 拆分字段，构建 MySQL URL 用 |
| `DATABASE_PORT` | ❌ | `3306` | 同上 |
| `DATABASE_USER` | ❌ | `root` | 同上 |
| `DATABASE_PASSWORD` | ✅（生产） | 空 | 同上 |
| `DATABASE_NAME` | ❌ | `gpt_image2_platform` | 同上 |
| `MAX_CONCURRENT_GENERATIONS` | ❌ | `20` | 同时向 ToAPIs 提交任务的最大并发 |
| `MAX_CONCURRENT_TITLE_GENERATIONS` | ❌ | `10` | 同时向 ToAPIs chat/completions 提交的最大并发（标题生成） |
| `POLL_INTERVAL_SECONDS` | ❌ | `5` | 后台轮询器周期（秒） |

> 所有敏感字段（API Key、数据库密码）**不要**在源码或 `.env.example` 中写实际
> 值。`.env` 文件本身已被 `.gitignore` 忽略，请勿绕过忽略规则手动 `git add -f`。

---

## 数据库

### MySQL（推荐）

- 字符集：`utf8mb4` / `utf8mb4_unicode_ci`
- 引擎：`InnoDB`
- 详见 [backend/sql/init.sql](backend/sql/init.sql)

### SQLite（开发 / 演示）

- 默认在仓库根目录创建 `gpt_image2_platform.db`
- 启动时由 `lifespan` 自动 `create_all` 建表
- 不需要手动建库

---

## 后端开发

### 路由层与业务层

- **Routers** (`backend/app/routers/`)：只做参数解析、权限/校验、调用 service
  或 crud，返回 Pydantic schema
- **Services** (`backend/app/services/`)：跨表业务逻辑、并发控制、第三方调用
- **CRUD** (`backend/app/crud/`)：单表 SQL 操作，不依赖 service

### 测试

测试不依赖真实数据库 / 网络，仅通过 `unittest.mock` 验证关键算法：

```bash
uv run python backend/tests/test_batch_id_gap.py
uv run python backend/tests/test_product_swap.py
```

### 重置数据库

```bash
# MySQL
mysql -uroot -p -e "DROP DATABASE gpt_image2_platform;" && \
  mysql -uroot -p < backend/sql/init.sql

# SQLite
rm -f gpt_image2_platform.db
```

---

## 前端开发

```bash
cd frontend

# 开发服务器（已配 /api 反代）
npm run dev

# 类型检查 + 生产构建
npm run build

# 本地预览构建产物
npm run preview
```

### 关键约定

- 所有 API 请求走相对路径 `/api/...`，由 Vite dev server / 反代服务器转发
- 批次号前缀：1-10 位 A-Z / 0-9，存 `localStorage`（`gpt2.batchPrefix`）
- 远端图片统一走后端 `/api/generations/download` 代理，规避 CORS

---

## API 概览

> 完整定义见 `http://localhost:8000/docs`（Swagger 自动生成）

| Method | Path | 说明 |
| ------ | ---- | ---- |
| GET    | `/health` | 健康检查 |
| POST   | `/api/generations/generate` | 单次文生图（**已弃用**，前端已移除该功能，端点暂保留兼容） |
| GET    | `/api/generations/tasks/{task_id}` | 查询任务状态（**已弃用**，同上） |
| GET    | `/api/generations/download` | 代理下载远端图片（绕过 CORS） |
| POST   | `/api/generations/uploads/images` | 上传本地图片到 ToAPIs |
| GET    | `/api/variant-groups` | 变体组列表 |
| POST   | `/api/variant-groups` | 创建变体组（含变体） |
| GET    | `/api/variant-groups/{id}` | 变体组详情 |
| PUT    | `/api/variant-groups/{id}` | 更新变体组 |
| DELETE | `/api/variant-groups/{id}` | 删除变体组 |
| POST   | `/api/batches/generate` | 基于变体组创建批量任务 |
| GET    | `/api/batches/today-count?prefix=XXX` | 今日 prefix 批次计数 + 下一序号预览 |
| GET    | `/api/batches` | 分页列出最近批次 |
| GET    | `/api/batches/{batch_id}/status` | 拉取批次状态（顺带同步 ToAPIs） |
| POST   | `/api/batches/{batch_id}/retry` | 重试批次中失败任务 |
| POST   | `/api/batches/{batch_id}/tasks/{task_id}/regenerate` | 重新生成单个任务 |
| DELETE | `/api/batches/{batch_id}` | 删除指定批次 |
| DELETE | `/api/batches` | 批量删除（body: `{"batch_ids": [...]}`） |
| POST   | `/api/product-swap/generate` | 产品替换：1 模板 + N 产品 → N 任务 |
| GET    | `/api/title-tasks` | 标题生成任务列表（支持 batch_id / source_task_id / status 过滤） |
| POST   | `/api/title-tasks/generate` | 批量标题生成（多批次 × 第 K 张图） |
| GET    | `/api/title-tasks/batches/{batch_id}/images` | 查某批次可作为底图的图片列表 |
| POST   | `/api/title-tasks/{id}/regenerate` | 单条标题重新生成 |
| DELETE | `/api/title-tasks/{id}` | 单条标题删除 |
| POST   | `/api/title-tasks/batch-delete` | 批量删除标题任务 |

### 批次号规则

格式：`{PREFIX}{MMDD}{SEQ}`，其中

- `PREFIX`：1-10 位 `A-Z / 0-9`，可由用户在请求中指定
- `MMDD`：北京时间月日
- `SEQ`：当天该 prefix 下最小未使用的序号（填空隙）

例：`MZY072501` 表示 prefix=`MZY`、7 月 25 日的第 1 个批次。

---

## 部署建议

### 后端

1. 用生产级 ASGI 服务器：`uvicorn` 配合 `gunicorn -k uvicorn.workers.UvicornWorker`
2. 反向代理（Nginx / Caddy）做 HTTPS 终止、静态文件、限流
3. 数据库务必使用 MySQL，并配连接池（`pool_size` / `max_overflow` 视并发调）
4. **不要**把 `.env` 复制到容器镜像里，建议用 Docker secrets / 环境变量注入
5. 至少在以下位置配置备份：MySQL dump、`.env`（加密存储）、上传目录（若有）

### 前端

```bash
cd frontend
npm run build
# 将 dist/ 通过 Nginx 静态托管，/api/* 反代到后端
```

### 推荐的部署拓扑

```
┌────────┐      ┌─────────────┐      ┌──────────────┐
│ Nginx  │ ───► │ FastAPI     │ ───► │   MySQL 8.0+ │
│ (TLS)  │      │ (uvicorn)   │      └──────────────┘
└────────┘      └──────┬──────┘
   ▲                   │ HTTPS（图片代理）
   │                   ▼
┌──┴────────┐    ┌─────────────┐
│ Browser   │    │  ToAPIs     │
│ (React)   │    │  (gpt-image-2)│
└───────────┘    └─────────────┘
```

---

## 常见问题

**Q: 启动后报 `TOAPIS_API_KEY` 为空？**
A: `.env` 未生效。检查：(1) `.env` 文件在仓库根目录；(2) 文件名无 `.local`
等后缀；(3) `pydantic-settings` 版本 ≥ 2.x。

**Q: MySQL 中文 / Emoji 乱码？**
A: 客户端、连接、表 / 库都必须使用 `utf8mb4`。建表脚本已是 `utf8mb4_unicode_ci`，
但请检查 MySQL `character_set_server` 与连接驱动配置。

**Q: 重新生成任务会重复扣费吗？**
A: 任务仅在状态为 `completed` 或 `failed` 时允许 regenerate，会复用同一个
`task_id` 重新调用 ToAPIs；进行中的任务会被拒绝，避免重复扣费。

**Q: 怎么调整最大并发？**
A: 设置 `MAX_CONCURRENT_GENERATIONS`（同时提交的 ToAPIs 任务数上限，受
ToAPIs 配额约束）。

**Q: 为什么我加了一个旧格式的 `batch_id`（UUID）依然能查？**
A: 表结构保留 `VARCHAR(36)` 兼容 UUID，新格式 `{PREFIX}{MMDD}{SEQ}` 同样可以
容纳。`count_today_batches` 会忽略无法解析为整数的 batch_id。

---

## 许可证

本仓库以 **MIT** 协议开源，你可以自由使用、修改、分发，但请保留版权声明。
ToAPIs 及其模型服务遵循 ToAPIs 平台自身的服务条款，请遵守对应使用协议。

---

## 致谢

- [FastAPI](https://fastapi.tiangolo.com/) —— 高性能 Python Web 框架
- [Vite](https://vitejs.dev/) / [React](https://react.dev/) —— 现代前端工程化
- [uv](https://github.com/astral-sh/uv) —— 极速 Python 包管理
- [ToAPIs](https://toapis.com) —— gpt-image-2 模型服务
