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

- 项目 = Hub 里的一个工作区（例如 CourseMate）；职能 = 项目里的一块看板（开发 / 运营 / 营销）；任务 = 看板上的一张卡片；阶段 = 卡片所在的列。
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

## 注意

- `+move` 只会移到**同一块看板**里的列；那块看板没有目标列时返回 `not_found / unknown_list`，`hint` 里列出了可用的列。
- `--due` 是日期，按当天 23:59（运行 CLI 的机器的本地时间）保存。
- 输出任务给用户时，把 `due` 换成用户的本地时间，并显示 `assignees` 里的名字。
- 「我的任务」「即将到期」「已逾期」这些跨项目视图还没有命令（需要 Hub 新接口），暂时逐个看板用 `+list` 汇总，并告诉用户这是临时做法。
