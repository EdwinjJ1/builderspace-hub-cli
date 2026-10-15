import { readFile, writeFile } from "node:fs/promises";
import type { Command } from "commander";

import type { HubClient } from "../core/client.js";
import type { Deps, FileAccess } from "../core/runtime.js";
import type { BoardDetail, Card, CardDetail, Member } from "./resources.js";
import { CliError, validationError } from "../core/errors.js";
import { readLocalFile, writeLocalFile } from "../core/files.js";
import { action, requireValue } from "../core/runtime.js";
import { parseDueDate, stageNames, stageOf } from "../core/stages.js";
import { dueFlag, getBoard, getCard, memberName, resolveList, taskView } from "./resources.js";

/**
 * The rest of the everyday work: changing and deleting tasks, assigning people,
 * labels and checklists, the cross-project views (my tasks, due soon, overdue,
 * the overall board), and taking data out and bulk-adding tasks.
 *
 * Everything here uses Kan's own REST API, so it works with any API key. The
 * cross-project views are put together on the client, board by board.
 */

const nodeFiles: FileAccess = { readFile, writeFile };

const group = (program: Command, name: string, description: string) =>
  program.commands.find((command) => command.name() === name) ?? program.command(name).description(description);

const collect = (value: string, previous: string[]) => [...previous, value];

const enc = encodeURIComponent;

/* ── people and labels ───────────────────────────────────────────────── */

function resolveMember(members: Member[], who: string, myEmail?: string): Member {
  const wanted = who.trim().toLowerCase();
  const email = wanted === "me" ? myEmail?.toLowerCase() : wanted;
  const matches = members.filter(
    (member) =>
      member.publicId === who.trim() ||
      (member.user?.email ?? member.email)?.toLowerCase() === email ||
      member.user?.name?.trim().toLowerCase() === wanted,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new CliError({
      type: "conflict",
      subtype: "ambiguous_member",
      message: `「${who}」对上了不止一个成员`,
      hint: `改用邮箱或 publicId：${matches.map(memberName).join("、")}`,
    });
  }
  throw new CliError({
    type: "not_found",
    subtype: "unknown_member",
    message: `这个项目里没有叫「${who}」的成员`,
    hint: `可以用邮箱、名字或 publicId，也可以写 me。项目成员：${members.map(memberName).join("、") || "（没有）"}`,
  });
}

function resolveLabel(board: BoardDetail, who: string) {
  const labels = board.labels ?? [];
  const wanted = who.trim().toLowerCase();
  const found = labels.find((label) => label.publicId === who.trim() || label.name.trim().toLowerCase() === wanted);
  if (!found) {
    throw new CliError({
      type: "not_found",
      subtype: "unknown_label",
      message: `看板「${board.name}」上没有「${who}」这个标签`,
      hint: `可用的标签：${labels.map((label) => label.name).join("、") || "（没有）"}`,
    });
  }
  return found;
}

async function boardOfCard(client: HubClient, card: CardDetail): Promise<BoardDetail> {
  const boardId = card.list?.board?.publicId;
  if (!boardId) {
    throw new CliError({ type: "api", subtype: "unexpected_shape", message: "Hub 没有返回这个任务所在的看板" });
  }
  return getBoard(client, boardId);
}

/* ── cross-project views ─────────────────────────────────────────────── */

interface Row {
  card: Card;
  list: { publicId: string; name: string };
  board: BoardDetail;
  project: { publicId: string; name: string };
  mine: boolean;
}

/** Every task in every project the key can see, with whether it is yours. */
async function everyTask(client: HubClient, onlyProject?: string): Promise<Row[]> {
  const me = await client.request<{ email?: string }>({ method: "GET", path: "/users/me" });
  const workspaces = await client.request<{ workspace: { publicId: string; name: string } }[]>({
    method: "GET",
    path: "/workspaces",
  });
  const rows: Row[] = [];
  for (const { workspace } of workspaces) {
    if (onlyProject && workspace.publicId !== onlyProject) continue;
    const boards = await client.request<{ publicId: string }[]>({
      method: "GET",
      path: `/workspaces/${enc(workspace.publicId)}/boards`,
    });
    for (const summary of boards) {
      const board = await getBoard(client, summary.publicId);
      const mineIds = new Set(
        (board.workspace?.members ?? [])
          .filter((member) => (member.user?.email ?? member.email)?.toLowerCase() === me.email?.toLowerCase())
          .map((member) => member.publicId),
      );
      for (const list of board.lists) {
        for (const card of list.cards ?? []) {
          rows.push({
            card,
            list,
            board,
            project: workspace,
            mine: (card.members ?? []).some((member) => mineIds.has(member.publicId)),
          });
        }
      }
    }
  }
  return rows;
}

const byDue = (a: Row, b: Row) =>
  (a.card.dueDate ? Date.parse(a.card.dueDate) : Infinity) - (b.card.dueDate ? Date.parse(b.card.dueDate) : Infinity);

/** A card's members may carry only an id; the project's member list has the names. */
const assigneeNames = (board: BoardDetail, card: Card) =>
  (card.members ?? []).map((member) =>
    memberName(board.workspace?.members?.find((known) => known.publicId === member.publicId) ?? member),
  );

const rowView = (row: Row) => ({
  ...taskView(row.card, row.list, row.board),
  assignees: assigneeNames(row.board, row.card),
  project: row.project.name,
  mine: row.mine,
});

const isDone = (row: Row) => stageOf(row.list.name) === "done";

/* ── bulk add ────────────────────────────────────────────────────────── */

interface ImportItem {
  title: string;
  description?: string;
  stage?: string;
  due?: string;
  labels?: string[];
}

const MAX_IMPORT = 200;

function parseImport(text: string): ImportItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw validationError("文件不是合法的 JSON", "file");
  }
  if (!Array.isArray(parsed)) throw validationError("文件要是一个任务数组：[{ \"title\": \"…\" }, …]", "file");
  if (parsed.length === 0) throw validationError("文件里没有任务", "file");
  if (parsed.length > MAX_IMPORT) throw validationError(`一次最多导入 ${MAX_IMPORT} 个任务`, "file");
  return parsed.map((raw, index) => {
    const where = `第 ${index + 1} 项`;
    if (typeof raw !== "object" || raw === null) throw validationError(`${where}不是对象`, "file");
    const item = raw as Record<string, unknown>;
    if (typeof item.title !== "string" || !item.title.trim()) throw validationError(`${where}缺少 title`, "file");
    for (const key of ["description", "stage", "due"] as const) {
      if (item[key] !== undefined && typeof item[key] !== "string") throw validationError(`${where}的 ${key} 要是文字`, "file");
    }
    if (item.due !== undefined && !parseDueDate(item.due as string)) {
      throw validationError(`${where}的 due 要写成 YYYY-MM-DD`, "file");
    }
    if (item.labels !== undefined && !(Array.isArray(item.labels) && item.labels.every((label) => typeof label === "string"))) {
      throw validationError(`${where}的 labels 要是文字数组`, "file");
    }
    return {
      title: item.title.trim(),
      ...(item.description !== undefined ? { description: item.description as string } : {}),
      ...(item.stage !== undefined ? { stage: item.stage as string } : {}),
      ...(item.due !== undefined ? { due: item.due as string } : {}),
      ...(item.labels !== undefined ? { labels: item.labels as string[] } : {}),
    };
  });
}

export function registerWork(program: Command, deps: Deps, exit: { code: number }) {
  const project = group(program, "project", "项目（工作区）");
  const board = group(program, "board", "看板（职能）");
  const task = group(program, "task", "任务（卡片）。带 + 的是快捷命令");

  /* ── projects, boards, labels ──────────────────────────────────────── */

  project
    .command("get")
    .description("一个项目的详情和成员")
    .argument("<publicId>", "项目的 publicId")
    .action(
      action(deps, exit, async (runtime, args) => {
        const detail = await (await runtime.client()).request<{
          publicId: string;
          name: string;
          slug?: string;
          members?: (Member & { role?: string })[];
        }>({ method: "GET", path: `/workspaces/${enc(requireValue(args[0], "<publicId>"))}` });
        return {
          data: {
            publicId: detail.publicId,
            name: detail.name,
            slug: detail.slug ?? null,
            members: (detail.members ?? []).map((member) => ({
              publicId: member.publicId,
              name: memberName(member),
              role: member.role ?? null,
            })),
          },
        };
      }),
    );

  board
    .command("+overall")
    .description("总版：一个项目里开发 / 运营 / 营销所有看板的全部任务")
    .requiredOption("--project <publicId>", "项目的 publicId")
    .option("--stage <stage>", "只看某一阶段")
    .action(
      action<{ project: string; stage?: string }>(deps, exit, async (runtime, _args, options) => {
        const stage = options.stage ? stageOf(options.stage) : null;
        if (options.stage && !stage) throw validationError(`不认识的阶段：${options.stage}`, "stage");
        const rows = (await everyTask(await runtime.client(), options.project)).filter(
          (row) => !stage || stageOf(row.list.name) === stage,
        );
        const counts: Record<string, number> = {};
        for (const row of rows) counts[row.board.name] = (counts[row.board.name] ?? 0) + 1;
        return { data: rows.sort(byDue).map(rowView), meta: { count: rows.length, byBoard: counts } };
      }),
    );

  program
    .command("label")
    .description("标签")
    .command("list")
    .description("一块看板上的标签")
    .requiredOption("--board <publicId>", "看板的 publicId")
    .action(
      action<{ board: string }>(deps, exit, async (runtime, _args, options) => {
        const detail = await getBoard(await runtime.client(), options.board);
        const data = (detail.labels ?? []).map((label) => ({ publicId: label.publicId, name: label.name }));
        return { data, meta: { count: data.length, board: detail.name } };
      }),
    );

  /* ── changing tasks ────────────────────────────────────────────────── */

  task
    .command("+update")
    .description("改任务的标题或说明")
    .argument("<publicId>", "任务的 publicId")
    .option("--title <title>", "新标题")
    .option("--description <text>", "新说明")
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{ title?: string; description?: string; dryRun?: boolean }>(deps, exit, async (runtime, args, options) => {
        const publicId = requireValue(args[0], "<publicId>");
        if (options.title === undefined && options.description === undefined) {
          throw validationError("没有要改的内容：给 --title 或 --description", "title");
        }
        const client = await runtime.client();
        const spec = {
          method: "PUT" as const,
          path: `/cards/${enc(publicId)}`,
          body: {
            ...(options.title !== undefined ? { title: requireValue(options.title.trim(), "--title") } : {}),
            ...(options.description !== undefined ? { description: options.description } : {}),
          },
        };
        if (options.dryRun) return { data: client.describe(spec), meta: { dryRun: true } };
        await client.request(spec);
        return { data: { publicId, updated: Object.keys(spec.body) } };
      }),
    );

  task
    .command("+delete")
    .description("删除任务（要加 --yes 确认）")
    .argument("<publicId>", "任务的 publicId")
    .option("--yes", "确认删除")
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{ yes?: boolean; dryRun?: boolean }>(deps, exit, async (runtime, args, options) => {
        const publicId = requireValue(args[0], "<publicId>");
        const client = await runtime.client();
        const spec = { method: "DELETE" as const, path: `/cards/${enc(publicId)}` };
        if (options.dryRun) return { data: client.describe(spec), meta: { dryRun: true } };
        if (!options.yes) {
          throw validationError("删除任务不能撤销，要加 --yes 确认", "yes", `先用 bshub task +get ${publicId} 看一眼，确认后加 --yes。`);
        }
        await client.request(spec);
        return { data: { publicId, deleted: true } };
      }),
    );

  for (const [name, assigning] of [["+assign", true], ["+unassign", false]] as const) {
    task
      .command(name)
      .description(assigning ? "把任务指派给某人（已经指派过就什么也不做）" : "取消某人对任务的指派")
      .argument("<publicId>", "任务的 publicId")
      .requiredOption("--member <who>", "邮箱、名字、成员 publicId，或 me")
      .option("--dry-run", "只打印将要发出的请求")
      .action(
        action<{ member: string; dryRun?: boolean }>(deps, exit, async (runtime, args, options) => {
          const client = await runtime.client();
          const card = await getCard(client, requireValue(args[0], "<publicId>"));
          const detail = await boardOfCard(client, card);
          const me = options.member.trim().toLowerCase() === "me"
            ? await client.request<{ email?: string }>({ method: "GET", path: "/users/me" })
            : undefined;
          const member = resolveMember(detail.workspace?.members ?? [], options.member, me?.email);
          const assigned = (card.members ?? []).some((existing) => existing.publicId === member.publicId);
          const result = { publicId: card.publicId, member: memberName(member) };
          if (assigned === assigning) return { data: { ...result, changed: false } };

          // Kan only offers a toggle, so the current state was checked above.
          const spec = {
            method: "PUT" as const,
            path: `/cards/${enc(card.publicId)}/members/${enc(member.publicId)}`,
          };
          if (options.dryRun) return { data: client.describe(spec), meta: { dryRun: true } };
          const response = await client.request<{ newMember?: boolean }>(spec);
          if (response?.newMember !== assigning) {
            throw new CliError({
              type: "conflict",
              subtype: "changed_meanwhile",
              message: "这个任务的指派刚被别人改过，结果和预期相反",
              hint: `重新看一眼：bshub task +get ${card.publicId}`,
            });
          }
          return { data: { ...result, changed: true, assigned: assigning } };
        }),
      );
  }

  task
    .command("+label")
    .description("给任务加标签，或用 --remove 去掉")
    .argument("<publicId>", "任务的 publicId")
    .requiredOption("--label <name>", "标签的名字或 publicId（bshub label list --board）")
    .option("--remove", "去掉这个标签")
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{ label: string; remove?: boolean; dryRun?: boolean }>(deps, exit, async (runtime, args, options) => {
        const client = await runtime.client();
        const card = await getCard(client, requireValue(args[0], "<publicId>"));
        const label = resolveLabel(await boardOfCard(client, card), options.label);
        const has = (card.labels ?? []).some((existing) => existing.publicId === label.publicId);
        const wanted = !options.remove;
        const result = { publicId: card.publicId, label: label.name };
        if (has === wanted) return { data: { ...result, changed: false } };
        const spec = {
          method: "PUT" as const,
          path: `/cards/${enc(card.publicId)}/labels/${enc(label.publicId)}`,
        };
        if (options.dryRun) return { data: client.describe(spec), meta: { dryRun: true } };
        const response = await client.request<{ newLabel?: boolean }>(spec);
        if (response?.newLabel !== wanted) {
          throw new CliError({
            type: "conflict",
            subtype: "changed_meanwhile",
            message: "这个任务的标签刚被别人改过，结果和预期相反",
            hint: `重新看一眼：bshub task +get ${card.publicId}`,
          });
        }
        return { data: { ...result, changed: true, labelled: wanted } };
      }),
    );

  task
    .command("+checklist")
    .description("给任务新建一个检查清单，可以同时加条目")
    .argument("<publicId>", "任务的 publicId")
    .requiredOption("--name <name>", "清单名")
    .option("--item <title>", "清单条目，可重复", collect, [] as string[])
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{ name: string; item: string[]; dryRun?: boolean }>(deps, exit, async (runtime, args, options) => {
        const publicId = requireValue(args[0], "<publicId>");
        const client = await runtime.client();
        const create = {
          method: "POST" as const,
          path: `/cards/${enc(publicId)}/checklists`,
          body: { name: requireValue(options.name.trim(), "--name") },
        };
        if (options.dryRun) {
          return {
            data: [
              client.describe(create),
              ...options.item.map((title) => client.describe({ method: "POST", path: "/checklists/<新清单>/items", body: { title } })),
            ],
            meta: { dryRun: true },
          };
        }
        const checklist = await client.request<{ publicId: string }>(create);
        const items: { publicId: string; title: string }[] = [];
        for (const title of options.item) {
          try {
            const item = await client.request<{ publicId: string }>({
              method: "POST",
              path: `/checklists/${enc(checklist.publicId)}/items`,
              body: { title },
            });
            items.push({ publicId: item.publicId, title });
          } catch (error) {
            const cause = error instanceof CliError ? error : undefined;
            throw new CliError({
              type: cause?.type ?? "api",
              subtype: "checklist_incomplete",
              message: `清单「${options.name.trim()}」建好了，但条目「${title}」没加上：${error instanceof Error ? error.message : String(error)}`,
              hint: `清单 ${checklist.publicId} 已存在，里面有 ${items.length} 个条目。不要重跑整条命令（会再建一个清单）；用网页补上剩下的 ${options.item.length - items.length} 个条目。`,
              status: cause?.status,
              retryable: false,
            });
          }
        }
        return { data: { publicId: checklist.publicId, name: options.name.trim(), items } };
      }),
    );

  task
    .command("+check")
    .description("勾选清单条目，或用 --undo 取消勾选")
    .argument("<itemPublicId>", "清单条目的 publicId（bshub task +get 里能看到）")
    .option("--undo", "取消勾选")
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{ undo?: boolean; dryRun?: boolean }>(deps, exit, async (runtime, args, options) => {
        const publicId = requireValue(args[0], "<itemPublicId>");
        const client = await runtime.client();
        const spec = {
          method: "PATCH" as const,
          path: `/checklists/items/${enc(publicId)}`,
          body: { completed: !options.undo },
        };
        if (options.dryRun) return { data: client.describe(spec), meta: { dryRun: true } };
        await client.request(spec);
        return { data: { publicId, completed: !options.undo } };
      }),
    );

  task
    .command("+activity")
    .description("一个任务的变更记录")
    .argument("<publicId>", "任务的 publicId")
    .action(
      action(deps, exit, async (runtime, args) => {
        const data = await (await runtime.client()).request({
          method: "GET",
          path: `/cards/${enc(requireValue(args[0], "<publicId>"))}/activities`,
        });
        return { data };
      }),
    );

  /* ── my tasks, due soon, overdue ───────────────────────────────────── */

  task
    .command("+mine")
    .description("指派给我的任务，跨所有项目（默认不含已完成）")
    .option("--project <publicId>", "只看一个项目")
    .option("--include-done", "也列出已完成的")
    .action(
      action<{ project?: string; includeDone?: boolean }>(deps, exit, async (runtime, _args, options) => {
        const rows = (await everyTask(await runtime.client(), options.project))
          .filter((row) => row.mine && (options.includeDone || !isDone(row)))
          .sort(byDue);
        return { data: rows.map(rowView), meta: { count: rows.length } };
      }),
    );

  task
    .command("+due-soon")
    .description("快到期的任务：从现在起 N 天内（默认 7 天、只看我的、不含已完成）")
    .option("--days <n>", "几天内", "7")
    .option("--project <publicId>", "只看一个项目")
    .option("--all", "不只看我的")
    .action(
      action<{ days: string; project?: string; all?: boolean }>(deps, exit, async (runtime, _args, options) => {
        const days = Number(options.days);
        if (!Number.isInteger(days) || days < 1 || days > 365) throw validationError("--days 要是 1 到 365 的整数", "days");
        const now = Date.now();
        const until = now + days * 86_400_000;
        const rows = (await everyTask(await runtime.client(), options.project))
          .filter((row) => {
            const due = row.card.dueDate ? Date.parse(row.card.dueDate) : NaN;
            return (options.all || row.mine) && !isDone(row) && due >= now && due <= until;
          })
          .sort(byDue);
        return { data: rows.map(rowView), meta: { count: rows.length, days } };
      }),
    );

  task
    .command("+overdue")
    .description("已逾期的任务（默认只看我的、不含已完成）")
    .option("--project <publicId>", "只看一个项目")
    .option("--all", "不只看我的")
    .action(
      action<{ project?: string; all?: boolean }>(deps, exit, async (runtime, _args, options) => {
        const now = Date.now();
        const rows = (await everyTask(await runtime.client(), options.project))
          .filter((row) => {
            const due = row.card.dueDate ? Date.parse(row.card.dueDate) : NaN;
            return (options.all || row.mine) && !isDone(row) && due < now;
          })
          .sort(byDue);
        return { data: rows.map(rowView), meta: { count: rows.length } };
      }),
    );

  /* ── taking data out, bulk adding ──────────────────────────────────── */

  program
    .command("export")
    .description("把一个项目的看板、列和任务导出成 JSON（备份用）")
    .requiredOption("--project <publicId>", "项目的 publicId")
    .option("--out <path>", "写到文件；不给就直接在输出里")
    .action(
      action<{ project: string; out?: string }>(deps, exit, async (runtime, _args, options) => {
        const client = await runtime.client();
        const summaries = await client.request<{ publicId: string }[]>({
          method: "GET",
          path: `/workspaces/${enc(options.project)}/boards`,
        });
        const boards = [];
        let tasks = 0;
        for (const summary of summaries) {
          const detail = await getBoard(client, summary.publicId);
          boards.push({
            publicId: detail.publicId,
            name: detail.name,
            labels: (detail.labels ?? []).map((label) => label.name),
            lists: detail.lists.map((list) => ({
              name: list.name,
              stage: stageOf(list.name),
              cards: (list.cards ?? []).map((card) => {
                tasks += 1;
                return {
                  publicId: card.publicId,
                  title: card.title,
                  description: card.description ?? null,
                  due: card.dueDate ?? null,
                  labels: (card.labels ?? []).map((label) => label.name),
                  assignees: assigneeNames(detail, card),
                };
              }),
            })),
          });
        }
        const snapshot = { exportedAt: new Date().toISOString(), project: options.project, boards };
        if (options.out) {
          await writeLocalFile(deps.files ?? nodeFiles, options.out, new TextEncoder().encode(`${JSON.stringify(snapshot, null, 2)}\n`));
          return { data: { out: options.out, boards: boards.length, tasks } };
        }
        return { data: snapshot, meta: { boards: boards.length, tasks } };
      }),
    );

  task
    .command("+import")
    .description("从 JSON 文件批量新建任务：[{ title, description?, stage?, due?, labels? }, …]")
    .requiredOption("--board <publicId>", "加到哪块看板")
    .requiredOption("--file <path>", "JSON 文件")
    .option("--dry-run", "只检查文件、列出会新建的任务，不真的新建")
    .action(
      action<{ board: string; file: string; dryRun?: boolean }>(deps, exit, async (runtime, _args, options) => {
        const text = new TextDecoder().decode(await readLocalFile(deps.files ?? nodeFiles, options.file));
        const items = parseImport(text);
        const client = await runtime.client();
        const detail = await getBoard(client, options.board);

        // Resolve everything first so a typo in item 40 does not leave 39 half-added.
        const plan = items.map((item) => ({
          item,
          list: resolveList(detail, item.stage ?? stageNames.todo),
          labels: (item.labels ?? []).map((name) => resolveLabel(detail, name)),
        }));
        if (options.dryRun) {
          return {
            data: plan.map(({ item, list, labels }) => ({ title: item.title, list: list.name, due: item.due ?? null, labels: labels.map((l) => l.name) })),
            meta: { dryRun: true, count: plan.length, board: detail.name },
          };
        }

        const created: { publicId: string; title: string; list: string }[] = [];
        for (const { item, list, labels } of plan) {
          try {
            const card = await client.request<{ publicId: string }>({
              method: "POST",
              path: "/cards",
              body: {
                title: item.title,
                description: item.description ?? "",
                listPublicId: list.publicId,
                labelPublicIds: labels.map((label) => label.publicId),
                memberPublicIds: [],
                position: "end",
                ...(item.due ? { dueDate: dueFlag(item.due).toISOString() } : {}),
              },
            });
            created.push({ publicId: card.publicId, title: item.title, list: list.name });
          } catch (error) {
            const cause = error instanceof CliError ? error : undefined;
            throw new CliError({
              type: cause?.type ?? "api",
              subtype: "import_stopped",
              message: `导入在第 ${created.length + 1} 项（${item.title}）停了：${error instanceof Error ? error.message : String(error)}`,
              hint: `已经新建了 ${created.length} 项，不要整份重跑；从第 ${created.length + 1} 项开始补。已建的 publicId：${created.map((c) => c.publicId).join("、") || "（没有）"}`,
              status: cause?.status,
              retryable: cause?.retryable,
            });
          }
        }
        return { data: created, meta: { count: created.length, board: detail.name } };
      }),
    );

}
