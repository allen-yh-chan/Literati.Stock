import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";



function readFirst(paths) {
  for (const rel of paths) {
    if (existsSync(repoPath(rel))) return read(rel);
  }
  throw new Error(`none of the expected files exist: ${paths.join(", ")}`);
}

describe("environment setup Playwright install anchors", () => {
  const rule = read(".devpro/agent-rules/environment-setup-nvm-nodejs-openspec.md");
  const environmentSetupSpec = readFirst([
    "openspec/changes/add-playwright-environment-check/specs/environment-setup/spec.md",
    "openspec/specs/environment-setup/spec.md",
  ]);

  it("rule detects declared Playwright before install", () => {
    assert.match(rule, /playwright\.config\.\*/);
    assert.match(rule, /@playwright\/test/);
    assert.match(rule, /Playwright: N\/A/);
  });

  it("rule scans tracked files in subdirectories and both stacks before N/A", () => {
    assert.match(rule, /偵測：在 worktree 根目錄跑 `node \.devpro\/scripts\/detect-playwright-projects\.mjs`/);
    assert.match(rule, /- Node 訊號：[^\n]*`scripts`、`overrides` 等其他欄位不算/);
    assert.match(rule, /- \.NET 訊號：任一層 `\*\.csproj` 或 `Directory\.Build\.props` 的 `PackageReference` 含 `Microsoft\.Playwright`/);
    assert.match(rule, /`not-verified` → [^\n]*MUST NOT 回報 N\/A/);
    assert.match(
      rule,
      /- `none` → `Playwright: N\/A（已查 tracked playwright\.config\.\*、package\.json、\*\.csproj、Directory\.Build\.props）`/
    );
    assert.match(rule, /「根目錄沒有 Node 專案」MUST NOT 當成 N\/A 依據/);
  });

  it("rule gates .NET Playwright on build output and pwsh without inventing commands", () => {
    assert.match(rule, /\*\*Local package gate（\.NET）\*\*/);
    assert.match(rule, /pwsh <輸出目錄>\/playwright\.ps1 install --with-deps/);
    assert.match(rule, /pwsh <輸出目錄>\/playwright\.ps1 install --list/);
    assert.match(rule, /`dotnet list <專案> package`/);
    assert.match(rule, /`playwright\.ps1` 缺失 → \*\*MUST NOT\*\* 自動 build[^\n]*blocked/);
    assert.match(rule, /`pwsh` 缺失 → \*\*MUST NOT\*\* 自動安裝 PowerShell[^\n]*blocked/);
    assert.doesNotMatch(rule, /playwright\.ps1 --version/);
  });

  it("rule covers subdirectory Node projects without running npx at repo root", () => {
    assert.match(rule, /\*\*Local package gate（Node）\*\*：在命中專案目錄/);
    assert.match(rule, /依賴未裝 → 禁 `npx playwright`[^\n]*blocked/);
  });

  it("rule still gates readable projects when another manifest is not verified", () => {
    assert.match(rule, /`not-verified` →[^\n]*`projects` 非空時仍逐一跑下方 gate/);
  });

  it("rule and spec state the project-file check is not a full XML validator", () => {
    assert.match(rule, /`not-verified` →[^\n]*只驗 tag 與 attribute 語法，不是完整 XML 驗證/);
    assert.match(environmentSetupSpec, /project-file check is not a full XML validator/);
  });

  it("config-only blocks only when the local CLI is missing, in rule and spec", () => {
    assert.match(rule, /未宣告（只有 `playwright\.config\.\*`）且上述路徑都沒有 CLI → 禁 `npx playwright`/);
    assert.doesNotMatch(rule, /未宣告（只有 `playwright\.config\.\*`）→/);
    assert.match(rule, /local 已 install（含只有 `playwright\.config\.\*`[^\n]*）→ 在該目錄跑/);
    assert.match(environmentSetupSpec, /Scenario: Playwright config-only with a workspace CLI installs browser dependencies/);
  });

  it("rule includes devpro:change worktree trigger before repo writes", () => {
    assert.match(rule, /devpro:change.*worktree/);
    assert.match(rule, /第一個 repo write 前/);
  });

  it("rule includes Playwright browser install and verification commands", () => {
    assert.match(rule, /npx playwright --version/);
    assert.match(rule, /npx playwright install --with-deps/);
    assert.match(rule, /npx playwright install --list/);
  });

  it("rule forbids automatic Playwright package additions", () => {
    assert.match(rule, /不可.*自動新增或升級 Playwright npm package 或 `Microsoft\.Playwright` NuGet package/);
    assert.match(rule, /third-party-packages-licensing\.md/);
  });

  it("spec delta locks Playwright install scenarios", () => {
    assert.match(environmentSetupSpec, /Scenario: Playwright absent in repo is N\/A/);
    assert.match(environmentSetupSpec, /Scenario: Playwright declared installs browser dependencies/);
    assert.match(environmentSetupSpec, /npx playwright install --with-deps/);
    assert.match(environmentSetupSpec, /MUST NOT auto-add Playwright package dependencies/);
  });

  it("spec locks .NET and subdirectory Playwright scenarios", () => {
    assert.match(environmentSetupSpec, /Scenario: Playwright in a subdirectory project is not N\/A/);
    assert.match(environmentSetupSpec, /Scenario: \.NET Playwright declared installs browsers from build output/);
    assert.match(environmentSetupSpec, /Scenario: \.NET Playwright without build output or pwsh reports blocked/);
    assert.match(environmentSetupSpec, /Scenario: Playwright keys outside dependencies are not declared/);
    assert.match(environmentSetupSpec, /Scenario: Unparseable manifest is not N\/A/);
    assert.match(environmentSetupSpec, /`pwsh <output-dir>\/playwright\.ps1 install --with-deps`/);
    assert.match(environmentSetupSpec, /MUST NOT auto-build[^\n]*MUST NOT auto-install PowerShell/);
  });

  it("devpro:change startup gate names both Playwright stacks", () => {
    const skill = read(".devpro/agent-skills/devpro-workflows/change/SKILL.md");
    assert.match(
      skill,
      /Playwright local-package gate（掃 tracked 檔含子目錄；Node [^\n]*`\.bin\/playwright`[^\n]*\.NET [^\n]*`playwright\.ps1`[^\n]*`pwsh`/
    );
  });

  it("spec locks devpro:change setup before first repo write", () => {
    assert.match(environmentSetupSpec, /Scenario: `devpro:change` worktree setup runs before repo writes/);
    assert.match(environmentSetupSpec, /before creating `openspec\/changes\/<name>\/` or writing meeting-notes\.md/);
    assert.match(environmentSetupSpec, /`nvm install` followed by `nvm use` before any repo write/);
  });
});
