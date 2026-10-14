import type { Command } from "commander";

import type { Deps } from "../core/runtime.js";
import { isConfigExposed, maskKey, normalizeUrl, writeConfig } from "../core/config.js";
import { CliError } from "../core/errors.js";
import { action, requireValue } from "../core/runtime.js";

/** `config`: which Hubs this machine knows (profiles) and which one is current. */
export function registerConfig(program: Command, deps: Deps, exit: { code: number }) {
  const config = program.command("config").description("Hub 地址和 profile");

  config
    .command("init")
    .description("设置一个 profile 的 Hub 地址，并设为当前 profile")
    .requiredOption("--hub <url>", "Hub 地址，例如 https://hub.example.com")
    .action(
      action<{ hub: string }>(deps, exit, async (runtime, _args, options) => {
        const file = await runtime.config();
        const name = program.opts<{ profile?: string }>().profile ?? deps.env.BSHUB_PROFILE ?? file.currentProfile;
        const url = normalizeUrl(requireValue(options.hub, "--hub"));
        const previous = file.profiles[name];
        // Keep the key only when the profile still points at the same Hub.
        file.profiles[name] = previous?.url === url ? { ...previous, url } : { url };
        file.currentProfile = name;
        await writeConfig(runtime.configFile, file);
        runtime.ctx.profile = name;
        return {
          data: {
            profile: name,
            url,
            loggedIn: Boolean(file.profiles[name]?.apiKey),
            next: file.profiles[name]?.apiKey ? null : "bshub auth login",
          },
        };
      }),
    );

  config
    .command("show")
    .description("所有 profile（API key 只显示首尾）")
    .action(
      action(deps, exit, async (runtime) => {
        const file = await runtime.config();
        return {
          data: {
            file: runtime.configFile,
            exposed: await isConfigExposed(runtime.configFile),
            currentProfile: file.currentProfile,
            profiles: Object.entries(file.profiles).map(([name, profile]) => ({
              name,
              url: profile.url,
              key: maskKey(profile.apiKey),
              current: name === file.currentProfile,
            })),
          },
        };
      }),
    );

  config
    .command("use")
    .description("切换当前 profile")
    .argument("<profile>", "profile 名")
    .action(
      action(deps, exit, async (runtime, args) => {
        const name = requireValue(args[0], "<profile>");
        const file = await runtime.config();
        if (!file.profiles[name]) {
          throw new CliError({
            type: "not_found",
            subtype: "unknown_profile",
            message: `没有叫 ${name} 的 profile`,
            hint: "bshub config show 看看有哪些；新建用 bshub --profile <名字> config init --hub <地址>。",
          });
        }
        file.currentProfile = name;
        await writeConfig(runtime.configFile, file);
        runtime.ctx.profile = name;
        return { data: { currentProfile: name } };
      }),
    );
}
