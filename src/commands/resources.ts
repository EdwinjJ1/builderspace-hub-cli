import type { Command } from "commander";

import type { HubClient } from "../core/client.js";
import type { Deps } from "../core/runtime.js";
import { CliError, validationError } from "../core/errors.js";
import { findList, parseDueDate, stageNames, stageOf } from "../core/stages.js";
import { action, requireValue } from "../core/runtime.js";

/**
 * Projects, boards and tasks: the shortcuts people and agents use most.
 * A project is a Kan workspace, a function (技术 / 活动 / 宣传) is a board,
 * a task is a card and its column is a list.
 */

export interface Member {
  publicId: string;
  email?: string;
  user?: { name?: string | null; email?: string } | null;
}

export interface Card {
  publicId: string;
  title: string;
  description?: string | null;
  dueDate?: string | null;
  labels?: { publicId?: string; name: string }[];
  members?: Member[];
  checklists?: { publicId: string; name: string; items?: { publicId: string; title: string; completed: boolean }[] }[];
}

export interface List {
  publicId: string;
  name: string;
  index?: number;
  cards?: Card[];
}

export interface BoardDetail {
  publicId: string;
  name: string;
  lists: List[];
  labels?: { publicId: string; name: string }[];
  workspace?: { publicId: string; name?: string; members?: Member[] };
}

export interface CardDetail extends Card {
  list?: { publicId: string; name: string; board?: { publicId: string; name: string } };
}

export const memberName = (member: Member) =>
  member.user?.name?.trim() || member.user?.email || member.email || member.publicId;

/** One task as the CLI prints it: flat, with its column and stage. */
export function taskView(card: Card, list: { publicId: string; name: string }, board?: { publicId: string; name: string }) {
  return {
    publicId: card.publicId,
    title: card.title,
    list: list.name,
    stage: stageOf(list.name),
    due: card.dueDate ?? null,
    labels: (card.labels ?? []).map((label) => label.name),
    assignees: (card.members ?? []).map(memberName),
    ...(board ? { board: board.name } : {}),
  };
}

export const getBoard = (client: HubClient, boardId: string) =>
  client.request<BoardDetail>({ method: "GET", path: `/boards/${encodeURIComponent(boardId)}` });

export const getCard = (client: HubClient, cardId: string) =>
  client.request<CardDetail>({ method: "GET", path: `/cards/${encodeURIComponent(cardId)}` });

export function resolveList(board: BoardDetail, target: string) {
  const list = findList(board.lists, target);
  if (!list) {
    throw new CliError({
      type: "not_found",
      subtype: "unknown_list",
      message: `看板「${board.name}」里没有「${target}」这一列`,
      hint: `可用的列：${board.lists.map((l) => l.name).join("、")}；也可以用 ${Object.values(stageNames).join(" / ")} 或 todo / doing / review / done。`,
    });
  }
  return list;
}

export function dueFlag(value: string): Date {
  const due = parseDueDate(value);
  if (!due) throw validationError("日期要写成 YYYY-MM-DD", "due");
  return due;
}

export function registerResources(program: Command, deps: Deps, exit: { code: number }) {
  // ── projects ────────────────────────────────────────────────────────────
  const project = program.command("project").description("项目（工作区）");

  project
    .command("list")
    .description("你加入的项目")
    .action(
      action(deps, exit, async (runtime) => {
        const rows = await (await runtime.client()).request<
          { role?: string; workspace: { publicId: string; name: string; slug?: string } }[]
        >({ method: "GET", path: "/workspaces" });
        const data = rows.map((row) => ({
          publicId: row.workspace.publicId,
          name: row.workspace.name,
          slug: row.workspace.slug ?? null,
          role: row.role ?? null,
        }));
        return { data, meta: { count: data.length } };
      }),
    );

  // ── boards ──────────────────────────────────────────────────────────────
  const board = program.command("board").description("看板（职能）");

  board
    .command("list")
    .description("一个项目里的看板")
    .requiredOption("--project <publicId>", "项目的 publicId（bshub project list）")
    .action(
      action<{ project: string }>(deps, exit, async (runtime, _args, options) => {
        const rows = await (await runtime.client()).request<
          { publicId: string; name: string; lists?: { name: string }[] }[]
        >({ method: "GET", path: `/workspaces/${encodeURIComponent(options.project)}/boards` });
        const data = rows.map((row) => ({
          publicId: row.publicId,
          name: row.name,
          lists: (row.lists ?? []).map((list) => list.name),
        }));
        return { data, meta: { count: data.length } };
      }),
    );

  board
    .command("get")
    .description("一块看板的列和每列的任务数")
    .argument("<publicId>", "看板的 publicId")
    .action(
      action(deps, exit, async (runtime, args) => {
        const detail = await getBoard(await runtime.client(), requireValue(args[0], "<publicId>"));
        return {
          data: {
            publicId: detail.publicId,
            name: detail.name,
            lists: detail.lists.map((list) => ({
              publicId: list.publicId,
              name: list.name,
              stage: stageOf(list.name),
              tasks: list.cards?.length ?? 0,
            })),
          },
        };
      }),
    );

  // ── tasks (shortcuts) ───────────────────────────────────────────────────
  const task = program.command("task").description("任务（卡片）。带 + 的是快捷命令");

  task
    .command("+list")
    .description("一块看板上的任务，可按阶段筛选")
    .requiredOption("--board <publicId>", "看板的 publicId")
    .option("--stage <stage>", "只看某一列：待办 / 进行中 / 待验收 / 已完成，或 todo / doing / review / done")
    .action(
      action<{ board: string; stage?: string }>(deps, exit, async (runtime, _args, options) => {
        const detail = await getBoard(await runtime.client(), options.board);
        const stage = options.stage ? stageOf(options.stage) : null;
        if (options.stage && !stage) throw validationError(`不认识的阶段：${options.stage}`, "stage");
        const data = detail.lists
          .filter((list) => !stage || stageOf(list.name) === stage)
          .flatMap((list) => (list.cards ?? []).map((card) => taskView(card, list)));
        return { data, meta: { count: data.length, board: detail.name } };
      }),
    );

  task
    .command("+get")
    .description("一个任务的详情")
    .argument("<publicId>", "任务的 publicId")
    .action(
      action(deps, exit, async (runtime, args) => {
        const card = await getCard(await runtime.client(), requireValue(args[0], "<publicId>"));
        return {
          data: {
            ...taskView(card, card.list ?? { publicId: "", name: "" }, card.list?.board),
            description: card.description ?? null,
          },
        };
      }),
    );

  task
    .command("+create")
    .description("在一块看板上新建任务")
    .requiredOption("--board <publicId>", "看板的 publicId")
    .requiredOption("--title <title>", "任务内容")
    .option("--stage <stage>", "放进哪一列（默认 待办）", "待办")
    .option("--due <YYYY-MM-DD>", "截止日期（当天 23:59，本地时间）")
    .option("--description <text>", "详细说明")
    .option("--assign-me", "指派给自己")
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{ board: string; title: string; stage: string; due?: string; description?: string; assignMe?: boolean; dryRun?: boolean }>(
        deps,
        exit,
        async (runtime, _args, options) => {
          const client = await runtime.client();
          const detail = await getBoard(client, options.board);
          const list = resolveList(detail, options.stage);

          const memberPublicIds: string[] = [];
          if (options.assignMe) {
            const me = await client.request<{ email?: string }>({ method: "GET", path: "/users/me" });
            const mine = detail.workspace?.members?.find(
              (member) => (member.user?.email ?? member.email) === me.email,
            );
            if (!mine) {
              throw new CliError({
                type: "authorization",
                subtype: "not_a_member",
                message: "你不是这个项目的成员，不能指派给自己",
              });
            }
            memberPublicIds.push(mine.publicId);
          }

          const spec = {
            method: "POST" as const,
            path: "/cards",
            body: {
              title: requireValue(options.title.trim(), "--title"),
              description: options.description ?? "",
              listPublicId: list.publicId,
              labelPublicIds: [],
              memberPublicIds,
              position: "end",
              ...(options.due ? { dueDate: dueFlag(options.due).toISOString() } : {}),
            },
          };
          if (options.dryRun) return { data: client.describe(spec), meta: { dryRun: true } };
          const created = await client.request<{ publicId: string }>(spec);
          return { data: { publicId: created.publicId, title: options.title.trim(), list: list.name, board: detail.name } };
        },
      ),
    );

  task
    .command("+move")
    .description("把任务移到同一块看板的另一列")
    .argument("<publicId>", "任务的 publicId")
    .requiredOption("--to <stage>", "目标列：待办 / 进行中 / 待验收 / 已完成、todo / doing / review / done，或列名、列的 publicId")
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{ to: string; dryRun?: boolean }>(deps, exit, async (runtime, args, options) => {
        const client = await runtime.client();
        const card = await getCard(client, requireValue(args[0], "<publicId>"));
        const boardId = card.list?.board?.publicId;
        if (!boardId) {
          throw new CliError({ type: "api", subtype: "unexpected_shape", message: "Hub 没有返回这个任务所在的看板" });
        }
        const list = resolveList(await getBoard(client, boardId), options.to);
        const spec = {
          method: "PUT" as const,
          path: `/cards/${encodeURIComponent(card.publicId)}`,
          body: { listPublicId: list.publicId },
        };
        if (options.dryRun) return { data: client.describe(spec), meta: { dryRun: true } };
        await client.request(spec);
        return { data: { publicId: card.publicId, from: card.list?.name ?? null, to: list.name } };
      }),
    );

  task
    .command("+due")
    .description("设置或清除截止日期")
    .argument("<publicId>", "任务的 publicId")
    .option("--date <YYYY-MM-DD>", "截止日期（当天 23:59，本地时间）")
    .option("--clear", "清除截止日期")
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{ date?: string; clear?: boolean; dryRun?: boolean }>(deps, exit, async (runtime, args, options) => {
        if (Boolean(options.date) === Boolean(options.clear)) {
          throw validationError("--date 和 --clear 二选一", "date");
        }
        const due = options.date ? dueFlag(options.date) : null;
        const client = await runtime.client();
        const publicId = requireValue(args[0], "<publicId>");
        const spec = {
          method: "PUT" as const,
          path: `/cards/${encodeURIComponent(publicId)}`,
          body: { dueDate: due ? due.toISOString() : null },
        };
        if (options.dryRun) return { data: client.describe(spec), meta: { dryRun: true } };
        await client.request(spec);
        return { data: { publicId, due: due?.toISOString() ?? null } };
      }),
    );

  task
    .command("+comment")
    .description("给任务加一条评论")
    .argument("<publicId>", "任务的 publicId")
    .requiredOption("--text <text>", "评论内容")
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{ text: string; dryRun?: boolean }>(deps, exit, async (runtime, args, options) => {
        const client = await runtime.client();
        const publicId = requireValue(args[0], "<publicId>");
        const spec = {
          method: "POST" as const,
          path: `/cards/${encodeURIComponent(publicId)}/comments`,
          body: { comment: requireValue(options.text.trim(), "--text") },
        };
        if (options.dryRun) return { data: client.describe(spec), meta: { dryRun: true } };
        await client.request(spec);
        return { data: { publicId, commented: true } };
      }),
    );

  task
    .command("+search")
    .description("在一个项目里搜索任务和看板")
    .requiredOption("--project <publicId>", "项目的 publicId")
    .requiredOption("--query <text>", "关键词")
    .action(
      action<{ project: string; query: string }>(deps, exit, async (runtime, _args, options) => {
        const data = await (await runtime.client()).request({
          method: "GET",
          path: `/workspaces/${encodeURIComponent(options.project)}/search`,
          query: { query: options.query },
        });
        return { data };
      }),
    );
}
