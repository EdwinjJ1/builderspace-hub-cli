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
| `project get <id>` | 项目详情和成员 | 🔜 |
| `board list --project <id>` | 项目里的看板和列 | ✅ |
| `board get <id>` | 看板的列和每列任务数 | ✅ |
| `board +overall --project <id>` | 总版：开发 / 运营 / 营销的全部任务 | 🔜 需要 Hub 接口 |

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
| `task +mine` / `+due-soon` / `+overdue` | 跨项目的我的任务、即将到期、已逾期 | 🔜 需要 Hub 接口 |
| `task +assign <id> --member` / `+unassign` | 指派 | 🔜 |
| `task +label <id> --label` | 标签 | 🔜 |
| `task +checklist …` | 检查清单 | 🗓 |
| `task +run <id> --agent claude\|codex` | 把任务交给本机的 Claude Code / Codex（[AI_CHANNEL.md](AI_CHANNEL.md)） | 🗓 |

## 文档库

文档走 Hub 自己的接口 `/api/hub/v1/documents`，约定见 [HUB_DOCUMENTS_API.md](HUB_DOCUMENTS_API.md)。

| 命令 | 说明 | 状态 |
| --- | --- | --- |
| `doc list [--folder] [--search]` | 一个文件夹的内容（不指定是最上层），或搜索 | ✅ |
| `doc get <id>` / `doc cat <id>` | 详情 / 文本文档的内容 | ✅ |
| `doc +create --title [--file \| --text \| --stdin] [--filename] [--folder] [--private]` | 新建。md / txt / csv / json / html 直接发文本；PDF、PPT 等先上传再完成 | ✅ |
| `doc +update <id> [--title] [--description] [--folder] [--private\|--public] [--file \| --text \| --stdin]` | 改信息、可读性，或换掉文本内容 | ✅ |
| `doc +download <id> --out <path>` | 下载到本地 | ✅ |
| `doc folder +create --name [--parent]` | 新建文件夹 | ✅ |
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
| `mcp serve` | 以 MCP 服务器的形式暴露命令 | 🗓 |
| `event +watch` | 订阅任务事件 | 🗓 |
| `skill list/show` | 查看内置 Agent Skills | 🗓 |
