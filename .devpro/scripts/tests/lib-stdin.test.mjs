/**
 * lib-stdin.test.mjs
 *
 * Characterization tests for .devpro/scripts/hooks/lib/stdin.mjs `readStdin`.
 * Timeout / I/O-error paths MUST resolve (never reject).
 */

import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL, fileURLToPath } from "node:url";

const LIB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/lib/stdin.mjs"
);

async function loadReadStdin() {
  const mod = await import(pathToFileURL(LIB).href);
  assert.equal(typeof mod.readStdin, "function", "readStdin export missing");
  return mod.readStdin;
}

test("timeout with no data resolves empty string", { timeout: 1500 }, async () => {
  const readStdin = await loadReadStdin();
  const stream = new PassThrough();
  const result = await readStdin({ timeoutMs: 50, stream });
  assert.equal(result, "");
});

test("partial UTF-8 then stall resolves buffered bytes", { timeout: 1500 }, async () => {
  const readStdin = await loadReadStdin();
  const stream = new PassThrough();
  const pending = readStdin({ timeoutMs: 80, stream });
  stream.write(Buffer.from("hello-世界", "utf8"));
  const result = await pending;
  assert.equal(result, "hello-世界");
});

test("I/O error resolves and never rejects", { timeout: 1500 }, async () => {
  const readStdin = await loadReadStdin();
  const stream = new PassThrough();
  const pending = readStdin({ timeoutMs: 500, stream });
  stream.write("abc");
  stream.emit("error", Object.assign(new Error("EIO"), { code: "EIO" }));
  await assert.doesNotReject(() => pending);
  const result = await pending;
  assert.equal(result, "abc");
});

test("stalled stdin timeout lets the process exit without SIGKILL", { timeout: 6500 }, async () => {
  const href = pathToFileURL(LIB).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { readStdin } from ${JSON.stringify(href)};
const t0 = Date.now();
const result = await readStdin({ timeoutMs: 80 });
const elapsed = Date.now() - t0;
process.stdout.write(JSON.stringify({ result, elapsed }));
`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  child.stdin.write("partial");

  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
      // 5000 ms, not 1500: the child is a node cold start before its 80 ms read even begins.
    }, 5000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  assert.notEqual(exited, "timeout", "child still alive after 1500ms; SIGKILL sent");
  assert.equal(exited.signal, null);
  assert.equal(exited.code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.result, "partial");
  assert.ok(
    parsed.elapsed < 400,
    `elapsed ${parsed.elapsed}ms should be well under a few hundred ms`
  );
});
