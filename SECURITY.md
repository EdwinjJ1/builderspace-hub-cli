# 安全说明

**请不要在公开的 Issue 里描述漏洞。** 通过 GitHub 的私下漏洞报告提交：仓库页面 → **Security** → **Report a vulnerability**（[直接打开](https://github.com/EdwinjJ1/builderspace-hub-cli/security/advisories/new)）。我们会在 3 个工作日内回复。

涉及 Hub 服务端的问题，请报到 [Hub 仓库](https://github.com/EdwinjJ1/builderspace-hub/security/advisories/new)。

## CLI 的安全设计

- API key 只从标准输入、隐藏输入或 `BSHUB_API_KEY` 读取，从不作为命令行参数；输出里只显示首尾几位，`--dry-run` 显示为 `***`。
- 配置文件权限 0600、目录 0700，原子写入；`bshub doctor` 会检查权限。
- 只接受 https 的 Hub 地址（本机除外），拒绝带用户名密码的地址。
- Hub 返回的文字在 table / pretty 输出前去掉终端控制序列，防止终端注入。
- 依赖只有 `commander` 一个运行时包。

## 已知限制

- key 以明文存在配置文件里（受文件权限保护）。改存系统钥匙串在路线图里。
- key 的权限等于创建它的账号，暂不支持限定范围。给自动化用时，请用专门的账号。
