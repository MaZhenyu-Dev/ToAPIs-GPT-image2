"""一键恢复被 502 误标失败的任务（在出问题的电脑上、项目根目录运行）。

背景：
- 任务提交成功后 toapis_task_id 已落库（额度已扣），之后轮询查状态撞上
  502（base_url 配错 / 网络问题）→ 轮询器把任务误标 failed。
- ToAPIs 侧其实已出图，只需把状态翻回 in_progress，后台轮询器会自动
  拿 toapis_task_id 查回结果图片并标 completed，不重复扣费。

用法：
    .venv\\Scripts\\python.exe recover_502_tasks.py

安全条件（缺一不可）：
- status='failed'                → 只动失败任务
- error_msg LIKE '%502%'         → 只动被 502 误伤的
- toapis_task_id IS NOT NULL     → 只动提交成功的（没提交出去的本来就该重试）
- created_at = NOW()             → 避免被「5 分钟本地超时」兜底再次标失败

默认预览（dry-run）；确认无误后加 --apply 真正执行。
"""
import asyncio
import sys

from sqlalchemy import text

sys.path.insert(0, ".")


async def main() -> None:
    apply = "--apply" in sys.argv
    from backend.app.database import AsyncSessionLocal

    async with AsyncSessionLocal() as s:
        # 1) 预览命中任务
        rows = (
            await s.execute(
                text(
                    "SELECT id, batch_id, model, toapis_task_id, LEFT(error_msg, 60) "
                    "FROM generation_tasks "
                    "WHERE status='failed' AND error_msg LIKE '%502%' "
                    "AND toapis_task_id IS NOT NULL "
                    "ORDER BY id DESC"
                )
            )
        ).all()

        print(f"命中可恢复任务：{len(rows)} 条")
        for t in rows:
            print(f"  #{t[0]} | {t[1]} | {t[2]} | {t[3]}")

        # 提交阶段就被 502 挡住的任务（无 toapis_task_id）——不可恢复，需手动重试
        orphan = (
            await s.execute(
                text(
                    "SELECT COUNT(*) FROM generation_tasks "
                    "WHERE status='failed' AND error_msg LIKE '%502%' "
                    "AND toapis_task_id IS NULL"
                )
            )
        ).scalar()
        if orphan:
            print(f"\n另有 {orphan} 条 502 任务从未提交成功（toapis_task_id 为空），")
            print("这些任务 ToAPIs 侧不存在、未扣额度，请在批量详情页手动点「重试」。")

        if not rows:
            print("没有可恢复的任务，退出。")
            return

        if not apply:
            print("\n预览模式（未修改数据）。确认上面列表无误后，加 --apply 执行恢复：")
            print("    .venv\\Scripts\\python.exe recover_502_tasks.py --apply")
            return

        # 2) 执行恢复
        result = await s.execute(
            text(
                "UPDATE generation_tasks "
                "SET status='in_progress', error_msg=NULL, created_at=NOW() "
                "WHERE status='failed' AND error_msg LIKE '%502%' "
                "AND toapis_task_id IS NOT NULL"
            )
        )
        await s.commit()
        print(f"\n已恢复 {result.rowcount} 条任务为 in_progress。")
        print("后台轮询器（5 秒一轮）会自动从 ToAPIs 同步结果，稍等后刷新页面即可。")


if __name__ == "__main__":
    asyncio.run(main())
