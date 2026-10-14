# 输出与错误约定

脚本和 AI Agent 依赖这份约定，改动它是**破坏性变更**。

## 成功

stdout，退出码 0（`doctor` 不健康时例外：仍输出成功信封，但退出码 1，`data.healthy` 为 `false`）。

```json
{ "ok": true, "profile": "default", "data": {}, "meta": { "count": 3, "dryRun": true } }
```

- `data`：命令的结果。
- `meta`：可选，如列表的 `count`、预演时的 `dryRun: true`。

## 失败

stderr，退出码非 0。`-f table` / `-f pretty` 时改为一行人能读的文字。

```json
{
  "ok": false,
  "profile": "default",
  "error": {
    "type": "rate_limit",
    "subtype": "too_many_requests",
    "message": "请求太频繁，被 Hub 限流了",
    "hint": "等一会儿再试；脚本里请按 retry_after_seconds 退避。",
    "status": 429,
    "retryable": true,
    "retry_after_seconds": 30
  }
}
```

| 字段 | 稳定性 | 说明 |
| --- | --- | --- |
| `ok` | 稳定 | 失败时总是 `false` |
| `error.type` | **稳定** | 下表 9 个之一 |
| `error.subtype` | **稳定** | 小写加下划线；可以按它分支 |
| `error.message` | 不稳定 | 给人看，不要解析 |
| `error.hint` | 不稳定 | 下一步怎么做，通常是一条命令 |
| `error.status` | 稳定 | 来自 Hub 的 HTTP 状态码 |
| `error.retryable` | 稳定 | 出现即为 `true` |
| `error.retry_after_seconds` | 稳定 | 被限流时建议等待的秒数 |
| `error.param` | 稳定 | 参数错误时出错的参数名 |

## 类型与退出码

| type | 退出码 | 常见 subtype |
| --- | --- | --- |
| `internal` | 1 | `unexpected` |
| `validation` | 2 | `invalid_param`、`invalid_input`、`rejected_by_hub`、`config_unreadable` |
| `authentication` | 3 | `not_configured`、`not_logged_in`、`invalid_credentials` |
| `authorization` | 4 | `forbidden`、`not_a_member` |
| `not_found` | 5 | `not_found`、`unknown_list`、`unknown_operation`、`unknown_profile` |
| `conflict` | 6 | `conflict` |
| `rate_limit` | 7 | `too_many_requests` |
| `network` | 8 | `unreachable`、`timeout` |
| `api` | 9 | `server_error`、`unexpected_status`、`unexpected_shape` |

参数解析失败（未知命令、缺少必填参数）由命令行框架报告，退出码同样是 2。

新增 `subtype` 可以；改名或删除属于破坏性变更。
