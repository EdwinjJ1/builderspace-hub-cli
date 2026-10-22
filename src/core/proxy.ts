import http from "node:http";

/**
 * Proxy settings from the environment, read the way curl and Node read them.
 * Node's fetch ignores HTTP_PROXY / HTTPS_PROXY unless asked to follow them,
 * so behind a proxy (a firewall, or a VPN client listening on localhost) every
 * request went out directly and timed out while curl to the same Hub worked.
 */

export type ProxyEnv = Record<string, string | undefined>;

/**
 * Whether this process's fetch follows the proxy variables: "unsupported" on
 * a Node too old to switch it on at run time, "rejected" when Node refused the
 * values (requests then go out directly).
 */
export type ProxySupport = "active" | "unsupported" | "rejected";

/** The parts of Node that `enableEnvProxy` uses; tests pass their own. */
export interface ProxyRuntime {
  setGlobalProxyFromEnv?: (env: ProxyEnv) => unknown;
  execArgv: string[];
}

export interface ProxyRoute {
  /** The variable naming the proxy for this Hub's scheme, e.g. HTTPS_PROXY. */
  variable: string;
  /** Its value with any user name and password masked; null when none is set. */
  proxy: string | null;
  /** Node can only use an http(s) proxy given as a full URL. */
  valid: boolean;
  /** NO_PROXY names this Hub, so requests go out directly anyway. */
  bypassed: boolean;
}

const PROXY_VARIABLES = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];

const nodeRuntime: ProxyRuntime = {
  setGlobalProxyFromEnv: (http as { setGlobalProxyFromEnv?: ProxyRuntime["setGlobalProxyFromEnv"] })
    .setGlobalProxyFromEnv,
  execArgv: process.execArgv,
};

/**
 * Makes fetch follow HTTP_PROXY / HTTPS_PROXY / NO_PROXY. Node 24.14 and 25.4
 * can switch this on at run time; older ones only when started with
 * NODE_USE_ENV_PROXY=1 or --use-env-proxy. Call it before any request.
 */
export function enableEnvProxy(env: ProxyEnv, node: ProxyRuntime = nodeRuntime): ProxySupport {
  if (env.NODE_USE_ENV_PROXY === "1" || node.execArgv.includes("--use-env-proxy")) return "active";
  if (typeof node.setGlobalProxyFromEnv !== "function") return "unsupported";
  if (!PROXY_VARIABLES.some((name) => env[name])) return "active";
  try {
    node.setGlobalProxyFromEnv(env);
    return "active";
  } catch {
    // A malformed proxy URL throws here; it must not stop every command.
    return "rejected";
  }
}

/** Where requests to `hubUrl` go, by the same rules Node applies. */
export function proxyRoute(env: ProxyEnv, hubUrl: string): ProxyRoute {
  const url = new URL(hubUrl);
  const scheme = url.protocol === "https:" ? "https" : "http";
  // The lower-case variable wins when both are set; there is no fallback from
  // HTTPS_PROXY to HTTP_PROXY.
  const variable = env[`${scheme}_proxy`] ? `${scheme}_proxy` : `${scheme.toUpperCase()}_PROXY`;
  const raw = env[variable] || null;
  const noProxy = env.no_proxy ?? env.NO_PROXY ?? "";
  return {
    variable,
    proxy: raw === null ? null : maskProxy(raw),
    valid: raw !== null && isProxyUrl(raw),
    bypassed: raw !== null && matchesNoProxy(noProxy, url),
  };
}

function isProxyUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** A proxy URL for output: credentials masked, nothing else changed. */
export function maskProxy(raw: string): string {
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (url?.host) return `${url.protocol}//${url.username || url.password ? "***@" : ""}${url.host}`;
  // Not a URL with a host ("user:pass@proxy:8080" parses as a scheme); it may
  // still hold a password, so keep only what follows the last "@".
  return raw.includes("@") ? `***@${raw.slice(raw.lastIndexOf("@") + 1)}` : raw;
}

function splitPort(entry: string): { name: string; port: string | null } {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) return { name: bracketed[1] ?? "", port: bracketed[2] ?? null };
  const parts = entry.split(":");
  // More than one colon without brackets is a bare IPv6 address.
  if (parts.length === 2 && /^\d+$/.test(parts[1] ?? "")) return { name: parts[0] ?? "", port: parts[1] ?? null };
  return { name: entry, port: null };
}

/**
 * NO_PROXY in the forms Node documents: `*`, an exact host, `.example.com` or
 * `*.example.com` for subdomains, each optionally with `:port`. IP ranges are
 * not matched; this only decides what `doctor` reports.
 */
export function matchesNoProxy(list: string, url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return list
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const { name, port: entryPort } = splitPort(entry);
      if (entryPort !== null && entryPort !== port) return false;
      if (name.startsWith("*.")) return host.endsWith(name.slice(1));
      if (name.startsWith(".")) return host.endsWith(name);
      return host === name;
    });
}
