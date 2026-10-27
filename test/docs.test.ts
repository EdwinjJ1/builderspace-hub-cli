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
    if (!bytes) throw Object.assign(new Error(`no such file ${path}`), { code: "ENOENT" });
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
    expect(lastOut().data).toMatchObject({ publicId: "doc000000001", content: "# 讲稿" });
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

  it("creates an HTML document from a file", async () => {
    disk.set("/tmp/海报.html", new TextEncoder().encode("<h1>10-22</h1>"));
    routes[`POST ${H}/documents`] = () => json(doc({ filename: "海报.html", ext: "html" }));
    expect(await run(["doc", "+create", "--title", "海报", "--file", "/tmp/海报.html"])).toBe(0);
    expect(calls[0]!.body).toMatchObject({ filename: "海报.html", content: "<h1>10-22</h1>" });
  });

  it("refuses Word, PDF and slides with a pointer to the web upload, and sends nothing", async () => {
    for (const name of ["合同.pdf", "方案.docx", "deck.pptx", "notes.txt"]) {
      disk.set(`/tmp/${name}`, new Uint8Array([1, 2, 3]));
      err = "";
      expect(await run(["doc", "+create", "--title", "a", "--file", `/tmp/${name}`])).toBe(2);
      expect(lastErr().error).toMatchObject({ subtype: "invalid_param", param: "file" });
      expect(String(lastErr().error.hint)).toContain("上传文件");
    }
    expect(calls).toHaveLength(0);
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

  it("takes only a .md or .html filename for inline text", async () => {
    expect(await run(["doc", "+create", "--title", "a", "--text", "hello", "--filename", "report.pdf"])).toBe(2);
    expect(lastErr().error).toMatchObject({ subtype: "invalid_param", param: "filename" });
    expect(calls).toHaveLength(0);
  });

  it("names inline text after its title when no filename is given", async () => {
    routes[`POST ${H}/documents`] = () => json(doc());
    expect(await run(["doc", "+create", "--title", "a", "--text", "x"])).toBe(0);
    expect(calls[0]!.body).toMatchObject({ filename: "a.md" });
  });

  it("describes the one request on --dry-run for a file, and sends nothing", async () => {
    disk.set("/tmp/讲稿.md", new TextEncoder().encode("# 讲稿"));
    expect(await run(["doc", "+create", "--title", "讲稿", "--file", "/tmp/讲稿.md", "--private", "--dry-run"])).toBe(0);
    expect(calls).toHaveLength(0);
    const steps = lastOut().data as unknown as { method: string; url: string; body: unknown }[];
    expect(steps.map((step) => step.method)).toEqual(["POST"]);
    expect(steps[0]!.url).toBe(`${H}/documents`);
    expect(steps[0]!.body).toMatchObject({ filename: "讲稿.md", content: "# 讲稿", readable: false });
  });

  it("reports a missing local file as a not-found error with a hint, not a CLI bug", async () => {
    expect(await run(["doc", "+create", "--title", "a", "--file", "/tmp/missing.md"])).toBe(5);
    expect(lastErr().error).toMatchObject({ type: "not_found", subtype: "file_not_found" });
    expect(String(lastErr().error.hint)).toContain("路径");
  });

  it("reports an unreadable local file as a validation error", async () => {
    const denied = {
      readFile: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      writeFile: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    };
    expect(await run(["doc", "+create", "--title", "a", "--file", "/tmp/a.md"], { files: denied })).toBe(2);
    expect(lastErr().error).toMatchObject({ subtype: "file_unusable" });
    err = "";
    routes[`GET ${H}/documents/doc000000001`] = () => json(doc());
    routes[`GET ${H}/documents/doc000000001/content`] = () => json({ content: "x" });
    expect(await run(["doc", "+download", "doc000000001", "--out", "/root/x.md"], { files: denied })).toBe(2);
    expect(lastErr().error).toMatchObject({ subtype: "file_unusable" });
  });

  it("shows the request on --dry-run without sending it", async () => {
    expect(await run(["doc", "+create", "--title", "讲稿", "--text", "x", "--filename", "a.md", "--private", "--dry-run"])).toBe(0);
    expect(calls).toHaveLength(0);
    expect(lastOut().meta).toEqual({ dryRun: true });
    expect(out).not.toContain(KEY);
  });
});

describe("doc +update", () => {
  it("replaces content first and changes visibility last, unless it is going private", async () => {
    routes[`PUT ${H}/documents/doc000000001/content`] = () => json({ changed: true });
    routes[`PATCH ${H}/documents/doc000000001`] = () => json(doc({ title: "新", readable: true }));
    expect(await run(["doc", "+update", "doc000000001", "--text", "新内容", "--title", "新", "--public"])).toBe(0);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "PUT /api/hub/v1/documents/doc000000001/content",
      "PATCH /api/hub/v1/documents/doc000000001",
    ]);
    expect(calls[0]!.body).toEqual({ content: "新内容" });
    expect(calls[1]!.body).toEqual({ title: "新", readable: true });
    expect(lastOut().data).toMatchObject({ contentReplaced: true });
  });

  it("goes private before the new text is written, so it is never written into a readable document", async () => {
    routes[`PUT ${H}/documents/doc000000001/content`] = () => json({ changed: true });
    routes[`PATCH ${H}/documents/doc000000001`] = () => json(doc({ readable: false }));
    routes[`GET ${H}/documents/doc000000001`] = () => json(doc({ readable: false }));
    expect(await run(["doc", "+update", "doc000000001", "--text", "机密", "--private"])).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["PATCH", "PUT", "GET"]);

    // The preview shows the same order as the real thing.
    calls = [];
    out = "";
    expect(await run(["doc", "+update", "doc000000001", "--text", "机密", "--private", "--dry-run"])).toBe(0);
    expect(calls).toHaveLength(0);
    const steps = lastOut().data as unknown as { method: string }[];
    expect(steps.map((step) => step.method)).toEqual(["PATCH", "PUT"]);
  });

  it("checks that the document really went private before writing new text into it", async () => {
    routes[`PATCH ${H}/documents/doc000000001`] = () => json(doc({ readable: true })); // the Hub ignored the flag
    routes[`PUT ${H}/documents/doc000000001/content`] = () => json({ changed: true });
    expect(await run(["doc", "+update", "doc000000001", "--text", "机密", "--private"])).toBe(9);
    expect(lastErr().error).toMatchObject({ subtype: "not_private" });
    expect(calls.map((call) => call.method)).toEqual(["PATCH"]);
  });

  it("reads the document again after replacing text, so the size and time it prints are current", async () => {
    routes[`PATCH ${H}/documents/doc000000001`] = () => json(doc({ readable: false, size: 5, updatedAt: "old" }));
    routes[`PUT ${H}/documents/doc000000001/content`] = () => json({ changed: true });
    routes[`GET ${H}/documents/doc000000001`] = () => json(doc({ readable: false, size: 99, updatedAt: "new" }));
    expect(await run(["doc", "+update", "doc000000001", "--text", "新内容", "--private"])).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["PATCH", "PUT", "GET"]);
    expect(lastOut().data).toMatchObject({ size: 99, updatedAt: "new", contentReplaced: true });
  });

  it("stops before the content is written if making the document private fails", async () => {
    routes[`PATCH ${H}/documents/doc000000001`] = () => json({ message: "boom" }, 500);
    routes[`PUT ${H}/documents/doc000000001/content`] = () => json({ changed: true });
    expect(await run(["doc", "+update", "doc000000001", "--text", "机密", "--private"])).toBe(9);
    expect(calls.map((call) => call.method)).toEqual(["PATCH"]);
  });

  it("passes the time it was read at, so a stale save is refused by the Hub", async () => {
    routes[`PUT ${H}/documents/doc000000001/content`] = () =>
      json({ message: "这份文档在你打开之后被别人改过了，请刷新后再改" }, 409);
    expect(
      await run(["doc", "+update", "doc000000001", "--text", "x", "--if-unmodified-since", "2026-10-15T10:00:00.000Z"]),
    ).toBe(6);
    expect(calls[0]!.body).toEqual({ content: "x", expectedUpdatedAt: "2026-10-15T10:00:00.000Z" });
    expect(await run(["doc", "+update", "doc000000001", "--title", "t", "--if-unmodified-since", "x"])).toBe(2);
  });

  it("will not combine the freshness check with detail changes, which would defeat it", async () => {
    expect(
      await run(["doc", "+update", "doc000000001", "--text", "x", "--private", "--if-unmodified-since", "2026-10-15T10:00:00.000Z"]),
    ).toBe(2);
    expect(lastErr().error).toMatchObject({ param: "if-unmodified-since" });
    expect(calls).toHaveLength(0);
  });

  it("rejects contradictory or empty updates before any request", async () => {
    expect(await run(["doc", "+update", "doc000000001", "--private", "--public"])).toBe(2);
    expect(await run(["doc", "+update", "doc000000001"])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("replaces content only from a .md or .html file", async () => {
    disk.set("/tmp/deck.pptx", new Uint8Array([1]));
    expect(await run(["doc", "+update", "doc000000001", "--file", "/tmp/deck.pptx"])).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("doc +download", () => {
  it("writes the document's text to the file, read through the Hub with the key", async () => {
    routes[`GET ${H}/documents/doc000000001`] = () => json(doc());
    routes[`GET ${H}/documents/doc000000001/content`] = () => json({ content: "# 讲稿\n" });
    expect(await run(["doc", "+download", "doc000000001", "--out", "/tmp/讲稿.md"])).toBe(0);

    expect(new TextDecoder().decode(disk.get("/tmp/讲稿.md"))).toBe("# 讲稿\n");
    expect(calls.every((call) => call.headers["x-api-key"] === KEY)).toBe(true);
    expect(lastOut().data).toMatchObject({ filename: "讲稿.md", out: "/tmp/讲稿.md", size: 9 });
  });

  it("previews without fetching or writing", async () => {
    expect(await run(["doc", "+download", "doc000000001", "--out", "/tmp/out.md", "--dry-run"])).toBe(0);
    expect(calls).toHaveLength(0);
    expect(disk.size).toBe(0);
    expect(lastOut().meta).toEqual({ dryRun: true });
  });

  it("reports a connection that drops while the text is being read as a network error", async () => {
    routes[`GET ${H}/documents/doc000000001`] = () => json(doc());
    routes[`GET ${H}/documents/doc000000001/content`] = () =>
      ({ ok: true, status: 200, text: async () => Promise.reject(new Error("socket hang up")) }) as unknown as Response;
    expect(await run(["doc", "+download", "doc000000001", "--out", "/tmp/out.md"])).toBe(8);
    expect(lastErr().error).toMatchObject({ type: "network", retryable: true });
    expect(disk.size).toBe(0);
  });

  it("reports a dropped connection as a network error and writes nothing", async () => {
    routes[`GET ${H}/documents/doc000000001`] = () => json(doc());
    routes[`GET ${H}/documents/doc000000001/content`] = () => {
      throw new TypeError("fetch failed");
    };
    expect(await run(["doc", "+download", "doc000000001", "--out", "/tmp/out.md"])).toBe(8);
    expect(lastErr().error).toMatchObject({ type: "network", retryable: true });
    expect(disk.size).toBe(0);
  });
});

describe("doc +share", () => {
  const BOB = "11111111-1111-4111-8111-111111111111";
  const HEXIN = "22222222-2222-4222-8222-222222222222";
  const options = {
    departments: [
      { publicId: "dept00000001", name: "技术" },
      { publicId: "dept00000002", name: "运营" },
    ],
    projects: [
      {
        publicId: "proj00000001",
        name: "BuilderSpace 社团",
        members: [
          { userId: BOB, name: "Bob Lee" },
          { userId: HEXIN, name: "Hexin" },
        ],
        departments: [{ publicId: "dept00000002", memberIds: [HEXIN] }],
      },
    ],
  };
  const patches = () => apiCalls().filter((call) => call.method === "PATCH");

  beforeEach(() => {
    routes[`GET ${H}/documents/audience-options`] = () => json(options);
  });

  it("shares a document with people by name, sending their userIds", async () => {
    routes[`PATCH ${H}/documents/doc000000001`] = () =>
      json(
        doc({
          readable: false,
          audience: "selected",
          readers: {
            users: [
              { userId: BOB, name: "Bob Lee" },
              { userId: HEXIN, name: "Hexin" },
            ],
            groups: [],
          },
        }),
      );
    expect(await run(["doc", "+share", "doc000000001", "--reader", "bob lee", "--reader", HEXIN])).toBe(0);

    expect(patches()[0]!.body).toEqual({ audience: { kind: "selected", userIds: [BOB, HEXIN], groups: [] } });
    expect(lastOut().data).toMatchObject({ audience: "selected", readers: { users: [{ name: "Bob Lee" }, { name: "Hexin" }] } });
  });

  it("names projects and departments; a department of a project chosen whole is left out", async () => {
    routes[`PATCH ${H}/documents/doc000000001`] = () =>
      json(
        doc({
          readable: false,
          audience: "selected",
          readers: { users: [], groups: [{ projectPublicId: "proj00000001", departmentPublicId: null, label: "BuilderSpace 社团" }] },
        }),
      );
    expect(
      await run(["doc", "+share", "doc000000001", "--project", "BuilderSpace 社团", "--department", "BuilderSpace 社团/运营"]),
    ).toBe(0);
    expect(patches()[0]!.body).toEqual({
      audience: { kind: "selected", userIds: [], groups: [{ projectPublicId: "proj00000001", departmentPublicId: null }] },
    });

    calls = [];
    out = "";
    routes[`PATCH ${H}/documents/doc000000001`] = () =>
      json(
        doc({
          readable: false,
          audience: "selected",
          readers: { users: [], groups: [{ projectPublicId: "proj00000001", departmentPublicId: "dept00000002", label: "BuilderSpace 社团 · 运营" }] },
        }),
      );
    expect(await run(["doc", "+share", "doc000000001", "--department", "proj00000001/运营"])).toBe(0);
    expect(patches()[0]!.body).toEqual({
      audience: { kind: "selected", userIds: [], groups: [{ projectPublicId: "proj00000001", departmentPublicId: "dept00000002" }] },
    });
  });

  it("opens a document to everyone or closes it to its editors without looking anyone up", async () => {
    routes[`PATCH ${H}/documents/doc000000001`] = (call) =>
      json(
        (call.body as { audience: { kind: string } }).audience.kind === "all"
          ? doc({ audience: "all" })
          : doc({ readable: false, audience: "editors" }),
      );
    expect(await run(["doc", "+share", "doc000000001", "--everyone"])).toBe(0);
    expect(await run(["doc", "+share", "doc000000001", "--editors-only"])).toBe(0);
    expect(patches().map((call) => call.body)).toEqual([{ audience: { kind: "all" } }, { audience: { kind: "editors" } }]);
    expect(apiCalls().some((call) => call.url.endsWith("/audience-options"))).toBe(false);
  });

  it("fails when the Hub ignores the audience, so a document is never left open by mistake", async () => {
    // What a Hub without `audience` on PATCH does: answers 200 with the document unchanged.
    routes[`PATCH ${H}/documents/doc000000001`] = () => json(doc({ audience: "all" }));
    expect(await run(["doc", "+share", "doc000000001", "--reader", "Hexin"])).toBe(9);
    expect(lastErr().error).toMatchObject({ type: "api", subtype: "audience_not_applied" });
  });

  it("refuses unknown or ambiguous people and mixed choices before changing anything", async () => {
    expect(await run(["doc", "+share", "doc000000001", "--reader", "Nobody"])).toBe(5);
    expect(lastErr().error).toMatchObject({ type: "not_found", subtype: "unknown_reader" });

    routes[`GET ${H}/documents/audience-options`] = () =>
      json({ ...options, projects: [{ ...options.projects[0], members: [{ userId: BOB, name: "Bob" }, { userId: HEXIN, name: "bob" }] }] });
    err = "";
    expect(await run(["doc", "+share", "doc000000001", "--reader", "Bob"])).toBe(6);
    expect(lastErr().error).toMatchObject({ type: "conflict", subtype: "ambiguous_reader" });

    expect(await run(["doc", "+share", "doc000000001"])).toBe(2);
    expect(await run(["doc", "+share", "doc000000001", "--everyone", "--reader", "Hexin"])).toBe(2);
    expect(await run(["doc", "+share", "doc000000001", "--department", "运营"])).toBe(2);
    expect(patches()).toHaveLength(0);
  });

  it("refuses a project or department name that more than one has, instead of picking one", async () => {
    const twin = { ...options.projects[0]!, publicId: "proj00000002", name: " builderspace 社团 " };
    routes[`GET ${H}/documents/audience-options`] = () => json({ ...options, projects: [...options.projects, twin] });
    expect(await run(["doc", "+share", "doc000000001", "--project", "BuilderSpace 社团"])).toBe(6);
    expect(lastErr().error).toMatchObject({ type: "conflict", subtype: "ambiguous_project" });
    err = "";
    expect(await run(["doc", "+share", "doc000000001", "--department", "BuilderSpace 社团/运营"])).toBe(6);
    expect(lastErr().error).toMatchObject({ type: "conflict", subtype: "ambiguous_project" });
    expect(patches()).toHaveLength(0);

    // The publicId still picks exactly one.
    routes[`PATCH ${H}/documents/doc000000001`] = () =>
      json(
        doc({
          readable: false,
          audience: "selected",
          readers: { users: [], groups: [{ projectPublicId: "proj00000002", departmentPublicId: null, label: "builderspace 社团" }] },
        }),
      );
    expect(await run(["doc", "+share", "doc000000001", "--project", "proj00000002"])).toBe(0);
    expect(patches()[0]!.body).toMatchObject({ audience: { groups: [{ projectPublicId: "proj00000002" }] } });

    routes[`GET ${H}/documents/audience-options`] = () =>
      json({ ...options, departments: [...options.departments, { publicId: "dept00000003", name: "运营" }] });
    err = "";
    expect(await run(["doc", "+share", "doc000000001", "--department", "proj00000001/运营"])).toBe(6);
    expect(lastErr().error).toMatchObject({ type: "conflict", subtype: "ambiguous_department" });
  });

  it("lists who can be chosen, with department names", async () => {
    expect(await run(["doc", "audience-options"])).toBe(0);
    expect(lastOut().data).toMatchObject({
      projects: [{ name: "BuilderSpace 社团", members: [{ name: "Bob Lee" }, { name: "Hexin" }], departments: [{ name: "运营", memberIds: [HEXIN] }] }],
    });
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
