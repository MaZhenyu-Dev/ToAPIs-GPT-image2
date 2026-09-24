import asyncio
import logging
import random
import re
from typing import Any, Optional

import httpx
from fastapi import HTTPException, UploadFile
from backend.app.config import settings

logger = logging.getLogger(__name__)

# 可安全退避重试的上游状态码：
# - 429：限流
# - 5xx：网关 / 源站瞬时故障（504 即 ToAPIs 前置网关 volc-dcdn / tengine 超时）
RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})

# 错误体最大长度：网关超时页是整页 HTML（数百 KB），
# 截断后再落库 / 回前端，避免 error_msg 被 HTML 淹没。
MAX_ERROR_TEXT_LEN = 300

# 网关 HTML 错误页的标题（如 "504 Gateway Time-out"），用于生成友好文案
_HTML_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)


class ToApisClient:
    """封装 ToAPIs 图像生成、任务查询与图片上传接口。"""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: int = 300,
        max_retries: int = 3,
        base_delay: float = 1.0,
        proxy_url: Optional[str] = None,
        max_backoff: float = 30.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_backoff = max_backoff
        # 留空 / None = 走系统路由表（公司 VPN 场景）；
        # 传具体地址 = 显式走 HTTP/SOCKS 代理（个人 VPN 场景）。
        # trust_env 保持 False，避免误读系统环境变量里的代理。
        # 连接池放大：ToAPIs 官方并发 6000，本地 MAX_CONCURRENT_GENERATIONS
        # 可拉到 200+，默认 100 连接会成瓶颈（多余的请求排队等待连接）。
        self._client = httpx.AsyncClient(
            timeout=timeout,
            trust_env=False,
            proxy=proxy_url or None,
            limits=httpx.Limits(
                max_connections=600,
                max_keepalive_connections=100,
            ),
        )

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    async def create_generation(self, payload: dict) -> dict:
        """发起图像生成任务，返回任务元数据。

        429 / 5xx（网关超时等瞬时故障）由 ``_request_with_retry`` 自动退避重试；
        重试仅在拿到明确错误响应时触发，若首次请求已被上游受理但响应丢失，
        理论上存在极小概率的重复任务，权衡后仍以「自动恢复瞬时故障」优先。
        """
        url = f"{self.base_url}/v1/images/generations"
        response = await self._request_with_retry(
            method="POST",
            url=url,
            headers={**self._headers(), "Content-Type": "application/json"},
            json=payload,
        )
        return response.json()

    async def get_task_status(self, task_id: str) -> dict:
        """查询异步生成任务状态与结果（429 / 5xx 自动退避重试）。"""
        url = f"{self.base_url}/v1/images/generations/{task_id}"
        response = await self._request_with_retry(
            method="GET", url=url, headers=self._headers()
        )
        return response.json()

    async def chat_completion(
        self,
        model: str,
        messages: list[dict],
        max_tokens: int | None = None,
        temperature: float | None = None,
        timeout: int | None = None,
    ) -> dict:
        """调用 ToAPIs /v1/chat/completions（OpenAI 兼容）。

        主要用于标题生成场景：
        - messages 中 user 消息可携带 ``image_url`` 内容块（多模态）
        - 默认走非流式（stream=False），便于后端一次性落库

        返回 ToAPIs 原始 JSON（与 OpenAI Chat Completions 一致）：
        ``{"choices": [{"message": {"role": "assistant", "content": "..."}}], ...}``
        """
        url = f"{self.base_url}/v1/chat/completions"
        payload: dict = {
            "model": model,
            "messages": messages,
            "stream": False,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if temperature is not None:
            payload["temperature"] = temperature

        # 标题生成单次响应快，单独短超时（默认 60s）；被调用方可覆盖
        kwargs: dict = {
            "method": "POST",
            "url": url,
            "headers": {**self._headers(), "Content-Type": "application/json"},
            "json": payload,
        }
        if timeout is not None:
            kwargs["timeout"] = timeout
        response = await self._request_with_retry(**kwargs)
        return response.json()

    async def _request_with_retry(
        self, method: str, url: str, **kwargs
    ) -> httpx.Response:
        """带指数退避重试的 HTTP 请求封装。

        重试策略（最多 ``max_retries`` 次）：
        - 429 / 5xx：上游瞬时故障，按 Retry-After 或指数退避后重试
        - 超时 / 连接失败 / 网络中断：指数退避后重试
        - 其它 4xx：客户端错误（参数 / 鉴权等），不重试直接抛出

        所有最终失败统一映射为 ``HTTPException``（状态码尽量透传上游），
        调用方无需再区分底层异常类型。
        """
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = await self._client.request(method, url, **kwargs)
                response.raise_for_status()
                return response
            except httpx.HTTPStatusError as exc:
                last_exc = exc
                status = exc.response.status_code
                if (
                    status not in RETRYABLE_STATUS_CODES
                    or attempt == self.max_retries
                ):
                    raise self._to_http_exception(exc) from exc
                await self._sleep_before_retry(
                    attempt,
                    method,
                    url,
                    f"返回 {status}",
                    response=exc.response,
                )
            except httpx.TimeoutException as exc:
                last_exc = exc
                if attempt == self.max_retries:
                    raise HTTPException(
                        status_code=504, detail=f"ToAPIs 请求超时: {exc}"
                    ) from exc
                await self._sleep_before_retry(attempt, method, url, "请求超时")
            except httpx.ConnectError as exc:
                last_exc = exc
                if attempt == self.max_retries:
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            "ToAPIs 连接失败（代理未开启或网络不可达）："
                            f"{exc}"
                        ),
                    ) from exc
                await self._sleep_before_retry(attempt, method, url, "连接失败")
            except httpx.RequestError as exc:
                last_exc = exc
                if attempt == self.max_retries:
                    raise HTTPException(
                        status_code=502, detail=f"ToAPIs 网络错误: {exc}"
                    ) from exc
                await self._sleep_before_retry(attempt, method, url, "网络错误")

        # 逻辑上不会到达此处，作为防御性 fallback
        raise HTTPException(
            status_code=502, detail=f"ToAPIs 请求失败: {last_exc}"
        ) from last_exc

    async def _sleep_before_retry(
        self,
        attempt: int,
        method: str,
        url: str,
        reason: str,
        response: httpx.Response | None = None,
    ) -> None:
        """记录重试日志并等待退避时长。"""
        delay = self._retry_delay(attempt, response)
        logger.warning(
            "ToAPIs %s %s %s，%.1fs 后进行第 %d/%d 次重试",
            method,
            url,
            reason,
            delay,
            attempt + 1,
            self.max_retries,
        )
        await asyncio.sleep(delay)

    def _retry_delay(
        self, attempt: int, response: httpx.Response | None = None
    ) -> float:
        """计算重试等待秒数：优先遵循 Retry-After，其次指数退避 + 抖动。

        上限 ``max_backoff``，避免上游返回超长 Retry-After 时请求被长时间卡住。
        """
        if response is not None:
            retry_after = response.headers.get("Retry-After")
            if retry_after:
                try:
                    return min(max(float(retry_after), 0.0), self.max_backoff)
                except ValueError:
                    pass
        delay = self.base_delay * (2 ** attempt) + random.uniform(0, 1)
        return min(delay, self.max_backoff)

    @classmethod
    def _to_http_exception(cls, exc: httpx.HTTPStatusError) -> HTTPException:
        """把上游 HTTP 错误映射为带友好文案的 HTTPException（状态码透传）。"""
        return HTTPException(
            status_code=exc.response.status_code,
            detail=cls._extract_error(exc.response),
        )

    async def upload_image(self, file: UploadFile) -> str:
        """上传图片到 ToAPIs 并返回公开 URL。"""
        content = await file.read()
        return await self.upload_image_bytes(
            content, file.filename or "image", file.content_type or "application/octet-stream"
        )

    async def upload_image_bytes(
        self, content: bytes, filename: str = "image.png", content_type: str = "image/png"
    ) -> str:
        """上传图片字节流到 ToAPIs 并返回公开 URL（内部 / ERP 爬取图片用）。

        与其它请求一致走 ``_request_with_retry``：网关 5xx / 超时自动退避重试，
        避免单张图片的瞬时故障导致整个文件夹批量中断（图片字节可安全重放）。
        """
        url = f"{self.base_url}/v1/uploads/images"
        response = await self._request_with_retry(
            method="POST",
            url=url,
            headers=self._headers(),
            files={
                "file": (
                    filename,
                    content,
                    content_type,
                )
            },
        )

        try:
            data = response.json()
        except ValueError as exc:
            raise HTTPException(
                status_code=502,
                detail="ToAPIs 上传接口返回非 JSON 响应，请稍后重试",
            ) from exc

        if not data.get("success"):
            raise HTTPException(
                status_code=502,
                detail=data.get("message") or "ToAPIs 上传失败",
            )
        image_url = (data.get("data") or {}).get("url")
        if not image_url:
            raise HTTPException(
                status_code=502, detail="ToAPIs 上传响应缺少图片 URL"
            )
        return image_url

    @staticmethod
    def _extract_error(response: httpx.Response) -> str:
        """从错误响应中提取可读文案。

        - HTML 错误页（如网关 ``504 Gateway Time-out``）：提取 ``<title>``
          生成友好提示，绝不把整页 HTML 回传前端 / 落库
        - JSON 错误体：取 ``error.message`` / ``message`` 字段
        - 其它纯文本：截断到 ``MAX_ERROR_TEXT_LEN`` 后返回
        """
        text = response.text or ""
        content_type = response.headers.get("content-type", "").lower()
        if "html" in content_type or text.lstrip().startswith("<"):
            title = _HTML_TITLE_RE.search(text)
            title_text = title.group(1).strip() if title else ""
            if not title_text:
                title_text = f"HTTP {response.status_code}"
            return (
                f"ToAPIs 网关错误 (HTTP {response.status_code})："
                f"{title_text[:100]}，请稍后重试"
            )

        try:
            body = response.json()
        except Exception:
            text = text.strip()
            if not text:
                return f"ToAPIs 错误 (HTTP {response.status_code})"
            if len(text) > MAX_ERROR_TEXT_LEN:
                text = text[:MAX_ERROR_TEXT_LEN] + "…"
            return text

        if isinstance(body, dict):
            if "error" in body:
                error = body["error"]
                if isinstance(error, dict):
                    return str(error.get("message", error))
                return str(error)
            if "message" in body:
                return str(body["message"])
        return str(body)[:MAX_ERROR_TEXT_LEN]

    @staticmethod
    def extract_image_url(payload: Any) -> Optional[str]:
        """从 ToAPIs 任务状态响应中提取图片 URL。

        ToAPIs 不同接口/版本下图片 URL 字段位置不固定，需兼容以下结构：
        1. 顶层 ``url`` 字段（标准 ToAPIs gpt-image-2 异步任务完成返回）
        2. ``result.data[0].url`` 包装结构（部分模型/接口）
        3. 顶层 ``data[0].url`` 数组结构（部分中转接口）
        4. ``output`` / ``outputs`` / ``images`` 等列表字段
        """
        if not isinstance(payload, dict):
            return None

        # 1. 顶层 url 字段
        top_url = payload.get("url")
        if isinstance(top_url, str) and top_url:
            return top_url

        # 2. result.data[0].url 结构
        result = payload.get("result")
        if isinstance(result, dict):
            url = ToApisClient._first_url_from_list(result.get("data"))
            if url:
                return url

        # 3. 顶层 data[0].url 结构
        url = ToApisClient._first_url_from_list(payload.get("data"))
        if url:
            return url

        # 4. output / outputs / images 等列表字段
        for key in ("output", "outputs", "images"):
            url = ToApisClient._first_url_from_list(payload.get(key))
            if url:
                return url

        return None

    @staticmethod
    def _first_url_from_list(items: Any) -> Optional[str]:
        """从列表中取第一个可用的 url，兼容元素为 dict 或纯字符串两种形态。"""
        if not isinstance(items, list) or not items:
            return None
        first = items[0]
        if isinstance(first, dict):
            url = first.get("url")
            if isinstance(url, str) and url:
                return url
        elif isinstance(first, str) and first:
            return first
        return None

    async def fetch_image_bytes(self, url: str, timeout: int = 60) -> bytes:
        """代理下载任意 HTTP(S) 图片的字节流。

        浏览器直接 fetch 跨域图片（如 ToAPIs 文件 CDN）会因 CORS 失败，
        在此通过服务端请求中转，前端再从自己的后端下载，规避浏览器限制。

        对 5xx / 429 / 超时 / 网络错误做指数退避重试；其它 4xx 直接抛出。
        抛出原始 httpx 异常，由调用方决定如何映射为 HTTP 状态码。
        """
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = await self._client.get(
                    url, timeout=timeout, follow_redirects=True
                )
                response.raise_for_status()
                return response.content
            except (httpx.TimeoutException, httpx.RequestError) as exc:
                last_exc = exc
                if attempt == self.max_retries:
                    raise
                await asyncio.sleep(self._retry_delay(attempt))
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                # 5xx 与 429 可重试；其它 4xx 视为客户端错误，不再重试
                if status in RETRYABLE_STATUS_CODES:
                    last_exc = exc
                    if attempt == self.max_retries:
                        raise
                    await asyncio.sleep(self._retry_delay(attempt, exc.response))
                    continue
                raise
        # 逻辑上不会到达此处，作为防御性 fallback
        assert last_exc is not None
        raise last_exc

    async def close(self) -> None:
        await self._client.aclose()


client = ToApisClient(
    settings.TOAPIS_BASE_URL,
    settings.TOAPIS_API_KEY,
    settings.TOAPIS_TIMEOUT,
    proxy_url=settings.TOAPIS_PROXY_URL,
)
