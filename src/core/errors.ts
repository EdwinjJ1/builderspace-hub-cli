/**
 * Every failure the CLI reports, in a closed set of types. Scripts and AI
 * agents branch on `type` and `subtype` (or the exit code); `message` and
 * `hint` are for people and may change. See docs/ERROR_CONTRACT.md.
 */

export const errorTypes = [
  "validation",
  "authentication",
  "authorization",
  "not_found",
  "conflict",
  "rate_limit",
  "network",
  "api",
  "internal",
] as const;
export type ErrorType = (typeof errorTypes)[number];

/** The exit code for each type. 0 is success; nothing else ever exits 0. */
export const EXIT_CODES: Record<ErrorType, number> = {
  internal: 1,
  validation: 2,
  authentication: 3,
  authorization: 4,
  not_found: 5,
  conflict: 6,
  rate_limit: 7,
  network: 8,
  api: 9,
};

export interface CliErrorInit {
  type: ErrorType;
  /** Stable, lowercase_with_underscores; safe to branch on. */
  subtype: string;
  message: string;
  /** What to do about it, ideally a command to run. */
  hint?: string;
  /** HTTP status from the Hub, when the error came from it. */
  status?: number;
  retryable?: boolean;
  retryAfterSeconds?: number;
  /** The offending flag or argument, for validation errors. */
  param?: string;
}

export class CliError extends Error {
  readonly type: ErrorType;
  readonly subtype: string;
  readonly hint?: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  readonly param?: string;

  constructor(init: CliErrorInit) {
    super(init.message);
    this.name = "CliError";
    this.type = init.type;
    this.subtype = init.subtype;
    this.hint = init.hint;
    this.status = init.status;
    this.retryable = init.retryable;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.param = init.param;
  }

  /** The `error` object of the JSON envelope. */
  toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      subtype: this.subtype,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.status ? { status: this.status } : {}),
      ...(this.retryable ? { retryable: true } : {}),
      ...(this.retryAfterSeconds
        ? { retry_after_seconds: this.retryAfterSeconds }
        : {}),
      ...(this.param ? { param: this.param } : {}),
    };
  }
}

export function exitCodeOf(error: unknown): number {
  return error instanceof CliError ? EXIT_CODES[error.type] : EXIT_CODES.internal;
}

/** Any thrown value as a CliError, without leaking internals as messages. */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError({
    type: "internal",
    subtype: "unexpected",
    message: error instanceof Error ? error.message : String(error),
    hint: "这是 CLI 自身的问题，请把命令和输出报到 GitHub Issues。",
  });
}

export const validationError = (
  message: string,
  param?: string,
  hint?: string,
) =>
  new CliError({
    type: "validation",
    subtype: param ? "invalid_param" : "invalid_input",
    message,
    param,
    hint,
  });
