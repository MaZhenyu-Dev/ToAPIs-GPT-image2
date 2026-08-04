import asyncio
import random
from typing import Any, Optional

import httpx
from fastapi import HTTPException, UploadFile
from backend.app.config import settings


class ToApisClient:
    """封装 ToAPIs 图像生成、任务查询与图片上传接口。"""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: int = 300,
        max_retries: int = 3,
        base_delay: float = 1.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries
        self.base_delay = base_delay
        self._client = httpx.AsyncClient(timeout=timeout, trust_env=False)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    async def create_generation(self, payload: dict) -> dict:
        """发起图像生成任务，返回任务元数据（429 时指数退避重试）。"""
        url = f"{self.base_url}/v1/images/generations"
        response = await self._request_with_retry(
            method="POST",
            url=url,
            headers={**self._headers(), "Content-Type": "application/json"},
            json=payload,
        )
        return response.json()

    async def get_task_status(self, task_id: str) -> dict:
        """查询异步生成任务状态与结果（429 时指数退避重试）。"""
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
        """带 429 退避重试的 HTTP 请求封装。"""
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = await self._client.request(method, url, **kwargs)
                response.raise_for_status()
                return response
            except httpx.TimeoutException as exc:
                last_exc = exc
                if attempt == self.max_retries:
                    raise HTTPException(
                        status_code=504, detail=f"ToAPIs 请求超时: {exc}"
                    ) from exc
                await self._backoff(attempt)
            except httpx.HTTPStatusError as exc:
                last_exc = exc
                if exc.response.status_code == 429 and attempt < self.max_retries:
                    await self._backoff(attempt)
                    continue
                detail = self._extract_error(exc.response)
                raise HTTPException(
                    status_code=exc.response.status_code, detail=detail
                ) from exc
            except Exception as exc:
                last_exc = exc
                if attempt == self.max_retries:
                    raise
                await self._backoff(attempt)

        raise HTTPException(
            status_code=502, detail=f"ToAPIs 请求失败: {last_exc}"
        ) from last_exc

    async def _backoff(self, attempt: int) -> None:
        """指数退避 + 随机抖动，避免 thundering herd。"""
        delay = self.base_delay * (2 ** attempt) + random.uniform(0, 1)
        await asyncio.sleep(delay)

    async def upload_image(self, file: UploadFile) -> str:
        """上传图片到 ToAPIs 并返回公开 URL。"""
        url = f"{self.base_url}/v1/uploads/images"
        content = await file.read()
        try:
            response = await self._client.post(
                url,
                headers=self._headers(),
                files={
                    "file": (
                        file.filename or "image",
                        content,
                        file.content_type or "application/octet-stream",
                    )
                },
            )
            response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise HTTPException(status_code=504, detail=f"上传超时: {exc}") from exc
        except httpx.HTTPStatusError as exc:
            detail = self._extract_error(exc.response)
            raise HTTPException(
                status_code=exc.response.status_code, detail=detail
            ) from exc

        data = response.json()
        if not data.get("success"):
            raise HTTPException(
                status_code=502,
                detail=data.get("message") or "ToAPIs 上传失败",
            )
        return data["data"]["url"]

    @staticmethod
    def _extract_error(response: httpx.Response) -> str:
        try:
            body = response.json()
        except Exception:
            return response.text or f"ToAPIs 错误 (HTTP {response.status_code})"

        if "error" in body:
            error = body["error"]
            if isinstance(error, dict):
                return error.get("message", str(error))
            return str(error)
        if "message" in body:
            return body["message"]
        return str(body)

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
                await self._backoff(attempt)
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                # 5xx 与 429 可重试；其它 4xx 视为客户端错误，不再重试
                if status >= 500 or status == 429:
                    last_exc = exc
                    if attempt == self.max_retries:
                        raise
                    await self._backoff(attempt)
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
)
