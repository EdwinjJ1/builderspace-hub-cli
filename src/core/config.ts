import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CliError, validationError } from "./errors.js";

/**
 * Where the CLI keeps its settings: one file, readable by its owner only.
 *
 * A profile is one Hub to talk to (its URL) and how to sign in to it (an API
 * key, for now). Several profiles let one person keep, say, a production and
 * a local Hub side by side. Environment variables override the file, which is
 * how CI and agents are expected to pass credentials.
 *
 * The API key sits in this file in plain text, protected by file permissions
 * (0600 in a 0700 directory). Moving it into the OS keychain is planned; see
 * docs/DESIGN.md.
 */

export interface Profile {
  url: string;
  apiKey?: string;
}

export interface ConfigFile {
  currentProfile: string;
  profiles: Record<string, Profile>;
}

export const ENV = {
  url: "BSHUB_URL",
  apiKey: "BSHUB_API_KEY",
  profile: "BSHUB_PROFILE",
  configDir: "BSHUB_CONFIG_DIR",
} as const;

type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env): string {
  const dir =
    env[ENV.configDir] ??
    join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "bshub");
  return join(dir, "config.json");
}

const empty = (): ConfigFile => ({ currentProfile: "default", profiles: {} });

export async function readConfig(path: string): Promise<ConfigFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return empty();
  }
  try {
    const parsed = JSON.parse(text) as Partial<ConfigFile>;
    return {
      currentProfile: parsed.currentProfile ?? "default",
      profiles: parsed.profiles ?? {},
    };
  } catch {
    throw new CliError({
      type: "validation",
      subtype: "config_unreadable",
      message: `配置文件不是合法的 JSON：${path}`,
      hint: "修好或删掉这个文件，然后运行 bshub config init。",
    });
  }
}

/** Writes atomically, owner-only. */
export async function writeConfig(path: string, config: ConfigFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

/** True when the config file can be read by anyone but its owner. */
export async function isConfigExposed(path: string): Promise<boolean> {
  try {
    return ((await stat(path)).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A Hub URL as an origin. https is required except on this machine; a URL
 * carrying a user name or password is refused, since it would end up in
 * shell history and logs.
 */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw validationError(`不是合法的地址：${raw}`, "url");
  }
  if (url.username || url.password) {
    throw validationError("地址里不要带用户名或密码", "url");
  }
  const local = LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw validationError(
      "Hub 地址必须用 https（本机的 localhost 除外）",
      "url",
    );
  }
  return url.origin;
}

export interface ResolvedProfile {
  name: string;
  url: string;
  apiKey?: string;
  /** Where the key came from, for `auth status` and `doctor`. */
  keySource: "env" | "config" | "none";
}

/**
 * The profile a command runs with: --profile, then BSHUB_PROFILE, then the
 * file's current profile. BSHUB_URL and BSHUB_API_KEY override its values.
 */
export function resolveProfile(
  config: ConfigFile,
  options: { profile?: string; url?: string },
  env: Env = process.env,
): ResolvedProfile {
  const name = options.profile ?? env[ENV.profile] ?? config.currentProfile;
  const stored = config.profiles[name];
  const rawUrl = options.url ?? env[ENV.url] ?? stored?.url;
  if (!rawUrl) {
    throw new CliError({
      type: "authentication",
      subtype: "not_configured",
      message: `还没有配置 Hub 地址（profile：${name}）`,
      hint: "运行 bshub config init --url https://你的-hub-地址，或设置环境变量 BSHUB_URL。",
    });
  }
  const envKey = env[ENV.apiKey]?.trim();
  return {
    name,
    url: normalizeUrl(rawUrl),
    apiKey: envKey || stored?.apiKey,
    keySource: envKey ? "env" : stored?.apiKey ? "config" : "none",
  };
}

/** "kan_…wxyz": enough to recognise a key, never enough to use it. */
export function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  return key.length <= 12 ? "***" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
