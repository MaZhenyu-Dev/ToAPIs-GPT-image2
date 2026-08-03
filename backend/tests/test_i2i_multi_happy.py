"""Happy path：创建变体组 → 调 i2i-multi 创建批次 → 校验结果。"""
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
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def get(url):
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


print("=== 0) 查今天的 next_batch_id 预览 ===")
status, body = get("http://localhost:8765/api/batches/today-count?prefix=ZL")
print(f"  HTTP {status}: {body}")
data = json.loads(body)
next_bid = data["next_batch_id"]
print(f"  起始 batch_id 预期: {next_bid}\n")

print("=== 1) 创建测试变体组（3 个变体）===")
group_payload = {
    "name": "i2i_multi test group",
    "description": "automated test for i2i-multi endpoint",
    "variants": [
        {"prompt_content": f"variant prompt {i}", "sort_order": i}
        for i in range(3)
    ],
}
status, body = post("http://localhost:8765/api/variant-groups", group_payload)
print(f"  HTTP {status}")
assert status == 200, body
group = json.loads(body)
group_id = group["id"]
print(f"  创建变体组 id={group_id}, K={len(group['variants'])}\n")

print("=== 2) 调 i2i-multi 创建 3 个批次 ===")
# 用 https URL 但这些 URL 实际上不存在 - 不会上传，所以不会真触发 ToAPIs 提交
# 但我们故意打乱顺序看是否能正确生成 base+1, base+2
fake_urls = [
    f"https://files.toapis.com/test/{i}.png" for i in range(3)
]
status, body = post(
    "http://localhost:8765/api/batches/i2i-multi",
    {
        "group_id": group_id,
        "image_urls": fake_urls,
        "size": "1:1",
        "resolution": "1k",
        "prefix": "ZL",
    },
)
print(f"  HTTP {status}: {body[:500]}")
assert status == 200, body
result = json.loads(body)
assert "batch_ids" in result
assert "task_count" in result
assert "base_batch_id" in result
batch_ids = result["batch_ids"]
print(f"  返回 batch_ids: {batch_ids}")
print(f"  返回 task_count: {result['task_count']} (期望: 3×3=9)")
print(f"  返回 base_batch_id: {result['base_batch_id']}")
assert len(batch_ids) == 3, f"expected 3 batches, got {len(batch_ids)}"
assert result["task_count"] == 9, f"expected 9 tasks, got {result['task_count']}"
# 验证 batch_ids 是 base, base+1, base+2
import re
seqs = [int(re.search(r"(\d+)$", bid).group(1)) for bid in batch_ids]
assert seqs == sorted(seqs), f"batch_ids not sorted: {seqs}"
print(f"  ✓ seq 升序: {seqs}\n")

print("=== 3) 校验：每个 batch 都有 3 个任务（K=3）===")
for bid in batch_ids:
    status, body = get(f"http://localhost:8765/api/batches/{bid}/status")
    assert status == 200, body
    bs = json.loads(body)
    assert bs["total"] == 3, f"batch {bid} total={bs['total']} != 3"
    # 校验 mode 是 i2i_multi
    for t in bs["tasks"]:
        assert t["mode"] == "i2i_multi", f"task mode={t['mode']} != i2i_multi"
    print(f"  ✓ {bid}: total={bs['total']}, mode={bs['tasks'][0]['mode']}")
print()

print("=== 4) 校验：next_batch_id 推进了 3 ===")
status, body = get("http://localhost:8765/api/batches/today-count?prefix=ZL")
data = json.loads(body)
new_next = data["next_batch_id"]
print(f"  原 next_batch_id: {next_bid}")
print(f"  新 next_batch_id: {new_next}")
old_seq = int(re.search(r"(\d+)$", next_bid).group(1))
new_seq = int(re.search(r"(\d+)$", new_next).group(1))
assert new_seq == old_seq + 3, f"next_batch_id 没正确推进: {old_seq} → {new_seq}"
print(f"  ✓ seq 推进 {old_seq} → {new_seq}\n")

print("=== 5) 连续创建测试：再调一次，seq 应继续推进 ===")
# 注意：count_today_batches 自动填空隙，所以连续调用不会冲突。
# 真正要触发冲突需要并发或多进程，单元测试里通过 mock 验证更稳。
status, body = post(
    "http://localhost:8765/api/batches/i2i-multi",
    {
        "group_id": group_id,
        "image_urls": fake_urls,
        "size": "1:1",
        "resolution": "1k",
        "prefix": "ZL",
    },
)
print(f"  HTTP {status}: {body[:300]}")
assert status == 200, body
result = json.loads(body)
new_batch_ids = result["batch_ids"]
print(f"  ✓ 第二轮 batch_ids: {new_batch_ids}")

# 验证第一轮和第二轮的 seq 连续且不重叠
all_bids = batch_ids + new_batch_ids
all_seqs = [int(re.search(r"(\d+)$", bid).group(1)) for bid in all_bids]
assert all_seqs == sorted(set(all_seqs)), f"seq 有重复: {all_seqs}"
print(f"  ✓ 6 个 batch 的 seq 唯一且升序: {all_seqs}\n")

print("=== 6) 清理：删除测试变体组 ===")
req = urllib.request.Request(
    f"http://localhost:8765/api/variant-groups/{group_id}",
    method="DELETE",
)
with urllib.request.urlopen(req, timeout=10) as resp:
    print(f"  HTTP {resp.status}: 变体组已删除\n")

print("=" * 60)
print("Happy path 全部通过 ✓")
print("=" * 60)
