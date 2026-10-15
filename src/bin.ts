#!/usr/bin/env node
import { createInterface } from "node:readline";

import type { Deps, Stdio } from "./core/runtime.js";
import { runCli } from "./cli.js";
import { processWriter } from "./core/output.js";

/** Reads a line without echoing it, for API keys typed at a prompt. */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const mutable = rl as unknown as { _writeToOutput: (text: string) => void };
    process.stderr.write(prompt);
    mutable._writeToOutput = () => undefined;
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** For `mcp serve`: protocol messages on stdout, one per line, nothing else. */
const stdio: Stdio = {
  lines: createInterface({ input: process.stdin, crlfDelay: Infinity }),
  write: (text) => void process.stdout.write(text),
};

const deps: Deps = {
  writer: processWriter,
  env: process.env,
  fetch,
  readSecret,
  readStdin,
  isInteractive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  stdio,
};

process.exitCode = await runCli(process.argv.slice(2), deps);
