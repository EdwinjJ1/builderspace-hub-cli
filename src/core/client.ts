import { CliError } from "./errors.js";

/**
 * Talks to a Hub's REST API (`/api/v1`, described at `/api/v1/openapi.json`).
 * The API key goes in the `x-api-key` header and nowhere else: never in a
 * URL, never in output (a dry run shows it masked).
 */

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Which REST API a request goes to: Kan's own, or the Hub's (`/api/hub/v1`). */
export type ApiRoot = "kan" | "hub";

export interface RequestSpec {
  method: Method;
  /** Path under the root, e.g. "/workspaces". */
  path: string;
  /** Defaults to Kan's own API. The Hub's own features (documents) use "hub". */
  root?: ApiRoot;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface ClientOptions {
  url: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface HubClient {
  request<T = unknown>(spec: RequestSpec): Promise<T>;
  /** The request that would be sent, for --dry-run. Never contains the key. */
  describe(spec: RequestSpec): Record<string, unknown>;
  /** A URL that needs no key (health, OpenAPI document). */
  url(path: string): string;
}

const API_ROOTS: Record<ApiRoot, string> = { kan: "/api/v1", hub: "/api/hub/v1" };
const API_ROOT = API_ROOTS.kan;

export function apiPath(path: string, root: ApiRoot = "kan"): string {
  const prefix = API_ROOTS[root];
  const trimmed = path.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.startsWith(`${prefix}/`) ? withSlash.slice(prefix.length) : withSlash;
}

export function createClient(options: ClientOptions): HubClient {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const buildUrl = (spec: RequestSpec) => {
    const root = spec.root ?? "kan";
    const url = new URL(`${options.url}${API_ROOTS[root]}${apiPath(spec.path, root)}`);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  };

  return {
    url: (path) => `${options.url}${API_ROOT}${apiPath(path)}`,

    describe: (spec) => ({
      method: spec.method,
      url: buildUrl(spec),
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { "x-api-key": "***" } : {}),
      },
      ...(spec.body === undefined ? {} : { body: spec.body }),
    }),

    async request<T>(spec: RequestSpec): Promise<T> {
      if (!options.apiKey) {
        throw new CliError({
          type: "authentication",
          subtype: "not_logged_in",
          message: "还没有登录这个 Hub",
          hint: "运行 bshub auth login，或设置环境变量 BSHUB_API_KEY。",
        });
      }

      let response: Response;
      try {
        response = await fetcher(buildUrl(spec), {
          method: spec.method,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-api-key": options.apiKey,
          },
          body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw new CliError({
          type: "network",
          subtype: cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "unreachable",
          message: `连不上 Hub：${options.url}`,
          hint: "检查网络和地址（bshub doctor），稍后重试。",
          retryable: true,
        });
      }

      const text = await response.text();
      const body = parseJson(text);
      if (response.ok) return body as T;
      throw errorFromResponse(response, body);
    },
  };
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Maps a Hub error response to the CLI's error types. */
export function errorFromResponse(response: Response, body: unknown): CliError {
  const message =
    (typeof body === "object" && body !== null && "message" in body
      ? String((body as { message: unknown }).message)
      : null) ?? `Hub 返回了 HTTP ${response.status}`;
  const status = response.status;

  if (status === 400 || status === 422) {
    return new CliError({ type: "validation", subtype: "rejected_by_hub", message, status });
  }
  if (status === 401) {
    return new CliError({
      type: "authentication",
      subtype: "invalid_credentials",
      message,
      status,
      hint: "API key 可能已失效或被停用；在 Hub 的 设置 → API 重新创建，再运行 bshub auth login。",
    });
  }
  if (status === 403) {
    return new CliError({
      type: "authorization",
      subtype: "forbidden",
      message,
      status,
      hint: "你的账号在这个项目里没有这项权限；需要的话请项目管理员调整。",
    });
  }
  if (status === 404) {
    return new CliError({ type: "not_found", subtype: "not_found", message, status });
  }
  if (status === 409) {
    return new CliError({ type: "conflict", subtype: "conflict", message, status });
  }
  if (status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    return new CliError({
      type: "rate_limit",
      subtype: "too_many_requests",
      message: "请求太频繁，被 Hub 限流了",
      status,
      retryable: true,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      hint: "等一会儿再试；脚本里请按 retry_after_seconds 退避。",
    });
  }
  return new CliError({
    type: "api",
    subtype: status >= 500 ? "server_error" : "unexpected_status",
    message,
    status,
    retryable: status >= 500,
  });
}
