# 命令一览

✅ 已实现 · 🔜 下一版（v0.2）· 🗓 计划中。每条命令都支持全局参数 `--profile`、`-f/--format`、`--url`。所有写操作支持 `--dry-run`。

## 配置与登录

| 命令 | 说明 | 状态 |
| --- | --- | --- |
| `config init --hub <url>` | 设置当前 profile 的 Hub 地址 | ✅ |
| `config show` | 列出所有 profile（key 只显示首尾） | ✅ |
| `config use <profile>` | 切换当前 profile | ✅ |
| `auth login [--api-key-stdin]` | 用 API key 登录（隐藏输入 / 标准输入 / `BSHUB_API_KEY`） | ✅ |
| `auth login --no-wait` / `--device-code` | 设备码登录，Agent 友好 | 🗓 |
| `auth status` / `whoami` | 当前账号 | ✅ |
| `auth logout` | 删除保存的 key | ✅ |
| `auth check <scope>` | 检查 key 是否有某项权限 | 🗓 |

## 工具

| 命令 | 说明 | 状态 |
| --- | --- | --- |
| `doctor` | 检查 Node、配置文件权限、Hub 可达、登录有效；不健康时退出码 1 | ✅ |
| `schema [operation]` | 列出接口；查看某个接口的参数和请求体 | ✅ |
| `api <METHOD> <path> [--params] [--data]` | 原始 API 调用 | ✅ |
| `completion <shell>` | shell 补全 | 🔜 |
| `update` | 检查新版本 | 🗓 |

## 项目与看板

| 命令 | 说明 | 状态 |
| --- | --- | --- |
| `project list` | 我加入的项目 | ✅ |
| `project get <id>` | 项目详情和成员 | ✅ |
| `board list --project <id>` | 项目里的看板和列 | ✅ |
| `board get <id>` | 看板的列和每列任务数 | ✅ |
| `board +audience <id> [--to members\|admins\|owner]` | 看或设置看板的可见范围：所有成员 / 仅管理员可见 / 仅自己可见。走 Hub 自己的 `/api/hub/v1/boards/{id}/audience`，规则和看板页一样 | ✅ |
| `board +overall --project <id> [--stage]` | 总版：技术 / 活动 / 运营的全部任务。在客户端逐块看板汇总，不需要新接口 | ✅ |
| `label list --board <id>` | 看板上的标签 | ✅ |

## 任务

| 命令 | 说明 | 状态 |
| --- | --- | --- |
| `task +list --board <id> [--stage]` | 一块看板的任务 | ✅ |
| `task +get <id>` | 任务详情 | ✅ |
| `task +create --board --title [--stage] [--due] [--description] [--assign-me]` | 新建 | ✅ |
| `task +move <id> --to <阶段/列>` | 换列，按阶段名、列名或列 id | ✅ |
| `task +due <id> --date YYYY-MM-DD \| --clear` | 截止日期 | ✅ |
| `task +comment <id> --text` | 评论 | ✅ |
| `task +search --project --query` | 搜索 | ✅ |
| `task +mine [--project] [--include-done]` | 跨项目的我的任务，按截止日期排序 | ✅ |
| `task +due-soon [--days 7] [--project] [--all]` | 快到期的 | ✅ |
| `task +overdue [--project] [--all]` | 已逾期且没完成的 | ✅ |
| `task +update <id> [--title] [--description]` | 改标题或说明 | ✅ |
| `task +delete <id> --yes` | 删除（不可撤销，必须带 `--yes`） | ✅ |
| `task +assign <id> --member <邮箱\|名字\|me>` / `+unassign` | 指派 / 取消指派；已经是目标状态时什么也不做 | ✅ |
| `task +activity <id>` | 变更记录 | ✅ |
| `task +label <id> --label <名字> [--remove]` | 加 / 去掉标签 | ✅ |
| `task +checklist <id> --name [--item …]` | 新建检查清单和条目 | ✅ |
| `task +check <itemId> [--undo]` | 勾选 / 取消勾选条目 | ✅ |
| `task +import --board --file tasks.json [--dry-run]` | 从 JSON 批量新建任务；先整体检查，再逐个新建，中途失败会说从哪一项补 | ✅ |
| `task +run <id> --agent claude\|codex` | 把任务交给本机的 Claude Code / Codex（[AI_CHANNEL.md](AI_CHANNEL.md)） | 🗓 |

## 数据

| 命令 | 说明 | 状态 |
| --- | --- | --- |
| `export --project <id> [--out file]` | 导出一个项目的看板、列、任务（含标签、指派人、截止日期），备份用 | ✅ |

## 文档库

文档走 Hub 自己的接口 `/api/hub/v1/documents`，约定见 [HUB_DOCUMENTS_API.md](HUB_DOCUMENTS_API.md)。

| 命令 | 说明 | 状态 |
| --- | --- | --- |
| `doc list [--folder] [--search]` | 一个文件夹的内容（不指定是最上层），或搜索 | ✅ |
| `doc get <id>` / `doc cat <id>` | 详情 / 文档的内容和 `updatedAt` | ✅ |
| `doc +create --title [--file \| --text \| --stdin] [--filename] [--folder] [--private]` | 新建 Markdown 或 HTML 文档（只收 .md / .html，内容作为文本发送）。Word 请在网页「上传文件」里传 | ✅ |
| `doc +update <id> [--title] [--description] [--folder] [--private\|--public] [--file \| --text \| --stdin] [--if-unmodified-since <updatedAt>]` | 改信息、可读性，或换掉文本内容。设为不可读会先于写入新文本；`--if-unmodified-since` 防止覆盖别人的修改（不能和改信息一起用） | ✅ |
| `doc +download <id> --out <path>` | 把文档内容存成本地文件（读 `/content`） | ✅ |
| `doc folder +create --name [--parent]` | 新建文件夹 | ✅ |
| `doc +share <id> (--everyone \| --editors-only \| [--reader <名字或 userId>]… [--project <项目>]… [--department <项目/部门>]…)` | 设置谁能看，和网页的「谁能看」一样：所有成员、指定的人、只有编辑者。指定的人可以是人、整个项目或项目里的部门；Hub 返回的可见范围和要的不一样就报 `audience_not_applied` | ✅ |
| `doc audience-options` | 能指定的人（带 userId）、项目和部门 | ✅ |
| 删除文档、分配编辑权限 | **只能在网页里做。** API key 还没有权限范围，key 泄露时不能删文件或转让编辑权，所以刻意不开放，等带范围的 key（v0.3）再说 | — |

## 后台（需要后台角色）

| 命令 | 说明 | 状态 |
| --- | --- | --- |
| `admin account list/create/reset-password/suspend/restore` | 账号 | 🗓 需要 Hub 接口 |
| `admin grant issue/revoke/list` | 注册链接 | 🗓 |
| `admin permission get/set` | 项目权限 | 🗓 |
| `admin audit list` | 操作日志 | 🗓 |

## AI 通道

| 命令 | 说明 | 状态 |
| --- | --- | --- |
| `mcp serve [--read-only]` | 以 MCP 服务器的形式暴露常用命令，见 [MCP.md](MCP.md) | ✅ |
| `event +watch` | 订阅任务事件 | 🗓 |
| `skill list/show` | 查看内置 Agent Skills | 🗓 |
