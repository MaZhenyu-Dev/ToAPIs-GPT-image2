"""通过 HTTP 真实调用 i2i-multi 端点（仅测试参数校验层，不连真实 DB）。"""
import sys
sys.path.insert(0, r"c:\Users\Admin\Desktop\GPT2")

import json
import urllib.request
import urllib.error


def post(url, data):
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


print("=== 测 1：缺少 group_id（应 422 拒绝）===")
status, body = post(
    "http://localhost:8765/api/batches/i2i-multi",
    {"image_urls": ["https://x.com/a.png"]},
)
print(f"  HTTP {status}: {body[:200]}")
assert status == 422, f"expected 422, got {status}"
assert "group_id" in body
print("  ✓ OK\n")

print("=== 测 2：group_id=99999（变体组不存在，应 400）===")
status, body = post(
    "http://localhost:8765/api/batches/i2i-multi",
    {
        "group_id": 99999,
        "image_urls": ["https://x.com/a.png", "https://x.com/b.png"],
    },
)
print(f"  HTTP {status}: {body[:200]}")
assert status == 400, f"expected 400, got {status}"
assert "不存在" in body
print("  ✓ OK\n")

print("=== 测 3：image_urls=[]（空数组，应 422）===")
status, body = post(
    "http://localhost:8765/api/batches/i2i-multi",
    {"group_id": 1, "image_urls": []},
)
print(f"  HTTP {status}: {body[:200]}")
assert status == 422, f"expected 422, got {status}"
print("  ✓ OK\n")

print("=== 测 4：image_urls 含 51 个（超上限，应 422）===")
status, body = post(
    "http://localhost:8765/api/batches/i2i-multi",
    {
        "group_id": 1,
        "image_urls": [f"https://x.com/{i}.png" for i in range(51)],
    },
)
print(f"  HTTP {status}: {body[:200]}")
assert status == 422, f"expected 422, got {status}"
print("  ✓ OK\n")

print("=== 测 5：prefix 非法（应 422）===")
status, body = post(
    "http://localhost:8765/api/batches/i2i-multi",
    {
        "group_id": 1,
        "image_urls": ["https://x.com/a.png"],
        "prefix": "abc-def",
    },
)
print(f"  HTTP {status}: {body[:200]}")
assert status == 422, f"expected 422, got {status}"
print("  ✓ OK\n")

print("=== 测 6：URL 含逗号（应 422）===")
status, body = post(
    "http://localhost:8765/api/batches/i2i-multi",
    {
        "group_id": 1,
        "image_urls": ["https://x.com/a,b.png"],
    },
)
print(f"  HTTP {status}: {body[:200]}")
assert status == 422, f"expected 422, got {status}"
print("  ✓ OK\n")

print("所有 HTTP 校验测试通过 ✓")
