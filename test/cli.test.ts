import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Deps } from "../src/core/runtime.js";
import { runCli } from "../src/cli.js";

/**
 * The real command tree, driven with a fake Hub: every request is recorded and
 * answered from a small routing table, so these tests need no server.
 */

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

// An obviously fake key, built at run time so secret scanners have nothing to flag.
const KEY = `kan_${"x".repeat(20)}cdef`;
let calls: Call[];
let routes: Record<string, (call: Call) => Response>;
let out: string;
let err: string;
let configDir: string;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const call: Call = {
    method: init?.method ?? "GET",
    url: url.pathname + url.search,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
  calls.push(call);
  const route = routes[`${call.method} ${url.pathname}`];
  return route ? route(call) : json({ message: "not found" }, 404);
};

function deps(overrides: Partial<Deps> = {}): Deps {
  return {
    writer: { out: (text) => void (out += text), err: (text) => void (err += text) },
    env: { BSHUB_CONFIG_DIR: configDir },
    fetch: fakeFetch,
    readSecret: async () => KEY,
    readStdin: async () => `${KEY}\n`,
    isInteractive: false,
    ...overrides,
  };
}

const run = (args: string, extra: Partial<Deps> = {}) => runCli(args.split(" "), deps(extra));
const lastOut = () => JSON.parse(out) as { ok: boolean; data: Record<string, unknown> };

const board = {
  publicId: "board0000001",
  name: "运营",
  lists: [
    { publicId: "list00000001", name: "待办", cards: [{ publicId: "card00000001", title: "写周报", members: [] }] },
    { publicId: "list00000002", name: "进行中", cards: [] },
  ],
  workspace: { publicId: "proj00000001", members: [{ publicId: "memb00000001", email: "me@example.test" }] },
};

beforeEach(async () => {
  calls = [];
  out = "";
  err = "";
  configDir = await mkdtemp(join(tmpdir(), "bshub-cli-"));
  routes = {
    "GET /api/v1/users/me": (call) =>
      call.headers["x-api-key"] === KEY
        ? json({ id: "u1", name: "Me", email: "me@example.test" })
        : json({ message: "Unauthorized" }, 401),
    "GET /api/v1/boards/board0000001": () => json(board),
    "GET /api/v1/cards/card00000001": () =>
      json({
        publicId: "card00000001",
        title: "写周报",
        list: { publicId: "list00000001", name: "待办", board: { publicId: "board0000001", name: "运营" } },
      }),
    "PUT /api/v1/cards/card00000001": () => json({ publicId: "card00000001" }),
    "POST /api/v1/cards": () => json({ publicId: "card00000002" }),
  };
});

async function loggedIn() {
  expect(await run("config init --hub http://localhost:3210")).toBe(0);
  expect(await run("auth login --api-key-stdin")).toBe(0);
  out = "";
  calls = [];
}

describe("login", () => {
  it("checks the key, keeps it owner-only, and never prints it", async () => {
    await run("config init --hub http://localhost:3210");
    out = "";
    expect(await run("auth login --api-key-stdin")).toBe(0);

    expect(lastOut().data).toMatchObject({ key: "kan_…cdef", user: { email: "me@example.test" } });
    expect(out).not.toContain(KEY);
    expect((await stat(join(configDir, "config.json"))).mode & 0o777).toBe(0o600);
  });

  it("refuses to guess a key in a non-interactive shell", async () => {
    await run("config init --hub http://localhost:3210");
    expect(await run("auth login")).toBe(2);
    expect(JSON.parse(err).error).toMatchObject({ type: "validation", param: "api-key-stdin" });
  });

  it("reports a bad key as an authentication error", async () => {
    await run("config init --hub http://localhost:3210");
    expect(await run("auth login --api-key-stdin", { readStdin: async () => "wrong" })).toBe(3);
  });

  it("tells you to configure first", async () => {
    expect(await run("whoami")).toBe(3);
    expect(JSON.parse(err).error).toMatchObject({ subtype: "not_configured" });
  });
});

describe("tasks", () => {
  beforeEach(loggedIn);

  it("lists a board's tasks with their stage", async () => {
    expect(await run("task +list --board board0000001")).toBe(0);
    expect(lastOut().data).toEqual([
      expect.objectContaining({ publicId: "card00000001", list: "待办", stage: "todo" }),
    ]);
  });

  it("moves a task by stage word to the list on its own board", async () => {
    expect(await run("task +move card00000001 --to doing")).toBe(0);
    expect(calls.at(-1)).toMatchObject({
      method: "PUT",
      url: "/api/v1/cards/card00000001",
      body: { listPublicId: "list00000002" },
    });
    expect(lastOut().data).toEqual({ publicId: "card00000001", from: "待办", to: "进行中" });
  });

  it("creates a task assigned to me, and a dry run sends nothing and hides the key", async () => {
    expect(await run("task +create --board board0000001 --title 新任务 --assign-me --dry-run")).toBe(0);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(out).toContain('"x-api-key": "***"');
    expect(out).not.toContain(KEY);

    out = "";
    expect(await run("task +create --board board0000001 --title 新任务 --assign-me")).toBe(0);
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      body: { title: "新任务", listPublicId: "list00000001", memberPublicIds: ["memb00000001"] },
    });
  });

  it("explains an unknown column and exits 5", async () => {
    expect(await run("task +move card00000001 --to 火星")).toBe(5);
    expect(JSON.parse(err).error).toMatchObject({ type: "not_found", subtype: "unknown_list" });
  });
});

describe("usage", () => {
  it("exits 2 for unknown commands and formats, 0 for help", async () => {
    expect(await run("task +fly")).toBe(2);
    expect(await run("project list -f xml")).toBe(2);
    expect(await run("--help")).toBe(0);
  });
});
