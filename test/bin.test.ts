import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

/** Runs the real entry point with `env` and returns its exit code and stdout. */
function runBin(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/bin.ts", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => void (stdout += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("bshub did not exit"));
    }, 12_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

/** The environment without any proxy settings inherited from this machine. */
function withoutProxy(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"]) {
    delete env[name];
  }
  return env;
}

const canSwitchProxy = typeof (http as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv === "function";

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

  // Node 24.14 and 25.4 can switch fetch onto the proxy at run time; on older
  // ones `doctor` explains instead (covered in cli.test.ts).
  it.skipIf(!canSwitchProxy)("sends requests through HTTPS_PROXY, as curl does", async () => {
    const seen: string[] = [];
    const proxy = createServer((socket) => {
      socket.once("data", (chunk) => {
        seen.push(chunk.toString().split("\r\n")[0] ?? "");
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const { port } = proxy.address() as AddressInfo;

    try {
      const { stdout } = await runBin(["doctor"], {
        ...withoutProxy(),
        BSHUB_CONFIG_DIR: "/tmp/bshub-bin-test",
        BSHUB_URL: "https://hub.example.test",
        BSHUB_API_KEY: `kan_${"x".repeat(20)}cdef`,
        HTTPS_PROXY: `http://127.0.0.1:${port}`,
      });
      // hub.example.test does not resolve, so only the proxy can have seen it.
      expect(seen).toContain("CONNECT hub.example.test:443 HTTP/1.1");
      const checks = (JSON.parse(stdout) as { data: { checks: { name: string; ok: boolean }[] } }).data.checks;
      expect(checks.find((check) => check.name === "proxy")?.ok).toBe(true);
    } finally {
      proxy.close();
    }
  }, 15_000);
});
