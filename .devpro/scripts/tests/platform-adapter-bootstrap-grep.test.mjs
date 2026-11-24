import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
async function read(relPath) {
  return fs.readFile(repoPath(relPath), "utf8");
}

describe("platform adapter bootstrap", () => {
  it("AGENTS.md always-loaded self-check requires active platform adapter before writes", async () => {
    const agents = await read("AGENTS.md");

    assert.match(agents, /bash cwd \/ platform/);
    assert.match(agents, /write 前讀 active adapter/);
    assert.match(agents, /git write 前先 `pwd && git rev-parse --abbrev-ref HEAD`/);
    assert.match(agents, /adapter\/runtime\|`platform-adapter-contract\.md`/);
    assert.doesNotMatch(agents, /adapter\/runtime[^\n]*platform-adapters\/\*\.md/);
  });

  it("shared adapter contract defines active-runtime-only bootstrap and unknown-runtime stop", async () => {
    const contract = await read(".devpro/agent-rules/platform-adapter-contract.md");

    assert.match(contract, /## When to Use/);
    assert.match(contract, /任何 repository tool operation（含唯讀 `rg`／`cat`）前先判定 active runtime\/platform/);
    assert.match(contract, /純文字問答.*不載入 runtime adapter/);
    assert.match(contract, /active runtime\/platform/);
    assert.match(contract, /只載入 active runtime 的 adapter/);
    assert.match(contract, /不得預設載入全部 `platform-adapters\/\*\.md`/);
    assert.match(contract, /AGENTS\.md 只 eager-load 本契約/);
    assert.match(contract, /不得由 AGENTS trigger index eager-load `platform-adapters\/\*\.md`/);
    assert.match(contract, /runtime-unknown blocker/);
    assert.match(contract, /write-class 動作前已停下/);
  });

  it("ai-autonomy expands the AGENTS.md platform bootstrap line", async () => {
    const autonomy = await read(".devpro/agent-rules/ai-autonomy.md");

    assert.match(autonomy, /bash cwd \/ platform adapter/);
    assert.match(autonomy, /先判定 active runtime\/platform/);
    assert.match(autonomy, /`platform-adapter-contract\.md` \+ 對應 `platform-adapters\/<runtime>\.md`/);
    assert.match(autonomy, /若無法判定 runtime，write-class 動作前停下釐清/);
  });

  it("README documents platform adapter bootstrap as part of the always-loaded layer", async () => {
    const readme = await read("README.md");

    assert.match(readme, /platform adapter bootstrap/);
    assert.match(readme, /write 前先載 active platform adapter/);
  });
});
