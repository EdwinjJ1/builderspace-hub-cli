import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Deps, FileAccess } from "../src/core/runtime.js";
import { runCli } from "../src/cli.js";

/** The document commands, driven with a fake Hub and a fake disk. */

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const KEY = `kan_${"x".repeat(20)}cdef`;
const SIGNED = "https://files.example.test/documents/abc.pdf?signature=fake";

let calls: Call[];
let routes: Record<string, (call: Call) => Response>;
let out: string;
let err: string;
let configDir: string;
let disk: Map<string, Uint8Array>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const raw = init?.body;
  const call: Call = {
    method: init?.method ?? "GET",
    url: url.origin + url.pathname + url.search,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: typeof raw === "string" ? JSON.parse(raw) : raw,
  };
  calls.push(call);
  const route = routes[`${call.method} ${url.origin}${url.pathname}`];
  return route ? route(call) : json({ message: "not found" }, 404);
};

const files: FileAccess = {
  readFile: async (path) => {
    const bytes = disk.get(path);
    if (!bytes) throw new Error(`no such file ${path}`);
    return bytes;
  },
  writeFile: async (path, data) => void disk.set(path, data),
};

function deps(overrides: Partial<Deps> = {}): Deps {
  return {
    writer: { out: (text) => void (out += text), err: (text) => void (err += text) },
    env: { BSHUB_CONFIG_DIR: configDir, BSHUB_URL: "http://localhost:3210", BSHUB_API_KEY: KEY },
    fetch: fakeFetch,
    readSecret: async () => KEY,
    readStdin: async () => "from stdin",
    isInteractive: false,
    files,
    ...overrides,
  };
}

// Arguments with spaces would be split by a plain `split(" ")`, so tests pass arrays.
const run = (args: string[], extra: Partial<Deps> = {}) => runCli(args, deps(extra));
const lastOut = () => JSON.parse(out) as { ok: boolean; data: Record<string, unknown>; meta?: Record<string, unknown> };
const lastErr = () => JSON.parse(err) as { error: Record<string, unknown> };
const apiCalls = () => calls.filter((call) => call.url.startsWith("http://localhost:3210"));

const doc = (overrides: Record<string, unknown> = {}) => ({
  publicId: "doc000000001",
  title: "讲稿",
  filename: "讲稿.md",
  ext: "md",
  size: 12,
  readable: true,
  canEdit: true,
  updatedAt: "2026-10-15T10:00:00Z",
  ...overrides,
});

const H = "http://localhost:3210/api/hub/v1";

beforeEach(async () => {
  calls = [];
  out = "";
  err = "";
  disk = new Map();
  configDir = await mkdtemp(join(tmpdir(), "bshub-docs-"));
  routes = {};
});

describe("doc list / get / cat", () => {
  it("lists a folder from the Hub's own API with the key in the header", async () => {
    routes[`GET ${H}/documents`] = () =>
      json({ folders: [{ publicId: "fold00000001", name: "合同" }], documents: [doc()] });
    expect(await run(["doc", "list", "--search", "讲"])).toBe(0);

    expect(calls[0]).toMatchObject({ method: "GET", url: `${H}/documents?search=%E8%AE%B2` });
    expect(calls[0]!.headers["x-api-key"]).toBe(KEY);
    expect(lastOut().data).toMatchObject({
      folders: [{ name: "合同" }],
      documents: [{ publicId: "doc000000001", title: "讲稿", readable: true }],
    });
    expect(lastOut().meta).toEqual({ count: 1 });
    expect(out).not.toContain(KEY);
  });

  it("reads a text document's content", async () => {
    routes[`GET ${H}/documents/doc000000001/content`] = () => json({ content: "# 讲稿" });
    expect(await run(["doc", "cat", "doc000000001"])).toBe(0);
    expect(lastOut().data).toEqual({ publicId: "doc000000001", content: "# 讲稿" });
  });

  it("maps a refusal to the authorization exit code", async () => {
    routes[`GET ${H}/documents/doc000000001`] = () => json({ message: "找不到这份文档" }, 404);
    expect(await run(["doc", "get", "doc000000001"])).toBe(5);
  });
});

describe("doc +create", () => {
  it("creates a text document straight from --text", async () => {
    routes[`POST ${H}/documents`] = () => json(doc());
    expect(await run(["doc", "+create", "--title", "讲稿", "--text", "# 讲稿", "--filename", "讲稿.md"])).toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ title: "讲稿", filename: "讲稿.md", content: "# 讲稿", readable: true });
    expect(lastOut().data).toMatchObject({ publicId: "doc000000001", readable: true });
  });

  it("takes the filename from the title when the text comes from stdin", async () => {
    routes[`POST ${H}/documents`] = () => json(doc());
    expect(await run(["doc", "+create", "--title", "会议/讲稿", "--stdin"])).toBe(0);
    expect(calls[0]!.body).toMatchObject({ filename: "会议-讲稿.md", content: "from stdin" });
  });

  it("sends private documents as unreadable", async () => {
    routes[`POST ${H}/documents`] = () => json(doc({ readable: false }));
    expect(await run(["doc", "+create", "--title", "讲稿", "--text", "x", "--filename", "a.md", "--private"])).toBe(0);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { readable: boolean }).readable).toBe(false);
    expect(lastOut().data).toMatchObject({ readable: false });
  });

  it("fixes a private document an older Hub created as readable", async () => {
    routes[`POST ${H}/documents`] = () => json(doc({ readable: true }));
    routes[`PATCH ${H}/documents/doc000000001`] = () => json(doc({ readable: false }));
    expect(await run(["doc", "+create", "--title", "讲稿", "--text", "x", "--filename", "a.md", "--private"])).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["POST", "PATCH"]);
    expect(lastOut().data).toMatchObject({ readable: false });
  });

  it("fails loudly when a private document cannot be made private", async () => {
    routes[`POST ${H}/documents`] = () => json(doc({ readable: true }));
    routes[`PATCH ${H}/documents/doc000000001`] = () => json(doc({ readable: true }));
    expect(await run(["doc", "+create", "--title", "讲稿", "--text", "x", "--filename", "a.md", "--private"])).toBe(9);
    expect(lastErr().error).toMatchObject({ subtype: "not_private" });
  });

  it("uploads a PDF to the signed link without the API key, then completes it", async () => {
    disk.set("/tmp/合同.pdf", new Uint8Array([1, 2, 3, 4]));
    routes[`POST ${H}/documents/uploads`] = () => json({ uploadId: "upl000000001", url: SIGNED, method: "PUT" });
    routes[`PUT https://files.example.test/documents/abc.pdf`] = () => new Response(null, { status: 200 });
    routes[`POST ${H}/documents/uploads/upl000000001/complete`] = () =>
      json(doc({ filename: "合同.pdf", ext: "pdf", size: 4, readable: false }));

    expect(await run(["doc", "+create", "--title", "合同", "--file", "/tmp/合同.pdf", "--private"])).toBe(0);

    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.url).toContain("https://files.example.test/");
    expect(put.headers["x-api-key"]).toBeUndefined();
    expect(put.body).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(calls[0]!.body).toEqual({ filename: "合同.pdf", size: 4 });
    expect(calls.at(-1)!.body).toMatchObject({ title: "合同", readable: false });
    expect(out).not.toContain(KEY);
  });

  it("refuses a text file that is not UTF-8 and sends nothing", async () => {
    disk.set("/tmp/a.md", new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(await run(["doc", "+create", "--title", "a", "--file", "/tmp/a.md"])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("needs exactly one content source", async () => {
    expect(await run(["doc", "+create", "--title", "a"])).toBe(2);
    expect(await run(["doc", "+create", "--title", "a", "--text", "x", "--stdin"])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("names inline text after its title when no filename is given", async () => {
    routes[`POST ${H}/documents`] = () => json(doc());
    expect(await run(["doc", "+create", "--title", "a", "--text", "x"])).toBe(0);
    expect(calls[0]!.body).toMatchObject({ filename: "a.md" });
  });

  it("shows the request on --dry-run without sending it", async () => {
    expect(await run(["doc", "+create", "--title", "讲稿", "--text", "x", "--filename", "a.md", "--private", "--dry-run"])).toBe(0);
    expect(calls).toHaveLength(0);
    expect(lastOut().meta).toEqual({ dryRun: true });
    expect(out).not.toContain(KEY);
  });
});

describe("doc +update", () => {
  it("replaces content before changing visibility", async () => {
    routes[`PUT ${H}/documents/doc000000001/content`] = () => json({ ok: true });
    routes[`PATCH ${H}/documents/doc000000001`] = () => json(doc({ title: "新", readable: false }));
    expect(await run(["doc", "+update", "doc000000001", "--text", "新内容", "--title", "新", "--private"])).toBe(0);

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "PUT /api/hub/v1/documents/doc000000001/content",
      "PATCH /api/hub/v1/documents/doc000000001",
    ]);
    expect(calls[0]!.body).toEqual({ content: "新内容" });
    expect(calls[1]!.body).toEqual({ title: "新", readable: false });
    expect(lastOut().data).toMatchObject({ contentReplaced: true, readable: false });
  });

  it("rejects contradictory or empty updates before any request", async () => {
    expect(await run(["doc", "+update", "doc000000001", "--private", "--public"])).toBe(2);
    expect(await run(["doc", "+update", "doc000000001"])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("only replaces text content from the command line", async () => {
    disk.set("/tmp/deck.pptx", new Uint8Array([1]));
    expect(await run(["doc", "+update", "doc000000001", "--file", "/tmp/deck.pptx"])).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("doc +download", () => {
  it("fetches the signed link without the key and writes the file", async () => {
    routes[`GET ${H}/documents/doc000000001/download`] = () => json({ url: SIGNED, filename: "合同.pdf" });
    routes[`GET https://files.example.test/documents/abc.pdf`] = () => new Response(new Uint8Array([9, 8, 7]));
    expect(await run(["doc", "+download", "doc000000001", "--out", "/tmp/out.pdf"])).toBe(0);

    expect(disk.get("/tmp/out.pdf")).toEqual(new Uint8Array([9, 8, 7]));
    expect(calls.at(-1)!.headers["x-api-key"]).toBeUndefined();
    expect(lastOut().data).toMatchObject({ filename: "合同.pdf", size: 3 });
  });
});

describe("what the CLI does not do", () => {
  it("has no delete or access commands: those stay in the web app", async () => {
    expect(await run(["doc", "delete", "doc000000001"])).toBe(2);
    expect(await run(["doc", "access", "doc000000001"])).toBe(2);
    expect(apiCalls()).toHaveLength(0);
  });
});

describe("folders", () => {
  it("creates a folder", async () => {
    routes[`POST ${H}/documents/folders`] = () => json({ publicId: "fold00000001", name: "合同" });
    expect(await run(["doc", "folder", "+create", "--name", "合同"])).toBe(0);
    expect(calls[0]!.body).toEqual({ name: "合同" });
  });
});
