import type { Command } from "commander";

import type { Deps } from "../core/runtime.js";
import { createClient } from "../core/client.js";
import { maskKey, readConfig, writeConfig } from "../core/config.js";
import { CliError, validationError } from "../core/errors.js";
import { action } from "../core/runtime.js";

interface Me {
  id?: string;
  name?: string | null;
  email?: string;
}

const describeUser = (me: Me) => ({ name: me.name ?? null, email: me.email ?? null });

/**
 * `auth`: sign in to a Hub with an API key, check who you are, sign out.
 *
 * The key is never taken as a command-line value (it would land in shell
 * history and process lists). It comes from stdin (`--api-key-stdin`), from
 * BSHUB_API_KEY, or from a hidden prompt in an interactive terminal.
 * Device-code login, as in the Lark CLI, needs a Hub endpoint that does not
 * exist yet; see docs/DESIGN.md.
 */
export function registerAuth(program: Command, deps: Deps, exit: { code: number }) {
  const auth = program.command("auth").description("登录、查看登录状态、退出");

  auth
    .command("login")
    .description("用 API key 登录当前 profile 的 Hub（key 在 Hub 的 设置 → API 创建）")
    .option("--api-key-stdin", "从标准输入读取 API key（脚本和 Agent 用）")
    .action(
      action<{ apiKeyStdin?: boolean }>(deps, exit, async (runtime, _args, options) => {
        const config = await runtime.config();
        const profile = await runtime.profile();

        let apiKey: string;
        if (options.apiKeyStdin) apiKey = (await deps.readStdin()).trim();
        else if (deps.env.BSHUB_API_KEY?.trim()) apiKey = deps.env.BSHUB_API_KEY.trim();
        else if (deps.isInteractive) apiKey = (await deps.readSecret("API key: ")).trim();
        else {
          throw validationError(
            "非交互环境里请用 --api-key-stdin 或环境变量 BSHUB_API_KEY 提供 API key",
            "api-key-stdin",
          );
        }
        if (!apiKey) throw validationError("API key 是空的", "api-key-stdin");

        // Check the key before keeping it.
        const me = await createClient({ url: profile.url, apiKey, fetch: deps.fetch }).request<Me>(
          { method: "GET", path: "/users/me" },
        );

        const fresh = await readConfig(runtime.configFile);
        fresh.profiles[profile.name] = { url: profile.url, apiKey };
        if (!config.profiles[fresh.currentProfile]) fresh.currentProfile = profile.name;
        await writeConfig(runtime.configFile, fresh);

        return {
          data: {
            profile: profile.name,
            url: profile.url,
            key: maskKey(apiKey),
            user: describeUser(me),
          },
        };
      }),
    );

  auth
    .command("status")
    .description("当前 profile 登录的是哪个账号")
    .action(
      action(deps, exit, async (runtime) => {
        const profile = await runtime.profile();
        const me = await (await runtime.client()).request<Me>({ method: "GET", path: "/users/me" });
        return {
          data: {
            profile: profile.name,
            url: profile.url,
            key: maskKey(profile.apiKey),
            keySource: profile.keySource,
            user: describeUser(me),
          },
        };
      }),
    );

  auth
    .command("logout")
    .description("从配置文件里删掉当前 profile 的 API key")
    .action(
      action(deps, exit, async (runtime) => {
        const config = await runtime.config();
        const name = (await runtime.profile()).name;
        const stored = config.profiles[name];
        if (!stored?.apiKey) {
          throw new CliError({
            type: "authentication",
            subtype: "not_logged_in",
            message: `profile ${name} 没有保存的 API key`,
          });
        }
        delete stored.apiKey;
        await writeConfig(runtime.configFile, config);
        return { data: { profile: name, loggedOut: true } };
      }),
    );

  program
    .command("whoami")
    .description("auth status 的简写")
    .action(
      action(deps, exit, async (runtime) => {
        const me = await (await runtime.client()).request<Me>({ method: "GET", path: "/users/me" });
        return { data: { profile: (await runtime.profile()).name, user: describeUser(me) } };
      }),
    );
}
