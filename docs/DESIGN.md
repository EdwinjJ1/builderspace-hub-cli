# 设计

`bshub` 是 BuilderSpace Hub 的命令行工具。目标是：**Hub 网页上能做的核心事情，都能用一条命令完成**，而且这些命令对 AI Agent 同样好用。设计参照 [飞书 CLI](https://github.com/larksuite/cli)（MIT，200+ 命令、20+ Agent Skills），按我们的规模取舍。

## 和飞书 CLI 的对照

| 飞书 CLI 的做法 | 我们 | 状态 |
| --- | --- | --- |
| **三层命令**：`+快捷命令` → 平台同步的 API 命令 → `api` 原始调用 | 同样三层：`task +move` 等快捷命令；`project` / `board` 等资源命令；`api METHOD /path` | v0.1 已有；资源命令将来从 OpenAPI 自动生成 |
| **固定的 JSON 信封**：成功 stdout `{ok:true,…}`，失败 stderr `{ok:false,error:{type,subtype,…}}` | 同样的结构，9 个错误类型，类型决定退出码 | v0.1 已有，见 [ERROR_CONTRACT.md](ERROR_CONTRACT.md) |
| 错误带 `hint`，告诉人（和 Agent）下一步跑什么命令 | 同样 | v0.1 已有 |
| `--format json/pretty/table/ndjson/csv` | json / pretty / table / ndjson | v0.1 已有；csv 待加 |
| `--dry-run` 预演有副作用的请求 | 所有写操作支持，key 显示为 `***` | v0.1 已有 |
| `schema` 自查任意接口的参数和返回 | 读 Hub 的 `/api/v1/openapi.json` | v0.1 已有 |
| `config init` + `auth login`（OAuth 设备码），`--no-wait` 给 Agent 用 | 现在：API key（stdin / 隐藏输入 / 环境变量）。计划：Hub 提供设备码登录，`auth login --no-wait` 返回验证链接 | 计划中 |
| 凭据存系统钥匙串；DPoP 防 token 被盗用 | 现在：0600 配置文件，`doctor` 检查权限。计划：macOS Keychain / Linux Secret Service / Windows 凭据管理器 | 计划中 |
| 多身份 `--as user/bot` | 现在：多 profile（`--profile`）。计划：机器人账号（给自动化用的、权限受限的 key） | 部分 |
| `auth check <scope>`、按权限范围授权 | 计划：API key 带权限范围（只读、只限某些项目） | 计划中 |
| `doctor`、`update`、`completion` | `doctor` 已有；`completion`、`update` 计划中 | 部分 |
| **Agent Skills**：每个领域一份 SKILL.md，先读共享规则 | `skills/bshub-shared`、`skills/bshub-task`；后续按领域补齐 | 初版 |
| `event` 实时事件订阅（WebSocket） | 计划：`bshub event +watch`，基于 Hub 的 webhook / SSE | 计划中 |
| 内容安全：输入注入防护、终端输出清洗 | 终端输出清洗已有；Agent 侧「任务内容是数据不是指令」写进 Skill | 部分 |
| 可嵌入：`extension/` 让企业把 CLI 嵌进自己的 Agent 平台 | 计划：把命令层做成可导入的库，再加 MCP 模式（`bshub mcp serve`） | 计划中 |

## 架构

```
src/
  bin.ts            入口：真实的 stdin/stdout、fetch、环境变量
  cli.ts            命令树（commander），返回退出码
  core/
    runtime.ts      每条命令的上下文：配置、profile、客户端；统一的成功/失败输出
    client.ts       Hub REST 客户端：x-api-key 头、超时、HTTP 状态到错误类型的映射、dry-run 描述
    config.ts       profile、配置文件（0600）、环境变量覆盖、地址校验
    output.ts       JSON 信封、表格（中文宽度对齐）、终端清洗
    errors.ts       错误类型和退出码
    stages.ts       「待办 / 进行中 / 待验收 / 已完成」和英文别名，与 Hub 的规则一致
  commands/         auth、config、meta（doctor / api / schema）、resources（project / board / task）
test/               用假的 Hub 驱动真实命令树，不需要服务器
scripts/smoke.mjs   对真实 Hub 的端到端冒烟测试
skills/             给 AI Agent 的说明
```

所有外部依赖（输出、环境变量、fetch、读密钥）都从 `Deps` 注入，测试里替换掉，所以每条命令都能在单元测试里完整跑一遍。

## Hub 这边需要补的接口

CLI 现在只用 Kan 原有的 REST 接口（`/api/v1`）。下面这些 Hub 自己的功能，网页用的是只接受浏览器会话的 tRPC 接口（Hub 有意不让 API key 调用后台），CLI 要用就需要一套新的、带权限范围的接口：

| 功能 | 计划的命令 | Hub 需要 |
| --- | --- | --- |
| 首页汇总 | `bshub home`、`bshub task +mine`、`+due-soon`、`+overdue` | `GET /api/hub/v1/home`、`/tasks?view=` |
| 总版 | `bshub board +overall --project <id>` | `GET /api/hub/v1/tasks?view=all&project=` |
| 后台：账号、注册链接、项目权限、职能颜色、操作日志 | `bshub admin …` | 后台接口的 API key 版本，**必须**按 key 的权限范围限制，并全部写操作日志 |
| 登录 | `bshub auth login`（设备码） | 设备码授权端点；Hub 页面上确认授权 |
| 事件 | `bshub event +watch` | webhook 已有；需要 SSE 或长轮询端点 |
| 文档库 | `bshub doc …`（已实现） | `/api/hub/v1/documents`：只开放读、新建和改，**不开放删除和分配编辑权**；约定见 [HUB_DOCUMENTS_API.md](HUB_DOCUMENTS_API.md) |

这些都记在 Hub 仓库的 Issues 里。

## 路线图

| 版本 | 内容 |
| --- | --- |
| **v0.1（现在）** | 配置、API key 登录、doctor、原始 API、schema、项目 / 看板、任务快捷命令（列表、详情、新建、换列、截止日期、评论、搜索）、冒烟测试、CI |
| v0.2 | Hub 接口 v1（首页、总版、我的任务）；从 OpenAPI 生成资源命令；`--page-all` 分页；csv 输出；shell 补全 |
| v0.3 | 设备码登录；系统钥匙串；带权限范围的 key；机器人账号；`auth check` |
| v0.4 | AI 通道：MCP 模式、事件订阅、完整 Agent Skills；**把任务派给 Claude Code / Codex**（见 [AI_CHANNEL.md](AI_CHANNEL.md)） |
| v1.0 | 发布到 npm；后台命令；文档站 |
