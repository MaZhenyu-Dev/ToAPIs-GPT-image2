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
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending'
        COMMENT '状态: pending/queued/in_progress/completed/failed',
    `progress` TINYINT NOT NULL DEFAULT 0 COMMENT '进度 0-100',
    `image_url` VARCHAR(500) NULL COMMENT '生成成功后的图片地址',
    `error_msg` TEXT NULL COMMENT '失败原因',
    `reference_image_urls` TEXT NULL COMMENT '图生图参考图 URL 列表, 逗号分隔',
    `template_image_url` VARCHAR(500) NULL COMMENT 'product_swap 模式: 批次级模板图 URL',
    `product_image_url` VARCHAR(500) NULL COMMENT 'product_swap 模式: 任务级产品图 URL',
    `prompt` TEXT NULL COMMENT 'product_swap 模式: 任务级 prompt（不再依赖 variant）',
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

-- 标题生成任务表（多模态 chat/completions 生成的电商标题）
-- 关联 generation_tasks.id 作为底图来源；每次「生成 / 重新生成」都新建一条记录
CREATE TABLE IF NOT EXISTS `title_tasks` (
    `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    `source_task_id` BIGINT NULL COMMENT '底图对应的源 generation_task.id（SET NULL 保留历史）',
    `batch_id` VARCHAR(36) NOT NULL COMMENT '冗余：源任务所在批次（加速列表 / 导出 CSV）',
    `source_image_url` VARCHAR(500) NOT NULL COMMENT '冗余：底图远端 URL',
    `model` VARCHAR(64) NOT NULL COMMENT '多模态模型：gemini-3.6-flash / grok-4.5 / gpt-5.6-sol',
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
