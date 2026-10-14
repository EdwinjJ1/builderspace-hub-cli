import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { errorFromResponse } from "../src/core/client.js";
import { maskKey, normalizeUrl, readConfig, resolveProfile, writeConfig } from "../src/core/config.js";
import { CliError, EXIT_CODES, errorTypes, exitCodeOf } from "../src/core/errors.js";
import { displayWidth, renderTable, sanitize } from "../src/core/output.js";
import { findList, parseDueDate, stageOf } from "../src/core/stages.js";

describe("errors", () => {
  it("gives every type its own non-zero exit code", () => {
    const codes = errorTypes.map((type) => EXIT_CODES[type]);
    expect(new Set(codes).size).toBe(errorTypes.length);
    expect(codes.every((code) => code > 0)).toBe(true);
    expect(exitCodeOf(new Error("boom"))).toBe(EXIT_CODES.internal);
  });

  it("maps Hub responses onto the CLI's types", () => {
    const map = (status: number, headers: Record<string, string> = {}) =>
      errorFromResponse(new Response(null, { status, headers }), { message: "m" });

    expect(map(400).type).toBe("validation");
    expect(map(401).type).toBe("authentication");
    expect(map(403).type).toBe("authorization");
    expect(map(404).type).toBe("not_found");
    expect(map(409).type).toBe("conflict");
    expect(map(429, { "retry-after": "12" }).toJSON()).toMatchObject({
      type: "rate_limit",
      retryable: true,
      retry_after_seconds: 12,
    });
    expect(map(503).toJSON()).toMatchObject({ type: "api", retryable: true });
  });
});

describe("output", () => {
  it("strips terminal escape sequences and control characters", () => {
    expect(sanitize("ok\u001b[31mred\u001b[0m\u001b]0;title\u0007\u0000done\n")).toBe(
      "okreddone\n",
    );
  });

  it("measures Chinese as two columns and aligns tables by it", () => {
    expect(displayWidth("待办")).toBe(4);
    expect(renderTable([{ a: "待办", b: 1 }, { a: "x", b: 22 }]).split("\n")).toEqual([
      "a     b",
      "----  --",
      "待办  1",
      "x     22",
    ]);
  });
});

describe("config", () => {
  it("accepts https and local http, refuses the rest", () => {
    expect(normalizeUrl("https://hub.example.com/path")).toBe("https://hub.example.com");
    expect(normalizeUrl("http://localhost:3210")).toBe("http://localhost:3210");
    expect(() => normalizeUrl("http://hub.example.com")).toThrow(CliError);
    expect(() => normalizeUrl("https://user:pw@hub.example.com")).toThrow("用户名或密码");
    expect(() => normalizeUrl("not a url")).toThrow(CliError);
  });

  it("lets the environment override the file", () => {
    const config = {
      currentProfile: "prod",
      profiles: { prod: { url: "https://prod.example.com", apiKey: "file-key-1234567890" } },
    };
    expect(resolveProfile(config, {}, {})).toMatchObject({
      name: "prod",
      apiKey: "file-key-1234567890",
      keySource: "config",
    });
    expect(
      resolveProfile(config, {}, { BSHUB_API_KEY: "env-key", BSHUB_URL: "http://localhost:1" }),
    ).toMatchObject({ url: "http://localhost:1", apiKey: "env-key", keySource: "env" });
    expect(() => resolveProfile(config, { profile: "missing" }, {})).toThrow("还没有配置");
  });

  it("writes the file for its owner only", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "bshub-")), "nested", "config.json");
    await writeConfig(path, { currentProfile: "default", profiles: { default: { url: "https://x.test" } } });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readConfig(path)).profiles.default?.url).toBe("https://x.test");
  });

  it("masks keys", () => {
    expect(maskKey("kan_abcdefghijklmnopqrstuvwxyz")).toBe("kan_…wxyz");
    expect(maskKey("short")).toBe("***");
    expect(maskKey(undefined)).toBeNull();
  });
});

describe("stages", () => {
  const lists = [
    { publicId: "l1", name: "待办" },
    { publicId: "l2", name: "进行中" },
    { publicId: "l3", name: "Code Review" },
  ];

  it("finds a list by id, by name or by stage word", () => {
    expect(findList(lists, "l2")?.name).toBe("进行中");
    expect(findList(lists, "待办")?.publicId).toBe("l1");
    expect(findList(lists, "doing")?.publicId).toBe("l2");
    expect(findList(lists, "review")?.publicId).toBe("l3");
    expect(findList(lists, "done")).toBeNull();
    expect(stageOf("In Progress")).toBe("doing");
  });

  it("reads YYYY-MM-DD as the end of that day, rejecting impossible dates", () => {
    const due = parseDueDate("2026-10-25");
    expect([due?.getFullYear(), due?.getMonth(), due?.getDate(), due?.getHours()]).toEqual([
      2026, 9, 25, 23,
    ]);
    expect(parseDueDate("2026-13-01")).toBeNull();
    expect(parseDueDate("2026-02-30")).toBeNull();
    expect(parseDueDate("tomorrow")).toBeNull();
  });
});
