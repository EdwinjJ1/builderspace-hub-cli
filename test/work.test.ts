import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Deps, FileAccess } from "../src/core/runtime.js";
import { runCli } from "../src/cli.js";

/** The task, view, export and import commands, against a fake Hub with two projects. */

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const KEY = `kan_${"x".repeat(20)}cdef`;
const H = "http://localhost:3210/api/v1";
const day = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();

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
  const call: Call = {
    method: init?.method ?? "GET",
    path: url.pathname,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
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

function deps(): Deps {
  return {
    writer: { out: (text) => void (out += text), err: (text) => void (err += text) },
    env: { BSHUB_CONFIG_DIR: configDir, BSHUB_URL: "http://localhost:3210", BSHUB_API_KEY: KEY },
    fetch: fakeFetch,
    readSecret: async () => KEY,
    readStdin: async () => "",
    isInteractive: false,
    files,
  };
}

const run = (args: string[]) => runCli(args, deps());
const lastOut = () => JSON.parse(out) as { ok: boolean; data: any; meta?: Record<string, any> };
const lastErr = () => JSON.parse(err) as { error: Record<string, unknown> };
const writes = () => calls.filter((call) => call.method !== "GET");

const members = [
  { publicId: "memb00000001", email: "me@example.test", user: { name: "Me", email: "me@example.test" } },
  { publicId: "memb00000002", email: "bob@example.test", user: { name: "Bob", email: "bob@example.test" } },
];
const labels = [
  { publicId: "labl00000001", name: "紧急" },
  { publicId: "labl00000002", name: "文档" },
];

// Project A / board 运营: my overdue task, someone else's task, a done task of mine.
const boardA = {
  publicId: "boardA000001",
  name: "运营",
  labels,
  workspace: { publicId: "projA0000001", members },
  lists: [
    {
      publicId: "listA0000001",
      name: "待办",
      cards: [
        { publicId: "cardA0000001", title: "我的逾期", dueDate: iso(-2), members: [{ publicId: "memb00000001" }], labels: [] },
        { publicId: "cardA0000002", title: "Bob 的", dueDate: iso(2), members: [{ publicId: "memb00000002" }], labels: [] },
      ],
    },
    { publicId: "listA0000002", name: "进行中", cards: [] },
    {
      publicId: "listA0000003",
      name: "已完成",
      cards: [{ publicId: "cardA0000003", title: "我做完的", dueDate: iso(-5), members: [{ publicId: "memb00000001" }], labels: [] }],
    },
  ],
};
// Project B / board 开发: my task due in three days, one without a due date.
const boardB = {
  publicId: "boardB000001",
  name: "开发",
  labels: [],
  workspace: { publicId: "projB0000001", members },
  lists: [
    {
      publicId: "listB0000001",
      name: "待办",
      cards: [
        { publicId: "cardB0000001", title: "三天后", dueDate: iso(3), members: [{ publicId: "memb00000001" }], labels: [] },
        { publicId: "cardB0000002", title: "没日期", dueDate: null, members: [{ publicId: "memb00000001" }], labels: [] },
      ],
    },
  ],
};

const cardDetail = (overrides: Record<string, unknown> = {}) => ({
  publicId: "cardA0000001",
  title: "我的逾期",
  list: { publicId: "listA0000001", name: "待办", board: { publicId: "boardA000001", name: "运营" } },
  members: [],
  labels: [],
  ...overrides,
});

beforeEach(async () => {
  calls = [];
  out = "";
  err = "";
  disk = new Map();
  configDir = await mkdtemp(join(tmpdir(), "bshub-work-"));
  routes = {
    [`GET ${H}/users/me`]: () => json({ id: "u1", email: "me@example.test" }),
    [`GET ${H}/workspaces`]: () =>
      json([
        { role: "admin", workspace: { publicId: "projA0000001", name: "社群" } },
        { role: "member", workspace: { publicId: "projB0000001", name: "CourseMate" } },
      ]),
    [`GET ${H}/workspaces/projA0000001/boards`]: () => json([{ publicId: "boardA000001" }]),
    [`GET ${H}/workspaces/projB0000001/boards`]: () => json([{ publicId: "boardB000001" }]),
    [`GET ${H}/boards/boardA000001`]: () => json(boardA),
    [`GET ${H}/boards/boardB000001`]: () => json(boardB),
    [`GET ${H}/cards/cardA0000001`]: () => json(cardDetail()),
  };
});

describe("project get / label list", () => {
  it("shows a project's members", async () => {
    routes[`GET ${H}/workspaces/projA0000001`] = () =>
      json({ publicId: "projA0000001", name: "社群", slug: "she-qun", members: members.map((m) => ({ ...m, role: "admin" })) });
    expect(await run(["project", "get", "projA0000001"])).toBe(0);
    expect(lastOut().data).toMatchObject({ name: "社群", members: [{ name: "Me", role: "admin" }, { name: "Bob" }] });
  });

  it("lists a board's labels", async () => {
    expect(await run(["label", "list", "--board", "boardA000001"])).toBe(0);
    expect(lastOut().data).toEqual([
      { publicId: "labl00000001", name: "紧急" },
      { publicId: "labl00000002", name: "文档" },
    ]);
  });
});

describe("changing tasks", () => {
  it("updates the title and description", async () => {
    routes[`PUT ${H}/cards/cardA0000001`] = () => json({ publicId: "cardA0000001" });
    expect(await run(["task", "+update", "cardA0000001", "--title", "新标题", "--description", "说明"])).toBe(0);
    expect(calls[0]).toMatchObject({ method: "PUT", body: { title: "新标题", description: "说明" } });
    expect(await run(["task", "+update", "cardA0000001"])).toBe(2);
  });

  it("will not delete without --yes, and shows the request on --dry-run", async () => {
    routes[`DELETE ${H}/cards/cardA0000001`] = () => json({ publicId: "cardA0000001" });
    expect(await run(["task", "+delete", "cardA0000001"])).toBe(2);
    expect(writes()).toHaveLength(0);
    out = "";
    expect(await run(["task", "+delete", "cardA0000001", "--dry-run"])).toBe(0);
    expect(writes()).toHaveLength(0);
    expect(await run(["task", "+delete", "cardA0000001", "--yes"])).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: "DELETE" })]);
  });
});

describe("assigning", () => {
  it("assigns by email, and does nothing when already assigned", async () => {
    routes[`PUT ${H}/cards/cardA0000001/members/memb00000002`] = () => json({ newMember: true });
    expect(await run(["task", "+assign", "cardA0000001", "--member", "bob@example.test"])).toBe(0);
    expect(lastOut().data).toMatchObject({ member: "Bob", changed: true });
    expect(writes()).toHaveLength(1);

    routes[`GET ${H}/cards/cardA0000001`] = () => json(cardDetail({ members: [{ publicId: "memb00000002" }] }));
    calls = [];
    out = "";
    expect(await run(["task", "+assign", "cardA0000001", "--member", "Bob"])).toBe(0);
    expect(lastOut().data).toMatchObject({ changed: false });
    expect(writes()).toHaveLength(0);
  });

  it("resolves me through the account behind the key, and unassigns", async () => {
    routes[`GET ${H}/cards/cardA0000001`] = () => json(cardDetail({ members: [{ publicId: "memb00000001" }] }));
    routes[`PUT ${H}/cards/cardA0000001/members/memb00000001`] = () => json({ newMember: false });
    expect(await run(["task", "+unassign", "cardA0000001", "--member", "me"])).toBe(0);
    expect(lastOut().data).toMatchObject({ member: "Me", changed: true, assigned: false });
  });

  it("names the people available when it cannot find one", async () => {
    expect(await run(["task", "+assign", "cardA0000001", "--member", "nobody"])).toBe(5);
    expect(lastErr().error).toMatchObject({ subtype: "unknown_member" });
    expect(String(lastErr().error.hint)).toContain("Bob");
  });

  it("reports a concurrent change instead of claiming success", async () => {
    routes[`PUT ${H}/cards/cardA0000001/members/memb00000002`] = () => json({ newMember: false });
    expect(await run(["task", "+assign", "cardA0000001", "--member", "Bob"])).toBe(6);
    expect(lastErr().error).toMatchObject({ subtype: "changed_meanwhile" });
  });
});

describe("labels and checklists", () => {
  it("adds a label by name once, and lists the labels when the name is wrong", async () => {
    routes[`PUT ${H}/cards/cardA0000001/labels/labl00000001`] = () => json({ newLabel: true });
    expect(await run(["task", "+label", "cardA0000001", "--label", "紧急"])).toBe(0);
    expect(lastOut().data).toMatchObject({ label: "紧急", changed: true });

    expect(await run(["task", "+label", "cardA0000001", "--label", "没有的"])).toBe(5);
    expect(String(lastErr().error.hint)).toContain("紧急");
  });

  it("compares by name when the card's label comes without an id, instead of toggling it off", async () => {
    routes[`GET ${H}/cards/cardA0000001`] = () => json(cardDetail({ labels: [{ name: "紧急" }] }));
    expect(await run(["task", "+label", "cardA0000001", "--label", "紧急"])).toBe(0);
    expect(lastOut().data).toMatchObject({ changed: false });
    expect(writes()).toHaveLength(0);
  });

  it("leaves a label alone that is already on the card when adding", async () => {
    routes[`GET ${H}/cards/cardA0000001`] = () => json(cardDetail({ labels: [{ publicId: "labl00000001", name: "紧急" }] }));
    expect(await run(["task", "+label", "cardA0000001", "--label", "紧急"])).toBe(0);
    expect(lastOut().data).toMatchObject({ changed: false });
    expect(writes()).toHaveLength(0);
  });

  it("reports a label that flipped the wrong way instead of claiming success", async () => {
    routes[`PUT ${H}/cards/cardA0000001/labels/labl00000001`] = () => json({ newLabel: false });
    expect(await run(["task", "+label", "cardA0000001", "--label", "紧急"])).toBe(6);
    expect(lastErr().error).toMatchObject({ subtype: "changed_meanwhile" });
  });

  it("says what exists when a checklist item fails half-way", async () => {
    routes[`POST ${H}/cards/cardA0000001/checklists`] = () => json({ publicId: "chkl00000001" });
    let n = 0;
    routes[`POST ${H}/checklists/chkl00000001/items`] = () =>
      ++n === 2 ? json({ message: "boom" }, 500) : json({ publicId: `item0000000${n}` });
    expect(await run(["task", "+checklist", "cardA0000001", "--name", "上线前", "--item", "一", "--item", "二", "--item", "三"])).toBe(9);
    expect(lastErr().error).toMatchObject({ subtype: "checklist_incomplete" });
    const hint = String(lastErr().error.hint);
    expect(hint).toContain("chkl00000001");
    expect(hint).toContain("不要重跑");
  });

  it("creates a checklist with its items", async () => {
    routes[`POST ${H}/cards/cardA0000001/checklists`] = () => json({ publicId: "chkl00000001" });
    let n = 0;
    routes[`POST ${H}/checklists/chkl00000001/items`] = () => json({ publicId: `item0000000${++n}` });
    expect(await run(["task", "+checklist", "cardA0000001", "--name", "上线前", "--item", "测试", "--item", "发布"])).toBe(0);
    expect(writes().map((call) => call.body)).toEqual([{ name: "上线前" }, { title: "测试" }, { title: "发布" }]);
    expect(lastOut().data.items).toHaveLength(2);
  });

  it("ticks and unticks an item", async () => {
    routes[`PATCH ${H}/checklists/items/item00000001`] = () => json({ publicId: "item00000001" });
    expect(await run(["task", "+check", "item00000001"])).toBe(0);
    expect(await run(["task", "+check", "item00000001", "--undo"])).toBe(0);
    expect(writes().map((call) => call.body)).toEqual([{ completed: true }, { completed: false }]);
  });
});

describe("cross-project views", () => {
  it("+mine lists my open tasks from every project, soonest first, without the done ones", async () => {
    expect(await run(["task", "+mine"])).toBe(0);
    expect(lastOut().data.map((row: { title: string }) => row.title)).toEqual(["我的逾期", "三天后", "没日期"]);
    expect(lastOut().data[0]).toMatchObject({ project: "社群", board: "运营", stage: "todo", mine: true });
  });

  it("+mine --include-done adds the finished ones", async () => {
    expect(await run(["task", "+mine", "--include-done"])).toBe(0);
    expect(lastOut().meta).toEqual({ count: 4 });
  });

  it("will not guess who you are when the Hub gives no email, instead of calling everyone's tasks yours", async () => {
    routes[`GET ${H}/users/me`] = () => json({ id: "u1" });
    expect(await run(["task", "+mine"])).toBe(9);
    expect(lastErr().error).toMatchObject({ subtype: "unexpected_shape" });
  });

  it("+overdue finds only my late, unfinished tasks", async () => {
    expect(await run(["task", "+overdue"])).toBe(0);
    expect(lastOut().data.map((row: { title: string }) => row.title)).toEqual(["我的逾期"]);
  });

  it("+due-soon looks N days ahead and can include everyone", async () => {
    expect(await run(["task", "+due-soon", "--days", "7"])).toBe(0);
    expect(lastOut().data.map((row: { title: string }) => row.title)).toEqual(["三天后"]);
    out = "";
    expect(await run(["task", "+due-soon", "--days", "7", "--all"])).toBe(0);
    expect(lastOut().data.map((row: { title: string }) => row.title)).toEqual(["Bob 的", "三天后"]);
    expect(await run(["task", "+due-soon", "--days", "0"])).toBe(2);
  });

  it("says so when the project filter matches nothing, instead of an empty success", async () => {
    for (const args of [["task", "+mine"], ["task", "+overdue"], ["task", "+due-soon"], ["board", "+overall"]]) {
      err = "";
      expect(await run([...args, "--project", "projNOPE0001"])).toBe(5);
      expect(lastErr().error).toMatchObject({ subtype: "unknown_project" });
      expect(String(lastErr().error.hint)).toContain("社群");
    }
  });

  it("board +overall gathers one project's boards and counts them", async () => {
    expect(await run(["board", "+overall", "--project", "projA0000001"])).toBe(0);
    expect(lastOut().meta).toEqual({ count: 3, byBoard: { 运营: 3 } });
  });
});

describe("export and import", () => {
  it("previews an export without reading boards or writing the file", async () => {
    expect(await run(["export", "--project", "projA0000001", "--out", "/tmp/backup.json", "--dry-run"])).toBe(0);
    expect(calls).toHaveLength(0);
    expect(disk.has("/tmp/backup.json")).toBe(false);
  });

  it("exports a project to a file", async () => {
    expect(await run(["export", "--project", "projA0000001", "--out", "/tmp/backup.json"])).toBe(0);
    const snapshot = JSON.parse(new TextDecoder().decode(disk.get("/tmp/backup.json")));
    expect(snapshot.boards[0]).toMatchObject({ name: "运营", labels: ["紧急", "文档"] });
    expect(snapshot.boards[0].lists[0].cards[0]).toMatchObject({ title: "我的逾期", assignees: ["Me"] });
    expect(lastOut().data).toMatchObject({ boards: 1, tasks: 3 });
  });

  const file = (value: unknown) => disk.set("/tmp/tasks.json", new TextEncoder().encode(JSON.stringify(value)));

  it("imports tasks and sends each to the right column", async () => {
    file([{ title: "赞助介绍", stage: "todo", due: "2026-10-20", labels: ["文档"] }, { title: "海报", stage: "进行中" }]);
    let n = 0;
    routes[`POST ${H}/cards`] = () => json({ publicId: `new0000000${++n}` });
    expect(await run(["task", "+import", "--board", "boardA000001", "--file", "/tmp/tasks.json"])).toBe(0);

    expect(writes()).toHaveLength(2);
    expect(writes()[0]!.body).toMatchObject({ title: "赞助介绍", listPublicId: "listA0000001", labelPublicIds: ["labl00000002"] });
    expect(writes()[1]!.body).toMatchObject({ title: "海报", listPublicId: "listA0000002" });
    expect(lastOut().meta).toMatchObject({ count: 2 });
  });

  it("checks everything before sending anything", async () => {
    file([{ title: "好的" }, { title: "坏的", labels: ["没有这个标签"] }]);
    expect(await run(["task", "+import", "--board", "boardA000001", "--file", "/tmp/tasks.json"])).toBe(5);
    expect(writes()).toHaveLength(0);

    file([{ title: "x", due: "明天" }]);
    expect(await run(["task", "+import", "--board", "boardA000001", "--file", "/tmp/tasks.json"])).toBe(2);
    file({ title: "不是数组" });
    expect(await run(["task", "+import", "--board", "boardA000001", "--file", "/tmp/tasks.json"])).toBe(2);
    expect(writes()).toHaveLength(0);
  });

  it("tells a missing import file apart from a bad one", async () => {
    expect(await run(["task", "+import", "--board", "boardA000001", "--file", "/tmp/nope.json"])).toBe(5);
    expect(lastErr().error).toMatchObject({ subtype: "file_not_found" });
  });

  it("--dry-run lists the plan without creating", async () => {
    file([{ title: "赞助介绍" }]);
    expect(await run(["task", "+import", "--board", "boardA000001", "--file", "/tmp/tasks.json", "--dry-run"])).toBe(0);
    expect(writes()).toHaveLength(0);
    expect(lastOut().meta).toMatchObject({ dryRun: true, count: 1 });
  });

  it("stops at the first rejected item and says where to resume", async () => {
    file([{ title: "一" }, { title: "二" }, { title: "三" }]);
    let n = 0;
    routes[`POST ${H}/cards`] = () => (++n === 2 ? json({ message: "bad title" }, 400) : json({ publicId: `new0000000${n}` }));
    expect(await run(["task", "+import", "--board", "boardA000001", "--file", "/tmp/tasks.json"])).toBe(2);
    expect(lastErr().error).toMatchObject({ subtype: "import_stopped" });
    expect(String(lastErr().error.hint)).toContain("从第 2 项开始补");
    expect(writes()).toHaveLength(2);
  });

  it("does not tell you to resume at an item whose reply was lost: it may exist", async () => {
    file([{ title: "一" }, { title: "二" }]);
    let n = 0;
    routes[`POST ${H}/cards`] = () => (++n === 2 ? json({ message: "gateway" }, 502) : json({ publicId: `new0000000${n}` }));
    expect(await run(["task", "+import", "--board", "boardA000001", "--file", "/tmp/tasks.json"])).toBe(9);
    const hint = String(lastErr().error.hint);
    expect(hint).toContain("可能已经建好了");
    expect(hint).toContain("先在看板上看一眼");
    expect(lastErr().error.retryable).toBeUndefined();
  });

  it("--dry-run describes every request that would be sent", async () => {
    file([{ title: "赞助介绍", due: "2026-10-20", labels: ["文档"] }]);
    expect(await run(["task", "+import", "--board", "boardA000001", "--file", "/tmp/tasks.json", "--dry-run"])).toBe(0);
    const [request] = lastOut().data as { method: string; url: string; body: Record<string, unknown> }[];
    expect(request).toMatchObject({ method: "POST", body: { title: "赞助介绍", listPublicId: "listA0000001", labelPublicIds: ["labl00000002"], position: "end" } });
    expect(request!.url).toContain("/cards");
    expect(writes()).toHaveLength(0);
  });
});
