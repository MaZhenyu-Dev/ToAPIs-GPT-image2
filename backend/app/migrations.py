"""启动时轻量自动迁移：为已存在的表补充缺失的新列。

背景：
- ``Base.metadata.create_all`` 只创建不存在的表，不会给已存在的表加列。
- 每次加字段（如 retried_count）都让用户手动 ALTER 不现实。
- 这里在启动时检测表/列是否存在，缺失则按需 ALTER，幂等可重复执行。

支持的方言：MySQL / SQLite（覆盖本项目的两种 DATABASE_URL）。
"""

import logging

from sqlalchemy import text

logger = logging.getLogger(__name__)

# 需要保证的列：{表名: {列名: 建列 SQL（不带 ADD COLUMN 前缀，MySQL 方言）}}
# 后续加字段时在此登记即可，重启后自动补齐。
REQUIRED_COLUMNS: dict[str, dict[str, str]] = {
    "generation_tasks": {
        "retried_count": (
            "INT NOT NULL DEFAULT 0 COMMENT '重试次数（重试/重新生成时+1）'"
        ),
    },
}


async def run_migrations(engine) -> None:
    """检测并补齐缺失的列（幂等）。"""
    dialect = engine.dialect.name  # "mysql" / "sqlite"
    for table, columns in REQUIRED_COLUMNS.items():
        existing = await _get_columns(engine, dialect, table)
        for col_name, col_ddl in columns.items():
            if col_name in existing:
                continue
            await _add_column(engine, dialect, table, col_name, col_ddl)


async def _get_columns(engine, dialect: str, table: str) -> set[str]:
    """返回表中现有列名集合。"""
    if dialect == "sqlite":
        async with engine.connect() as conn:
            result = await conn.execute(text(f"PRAGMA table_info({table})"))
            return {row[1] for row in result.fetchall()}
    # MySQL：information_schema 查询
    async with engine.connect() as conn:
        result = await conn.execute(
            text(
                "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t"
            ),
            {"t": table},
        )
        return {row[0] for row in result.fetchall()}


async def _add_column(
    engine, dialect: str, table: str, col_name: str, col_ddl: str
) -> None:
    """执行 ADD COLUMN。SQLite 不支持 COMMENT，剥离之。"""
    ddl = col_ddl
    if dialect == "sqlite":
        # SQLite 不支持 COMMENT 语法，去掉 COMMENT 及之前的内容保留类型定义
        import re

        ddl = re.sub(r"\s+COMMENT\s+'.*?'\s*$", "", col_ddl)
    async with engine.begin() as conn:
        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col_name} {ddl}"))
    logger.info("自动迁移：%s.%s 列已补齐", table, col_name)
