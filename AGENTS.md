# 给贡献者和 AI Agent

## 本地开发

```bash
pnpm install
pnpm check          # 类型检查 + 测试 + 构建
pnpm dev -- --help  # 不构建直接运行
```

对一个真实的 Hub 做端到端检查（会在指定看板上建一个任务再删掉）：

```bash
BSHUB_URL=http://localhost:3210 BSHUB_API_KEY=… BSHUB_SMOKE_BOARD=<看板 publicId> pnpm smoke
```

本地 Hub 怎么跑见 Hub 仓库的 `BUILDERSPACE.md`。

## 新增一条命令

1. 放进 `src/commands/` 里对应的文件，用 `action()` 包住处理函数：它负责输出信封、错误类型和退出码。
2. 出错一律抛 `CliError`，选一个已有的 `type`，`subtype` 用小写加下划线，给出 `hint`。
3. 有副作用的命令必须支持 `--dry-run`，并用 `client.describe()` 输出请求。
4. 在 `test/cli.test.ts` 里用假的 Hub 跑一遍，包括出错的情况。
5. 更新 `docs/COMMANDS.md`；如果给 Agent 用，更新 `skills/` 里对应的 SKILL.md。

## 不要做

- 不要把密钥作为命令行参数；不要在任何输出里打印完整的 key。
- 不要改 `docs/ERROR_CONTRACT.md` 里标为「稳定」的字段的含义。
- 不要提交 `.env`、配置文件或真实数据。

## PR 检查清单

- [ ] `pnpm check` 通过
- [ ] 新命令有测试，包括失败路径
- [ ] 文档和 Skills 已更新
