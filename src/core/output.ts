import type { CliError } from "./errors.js";

/**
 * How results are printed.
 *
 * - `json` (default): one envelope per command, `{ ok, profile, data, meta }`
 *   on stdout; errors as `{ ok: false, profile, error }` on stderr. This is
 *   the contract scripts and AI agents rely on (docs/ERROR_CONTRACT.md).
 * - `ndjson`: one JSON object per line for list results, for piping.
 * - `table` / `pretty`: for people. Text from the Hub is untrusted, so
 *   control characters and terminal escape sequences are stripped before it
 *   reaches the terminal.
 */

export const formats = ["json", "ndjson", "table", "pretty"] as const;
export type Format = (typeof formats)[number];

export interface Writer {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const processWriter: Writer = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

export interface Context {
  format: Format;
  profile: string;
  writer: Writer;
}

// ESC sequences (colours, cursor moves, OSC hyperlinks/titles) and other C0/C1
// control characters, except tab and newline.
// eslint-disable-next-line no-control-regex
const UNSAFE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Text safe to print to a terminal. */
export function sanitize(text: string): string {
  return text.replace(UNSAFE, "");
}

export function printSuccess(
  ctx: Context,
  data: unknown,
  meta?: Record<string, unknown>,
): void {
  switch (ctx.format) {
    case "json":
      ctx.writer.out(
        `${JSON.stringify({ ok: true, profile: ctx.profile, data, ...(meta ? { meta } : {}) }, null, 2)}\n`,
      );
      return;
    case "ndjson":
      for (const item of Array.isArray(data) ? data : [data]) {
        ctx.writer.out(`${JSON.stringify(item)}\n`);
      }
      return;
    case "table":
      ctx.writer.out(`${renderTable(data)}\n`);
      return;
    case "pretty":
      ctx.writer.out(`${renderPretty(data)}\n`);
      return;
  }
}

export function printError(ctx: Context, error: CliError): void {
  if (ctx.format === "json" || ctx.format === "ndjson") {
    ctx.writer.err(
      `${JSON.stringify({ ok: false, profile: ctx.profile, error: error.toJSON() }, null, 2)}\n`,
    );
    return;
  }
  ctx.writer.err(`✗ ${sanitize(error.message)}\n`);
  if (error.hint) ctx.writer.err(`  ${sanitize(error.hint)}\n`);
}

/** Width of a string in terminal columns (CJK and full-width count as 2). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
        ? 2
        : 1;
  }
  return width;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return sanitize(JSON.stringify(value));
  return sanitize(String(value));
}

const pad = (text: string, width: number) =>
  text + " ".repeat(Math.max(0, width - displayWidth(text)));

/** A plain text table of a list of objects; anything else prints as pretty. */
export function renderTable(data: unknown): string {
  if (!Array.isArray(data)) return renderPretty(data);
  if (data.length === 0) return "（无）";
  const rows: Record<string, unknown>[] = data.map((row: unknown) =>
    typeof row === "object" && row !== null
      ? (row as Record<string, unknown>)
      : { value: row },
  );
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const body = rows.map((row) => columns.map((column) => cell(row[column])));
  const widths = columns.map((column, index) =>
    Math.max(
      displayWidth(column),
      ...body.map((line) => displayWidth(line[index] ?? "")),
    ),
  );
  const line = (values: string[]) =>
    values
      .map((value, index) => pad(value, widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join(
    "\n",
  );
}

/** Indented key: value lines, for a single object. */
export function renderPretty(data: unknown, indent = ""): string {
  if (Array.isArray(data)) {
    return data.map((item) => `${indent}- ${renderPretty(item, `${indent}  `).trimStart()}`).join("\n");
  }
  if (typeof data === "object" && data !== null) {
    return Object.entries(data as Record<string, unknown>)
      .map(([key, value]) =>
        typeof value === "object" && value !== null && !(value instanceof Date)
          ? `${indent}${key}:\n${renderPretty(value, `${indent}  `)}`
          : `${indent}${key}: ${cell(value)}`,
      )
      .join("\n");
  }
  return `${indent}${cell(data)}`;
}
