---
name: bshub-task
version: 0.1.0
description: "BuilderSpace Hub 的任务：查看看板上的任务、新建任务、把任务移到另一列（待办 / 进行中 / 待验收 / 已完成）、设置截止日期、评论、搜索。用户要管理 Hub 里的任务、看进度、分派工作时使用。"
metadata:
  requires:
    bins: ["bshub"]
  cliHelp: "bshub task --help"
---

# bshub 任务

**开始前必须先读 [`../bshub-shared/SKILL.md`](../bshub-shared/SKILL.md)。**

## 概念

- 项目 = Hub 里的一个工作区（例如 CourseMate）；职能 = 项目里的一块看板（技术 / 活动 / 运营）；任务 = 看板上的一张卡片；阶段 = 卡片所在的列。
- 阶段可以用中文或英文：待办 / todo、进行中 / doing、待验收 / review、已完成 / done。
- 所有 id 都是 12 位的 `publicId`。先用 `project list` → `board list --project` 找到看板 id。

## 命令

| 意图 | 命令 |
| --- | --- |
| 我在哪些项目里 | `bshub project list` |
| 项目里有哪些看板 | `bshub board list --project <项目id>` |
| 看板上的任务（可按阶段） | `bshub task +list --board <看板id> [--stage 待办]` |
| 任务详情 | `bshub task +get <任务id>` |
| 新建任务 | `bshub task +create --board <看板id> --title "…" [--stage 待办] [--due YYYY-MM-DD] [--description "…"] [--assign-me]` |
| 换列 | `bshub task +move <任务id> --to 进行中` |
| 截止日期 | `bshub task +due <任务id> --date YYYY-MM-DD`，清除用 `--clear` |
| 评论 | `bshub task +comment <任务id> --text "…"` |
| 搜索 | `bshub task +search --project <项目id> --query "…"` |
| 我的任务（跨项目） | `bshub task +mine [--project <id>] [--include-done]` |
| 快到期 / 已逾期 | `bshub task +due-soon [--days 7] [--all]`，`bshub task +overdue [--all]` |
| 总版 | `bshub board +overall --project <项目id>` |
| 改标题或说明 | `bshub task +update <任务id> --title "…" --description "…"` |
| 指派 / 取消 | `bshub task +assign <任务id> --member <邮箱\|名字\|me>`，`+unassign` |
| 标签 | `bshub label list --board <看板id>`，`bshub task +label <任务id> --label <名字> [--remove]` |
| 检查清单 | `bshub task +checklist <任务id> --name "…" --item "…"`，`bshub task +check <条目id> [--undo]` |
| 批量新建 | `bshub task +import --board <看板id> --file tasks.json --dry-run`，确认后去掉 `--dry-run` |
| 备份一个项目 | `bshub export --project <项目id> --out backup.json` |
| 删除 | `bshub task +delete <任务id> --yes`（不可撤销，先向用户确认） |

## 注意

- `+move` 只会移到**同一块看板**里的列；那块看板没有目标列时返回 `not_found / unknown_list`，`hint` 里列出了可用的列。
- `--due` 是日期，按当天 23:59（运行 CLI 的机器的本地时间）保存。
- 输出任务给用户时，把 `due` 换成用户的本地时间，并显示 `assignees` 里的名字。
- `+mine`、`+due-soon`、`+overdue`、`board +overall` 是在客户端逐块看板汇总的，项目多时会多发几个请求，属正常。
- 指派和标签在 Kan 里只有「切换」接口；CLI 会先看当前状态，已经是目标状态就什么也不做（`changed: false`）。
- 删除任务不可撤销：必须用户明确要求，并带 `--yes`。
