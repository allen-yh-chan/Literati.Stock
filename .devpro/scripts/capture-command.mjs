#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { probeGitCommonDir } from "./hooks/lib/repo-state-identity.mjs";

function usage(exitCode = 1) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    [
      "Usage: node .devpro/scripts/capture-command.mjs --topic <topic> -- <cmd> [args...]",
      "",
      "Captures stdout+stderr into main-checkout notes/tmp and prints compact summary.",
    ].join("\n") + "\n",
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  let topic = "";
  let separator = -1;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--") {
      separator = index;
      break;
    }
    if (arg === "--topic") {
      topic = argv[index + 1] || "";
      index += 1;
      continue;
    }
    throw new Error(`unknown argument before --: ${arg}`);
  }

  if (!topic) throw new Error("--topic is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(topic)) {
    throw new Error("--topic must be 1-81 chars of letters, numbers, dot, underscore, or dash");
  }
  if (separator < 0) throw new Error("-- separator is required");

  const command = argv.slice(separator + 1);
  if (command.length === 0) throw new Error("command after -- is required");
  return { topic, command };
}

function repoRoot() {
  // Shared memoized probe; this call site keeps its original disposition of
  // letting a git failure propagate to the caller.
  const { ok, commonDir, error } = probeGitCommonDir();
  if (!ok) throw error;
  return path.dirname(commonDir);
}

function summarizeLog(logPath) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(logPath);
    let bytes = 0;
    let lines = 0;
    let lastByte = null;

    stream.on("data", (chunk) => {
      bytes += chunk.length;
      for (const byte of chunk) {
        if (byte === 10) lines += 1;
        lastByte = byte;
      }
    });
    stream.on("error", reject);
    stream.on("end", () => {
      if (bytes > 0 && lastByte !== 10) lines += 1;
      resolve({ bytes, lines });
    });
  });
}

function commandSummary(command) {
  return command.map((part) => JSON.stringify(part)).join(" ");
}

async function main() {
  const { topic, command } = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const tmpRoot = path.join(root, "notes", "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const logDir = mkdtempSync(path.join(tmpRoot, `${topic}.`));
  const logPath = path.join(logDir, "command.log");
  const log = createWriteStream(logPath, { flags: "wx" });

  const result = await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });

    child.on("error", (error) => {
      log.write(`spawn error: ${error.message}\n`);
      resolve({ code: 127, signal: null });
    });
    child.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal });
    });
  });

  await new Promise((resolve) => log.end(resolve));
  const { bytes, lines } = await summarizeLog(logPath);
  const signalPart = result.signal ? ` signal=${result.signal}` : "";
  process.stdout.write(
    `command=${commandSummary(command)} rc=${result.code}${signalPart} lines=${lines} bytes=${bytes} log=${logPath}\n`,
  );
  process.exitCode = result.code;
}

main().catch((error) => {
  process.stderr.write(`capture-command: ${error.message}\n`);
  process.exitCode = 1;
});
