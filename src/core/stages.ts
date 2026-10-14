/**
 * Columns by meaning, not by list id, so `task +move --to 进行中` works on any
 * board that follows the standard structure. Mirrors the Hub's own rules
 * (packages/hub/src/tasks/task.policy.ts in the Hub repository): the standard
 * Chinese list names, English aliases, and Kan's template names.
 */

export const stages = ["todo", "doing", "review", "done"] as const;
export type Stage = (typeof stages)[number];

export const stageNames: Record<Stage, string> = {
  todo: "待办",
  doing: "进行中",
  review: "待验收",
  done: "已完成",
};

const normalise = (name: string) => name.trim().toLowerCase();

const ALIASES = new Map<string, Stage>([
  ["待办", "todo"],
  ["进行中", "doing"],
  ["待验收", "review"],
  ["已完成", "done"],
  ["todo", "todo"],
  ["to do", "todo"],
  ["backlog", "todo"],
  ["doing", "doing"],
  ["in progress", "doing"],
  ["review", "review"],
  ["code review", "review"],
  ["done", "done"],
]);

/** The stage a list (or a user's --to value) stands for, if any. */
export function stageOf(name: string): Stage | null {
  return ALIASES.get(normalise(name)) ?? null;
}

export interface ListRef {
  publicId: string;
  name: string;
}

/**
 * The list on a board that `target` means: a list public id, an exact list
 * name, or a stage word (待办 / doing / …). Null when nothing matches.
 */
export function findList(lists: readonly ListRef[], target: string): ListRef | null {
  const wanted = target.trim();
  const byId = lists.find((list) => list.publicId === wanted);
  if (byId) return byId;
  const byName = lists.find((list) => normalise(list.name) === normalise(wanted));
  if (byName) return byName;
  const stage = stageOf(wanted);
  return stage ? (lists.find((list) => stageOf(list.name) === stage) ?? null) : null;
}

/** A YYYY-MM-DD day as "due by the end of that day" in local time. */
export function parseDueDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const date = new Date(year, month - 1, day, 23, 59, 0);
  return date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}
