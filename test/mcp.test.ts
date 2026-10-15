import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Deps } from "../src/core/runtime.js";
import { runCli } from "../src/cli.js";
import { argvFor, tools } from "../src/commands/mcp.js";

/** The MCP server, spoken to the way a client would: JSON-RPC lines in, lines out. */

const KEY = `kan_${"x".repeat(20)}cdef`;
const H = "http://localhost:3210/api";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[];
let routes: Record<string, () => Response>;
let configDir: string;
let processOut: string;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  calls.push({ method: init?.method ?? "GET", path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
  const route = routes[`${init?.method ?? "GET"} ${url.origin}${url.pathname}`];
  return route ? route() : json({ message: "not found" }, 404);
};

/** Sends the messages, returns the server's replies in order. */
async function session(messages: unknown[], flags: string[] = []): Promise<any[]> {
  const written: string[] = [];
  const deps: Deps = {
    writer: { out: (text) => void (processOut += text), err: (text) => void (processOut += text) },
    env: { BSHUB_CONFIG_DIR: configDir, BSHUB_URL: "http://localhost:3210", BSHUB_API_KEY: KEY },
    fetch: fakeFetch,
    readSecret: async () => KEY,
    readStdin: async () => "",
    isInteractive: false,
    stdio: {
      lines: (async function* () {
        for (const message of messages) yield typeof message === "string" ? message : JSON.stringify(message);
      })(),
      write: (text) => void written.push(text),
    },
  };
  expect(await runCli(["mcp", "serve", ...flags], deps)).toBe(0);
  return written.map((line) => JSON.parse(line));
}

const call = (id: number, name: string, args?: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const textOf = (reply: any) => reply.result.content[0].text as string;

beforeEach(async () => {
  calls = [];
  processOut = "";
  configDir = await mkdtemp(join(tmpdir(), "bshub-mcp-"));
  routes = {
    [`GET ${H}/v1/boards/board0000001`]: () =>
      json({ publicId: "board0000001", name: "运营", lists: [{ publicId: "list00000001", name: "待办", cards: [{ publicId: "card00000001", title: "写周报" }] }] }),
    [`POST ${H}/v1/cards/card00000001/comments`]: () => json({ publicId: "comm00000001" }),
    [`POST ${H}/hub/v1/documents`]: () => json({ publicId: "doc000000001", title: "t", filename: "t.md", size: 1, readable: false }),
  };
});

describe("protocol", () => {
  it("negotiates a version, ignores notifications, answers ping", async () => {
    const replies = await session([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(replies).toHaveLength(2);
    expect(replies[0].result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "bshub" } });
    expect(replies[0].result.instructions).toContain("数据");
    expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
  });

  it("answers bad input with JSON-RPC errors and keeps going", async () => {
    const replies = await session(["not json", { jsonrpc: "2.0", id: 5, method: "nope" }, { jsonrpc: "2.0", id: 6, method: "ping" }]);
    expect(replies.map((reply) => reply.error?.code ?? "ok")).toEqual([-32700, -32601, "ok"]);
  });

  it("writes nothing but protocol messages to the process output", async () => {
    await session([call(1, "board_get", { board: "board0000001" })]);
    expect(processOut).toBe("");
  });
});

describe("tool list", () => {
  it("offers read and write tools, or only reads with --read-only", async () => {
    const [all] = await session([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    const names = all.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["task_list", "task_create", "doc_cat", "doc_create"]));

    const [readOnly] = await session([{ jsonrpc: "2.0", id: 1, method: "tools/list" }], ["--read-only"]);
    const readNames = readOnly.result.tools.map((tool: { name: string }) => tool.name);
    expect(readNames).toContain("task_list");
    expect(readNames).not.toContain("task_create");
    expect(readOnly.result.tools.every((tool: any) => tool.annotations.readOnlyHint === true)).toBe(true);
  });

  it("has no delete, no access changes and no file path anywhere", () => {
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/delete|remove_|grant|access|editor/);
      expect(Object.keys(tool.params).join(",")).not.toMatch(/\b(file|path|out)\b/);
      expect(tool.command.join(" ")).not.toMatch(/delete|download|export|import/);
    }
  });

  it("gives every tool a closed object schema", async () => {
    const [all] = await session([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    for (const tool of all.result.tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });
});

describe("tool calls", () => {
  it("runs the real command and returns its envelope", async () => {
    const [reply] = await session([call(1, "task_list", { board: "board0000001" })]);
    expect(reply.result.isError).toBe(false);
    expect(JSON.parse(textOf(reply))).toMatchObject({ ok: true, data: [{ title: "写周报", stage: "todo" }] });
  });

  it("returns a command failure as an error result, not a protocol error", async () => {
    const [reply] = await session([call(1, "board_get", { board: "board0000099" })]);
    expect(reply.result.isError).toBe(true);
    expect(JSON.parse(textOf(reply)).error).toMatchObject({ type: "not_found" });
  });

  it("rejects bad input before any request goes out", async () => {
    const replies = await session([
      call(1, "task_list", { board: "board0000001", surprise: 1 }),
      call(2, "task_get", { task: "--yes" }),
      call(3, "task_create", { board: "board0000001" }),
      call(4, "task_due_soon", { days: "7" }),
    ]);
    expect(replies.every((reply) => reply.result.isError === true)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("passes text that looks like an option through as plain data", async () => {
    const [reply] = await session([call(1, "task_comment", { task: "card00000001", text: "--yes" })]);
    expect(reply.result.isError).toBe(false);
    expect(calls[0]).toMatchObject({ method: "POST", body: { comment: "--yes" } });
  });

  it("previews a write with dry_run and sends nothing", async () => {
    const [reply] = await session([call(1, "task_comment", { task: "card00000001", text: "hi", dry_run: true })]);
    expect(JSON.parse(textOf(reply)).meta).toEqual({ dryRun: true });
    expect(calls).toHaveLength(0);
  });

  it("does not let a mistyped dry_run turn a preview into the real write", async () => {
    const replies = await session([
      call(1, "task_comment", { task: "card00000001", text: "hi", dry_run: "true" }),
      call(2, "task_comment", { task: "card00000001", text: "hi", dry_run: 1 }),
    ]);
    expect(replies.every((reply) => reply.result.isError === true)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses an unknown tool, and write tools in read-only mode", async () => {
    const [unknown] = await session([call(1, "task_delete", { task: "card00000001" })]);
    expect(unknown.error.code).toBe(-32602);
    const [readOnly] = await session([call(1, "task_comment", { task: "card00000001", text: "hi" })], ["--read-only"]);
    expect(readOnly.error.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });
});

describe("documents", () => {
  it("creates private documents unless told otherwise", async () => {
    await session([call(1, "doc_create", { title: "t", text: "x" })]);
    expect(calls[0]!.body).toMatchObject({ readable: false, content: "x" });

    calls = [];
    routes[`POST ${H}/hub/v1/documents`] = () => json({ publicId: "doc000000001", title: "t", filename: "t.md", size: 1, readable: true });
    await session([call(1, "doc_create", { title: "t", text: "x", private: false })]);
    expect(calls[0]!.body).toMatchObject({ readable: true });
  });
});

describe("argv", () => {
  it("builds the command line without letting a value become an option", () => {
    const tool = tools.find((t) => t.name === "task_create")!;
    expect(argvFor(tool, { board: "board0000001", title: "-x", assign_me: true })).toEqual([
      "task", "+create", "--board=board0000001", "--title=-x", "--assign-me",
    ]);
  });
});
