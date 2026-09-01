-- GPT-Image-2 批量变体生成平台 - MySQL 建表脚本
-- 数据库: gpt_image2_platform
-- 请在 MySQL 8.0+ 中执行

CREATE DATABASE IF NOT EXISTS `gpt_image2_platform`
    DEFAULT CHARACTER SET utf8mb4
    DEFAULT COLLATE utf8mb4_unicode_ci;

USE `gpt_image2_platform`;

-- 变体组表
CREATE TABLE IF NOT EXISTS `variant_groups` (
    `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `name` VARCHAR(100) NOT NULL COMMENT '变体组名称',
    `description` TEXT COMMENT '描述信息',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    INDEX `idx_variant_groups_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='变体组';

-- 变体详情表
CREATE TABLE IF NOT EXISTS `variants` (
    `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `group_id` BIGINT NOT NULL COMMENT '关联变体组',
    `prompt_content` TEXT NOT NULL COMMENT '变体 Prompt 内容',
    `sort_order` INT NOT NULL DEFAULT 0 COMMENT '排序权重',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_variants_group_id` (`group_id`),
    CONSTRAINT `fk_variants_group`
        FOREIGN KEY (`group_id`) REFERENCES `variant_groups` (`id`)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='变体详情';

-- 生成任务表
CREATE TABLE IF NOT EXISTS `generation_tasks` (
    `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    -- batch_id 格式：旧数据为 UUID；新数据为 {prefix}{MMDD}{seq}，如 MZY072101
    -- prefix 用户自定义（A-Z / 0-9, 1-10 位），MMDD 为北京时间月日，seq 为当天序号
    `batch_id` VARCHAR(36) NOT NULL COMMENT '批次号（新格式 PREFIX+MMDD+SEQ，旧格式 UUID）',
    `variant_id` BIGINT NULL COMMENT '关联的变体 ID',
    `toapis_task_id` VARCHAR(100) NULL COMMENT 'ToAPIs 返回的任务 ID',
    `mode` VARCHAR(16) NOT NULL COMMENT '生成模式: t2i / i2i / product_swap',
    `size` VARCHAR(10) NOT NULL COMMENT '尺寸比例, 如 1:1',
    `resolution` VARCHAR(5) NOT NULL COMMENT '分辨率档位, 如 1k',
    `model` VARCHAR(64) NOT NULL DEFAULT 'gpt-image-2'
        COMMENT '生成模型: gpt-image-2 / gpt-image-2-vip / gemini-3.1-flash-image-preview',
    `quality` VARCHAR(10) NULL COMMENT '精度档位 low/medium/high（gpt-image-2-vip 的 quality；gemini 官方版映射 thinkingLevel；不支持的模型为 NULL）',
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending'
        COMMENT '状态: pending/queued/in_progress/completed/failed',
    `progress` TINYINT NOT NULL DEFAULT 0 COMMENT '进度 0-100',
    `image_url` VARCHAR(500) NULL COMMENT '生成成功后的图片地址',
    `error_msg` TEXT NULL COMMENT '失败原因',
    `reference_image_urls` TEXT NULL COMMENT '图生图参考图 URL 列表, 逗号分隔',
    `template_image_url` VARCHAR(500) NULL COMMENT 'product_swap 模式: 批次级模板图 URL',
    `product_image_url` VARCHAR(500) NULL COMMENT 'product_swap 模式: 任务级产品图 URL',
    `prompt` TEXT NULL COMMENT 'product_swap 模式: 任务级 prompt（不再依赖 variant）',
    `retried_count` INT NOT NULL DEFAULT 0 COMMENT '重试次数（重试失败任务/重新生成时+1，用于区分跨天重试批次）',
    `auto_retry_count` INT NOT NULL DEFAULT 0 COMMENT '自动重试已执行次数（0-3，失败后按模型阶梯 gpt-image-2→vip→gemini 自动重试；3 次后停止交由用户手动重试）',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `completed_at` DATETIME NULL COMMENT '完成时间',
    INDEX `idx_generation_tasks_batch_id` (`batch_id`),
    INDEX `idx_generation_tasks_toapis_task_id` (`toapis_task_id`),
    INDEX `idx_generation_tasks_status` (`status`),
    INDEX `idx_generation_tasks_created_at` (`created_at`),
    CONSTRAINT `fk_generation_tasks_variant`
        FOREIGN KEY (`variant_id`) REFERENCES `variants` (`id`)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='生成任务';

-- 工厂 ERP 会话配置（单行，id=1）：仅存 cookie，账号密码不入库
CREATE TABLE IF NOT EXISTS `erp_config` (
    `id` INT NOT NULL PRIMARY KEY,
    `cookies` TEXT NULL COMMENT 'ERP 会话 cookie（JSON，含 _identity-backend 等）',
    `updated_at` DATETIME NULL COMMENT '最近一次登录/会话更新时间',
    `last_error` TEXT NULL COMMENT '最近一次会话错误信息'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='工厂 ERP 会话配置';

-- 工厂 ERP 图片缺失订单快照 + 提取产品图业务状态
CREATE TABLE IF NOT EXISTS `erp_order_items` (
    `order_item_id` BIGINT NOT NULL PRIMARY KEY COMMENT 'ERP 订单条目 ID（唯一键）',
    `supplier_id` INT NOT NULL COMMENT 'ERP 店铺 ID（供应商 ID）',
    `store_name` VARCHAR(100) NOT NULL COMMENT '店铺名称',
    `goods_sn` VARCHAR(64) NOT NULL COMMENT '内部货号',
    `size` VARCHAR(32) NULL COMMENT '尺寸，如 80x400',
    `sku` VARCHAR(128) NULL COMMENT 'SKU 货号',
    `skcid` VARCHAR(64) NULL COMMENT 'SKCID',
    `skuid` VARCHAR(64) NULL COMMENT 'SKUID',
    `material` VARCHAR(255) NULL COMMENT '材质',
    `input_image_url` VARCHAR(500) NULL COMMENT 'AI 输入图（ERP 图片列缩略图地址）',
    `order_sn` VARCHAR(64) NULL COMMENT '备货单号',
    `quantity` INT NOT NULL DEFAULT 1 COMMENT '数量',
    `batch_id` VARCHAR(36) NULL COMMENT '关联生成批次号（{PREFIX}{MMDD}{SEQ}）',
    `generation_task_id` BIGINT NULL COMMENT '关联 generation_tasks.id（店铺+货号去重后共享一个任务）',
    `result_image_url` VARCHAR(500) NULL COMMENT '生成结果图 URL',
    `erp_uploaded_at` DATETIME NULL COMMENT '已上传回 ERP 的时间（非空=已上传）',
    `missing_synced_at` DATETIME NULL COMMENT '最近一次同步时仍在 ERP 缺失列表的时间（待处理列表据此过滤幽灵订单）',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_erp_order_items_supplier` (`supplier_id`),
    INDEX `idx_erp_order_items_store` (`store_name`),
    INDEX `idx_erp_order_items_goods` (`goods_sn`),
    INDEX `idx_erp_order_items_batch` (`batch_id`),
    INDEX `idx_erp_order_items_task` (`generation_task_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='工厂 ERP 图片缺失订单 + 提取产品图状态';

-- 标题生成任务表（多模态 chat/completions 生成的电商标题）
-- 关联 generation_tasks.id 作为底图来源；每次「生成 / 重新生成」都新建一条记录
CREATE TABLE IF NOT EXISTS `title_tasks` (
    `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `source_task_id` BIGINT NULL COMMENT '底图对应的源 generation_task.id（SET NULL 保留历史）',
    `batch_id` VARCHAR(36) NOT NULL COMMENT '冗余：源任务所在批次（加速列表 / 导出 CSV）',
    `source_image_url` VARCHAR(500) NOT NULL COMMENT '冗余：底图远端 URL',
    `model` VARCHAR(64) NOT NULL COMMENT '多模态模型：gemini-3.7-flash / grok-4.5 / gpt-5.6-sol',
    `prompt_snapshot` TEXT NOT NULL COMMENT '完整 prompt 快照（system + user 引用）',
    `extra_instructions` TEXT NULL COMMENT '用户附加的额外要求（可空）',
    `max_tokens` INT NULL COMMENT '生成上限 token；NULL 走 ToAPIs 默认',
    `temperature` FLOAT NULL COMMENT '采样温度 0-2；NULL 走 ToAPIs 默认',
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending'
        COMMENT '状态: pending/in_progress/completed/failed',
    `title` TEXT NULL COMMENT '生成的标题（成功时填入）',
    `error_msg` TEXT NULL COMMENT '失败原因',
    `regenerated_count` INT NOT NULL DEFAULT 0 COMMENT '该源任务累计重新生成次数（不含首次）',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `completed_at` DATETIME NULL COMMENT '完成时间',
    INDEX `idx_title_tasks_batch_id` (`batch_id`),
    INDEX `idx_title_tasks_source_task_id` (`source_task_id`),
    INDEX `idx_title_tasks_status` (`status`),
    INDEX `idx_title_tasks_created_at` (`created_at`),
    CONSTRAINT `fk_title_tasks_source_task`
        FOREIGN KEY (`source_task_id`) REFERENCES `generation_tasks` (`id`)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='标题生成任务（多模态 chat/completions）';
