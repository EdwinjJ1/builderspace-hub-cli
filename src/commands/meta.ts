import type { Command } from "commander";

import type { Method } from "../core/client.js";
import type { Deps } from "../core/runtime.js";
import { apiPath } from "../core/client.js";
import { isConfigExposed } from "../core/config.js";
import { CliError, toCliError, validationError } from "../core/errors.js";
import { action, jsonFlag } from "../core/runtime.js";

const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: unknown;
}

type OpenApiDocument = { paths?: Record<string, Record<string, OpenApiOperation>> };

/**
 * The commands about the CLI and the Hub themselves: `doctor` (is everything
 * set up), `api` (call any endpoint, the raw layer), `schema` (what endpoints
 * exist and what they take, read from the Hub's OpenAPI document).
 */
export function registerMeta(program: Command, deps: Deps, exit: { code: number }) {
  program
    .command("doctor")
    .description("检查 Node、配置、Hub 是否可达、登录是否有效；全部通过才返回 0")
    .action(
      action(deps, exit, async (runtime) => {
        const checks: Check[] = [];
        const major = Number(process.versions.node.split(".")[0]);
        checks.push({ name: "node", ok: major >= 20, detail: `Node ${process.versions.node}（需要 20 以上）` });

        const exposed = await isConfigExposed(runtime.configFile);
        checks.push({
          name: "config_permissions",
          ok: !exposed,
          detail: exposed ? `${runtime.configFile} 其他人可读，运行 chmod 600` : runtime.configFile,
        });

        try {
          const profile = await runtime.profile();
          checks.push({ name: "profile", ok: true, detail: `${profile.name} → ${profile.url}` });

          const client = await runtime.client();
          try {
            const response = await deps.fetch(client.url("/health"), { signal: AbortSignal.timeout(15_000) });
            const body = (await response.json().catch(() => null)) as { status?: string; database?: string } | null;
            checks.push({
              name: "hub_reachable",
              ok: response.ok && body?.database !== "error",
              detail: response.ok ? `状态 ${body?.status ?? "?"}，数据库 ${body?.database ?? "?"}` : `HTTP ${response.status}`,
            });
          } catch {
            checks.push({ name: "hub_reachable", ok: false, detail: `连不上 ${profile.url}` });
          }

          try {
            const me = await client.request<{ email?: string }>({ method: "GET", path: "/users/me" });
            checks.push({ name: "auth", ok: true, detail: `已登录：${me.email ?? "?"}（key 来自 ${profile.keySource}）` });
          } catch (error) {
            const typed = toCliError(error);
            checks.push({ name: "auth", ok: false, detail: `${typed.message}${typed.hint ? `；${typed.hint}` : ""}` });
          }
        } catch (error) {
          const typed = toCliError(error);
          checks.push({ name: "profile", ok: false, detail: `${typed.message}${typed.hint ? `；${typed.hint}` : ""}` });
        }

        const healthy = checks.every((check) => check.ok);
        return { data: { healthy, checks }, ...(healthy ? {} : { exitCode: 1 }) };
      }),
    );

  program
    .command("api")
    .description("直接调用 Hub 的任意 REST 接口（/api/v1 下的路径）")
    .argument("<method>", METHODS.join(" | "))
    .argument("<path>", "例如 /workspaces 或 /cards/{publicId}")
    .option("--params <json>", "查询参数，JSON 对象")
    .option("--data <json>", "请求体，JSON")
    .option("--dry-run", "只打印将要发出的请求，不发送")
    .action(
      action<{ params?: string; data?: string; dryRun?: boolean }>(deps, exit, async (runtime, args, options) => {
        const method = (args[0] ?? "").toUpperCase() as Method;
        if (!METHODS.includes(method)) {
          throw validationError(`不支持的方法 ${args[0] ?? ""}，只能是 ${METHODS.join(" / ")}`, "method");
        }
        const params = jsonFlag(options.params, "--params");
        if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
          throw validationError("--params 必须是 JSON 对象", "params");
        }
        const spec = {
          method,
          path: apiPath(args[1] ?? ""),
          query: params as Record<string, string> | undefined,
          body: jsonFlag(options.data, "--data"),
        };
        const client = await runtime.client();
        if (options.dryRun) return { data: client.describe(spec), meta: { dryRun: true } };
        return { data: await client.request(spec) };
      }),
    );

  program
    .command("schema")
    .description("列出 Hub 的所有接口；给出接口时显示它的参数和请求体")
    .argument("[operation]", "operationId，或 \"POST /cards\" 这样的方法加路径")
    .action(
      action(deps, exit, async (runtime, args) => {
        const client = await runtime.client();
        let document: OpenApiDocument;
        try {
          const response = await deps.fetch(client.url("/openapi.json"), { signal: AbortSignal.timeout(15_000) });
          document = (await response.json()) as OpenApiDocument;
        } catch {
          throw new CliError({
            type: "network",
            subtype: "unreachable",
            message: "读不到 Hub 的接口描述（/api/v1/openapi.json）",
            retryable: true,
          });
        }

        const operations = Object.entries(document.paths ?? {}).flatMap(([path, byMethod]) =>
          Object.entries(byMethod).map(([method, operation]) => ({
            id: operation.operationId ?? null,
            method: method.toUpperCase(),
            path,
            summary: operation.summary ?? null,
            tags: operation.tags ?? [],
            operation,
          })),
        );

        const wanted = args[0]?.trim();
        if (!wanted) {
          return {
            data: operations.map(({ operation: _operation, ...rest }) => rest),
            meta: { count: operations.length },
          };
        }

        const [first, ...rest] = wanted.split(/\s+/);
        const match = operations.find((op) =>
          rest.length > 0
            ? op.method === first?.toUpperCase() && op.path === apiPath(rest.join(" "))
            : op.id === wanted,
        );
        if (!match) {
          throw new CliError({
            type: "not_found",
            subtype: "unknown_operation",
            message: `没有这个接口：${wanted}`,
            hint: "不带参数运行 bshub schema 列出全部接口。",
          });
        }
        return {
          data: {
            id: match.id,
            method: match.method,
            path: match.path,
            summary: match.summary,
            description: match.operation.description ?? null,
            parameters: match.operation.parameters ?? [],
            requestBody: match.operation.requestBody ?? null,
          },
        };
      }),
    );
}
