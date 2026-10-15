import type { FileAccess } from "./runtime.js";
import { CliError } from "./errors.js";

/**
 * Local file access with failures turned into typed errors, so a missing or
 * unreadable file is reported as something the person can fix rather than as a
 * CLI bug.
 */

function fileError(path: string, error: unknown, action: "读取" | "写入"): CliError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return new CliError({
      type: "not_found",
      subtype: "file_not_found",
      message: `找不到文件：${path}`,
      hint: "检查路径是否写对；相对路径是从当前目录算起的。",
      param: "file",
    });
  }
  const reason =
    code === "EACCES" || code === "EPERM"
      ? "没有权限"
      : code === "EISDIR"
        ? "这是一个目录，不是文件"
        : error instanceof Error
          ? error.message
          : String(error);
  return new CliError({
    type: "validation",
    subtype: "file_unusable",
    message: `不能${action}文件 ${path}：${reason}`,
    param: "file",
  });
}

export async function readLocalFile(files: FileAccess, path: string): Promise<Uint8Array> {
  try {
    return await files.readFile(path);
  } catch (error) {
    throw fileError(path, error, "读取");
  }
}

export async function writeLocalFile(files: FileAccess, path: string, data: Uint8Array): Promise<void> {
  try {
    await files.writeFile(path, data);
  } catch (error) {
    throw fileError(path, error, "写入");
  }
}
