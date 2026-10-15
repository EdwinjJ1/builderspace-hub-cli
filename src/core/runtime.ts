import type { Command } from "commander";

import type { HubClient } from "./client.js";
import type { ConfigFile, ResolvedProfile } from "./config.js";
import type { Context, Format, Writer } from "./output.js";
import { createClient } from "./client.js";
import { configPath, readConfig, resolveProfile } from "./config.js";
import { CliError, exitCodeOf, toCliError, validationError } from "./errors.js";
import { formats, printError, printSuccess } from "./output.js";

/**
 * What every command runs on. Everything that touches the outside world comes
 * in through `Deps`, so tests drive the real commands with a fake fetch, a
 * temporary config directory and captured output.
 */

/** Local files, injected so tests need no disk. Defaults to Node's. */
export interface FileAccess {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

export interface Deps {
  writer: Writer;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** Reads secrets interactively; tests replace it. */
  readSecret: (prompt: string) => Promise<string>;
  readStdin: () => Promise<string>;
  isInteractive: boolean;
  files?: FileAccess;
}

export interface GlobalOptions {
  profile?: string;
  format?: string;
  url?: string;
}

export interface Runtime {
  ctx: Context;
  deps: Deps;
  configFile: string;
  config: () => Promise<ConfigFile>;
  profile: () => Promise<ResolvedProfile>;
  client: () => Promise<HubClient>;
}

function parseFormat(value: string | undefined): Format {
  if (value === undefined) return "json";
  if ((formats as readonly string[]).includes(value)) return value as Format;
  throw validationError(`--format 只支持 ${formats.join(" / ")}`, "format");
}

export function createRuntime(command: Command, deps: Deps): Runtime {
  const options = command.optsWithGlobals<GlobalOptions>();
  const configFile = configPath(deps.env);
  let format: Format = "json";
  try {
    format = parseFormat(options.format);
  } catch (error) {
    // Reported by `action` below with the default format.
    void error;
  }
  const ctx: Context = {
    format,
    profile: options.profile ?? deps.env.BSHUB_PROFILE ?? "default",
    writer: deps.writer,
  };

  let cachedConfig: ConfigFile | undefined;
  const config = async () => (cachedConfig ??= await readConfig(configFile));
  const profile = async () => {
    const resolved = resolveProfile(await config(), options, deps.env);
    ctx.profile = resolved.name;
    return resolved;
  };

  return {
    ctx,
    deps,
    configFile,
    config,
    profile,
    client: async () => {
      const resolved = await profile();
      return createClient({ url: resolved.url, apiKey: resolved.apiKey, fetch: deps.fetch });
    },
  };
}

/** The result of a command: what to print, plus optional `meta`. */
export interface Result {
  data: unknown;
  meta?: Record<string, unknown>;
  /** A non-zero exit with a success envelope, e.g. `doctor` finding problems. */
  exitCode?: number;
}

export type Handler<O> = (
  runtime: Runtime,
  args: string[],
  options: O,
) => Promise<Result>;

/**
 * Wraps a command handler: validates the global flags, runs it, prints the
 * envelope, and turns any failure into a typed error and its exit code, which
 * is left in `exit.code` for the entry point to use.
 */
export function action<O = Record<string, unknown>>(
  deps: Deps,
  exit: { code: number },
  handler: Handler<O>,
) {
  return async (...params: unknown[]) => {
    const command = params[params.length - 1] as Command;
    const runtime = createRuntime(command, deps);
    try {
      parseFormat(command.optsWithGlobals<GlobalOptions>().format);
      const result = await handler(
        runtime,
        command.args,
        command.opts<O & object>(),
      );
      printSuccess(runtime.ctx, result.data, result.meta);
      exit.code = result.exitCode ?? 0;
    } catch (error) {
      const typed = toCliError(error);
      printError(runtime.ctx, typed);
      exit.code = exitCodeOf(typed);
    }
  };
}

/** Parses a JSON flag value, with a validation error that names the flag. */
export function jsonFlag(value: string | undefined, flag: string): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw validationError(`${flag} 不是合法的 JSON`, flag.replace(/^--/, ""));
  }
}

export function requireValue<T>(value: T | undefined | null, flag: string): T {
  if (value === undefined || value === null || value === "") {
    throw validationError(`缺少 ${flag}`, flag.replace(/^--/, ""));
  }
  return value;
}

export { CliError };
