from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """应用配置，优先从环境变量 / .env 文件读取。"""

    # 注意：所有敏感字段（TOAPIS_API_KEY / DATABASE_PASSWORD 等）都不要在源码中
    # 写默认值，统一从环境变量 / .env 注入。空字符串表示「未配置」，由启动期
    # 校验或运行时错误兜底，避免把真实凭据意外写进 git 历史。
    TOAPIS_BASE_URL: str = "https://toapis.com"
    TOAPIS_API_KEY: str = ""
    TOAPIS_TIMEOUT: int = 300

    CORS_ORIGINS: list[str] = ["http://localhost:5173"]

    DATABASE_URL: str = "sqlite+aiosqlite:///./gpt_image2_platform.db"
    DATABASE_HOST: str = "localhost"
    DATABASE_PORT: int = 3306
    DATABASE_USER: str = "root"
    DATABASE_PASSWORD: str = ""
    DATABASE_NAME: str = "gpt_image2_platform"

    MAX_CONCURRENT_GENERATIONS: int = 20
    POLL_INTERVAL_SECONDS: int = 5

    # 标题生成：调用 ToAPIs chat/completions（多模态）时的并发上限。
    # 标题任务无需像图像生成那样重度并发，限制在 10 避免触发 ToAPIs 429。
    MAX_CONCURRENT_TITLE_GENERATIONS: int = 10

    @property
    def mysql_database_url(self) -> str:
        return (
            f"mysql+aiomysql://{self.DATABASE_USER}:{self.DATABASE_PASSWORD}"
            f"@{self.DATABASE_HOST}:{self.DATABASE_PORT}/{self.DATABASE_NAME}"
        )

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
