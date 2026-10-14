#!/usr/bin/env node
/**
 * Smoke test a Hub through the CLI: the same commands a person or an agent
 * would run, end to end, against a real instance.
 *
 *   BSHUB_URL=http://localhost:3210 \
 *   BSHUB_API_KEY=… \
 *   BSHUB_SMOKE_BOARD=<board publicId> \
 *   node scripts/smoke.mjs
 *
 * It creates one task on the given board, moves it, changes its due date,
 * comments on it and deletes it again, so point it at a test board or a local
 * instance. Exits non-zero at the first step that fails.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const board = process.env.BSHUB_SMOKE_BOARD;
if (!process.env.BSHUB_URL || !process.env.BSHUB_API_KEY || !board) {
  console.error("需要环境变量 BSHUB_URL、BSHUB_API_KEY 和 BSHUB_SMOKE_BOARD（测试用看板的 publicId）。");
  process.exit(2);
}

let failed = false;
function step(name, args, check = () => true) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  let envelope = null;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    // Reported below.
  }
  const ok = result.status === 0 && envelope?.ok === true && check(envelope.data);
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) {
    failed = true;
    console.log(result.stderr.trim() || result.stdout.trim());
  }
  return envelope?.data;
}

step("doctor", ["doctor"], (data) => data.healthy === true);
step("whoami", ["whoami"], (data) => Boolean(data.user?.email));
step("project list", ["project", "list"], (data) => Array.isArray(data));
step("task +list", ["task", "+list", "--board", board], (data) => Array.isArray(data));

const stamp = new Date().toISOString().slice(0, 19);
const created = step(
  "task +create",
  ["task", "+create", "--board", board, "--title", `CLI 冒烟测试 ${stamp}`, "--due", "2030-01-01"],
  (data) => typeof data.publicId === "string",
);
const id = created?.publicId;
if (id) {
  step("task +move → 进行中", ["task", "+move", id, "--to", "doing"], (data) => data.to !== undefined);
  step("task +due", ["task", "+due", id, "--date", "2030-01-02"], (data) => data.due !== null);
  step("task +comment", ["task", "+comment", id, "--text", "smoke test"]);
  step("task +get", ["task", "+get", id], (data) => data.stage === "doing");
  step("api DELETE（清理）", ["api", "DELETE", `/cards/${id}`]);
}

process.exit(failed ? 1 : 0);
