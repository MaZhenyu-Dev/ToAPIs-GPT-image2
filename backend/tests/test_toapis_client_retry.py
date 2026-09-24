"""ToAPIs 客户端重试 / 错误文案单元测试（httpx.MockTransport，无外网依赖）。

覆盖：
- _request_with_retry：5xx / 429 / 超时重试，4xx 不重试，重试耗尽映射 HTTPException
- upload_image_bytes：网关 504 自动重试、最终失败友好文案、响应校验
- _extract_error：HTML 网关错误页转友好文案、JSON / 纯文本错误提取与截断
- _retry_delay：Retry-After 优先且受 max_backoff 上限约束

运行：
    .venv\\Scripts\\python.exe backend/tests/test_toapis_client_retry.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import httpx
from fastapi import HTTPException

from backend.app.toapis_client import (
    MAX_ERROR_TEXT_LEN,
    ToApisClient,
)

GATEWAY_504_HTML = (
    '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n'
    "<html>\n"
    "<head><title>504 Gateway Time-out</title></head>\n"
    "<body>\n"
    "<center><h1>504 Gateway Time-out</h1></center>\n"
    "<hr/>Powered by volc-dcdn<hr><center>tengine</center>\n"
    "</body>\n"
    "</html>\n"
)


def make_client(handler, max_retries: int = 3, max_backoff: float = 0.001) -> ToApisClient:
    """构造走 MockTransport 的客户端（退避压到毫秒级，测试秒级完成）。"""
    client = ToApisClient(
        "https://toapis.test",
        "test-key",
        timeout=5,
        max_retries=max_retries,
        base_delay=0.001,
        max_backoff=max_backoff,
    )
    client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), timeout=5
    )
    return client


class CallCounter:
    """记录请求次数与最近一次请求，供断言使用。"""

    def __init__(self, responses):
        self.responses = responses
        self.calls = 0
        self.last_request: httpx.Request | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.last_request = request
        item = self.responses[min(self.calls, len(self.responses) - 1)]
        self.calls += 1
        if isinstance(item, Exception):
            raise item
        return item


async def test_retry_5xx_then_success() -> None:
    handler = CallCounter(
        [
            httpx.Response(504, text=GATEWAY_504_HTML, headers={"content-type": "text/html"}),
            httpx.Response(200, json={"id": "task-1", "status": "queued"}),
        ]
    )
    client = make_client(handler)
    try:
        data = await client.create_generation({"model": "gpt-image-2", "prompt": "x"})
        assert data["id"] == "task-1"
        assert handler.calls == 2, f"应在 504 后重试成功，实际请求 {handler.calls} 次"
        print("[1] 5xx 重试后成功: ok")
    finally:
        await client.close()


async def test_no_retry_on_4xx() -> None:
    handler = CallCounter(
        [httpx.Response(400, json={"error": {"message": "invalid prompt"}})]
    )
    client = make_client(handler)
    try:
        try:
            await client.create_generation({"prompt": ""})
            assert False, "400 应直接抛出"
        except HTTPException as exc:
            assert exc.status_code == 400, exc.status_code
            assert exc.detail == "invalid prompt", exc.detail
        assert handler.calls == 1, f"4xx 不应重试，实际请求 {handler.calls} 次"
        print("[2] 4xx 不重试且透传文案: ok")
    finally:
        await client.close()


async def test_retry_exhausted_friendly_detail() -> None:
    handler = CallCounter(
        [httpx.Response(504, text=GATEWAY_504_HTML, headers={"content-type": "text/html"})]
    )
    client = make_client(handler, max_retries=3)
    try:
        try:
            await client.create_generation({"prompt": "x"})
            assert False, "重试耗尽应抛出"
        except HTTPException as exc:
            assert exc.status_code == 504, exc.status_code
            assert "ToAPIs 网关错误 (HTTP 504)" in exc.detail, exc.detail
            assert "504 Gateway Time-out" in exc.detail, exc.detail
            assert "<html" not in exc.detail.lower(), "不应把整页 HTML 回传"
        assert handler.calls == 4, f"应为 1 次首发 + 3 次重试，实际 {handler.calls} 次"
        print("[3] 重试耗尽 → 友好 504 文案: ok")
    finally:
        await client.close()


async def test_timeout_retried_then_success() -> None:
    handler = CallCounter(
        [
            httpx.ReadTimeout("read timeout"),
            httpx.Response(200, json={"id": "task-2"}),
        ]
    )
    client = make_client(handler)
    try:
        data = await client.get_task_status("task-2")
        assert data["id"] == "task-2"
        assert handler.calls == 2, f"超时应重试，实际请求 {handler.calls} 次"
        print("[4] 超时重试后成功: ok")
    finally:
        await client.close()


async def test_connect_error_final_message() -> None:
    handler = CallCounter([httpx.ConnectError("connection refused")])
    client = make_client(handler, max_retries=1)
    try:
        try:
            await client.get_task_status("task-3")
            assert False, "连接失败应抛出"
        except HTTPException as exc:
            assert exc.status_code == 502, exc.status_code
            assert "连接失败" in exc.detail and "代理" in exc.detail, exc.detail
        assert handler.calls == 2, f"连接错误应重试，实际请求 {handler.calls} 次"
        print("[5] 连接失败重试 + 代理提示: ok")
    finally:
        await client.close()


async def test_upload_retries_and_returns_url() -> None:
    handler = CallCounter(
        [
            httpx.Response(504, text=GATEWAY_504_HTML, headers={"content-type": "text/html"}),
            httpx.Response(200, json={"success": True, "data": {"url": "https://files.toapis.com/a.png"}}),
        ]
    )
    client = make_client(handler)
    try:
        url = await client.upload_image_bytes(b"fake-bytes", "a.png", "image/png")
        assert url == "https://files.toapis.com/a.png", url
        assert handler.calls == 2, f"上传应在 504 后重试，实际请求 {handler.calls} 次"
        content_type = handler.last_request.headers.get("content-type", "")
        assert "multipart/form-data" in content_type, content_type
        print("[6] 上传 504 重试后返回 URL: ok")
    finally:
        await client.close()


async def test_upload_failure_friendly_detail() -> None:
    handler = CallCounter(
        [httpx.Response(502, text=GATEWAY_504_HTML, headers={"content-type": "text/html"})]
    )
    client = make_client(handler, max_retries=2)
    try:
        try:
            await client.upload_image_bytes(b"fake-bytes")
            assert False, "重试耗尽应抛出"
        except HTTPException as exc:
            assert exc.status_code == 502, exc.status_code
            assert "ToAPIs 网关错误 (HTTP 502)" in exc.detail, exc.detail
            assert "<html" not in exc.detail.lower(), "不应把整页 HTML 回传"
        assert handler.calls == 3, f"应为 1 次首发 + 2 次重试，实际 {handler.calls} 次"
        print("[7] 上传重试耗尽 → 友好文案: ok")
    finally:
        await client.close()


async def test_upload_bad_payload_raises() -> None:
    handler = CallCounter([httpx.Response(200, json={"success": False, "message": "文件过大"})])
    client = make_client(handler)
    try:
        try:
            await client.upload_image_bytes(b"fake-bytes")
            assert False, "success=false 应抛出"
        except HTTPException as exc:
            assert exc.status_code == 502 and exc.detail == "文件过大", exc.detail
        print("[8] 上传业务失败文案: ok")
    finally:
        await client.close()


def test_extract_error_html() -> None:
    response = httpx.Response(
        504, text=GATEWAY_504_HTML, headers={"content-type": "text/html; charset=utf-8"}
    )
    detail = ToApisClient._extract_error(response)
    assert detail == "ToAPIs 网关错误 (HTTP 504)：504 Gateway Time-out，请稍后重试", detail
    print("[9] HTML 网关错误页 → 友好文案: ok")


def test_extract_error_json() -> None:
    response = httpx.Response(
        429, json={"error": {"message": "rate limit exceeded", "type": "rate_limit"}}
    )
    assert ToApisClient._extract_error(response) == "rate limit exceeded"
    response = httpx.Response(400, json={"message": "bad request"})
    assert ToApisClient._extract_error(response) == "bad request"
    print("[10] JSON 错误体提取: ok")


def test_extract_error_text_truncated() -> None:
    response = httpx.Response(500, text="x" * 5000, headers={"content-type": "text/plain"})
    detail = ToApisClient._extract_error(response)
    assert len(detail) <= MAX_ERROR_TEXT_LEN + 1, len(detail)
    assert detail.endswith("…"), detail[-10:]
    print("[11] 超长纯文本截断: ok")


async def test_retry_delay() -> None:
    client = make_client(lambda request: httpx.Response(200), max_backoff=30.0)
    try:
        response = httpx.Response(429, headers={"Retry-After": "2"})
        assert client._retry_delay(0, response) == 2.0
        capped = httpx.Response(429, headers={"Retry-After": "9999"})
        assert client._retry_delay(0, capped) == client.max_backoff
        invalid = httpx.Response(429, headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"})
        assert client._retry_delay(0, invalid) >= 0
        print("[12] Retry-After 解析与上限: ok")
    finally:
        await client.close()


async def main() -> None:
    await test_retry_5xx_then_success()
    await test_no_retry_on_4xx()
    await test_retry_exhausted_friendly_detail()
    await test_timeout_retried_then_success()
    await test_connect_error_final_message()
    await test_upload_retries_and_returns_url()
    await test_upload_failure_friendly_detail()
    await test_upload_bad_payload_raises()
    test_extract_error_html()
    test_extract_error_json()
    test_extract_error_text_truncated()
    await test_retry_delay()
    print("\n所有 ToAPIs 客户端重试 / 文案测试通过 ✓")


if __name__ == "__main__":
    asyncio.run(main())
