import { Command, CommanderError } from "commander";

import type { Deps } from "./core/runtime.js";
import { registerAuth } from "./commands/auth.js";
import { registerConfig } from "./commands/config.js";
import { registerMeta } from "./commands/meta.js";
import { registerResources } from "./commands/resources.js";
import { EXIT_CODES } from "./core/errors.js";
import { formats } from "./core/output.js";

export const VERSION = "0.1.0";

/**
 * The command tree. Built fresh for every run so tests can drive it with
 * their own dependencies. Returns the process exit code.
 */
export async function runCli(argv: string[], deps: Deps): Promise<number> {
  const exit = { code: 0 };
  const program = new Command("bshub")
    .description("BuilderSpace Hub 命令行工具：给人用，也给 AI Agent 用。输出默认是 JSON。")
    .version(VERSION, "-v, --version")
    .option("--profile <name>", "使用哪个 profile（默认取配置里的当前 profile）")
    .option("-f, --format <format>", `输出格式：${formats.join(" / ")}`, "json")
    .option("--url <url>", "这一次临时改用的 Hub 地址")
    .showHelpAfterError("（运行 bshub --help 查看所有命令）")
    .configureOutput({
      writeOut: (text) => deps.writer.out(text),
      writeErr: (text) => deps.writer.err(text),
    })
    .exitOverride();

  registerConfig(program, deps, exit);
  registerAuth(program, deps, exit);
  registerMeta(program, deps, exit);
  registerResources(program, deps, exit);

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version exit 0; anything else is a usage error.
      return error.exitCode === 0 ? 0 : EXIT_CODES.validation;
    }
    throw error;
  }
  return exit.code;
}
