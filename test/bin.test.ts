import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * The real entry point. A readline interface created at start-up used to keep
 * every command from exiting, because it resumed an open stdin: tests that
 * drive the command tree with fake dependencies cannot see that.
 */
describe("bin", () => {
  it("exits on its own for an ordinary command while stdin stays open", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/bin.ts", "--version"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BSHUB_CONFIG_DIR: "/tmp/bshub-bin-test" },
    });
    // stdin is never written to or closed, like a terminal waiting for input.
    const exited = await new Promise<number | "timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 8000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });
    child.kill();
    expect(exited).toBe(0);
  }, 15_000);
});
