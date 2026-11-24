import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Normal fake producers follow the new packet contract. Negative omission/mismatch
// fixtures explicitly set DEVPRO_FAKE_GUARANTEE_NO_AUTO; never repair their output.
function fixtureAssessmentLine(line, input) {
  if (line.includes("\n")) return line.split("\n").map(event => fixtureAssessmentLine(event, input)).join("\n");
  if (enabled("DEVPRO_FAKE_GUARANTEE_NO_AUTO") || !input.includes("## Guarantee Assessment Output Contract")) return line;
  try {
    const marker = "Content-Type: application/json\nContent-Length: ";
    const bytes = Buffer.from(input);
    const start = bytes.indexOf(marker) + Buffer.byteLength(marker);
    const end = bytes.indexOf("\n\n", start);
    const data = JSON.parse(bytes.subarray(end + 2, end + 2 + Number(bytes.subarray(start, end).toString())));
    const event = JSON.parse(line);
    const key = event.type === "result" ? "result" : event.type === "item.completed" && event.item?.type === "agent_message" ? "text" : null;
    const owner = key === "text" ? event.item : event;
    if (!key || typeof owner[key] !== "string") return line;
    const completion = JSON.parse(owner[key]);
    if (!["PASS", "WARN"].includes(completion.verdict) || typeof completion.reason !== "string" || !completion.reason.trim() || completion.reason !== completion.reason.trim()) return line;
    if (completion.reason.includes("## Guarantee Assessment")) return line;
    const report = {
      schema: "devpro.review-guarantee-assessment/v1",
      reviewed_target: data.head_ref_oid !== "none" ? data.head_ref_oid : data.target,
      dispatch_id: data.dispatch_id,
      assessments: (completion.findings ?? []).map(finding => ({
        finding_id: finding.summary_id, guarantee_ceiling: "fixture owner: cooperative review; mechanical transport checks",
        classification: "within-ceiling", rationale: "An ordinary workflow omission is within the promised review.",
      })),
    };
    const section = "## Guarantee Assessment\n```json\n" + JSON.stringify(report) + "\n```";
    completion.reason += "\n\n" + section;
    owner[key] = JSON.stringify(completion);
    const root = process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
    if (root) { mkdirSync(root, { recursive: true }); writeFileSync(path.join(root, "..", "fake-guarantee-section.txt"), section); }
    return JSON.stringify(event);
  } catch { return line; } // Malformed transport fixtures remain malformed.
}
function fixtureStickyResponse(value) {
  if (enabled("DEVPRO_FAKE_GUARANTEE_NO_AUTO")) return value;
  try {
    const root = process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
    const section = readFileSync(path.join(root, "..", "fake-guarantee-section.txt"), "utf8");
    const response = JSON.parse(value);
    for (const comment of response.comments ?? []) {
      if (!comment.body.includes("## Guarantee Assessment")) comment.body = comment.body.replace(/^(Rules: .+)$/m, section + "\n$1");
    }
    return JSON.stringify(response);
  } catch { return value; }
}

function enabled(name) {
  return Boolean(process.env[name]);
}

function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

function writeAndWait(stream, value) {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function logFile(name, value) {
  const target = process.env[name];
  if (target) appendFileSync(target, value);
}

function logExecutableIdentity(kind) {
  let executable = process.argv[1];
  try {
    executable = realpathSync(executable);
  } catch {
    // A disappearing executable has no reviewer invocation identity to record.
  }
  logFile("DEVPRO_FAKE_EXECUTABLE_IDENTITY_LOG", `${kind}\t${executable}\n`);
}

function argsText(args) {
  return args.join(" ");
}

function isInside(candidate, root) {
  if (!candidate || !root) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Number(milliseconds)));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/\n+$/u, "");
}

async function readStdinRaw() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function writeEvent(value) {
  writeLine(process.stdout, JSON.stringify(value));
}

function stdoutChunksFromEnvironment() {
  const oneBase64 = process.env.DEVPRO_FAKE_REVIEWER_INIT_CHUNK_ONE_BASE64;
  if (oneBase64) {
    return [
      Buffer.from(oneBase64, "base64").toString("utf8"),
      Buffer.from(process.env.DEVPRO_FAKE_REVIEWER_INIT_CHUNK_TWO_BASE64 ?? "", "base64").toString("utf8"),
    ];
  }
  return [
    process.env.DEVPRO_FAKE_REVIEWER_INIT_CHUNK_ONE ?? "",
    process.env.DEVPRO_FAKE_REVIEWER_INIT_CHUNK_TWO ?? "",
  ];
}

function defaultClaudeTools(args) {
  const hasSchema = args.includes("--json-schema");
  const toolsIndex = args.indexOf("--tools");
  const enabledTools = toolsIndex >= 0 ? args[toolsIndex + 1] : "";
  if (hasSchema && enabledTools === "Write,Bash") return ["Bash", "StructuredOutput", "Write"];
  if (hasSchema) return ["StructuredOutput"];
  if (enabledTools === "Write,Bash") return ["Bash", "Write"];
  return [];
}

// `escapeProcessGroup` puts the descendant in its own process group (POSIX only), so the
// runner's process-group signals no longer reach it; by default it stays in the reviewer's group.
function startStubbornDescendant(pidLog, { escapeProcessGroup = false } = {}) {
  const child = spawn(process.execPath, [
    "-e",
    [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(pidLog)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join(""),
  ], {
    detached: escapeProcessGroup && process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  return child;
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 5000;
  while (!existsSync(filePath) && Date.now() < deadline) await sleep(10);
}

export async function runDisappearingClaude({ helpText }) {
  const args = process.argv.slice(2);
  if (args[0] === "auth" && args[1] === "status" && args[2] === "--json" && args.length === 3) {
    writeLine(process.stdout, '{"loggedIn":true}');
    rmSync(process.argv[1], { force: true });
    rmSync(`${process.argv[1]}.exe`, { force: true });
    return;
  }
  if (args.some((arg) => ["--help", "-help", "-h", "help"].includes(arg))) {
    process.stdout.write(helpText);
    return;
  }
  process.stderr.write("unexpected fake Claude invocation\n");
  process.exitCode = 97;
}

export async function runFakeClaude({ helpText }) {
  const args = process.argv.slice(2);
  const argsAsText = argsText(args);
  const env = process.env;

  if (args[0] === "auth" && args[1] === "status" && args[2] === "--json" && args.length === 3) {
    logExecutableIdentity("auth");
    if (env.DEVPRO_FAKE_AUTH_PREFLIGHT_LOG) writeFileSync(env.DEVPRO_FAKE_AUTH_PREFLIGHT_LOG, `${argsAsText}\n`);
    if (enabled("DEVPRO_FAKE_AUTH_PREFLIGHT_DELAY_MS")) {
      await sleep(env.DEVPRO_FAKE_AUTH_PREFLIGHT_DELAY_MS);
    }
    if (enabled("DEVPRO_FAKE_AUTH_PREFLIGHT_OUTPUT_BYTES")) {
      process.stdout.write("x".repeat(Number(env.DEVPRO_FAKE_AUTH_PREFLIGHT_OUTPUT_BYTES)));
      return;
    }
    if (enabled("DEVPRO_FAKE_AUTH_PREFLIGHT_FAILURE")) {
      process.stderr.write(`Not logged in: ${env.DEVPRO_FAKE_AUTH_PREFLIGHT_SECRET ?? ""} HOME=${env.HOME ?? ""}\n`);
      process.exitCode = 1;
      return;
    }
    if (enabled("DEVPRO_FAKE_AUTH_PREFLIGHT_STDOUT")) process.stdout.write(env.DEVPRO_FAKE_AUTH_PREFLIGHT_STDOUT);
    else writeLine(process.stdout, '{"loggedIn":true}');
    return;
  }

  if (enabled("DEVPRO_FAKE_REVIEWER_SIGNAL_LOG")) {
    appendFileSync(env.DEVPRO_FAKE_REVIEWER_SIGNAL_LOG, "");
    // Log, then leave at once: a handler that only sets exitCode keeps a busy
    // reviewer alive past the runner's termination grace.
    process.on("SIGTERM", () => {
      logFile("DEVPRO_FAKE_REVIEWER_SIGNAL_LOG", "reviewer-sigterm\n");
      process.exit(143);
    });
  }
  if (env.DEVPRO_FAKE_REVIEWER_ARGS_LOG) writeFileSync(env.DEVPRO_FAKE_REVIEWER_ARGS_LOG, `${argsAsText}\n`);

  if (args.some((arg) => ["--help", "-help", "-h", "help"].includes(arg))) {
    logExecutableIdentity("help");
    process.stdout.write(helpText);
    return;
  }

  logExecutableIdentity("reviewer");
  if (env.DEVPRO_FAKE_REVIEWER_INVOCATION_LOG) writeFileSync(env.DEVPRO_FAKE_REVIEWER_INVOCATION_LOG, `${argsAsText}\n`);
  const input = await readStdin();
  if (env.DEVPRO_FAKE_REVIEWER_STDIN_LOG) writeFileSync(env.DEVPRO_FAKE_REVIEWER_STDIN_LOG, input);
  const inputBytes = Buffer.byteLength(input, "utf8");

  if (enabled("DEVPRO_FAKE_REVIEWER_DELAY_MS")) await sleep(env.DEVPRO_FAKE_REVIEWER_DELAY_MS);
  if (enabled("DEVPRO_FAKE_REVIEWER_OMIT_ALL_STDOUT")) {
    process.stderr.write("fake stderr line\n");
    process.exitCode = Number(env.DEVPRO_FAKE_REVIEWER_EXIT_CODE ?? 0);
    return;
  }

  if (enabled("DEVPRO_FAKE_REVIEWER_PRE_INIT_STUBBORN_DESCENDANT_PID_LOG")) {
    startStubbornDescendant(env.DEVPRO_FAKE_REVIEWER_PRE_INIT_STUBBORN_DESCENDANT_PID_LOG);
    await waitForFile(env.DEVPRO_FAKE_REVIEWER_PRE_INIT_STUBBORN_DESCENDANT_PID_LOG);
  }

  if (!enabled("DEVPRO_FAKE_REVIEWER_OMIT_INIT")) {
    if (enabled("DEVPRO_FAKE_REVIEWER_INIT_CHUNK_ONE_BASE64") || enabled("DEVPRO_FAKE_REVIEWER_INIT_CHUNK_ONE")) {
      const [first, second] = stdoutChunksFromEnvironment();
      process.stdout.write(first);
      await sleep(20);
      process.stdout.write(second);
      writeLine(process.stdout, "");
    } else if (enabled("DEVPRO_FAKE_REVIEWER_INIT_EVENT")) {
      process.stdout.write(`${env.DEVPRO_FAKE_REVIEWER_INIT_EVENT}\n`);
    } else {
      const tools = enabled("DEVPRO_FAKE_REVIEWER_INIT_TOOLS")
        ? JSON.parse(env.DEVPRO_FAKE_REVIEWER_INIT_TOOLS)
        : defaultClaudeTools(args);
      writeEvent({ type: "system", subtype: "init", tools });
    }
  }

  if (enabled("DEVPRO_FAKE_REVIEWER_HOLD_AFTER_INIT_MS")) {
    await sleep(env.DEVPRO_FAKE_REVIEWER_HOLD_AFTER_INIT_MS);
  }

  if (enabled("DEVPRO_FAKE_REVIEWER_EXIT_WITH_STUBBORN_DESCENDANT_PID_LOG")) {
    startStubbornDescendant(env.DEVPRO_FAKE_REVIEWER_EXIT_WITH_STUBBORN_DESCENDANT_PID_LOG, { escapeProcessGroup: true });
    await waitForFile(env.DEVPRO_FAKE_REVIEWER_EXIT_WITH_STUBBORN_DESCENDANT_PID_LOG);
    await sleep(180);
    process.exitCode = 0;
    return;
  }

  if (enabled("DEVPRO_FAKE_REVIEWER_STUBBORN_DESCENDANT_PID_LOG")) {
    startStubbornDescendant(env.DEVPRO_FAKE_REVIEWER_STUBBORN_DESCENDANT_PID_LOG);
    await waitForFile(env.DEVPRO_FAKE_REVIEWER_STUBBORN_DESCENDANT_PID_LOG);
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }

  if (enabled("DEVPRO_FAKE_REVIEWER_BUSY_UNTIL_SIGNAL")) {
    // No handler here: without a signal log the default SIGTERM disposition ends the process.
    setInterval(() => {}, 1000);
    return;
  }

  if (enabled("DEVPRO_FAKE_REVIEWER_PROGRESS_COUNT")) {
    const count = Number(env.DEVPRO_FAKE_REVIEWER_PROGRESS_COUNT);
    const intervalMs = Number(env.DEVPRO_FAKE_REVIEWER_PROGRESS_INTERVAL_MS || 60);
    const gate = new Int32Array(new SharedArrayBuffer(4));
    for (let emitted = 1; emitted <= count; emitted += 1) {
      writeEvent({ type: "stream_event", event: { type: "content_block_delta" }, progress_index: emitted });
      if (emitted < count) Atomics.wait(gate, 0, 0, intervalMs);
    }
  }

  writeEvent({
    type: "assistant",
    cross: env.DEVPRO_CROSS_MODEL_REVIEWER ?? "",
    input_bytes: inputBytes,
    cwd: process.cwd(),
    gh_repo: env.GH_REPO ?? "",
    review_pr: env.DEVPRO_REVIEW_PR_NUMBER ?? "",
  });
  if (enabled("DEVPRO_FAKE_REVIEWER_PRE_PADDING_EVENT")) process.stdout.write(`${env.DEVPRO_FAKE_REVIEWER_PRE_PADDING_EVENT}\n`);

  if (enabled("DEVPRO_FAKE_REVIEWER_NEUTRAL_WRITE_NAME")) {
    const bodyPath = path.join(process.cwd(), env.DEVPRO_FAKE_REVIEWER_NEUTRAL_WRITE_NAME);
    writeFileSync(bodyPath, "reviewer sticky body\n");
    logFile("DEVPRO_FAKE_REVIEWER_NEUTRAL_WRITE_LOG", `${bodyPath}\n`);
    writeEvent({ type: "assistant", neutral_write_path: bodyPath, neutral_write_content: "reviewer sticky body" });
  }

  if (enabled("DEVPRO_FAKE_REVIEWER_TMPDIR_LOG")) {
    const tmpProbe = path.join(env.TMPDIR ?? "", "reviewer-scratch-probe.txt");
    try {
      writeFileSync(tmpProbe, "scratch");
      writeFileSync(env.DEVPRO_FAKE_REVIEWER_TMPDIR_LOG, `${env.TMPDIR}\nwritable\n`);
    } catch {
      writeFileSync(env.DEVPRO_FAKE_REVIEWER_TMPDIR_LOG, `${env.TMPDIR ?? ""}\nunwritable\n`);
    }
  }

  if (enabled("DEVPRO_FAKE_REVIEWER_PADDING_BYTES")) {
    writeEvent({ type: "assistant", padding: "x".repeat(Number(env.DEVPRO_FAKE_REVIEWER_PADDING_BYTES)) });
  }
  if (enabled("DEVPRO_FAKE_REVIEWER_PADDING_LINE_COUNT")) {
    const count = Number(env.DEVPRO_FAKE_REVIEWER_PADDING_LINE_COUNT);
    for (let index = 0; index < count; index += 1) {
      writeEvent({ type: "assistant", index, padding: "x".repeat(1000) });
    }
  }
  if (enabled("DEVPRO_FAKE_REVIEWER_UNSTRUCTURED_PADDING_BYTES")) {
    process.stdout.write(`${"x".repeat(Number(env.DEVPRO_FAKE_REVIEWER_UNSTRUCTURED_PADDING_BYTES))} authentication_failed Please run /login\n`);
  }
  if (enabled("DEVPRO_FAKE_REVIEWER_RAW_STDOUT_JSON_LINE")) {
    writeLine(process.stdout, env.DEVPRO_FAKE_REVIEWER_RAW_STDOUT_JSON_LINE);
  }
  if (enabled("DEVPRO_FAKE_REVIEWER_RAW_STDOUT_LINE_BYTES")) {
    process.stdout.write(`${"x".repeat(Number(env.DEVPRO_FAKE_REVIEWER_RAW_STDOUT_LINE_BYTES))}\n`);
  }
  if (enabled("DEVPRO_FAKE_REVIEWER_RAW_STDERR_LINE_BYTES")) {
    process.stderr.write(`${"x".repeat(Number(env.DEVPRO_FAKE_REVIEWER_RAW_STDERR_LINE_BYTES))}\n`);
  }
  if (enabled("DEVPRO_FAKE_REVIEWER_INPUT_JSON_FRAGMENTS") || enabled("DEVPRO_FAKE_REVIEWER_INPUT_JSON_FRAGMENTS_OPEN")) {
    const closed = env.DEVPRO_FAKE_REVIEWER_INPUT_JSON_FRAGMENTS;
    const chunks = JSON.parse(closed || env.DEVPRO_FAKE_REVIEWER_INPUT_JSON_FRAGMENTS_OPEN);
    const index = Number(env.DEVPRO_FAKE_REVIEWER_INPUT_JSON_BLOCK_INDEX || "7");
    const toolName = env.DEVPRO_FAKE_REVIEWER_INPUT_JSON_TOOL_NAME || "StructuredOutput";
    writeEvent({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id: "toolu_fixture_input_json", name: toolName, input: {} } } });
    for (const chunk of chunks) {
      writeEvent({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: chunk } } });
    }
    if (closed) writeEvent({ type: "stream_event", event: { type: "content_block_stop", index } });
  }

  if (!enabled("DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL") && enabled("DEVPRO_FAKE_REVIEWER_PAGE_PROGRAM")) {
    const child = spawnSync(process.execPath, [env.DEVPRO_FAKE_REVIEWER_PAGE_PROGRAM], {
      input,
      stdio: ["pipe", "inherit", "inherit"],
    });
    if (child.error) throw child.error;
  } else if (!enabled("DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL")) {
    const terminalLine = fixtureAssessmentLine(enabled("DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT")
      ? env.DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT
      : '{"type":"result","subtype":"success","is_error":false,"result":"{\\"sticky_comment_url\\":\\"none\\",\\"verdict\\":\\"PASS\\",\\"last_reviewed_sha\\":\\"none\\",\\"reviewer_model\\":\\"claude-test\\",\\"reason\\":\\"No blocking findings.\\"}"}', input);
    if (enabled("DEVPRO_FAKE_REVIEWER_FRAGMENTED_STDERR")) {
      await writeAndWait(process.stdout, `${terminalLine}\n`);
    } else {
      writeLine(process.stdout, terminalLine);
    }
  }
  if (enabled("DEVPRO_FAKE_REVIEWER_PARTIAL_STDOUT")) {
    if (enabled("DEVPRO_FAKE_REVIEWER_FRAGMENTED_STDERR")) {
      await writeAndWait(process.stdout, env.DEVPRO_FAKE_REVIEWER_PARTIAL_STDOUT);
    } else {
      process.stdout.write(env.DEVPRO_FAKE_REVIEWER_PARTIAL_STDOUT);
    }
  }

  if (enabled("DEVPRO_FAKE_REVIEWER_STDERR_LINE")) process.stderr.write(`${env.DEVPRO_FAKE_REVIEWER_STDERR_LINE}\n`);
  else if (enabled("DEVPRO_FAKE_REVIEWER_FRAGMENTED_STDERR")) {
    await sleep(50);
    const payload = Buffer.from("stderr 第一行\nstderr 第二行\n", "utf8");
    const splitAt = Buffer.byteLength("stderr 第一行\nstderr 第", "utf8") + 1;
    process.stderr.write(payload.subarray(0, splitAt));
    process.stderr.write(payload.subarray(splitAt));
    await sleep(250);
  } else process.stderr.write("fake stderr line\n");

  process.exitCode = Number(env.DEVPRO_FAKE_REVIEWER_EXIT_CODE ?? 0);
}

export async function runFakeCodex() {
  const args = process.argv.slice(2);
  const env = process.env;
  const argsAsText = argsText(args);
  const fakePath = process.argv[1];

  if (args[0] === "login" && args[1] === "status" && args.length === 2) {
    if (env.DEVPRO_FAKE_AUTH_PREFLIGHT_LOG) writeFileSync(env.DEVPRO_FAKE_AUTH_PREFLIGHT_LOG, `${argsAsText}\n`);
    if (isInside(env.CODEX_HOME, env.DEVPRO_FAKE_AUTH_PREFLIGHT_FAIL_UNDER)) {
      process.stderr.write("Not logged in\n");
      process.exitCode = 1;
      return;
    }
    if (isInside(env.CODEX_HOME, env.DEVPRO_FAKE_CODEX_SELF_DELETE_UNDER)) {
      writeLine(process.stdout, "Logged in using test credentials");
      rmSync(fakePath, { force: true });
      rmSync(`${fakePath}.exe`, { force: true });
      return;
    }
    writeLine(process.stdout, "Logged in using test credentials");
    return;
  }

  if (args.some((arg) => ["--help", "-help", "-h", "help"].includes(arg))) {
    process.stdout.write("Usage: codex exec [OPTIONS] [PROMPT]\nCommands:\n  exec\nOptions:\n  --json\n  -C, --cd <DIR>\n  --ignore-rules\n  --skip-git-repo-check\n  -s, --sandbox <SANDBOX_MODE>\n  -c, --config <KEY=VALUE>\n  --add-dir <DIR>\n");
    return;
  }

  if (env.DEVPRO_FAKE_REVIEWER_INVOCATION_LOG) writeFileSync(env.DEVPRO_FAKE_REVIEWER_INVOCATION_LOG, `${argsAsText}\n`);
  const input = await readStdin();
  const inputBytes = Buffer.byteLength(input, "utf8");
  if (enabled("DEVPRO_FAKE_REVIEWER_DELAY_MS")) await sleep(env.DEVPRO_FAKE_REVIEWER_DELAY_MS);
  if (enabled("DEVPRO_FAKE_REVIEWER_OMIT_ALL_STDOUT")) {
    process.stderr.write("fake codex stderr line\n");
    process.exitCode = Number(env.DEVPRO_FAKE_REVIEWER_EXIT_CODE ?? 0);
    return;
  }

  const diagnostic = {
    type: "harness.diagnostic",
    tool: "codex",
    cross: env.DEVPRO_CROSS_MODEL_REVIEWER ?? "",
    input_bytes: inputBytes,
    args: argsAsText,
    cwd: process.cwd(),
    gh_repo: env.GH_REPO ?? "",
    review_pr: env.DEVPRO_REVIEW_PR_NUMBER ?? "",
    codex_home: env.CODEX_HOME ?? "",
  };
  writeEvent(diagnostic);
  if (enabled("DEVPRO_FAKE_REVIEWER_RAW_STDOUT_PREFIX")) writeLine(process.stdout, env.DEVPRO_FAKE_REVIEWER_RAW_STDOUT_PREFIX);
  if (enabled("DEVPRO_FAKE_REVIEWER_RAW_STDOUT_LINE_BYTES")) {
    const bytes = Number(env.DEVPRO_FAKE_REVIEWER_RAW_STDOUT_LINE_BYTES);
    const repeat = Number(env.DEVPRO_FAKE_REVIEWER_RAW_STDOUT_LINE_REPEAT || "1");
    for (let index = 0; index < repeat; index += 1) process.stdout.write(`${"x".repeat(bytes)}\n`);
  }
  if (enabled("DEVPRO_FAKE_REVIEWER_RAW_STDERR_LINE_BYTES")) {
    process.stderr.write(`${"x".repeat(Number(env.DEVPRO_FAKE_REVIEWER_RAW_STDERR_LINE_BYTES))}\n`);
  }
  if (!enabled("DEVPRO_FAKE_REVIEWER_OMIT_TERMINAL")) {
    if (enabled("DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT")) process.stdout.write(`${fixtureAssessmentLine(env.DEVPRO_FAKE_REVIEWER_TERMINAL_EVENT, input)}\n`);
    else writeLine(process.stdout, fixtureAssessmentLine('{"type":"item.completed","item":{"id":"item-final","type":"agent_message","text":"{\\"sticky_comment_url\\":\\"none\\",\\"verdict\\":\\"PASS\\",\\"last_reviewed_sha\\":\\"none\\",\\"reviewer_model\\":\\"codex-test\\",\\"reason\\":\\"No blocking findings.\\"}"}}', input));
  }
  if (enabled("DEVPRO_FAKE_REVIEWER_PARTIAL_STDOUT")) process.stdout.write(env.DEVPRO_FAKE_REVIEWER_PARTIAL_STDOUT);
  process.stderr.write("fake codex stderr line\n");
  process.exitCode = Number(env.DEVPRO_FAKE_REVIEWER_EXIT_CODE ?? 0);
}

function readCount(filePath) {
  try {
    return Number.parseInt(readFileSync(filePath, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export async function runFakeGh() {
  const args = process.argv.slice(2);
  const command = args.join(" ");
  const env = process.env;
  if (env.DEVPRO_FAKE_GH_LOG) appendFileSync(env.DEVPRO_FAKE_GH_LOG, `${command}\n`);
  if (env.DEVPRO_FAKE_REVIEWER_SIGNAL_LOG) {
    appendFileSync(env.DEVPRO_FAKE_REVIEWER_SIGNAL_LOG, "gh-sticky-query\n");
  }

  if (args[0] === "api") {
    const endpoint = args.find(arg => /^repos\//.test(arg)) ?? "";
    const response = /^repos\/[^/]+\/[^/]+$/.test(endpoint) ? env.DEVPRO_FAKE_GH_REPO_RESPONSE
      : /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(endpoint) ? env.DEVPRO_FAKE_GH_PR_RESPONSE : null;
    if (response) { writeLine(process.stdout, response); return; }
  }

  const headOnly = args[0] === "pr" && args[1] === "view"
    && args.includes("--json") && args[args.indexOf("--json") + 1] === "headRefOid";
  const issueComments = args[0] === "api" && args.some(arg => /\/issues\/[1-9]\d*\/comments(?:\?|$)/.test(arg));
  if (issueComments && env.DEVPRO_FAKE_GH_DYNAMIC_STICKY === "1") {
    const store = JSON.parse(readFileSync(env.DEVPRO_FAKE_GH_COMMENT_STORE, "utf8"));
    writeLine(process.stdout, JSON.stringify({ comments: [store.comment], completeness: { status: "complete", pagination_exhausted: true, pages_fetched: 1 }, query_error: null }));
    return;
  }
  // The paged fixture delegates immutable scope reads through the portable
  // Node wrapper; keep the normal live-head and comment responses below.
  if (env.DEVPRO_FAKE_GH_SCOPE_AUTHORITY
    && !headOnly
    && !issueComments
    && !(env.DEVPRO_FAKE_GH_DYNAMIC_STICKY === "1" && command.includes("issues/comments/"))) {
    const child = spawnSync(process.execPath, [env.DEVPRO_FAKE_GH_SCOPE_AUTHORITY, ...args], { stdio: "inherit" });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }

  const isApiComment = args[0] === "api" && command.includes("issues/comments/");
  if (isApiComment) {
    const countFile = env.DEVPRO_FAKE_GH_API_COUNT_FILE ?? "";
    const patchStore = countFile ? `${countFile}.patch-body` : "";
    const commentStore = env.DEVPRO_FAKE_GH_COMMENT_STORE
      || (countFile ? `${countFile}.comment-store` : "");
    const includeHeaders = args.includes("--include");
    const isPatch = /(?:^| )-X PATCH(?: |$)/u.test(command) || /(?:^| )--method PATCH(?: |$)/u.test(command);

    if (isPatch) {
      const patchBody = await readStdinRaw();
      if (patchStore) writeFileSync(patchStore, patchBody);
      let store = commentStore && existsSync(commentStore)
        ? JSON.parse(readFileSync(commentStore, "utf8"))
        : {
            etag: env.DEVPRO_FAKE_GH_EXACT_COMMENT_ETAG || "snap-current",
            comment: env.DEVPRO_FAKE_GH_EXACT_COMMENT_RESPONSE
              ? JSON.parse(env.DEVPRO_FAKE_GH_EXACT_COMMENT_RESPONSE)
              : {
                  id: 4242,
                  html_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242",
                  node_id: "IC_kwDOExample4242",
                  updated_at: "2026-08-18T12:00:00Z",
                  body: "",
                },
            getCount: 0,
          };
      const patch = patchStore && existsSync(patchStore)
        ? JSON.parse(readFileSync(patchStore, "utf8"))
        : { body: "" };
      if (typeof patch?.body === "string") store.comment.body = patch.body;
      store.comment.updated_at = "2026-08-18T12:00:00Z";
      store.etag = "snap-patched";
      if (commentStore) writeFileSync(commentStore, JSON.stringify(store));
      writeLine(process.stdout, JSON.stringify({
        id: store.comment.id,
        html_url: store.comment.html_url,
        node_id: store.comment.node_id,
        updated_at: store.comment.updated_at,
        body: "",
      }));
      return;
    }

    const exactRaw = env.DEVPRO_FAKE_GH_EXACT_COMMENT_RESPONSE ?? "";
    const staleRaw = env.DEVPRO_FAKE_GH_EXACT_COMMENT_STALE_RESPONSE ?? "";
    if (!exactRaw && !(commentStore && existsSync(commentStore))) return;
    let store = commentStore && existsSync(commentStore)
      ? JSON.parse(readFileSync(commentStore, "utf8"))
      : {
          etag: env.DEVPRO_FAKE_GH_EXACT_COMMENT_ETAG || "snap-current",
          comment: JSON.parse(exactRaw),
          getCount: 0,
        };
    store.getCount = (store.getCount || 0) + 1;
    const response = JSON.stringify(store.comment);
    if (includeHeaders) {
      process.stdout.write(`HTTP/2.0 200 OK\nETag: ${store.etag}\n\n${response}\n`);
    } else writeLine(process.stdout, response);
    if (store.getCount === 1 && staleRaw) {
      store.comment = JSON.parse(staleRaw);
      store.etag = env.DEVPRO_FAKE_GH_EXACT_COMMENT_STALE_ETAG || "snap2";
    }
    if (commentStore) writeFileSync(commentStore, JSON.stringify(store));
    return;
  }

  if (args[0] === "api" && command.includes("/compare/") && env.DEVPRO_FAKE_GH_COMPARE_RESPONSE) {
    writeLine(process.stdout, env.DEVPRO_FAKE_GH_COMPARE_RESPONSE);
    return;
  }

  if (headOnly) {
    const countFile = env.DEVPRO_FAKE_GH_HEAD_COUNT_FILE ?? "";
    let headCount = 1;
    if (countFile) {
      headCount = readCount(countFile) + 1;
      writeFileSync(countFile, String(headCount));
    }
    if (headCount > 1 && env.DEVPRO_FAKE_GH_HEAD_AFTER_FIRST_RESPONSE) {
      writeLine(process.stdout, env.DEVPRO_FAKE_GH_HEAD_AFTER_FIRST_RESPONSE);
      return;
    }
    const headRefOid = env.DEVPRO_FAKE_GH_HEAD_REF_OID || "a".repeat(40);
    const query = args.includes("--jq") ? args[args.indexOf("--jq") + 1] : null;
    writeLine(process.stdout, query === ".headRefOid" ? headRefOid : JSON.stringify({ headRefOid }));
    return;
  }

  if (args[0] === "api" && env.DEVPRO_FAKE_GH_API_RESPONSE) {
    const countFile = env.DEVPRO_FAKE_GH_API_COUNT_FILE ?? "";
    let apiCount = 1;
    if (countFile) {
      apiCount = readCount(countFile) + 1;
      writeFileSync(countFile, String(apiCount));
    }
    const response = apiCount > 1 && env.DEVPRO_FAKE_GH_POST_API_RESPONSE
      ? env.DEVPRO_FAKE_GH_POST_API_RESPONSE
      : env.DEVPRO_FAKE_GH_API_RESPONSE;
    writeLine(process.stdout, fixtureStickyResponse(response));
    return;
  }

  if (env.DEVPRO_FAKE_GH_RESPONSE) writeLine(process.stdout, fixtureStickyResponse(env.DEVPRO_FAKE_GH_RESPONSE));
  else writeLine(process.stdout, '{"comments":[],"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}');
}

// Fake OpenCode v2 CLI. `run` stores what it was given and what it printed under a state
// directory keyed by session id; `session export` replays that state, optionally corrupted
// by DEVPRO_FAKE_OPENCODE_EXPORT_MODE, so the runner is judged on the export alone.
const FAKE_OPENCODE_RUN_HELP = [
  "USAGE",
  "  opencode run [flags]",
  "FLAGS",
  "  --standalone   run without a server",
  "  --format <fmt>   output format",
  "  --agent <name>   agent to use",
  "  --model <id>   model to use",
  "",
].join("\n");
const FAKE_OPENCODE_EXPORT_HELP = "DESCRIPTION\n  Export session data as JSON\n\nUSAGE\n  opencode session export [flags] [<session>]\n";

function fakeOpenCodeStateDir() {
  const dir = process.env.DEVPRO_FAKE_OPENCODE_STATE_DIR;
  if (!dir) throw new Error("DEVPRO_FAKE_OPENCODE_STATE_DIR is required by the fake opencode");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeOpenCodeReportText(input) {
  const probe = /single token (\S+) and nothing else/u.exec(input.toString("utf8"));
  if (probe) return probe[1];
  const configured = process.env.DEVPRO_FAKE_OPENCODE_REPORT;
  if (!configured) throw new Error("DEVPRO_FAKE_OPENCODE_REPORT is required for a review run");
  // Reuse the claude/codex assessment injector so ordinary completions stay valid.
  const line = fixtureAssessmentLine(JSON.stringify({ type: "result", result: configured }), input.toString("utf8"));
  return JSON.parse(line).result;
}

export async function runFakeOpenCode() {
  const args = process.argv.slice(2);
  const env = process.env;
  const joined = argsText(args);
  if (joined === "--version") {
    writeLine(process.stdout, env.DEVPRO_FAKE_OPENCODE_VERSION ?? "2.0.24");
    return;
  }
  if (joined === "run --help") {
    process.stdout.write(FAKE_OPENCODE_RUN_HELP);
    return;
  }
  if (joined === "session export --help") {
    process.stdout.write(FAKE_OPENCODE_EXPORT_HELP);
    return;
  }
  if (args[0] === "api" && args[1] === "model.list") {
    process.stdout.write(JSON.stringify({ data: [{
      id: "deepseek-v4-pro", modelID: "deepseek-v4-pro", providerID: "deepseek", name: "DeepSeek V4 Pro",
      enabled: true, status: "active", capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: ["low", "high", "max"].map(id => ({ id, settings: { reasoningEffort: id } })),
    }] }));
    return;
  }
  const stateDir = fakeOpenCodeStateDir();

  if (args[0] === "run") {
    const input = await readStdinRaw();
    logFile("DEVPRO_FAKE_OPENCODE_INVOCATION_LOG", `${joined}\tcwd=${process.cwd()}\tconfig=${env.OPENCODE_CONFIG ?? ""}\tproject_config_disabled=${env.OPENCODE_DISABLE_PROJECT_CONFIG ?? ""}\n`);
    // The launch file is removed once a run ends; tests that judge its content ask for a copy.
    if (enabled("DEVPRO_FAKE_OPENCODE_CONFIG_COPY") && env.OPENCODE_CONFIG) {
      writeFileSync(env.DEVPRO_FAKE_OPENCODE_CONFIG_COPY, readFileSync(env.OPENCODE_CONFIG));
    }
    const reportText = fakeOpenCodeReportText(input);
    const isProbe = /single token (\S+) and nothing else/u.test(input.toString("utf8"));
    const modelIndex = args.indexOf("--model");
    const selector = modelIndex >= 0 ? args[modelIndex + 1] : "";
    const sessionId = `ses_fake${String(readCount(path.join(stateDir, "count")) + 1).padStart(8, "0")}`;
    writeFileSync(path.join(stateDir, "count"), `${readCount(path.join(stateDir, "count")) + 1}\n`);
    writeFileSync(path.join(stateDir, `${sessionId}.json`), JSON.stringify({
      input: input.toString("utf8"),
      report: reportText,
      selector,
      probe: isProbe,
    }));
    // Misbehaving-reviewer switches for the output-bound and process-tree tests of the primary route.
    // A descendant that inherits stdout/stderr keeps the pipes open after this process is gone.
    if (enabled("DEVPRO_FAKE_OPENCODE_DESCENDANT_PID_FILE")) {
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
      descendant.unref(); // the reviewer itself must be able to exit while the descendant lingers
      writeFileSync(env.DEVPRO_FAKE_OPENCODE_DESCENDANT_PID_FILE, `${descendant.pid}\n`);
    }
    if (enabled("DEVPRO_FAKE_OPENCODE_STDERR_LINE_BYTES")) {
      for (let index = 0; index < Number(env.DEVPRO_FAKE_OPENCODE_STDERR_LINE_COUNT ?? 1); index += 1) {
        await writeAndWait(process.stderr, `${"e".repeat(Number(env.DEVPRO_FAKE_OPENCODE_STDERR_LINE_BYTES))}\n`);
      }
    }
    if (enabled("DEVPRO_FAKE_OPENCODE_STDOUT_LINE_BYTES")) {
      // One JSON event line of exactly this many bytes (newline excluded), repeated LINE_COUNT times.
      const base = JSON.stringify({ type: "noise", pad: "" });
      const total = Number(env.DEVPRO_FAKE_OPENCODE_STDOUT_LINE_BYTES);
      const line = JSON.stringify({ type: "noise", pad: "x".repeat(total - base.length) });
      for (let index = 0; index < Number(env.DEVPRO_FAKE_OPENCODE_STDOUT_LINE_COUNT ?? 1); index += 1) {
        await writeAndWait(process.stdout, `${line}\n`);
      }
    }
    if (enabled("DEVPRO_FAKE_OPENCODE_NO_NEWLINE_FLOOD_BYTES")) {
      const chunk = "z".repeat(16 * 1024);
      for (let written = 0; written < Number(env.DEVPRO_FAKE_OPENCODE_NO_NEWLINE_FLOOD_BYTES); written += chunk.length) {
        await writeAndWait(process.stdout, chunk);
      }
    }
    if (enabled("DEVPRO_FAKE_OPENCODE_HANG")) {
      await new Promise(() => setInterval(() => {}, 1000));
    }
    const now = 1792259653000;
    writeEvent({ type: "step_start", timestamp: now, sessionID: sessionId, part: { type: "step-start", sessionID: sessionId } });
    // Like export corruption, tool calls target the review window unless asked otherwise.
    // "1" emits one `read`; otherwise a comma-separated list of tool names.
    if (enabled("DEVPRO_FAKE_OPENCODE_TOOL_USE") && (!isProbe || env.DEVPRO_FAKE_OPENCODE_EXPORT_SCOPE === "all")) {
      const tools = env.DEVPRO_FAKE_OPENCODE_TOOL_USE === "1" ? ["read"] : env.DEVPRO_FAKE_OPENCODE_TOOL_USE.split(",");
      tools.forEach((tool, index) => {
        writeEvent({ type: "tool_use", timestamp: now + 1 + index, sessionID: sessionId, part: { type: "tool", tool, state: { status: "completed" } } });
      });
    }
    writeEvent({
      type: "text",
      timestamp: now + 2,
      sessionID: sessionId,
      part: { type: "text", sessionID: sessionId, text: reportText, time: { start: now, end: now + 2 } },
    });
    process.exitCode = Number(env.DEVPRO_FAKE_OPENCODE_RUN_EXIT_CODE ?? 0);
    return;
  }

  if (args[0] === "session" && args[1] === "export") {
    const sessionId = args[args.length - 1];
    const state = JSON.parse(readFileSync(path.join(stateDir, `${sessionId}.json`), "utf8"));
    // Corruption targets the review window by default so the readiness probe still passes;
    // DEVPRO_FAKE_OPENCODE_EXPORT_SCOPE=all also corrupts the probe's token session.
    const corrupt = !state.probe || env.DEVPRO_FAKE_OPENCODE_EXPORT_SCOPE === "all";
    const mode = corrupt ? (env.DEVPRO_FAKE_OPENCODE_EXPORT_MODE ?? "ok") : "ok";
    const exportModel = corrupt ? env.DEVPRO_FAKE_OPENCODE_EXPORT_MODEL : undefined;
    if (mode === "unavailable") {
      process.stderr.write("fake opencode: export unavailable\n");
      process.exitCode = 1;
      return;
    }
    if (mode === "malformed") {
      process.stdout.write("this is not json\n");
      return;
    }
    if (mode === "bad-schema") {
      // Valid JSON that is not an opencode session export: info.id is missing.
      process.stdout.write(`${JSON.stringify({ messages: [] })}\n`);
      return;
    }
    // #3624: a release that prints a one-line banner ahead of the exported JSON, with the
    // session itself intact.
    const banner = mode === "banner" ? `Exporting session ${sessionId} ...\n` : "";
    const selector = (exportModel ?? state.selector).split("#")[0];
    const slash = selector.indexOf("/");
    const model = { id: selector.slice(slash + 1), providerID: selector.slice(0, slash), variant: state.selector.split("#")[1] ?? "default" };
    const finish = mode === "unfinished" ? "length" : "stop";
    const exported = {
      info: {
        id: sessionId,
        model,
        outcome: "succeeded",
        time: { created: 1792259652153, updated: 1792259652238, idle: 1792259653337 },
        location: { directory: process.cwd() },
      },
      messages: [
        { id: "msg_fake0001", time: { created: 1792259652251 }, text: mode === "wrong-input" ? `${state.input}\ntampered` : state.input, files: [], type: "user" },
        {
          id: "msg_fake0002",
          time: { created: 1792259652269, streamed: 1792259653334, completed: 1792259653335 },
          type: "assistant",
          agent: "build",
          model,
          content: [{ type: "text", text: mode === "wrong-report" ? `${state.report} (edited)` : state.report }],
          finish,
          rawFinish: finish,
        },
        { id: "msg_fake0003", time: { created: 1792259653337 }, type: "idle", outcome: "succeeded" },
      ],
    };
    process.stdout.write(`${banner}${JSON.stringify(exported)}\n`);
    return;
  }

  process.stderr.write(`fake opencode: unsupported invocation ${joined}\n`);
  process.exitCode = 2;
}
