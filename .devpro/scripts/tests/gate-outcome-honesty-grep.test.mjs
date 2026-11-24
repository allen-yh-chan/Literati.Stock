/**
 * Prove-it / drift locks for strengthen-gate-outcome-honesty (R1–R4).
 * Locks §10 three triggers + two-state empty output; startup env-ready +
 * link preflight; Stop-Point blocked/not verified; 覆蓋：/not verified;
 * ban junction/symlink/hardlink shared deps.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

test("R3: design-core §10 carries three triggers + two-state empty output", () => {
  const content = read(".devpro/agent-rules/design-core.md");
  const lines = content.split("\n");
  assert.ok(
    lines.includes("### 10. Environment-Dependent Gate Effective Scope"),
    "§10 H3 title must remain"
  );
  assert.match(content, /diff[- ]base|merge-base|base 不可解/);
  assert.match(content, /不相交|副檔名|目錄掃描/);
  assert.match(content, /checked=false|not verified:\s*base unresolved/);
  assert.match(content, /no applicable files|checked=0/);
  assert.match(content, /兩態/);
  assert.match(
    content,
    /MUST NOT.*(?:印成|印成)\s*`?no applicable files|MUST NOT[\s\S]{0,80}no applicable files/
  );
  assert.match(content, /範圍描述＋實際檢查數|範圍.*檢查數/);
});

test("R1: 標準開工序列 requires 環境就緒後 deps + bans shared-deps links", () => {
  const content = read(".devpro/agent-rules/git-branch-naming-and-anchor.md");
  assert.match(content, /標準開工序列/);
  assert.match(content, /環境就緒後/);
  assert.match(content, /environment-setup-nvm-nodejs-openspec\.md/);
  assert.match(content, /npm ci/);
  assert.match(content, /dotnet restore/);
  assert.match(content, /MUST NOT[\s\S]{0,200}(?:junction|symlink|hardlink)/);
  assert.match(content, /(?:junction|symlink|hardlink)[\s\S]{0,120}(?:共用|共享)/);
});

test("R1: environment-setup carries link preflight + install before Playwright", () => {
  const content = read(".devpro/agent-rules/environment-setup-nvm-nodejs-openspec.md");
  assert.match(content, /symlink|junction|reparse/);
  assert.match(content, /MUST NOT[\s\S]{0,200}npm ci/);
  assert.match(content, /blocked|not verified/);
  assert.match(content, /npm ci/);
  assert.match(content, /yarn install --frozen-lockfile/);
  assert.match(content, /pnpm install --frozen-lockfile/);
  assert.match(content, /MUST NOT[\s\S]{0,80}yarn[\s\S]{0,40}pnpm[\s\S]{0,40}npm ci|MUST NOT[\s\S]{0,120}對 yarn／pnpm/);
  assert.match(content, /dotnet restore/);
  const installIdx = content.search(/專案依賴|project dependenc|npm ci/);
  const playwrightIdx = content.indexOf("**Playwright");
  assert.ok(installIdx >= 0, "project dependency install step missing");
  assert.ok(playwrightIdx >= 0, "Playwright step missing");
  assert.ok(
    installIdx < playwrightIdx,
    "project dependency install MUST appear before Playwright"
  );
});

test("R1: devpro:change unique order submodule → CLI → link → install → Playwright → write", () => {
  const skill = read(".devpro/agent-skills/devpro-workflows/change/SKILL.md");
  assert.match(skill, /git submodule update --init --recursive/);
  assert.match(skill, /link／reparse 前置|link\/reparse/);
  assert.match(skill, /npm ci/);
  assert.match(skill, /Playwright local-package/);
  assert.match(skill, /第一個 implementation write/);
  const step10 = skill.slice(
    skill.indexOf("10. **環境檢查/setup"),
    skill.indexOf("11. `mkdir -p openspec/changes")
  );
  const link = step10.indexOf("link／reparse 前置");
  const install = step10.indexOf("專案依賴安裝");
  const pw = step10.indexOf("Playwright local-package");
  assert.ok(link >= 0 && install >= 0 && pw >= 0, "step 10 missing ordered substeps");
  assert.ok(link < install, "link preflight before install");
  assert.ok(install < pw, "install before Playwright");
  // Unique order documented relative to submodule (step 8) and first write ban in step 10 header
  const sub = skill.indexOf("8. `git submodule update --init --recursive`");
  const step10idx = skill.indexOf("10. **環境檢查/setup");
  assert.ok(sub >= 0 && sub < step10idx, "submodule before env setup step 10");
});

test("R2: ai-autonomy Stop-Point has environment-unexecutable blocked/not verified", () => {
  const content = read(".devpro/agent-rules/ai-autonomy.md");
  const start = content.indexOf("### Stop-Point Next Step Contract");
  assert.ok(start >= 0);
  const section = content.slice(start, start + 2500);
  assert.match(section, /blocked/);
  assert.match(section, /not verified/);
  assert.match(section, /外部環境|環境不可執行|網路不通|依賴裝不了/);
  assert.match(section, /MUST NOT[\s\S]{0,200}(?:junction|symlink)/);
});

test("R2: rationalizations row rejects environment workaround", () => {
  const content = read(".devpro/agent-rules/ai-autonomy-rationalizations.md");
  assert.match(content, /環境問題先繞過去|環境.*繞過|先繞過去.*gate/);
  assert.match(content, /not verified|blocked/);
  assert.match(content, /junction|假綠/);
});

test("R2/R4: PR templates allow not verified and require 覆蓋：", () => {
  const rule = read(".devpro/agent-rules/git-pr-template-and-merge.md");
  const tmpl = read(".github/PULL_REQUEST_TEMPLATE.md");
  for (const [label, content] of [
    ["git-pr-template-and-merge.md", rule],
    ["PULL_REQUEST_TEMPLATE.md", tmpl],
  ]) {
    assert.match(content, /結果：/, `${label} missing 結果：`);
    assert.match(content, /not verified/, `${label} missing not verified`);
    assert.match(content, /覆蓋：/, `${label} missing 覆蓋：`);
    assert.match(
      content,
      /no applicable files|checked=0|base unresolved/,
      `${label} missing two-state coverage guidance`
    );
  }
});

test("R2/R3: testing-and-qa pointers to Stop-Point and §10", () => {
  const content = read(".devpro/agent-rules/testing-and-qa.md");
  assert.match(content, /ai-autonomy\.md/);
  assert.match(content, /Stop-Point|not verified|blocked/);
  assert.match(content, /design-core\.md.*§10|§10|Environment-Dependent Gate Effective Scope/);
  assert.match(content, /checked=false/);
});
