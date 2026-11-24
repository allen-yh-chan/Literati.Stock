import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CHECKED_SIGNALS, detectPlaywrightProjects } from "../detect-playwright-projects.mjs";
import { repoPath } from "./lib/repo-root.mjs";

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

function fixture(tracked, untracked = {}) {
  const repo = mkdtempSync(join(tmpdir(), "playwright detection "));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo, env }).status, 0);
  writeFiles(repo, tracked);
  assert.equal(spawnSync("git", ["add", "."], { cwd: repo, env }).status, 0);
  writeFiles(repo, untracked);
  return repo;
}

const summary = (result) =>
  result.projects.map(({ stack, project, declared }) => `${stack}:${project}:${declared}`);

describe("detect-playwright-projects", () => {
  const notDeclared = {
    "package.json": '{ "devDependencies": { "typescript": "^5.0.0" } }\n',
    "scripts-only/package.json": '{ "scripts": { "playwright": "playwright test" } }\n',
    "overrides-only/package.json": '{ "overrides": { "playwright": "1.50.0" } }\n',
    "src/App/App.csproj": '<PackageReference Include="Serilog" Version="4.0.0" />\n',
    "src/Old/Old.csproj": '<Project><!-- <PackageReference Include="Microsoft.Playwright" /> --></Project>\n',
    "src/Cdata/Cdata.csproj": '<Project><![CDATA[<PackageReference Include="Microsoft.Playwright" />]]></Project>\n',
    "src/Attr/Attr.csproj":
      '<Project><PackageReference Include="Serilog" Condition="Include=\'Microsoft.Playwright\'" /></Project>\n',
    "docs/testing.md": "Microsoft.Playwright and @playwright/test are mentioned here only.\n",
  };
  const untracked = {
    "scratch/playwright.config.js": "export default {};\n",
    "scratch/Scratch.csproj": '<PackageReference Include="Microsoft.Playwright" />\n',
  };
  let declaredRepo;
  let absentRepo;

  before(() => {
    declaredRepo = fixture(
      {
        ...notDeclared,
        "web/e2e/package.json": '{ "devDependencies": { "@playwright/test": "^1.50.0" } }\n',
        "tools/runner/package.json": '{\n  "dependencies": {\n    "playwright"\n      : "^1.50.0"\n  }\n}\n',
        "web/config-only/playwright.config.ts": "export default {};\n",
        "tests/App.E2E/App.E2E.csproj":
          '<PackageReference\n  Include="Microsoft.Playwright.NUnit"\n  Version="1.50.0" />\n',
        "tests/Api.E2E/Api.E2E.csproj": '<PackageReference Include="Microsoft.Playwright" Version="1.50.0" />\n',
        "shared/Directory.Build.props": '<PackageReference Include="Microsoft.Playwright.Xunit" />\n',
      },
      untracked
    );
    absentRepo = fixture(notDeclared, untracked);
  });

  after(() => {
    rmSync(declaredRepo, { recursive: true, force: true });
    rmSync(absentRepo, { recursive: true, force: true });
  });

  it("finds every declared shape, including subdirectories and .NET", () => {
    const result = detectPlaywrightProjects(declaredRepo);
    assert.equal(result.status, "detected");
    assert.deepEqual(summary(result).sort(), [
      "dotnet:shared:true",
      "dotnet:tests/Api.E2E:true",
      "dotnet:tests/App.E2E:true",
      "node:tools/runner:true",
      "node:web/config-only:false",
      "node:web/e2e:true",
    ]);
  });

  it("reports none for keys outside dependencies, comments, mentions, and untracked files", () => {
    const result = detectPlaywrightProjects(absentRepo);
    assert.equal(result.status, "none");
    assert.deepEqual(result.projects, []);
    assert.deepEqual(result.checked, [...CHECKED_SIGNALS]);
  });

  it("reports not-verified instead of none when a manifest cannot be parsed", () => {
    const repo = fixture({ "web/package.json": "{ not json\n" });
    try {
      const result = detectPlaywrightProjects(repo);
      assert.equal(result.status, "not-verified");
      assert.deepEqual(result.unreadable, ["web/package.json"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps detected projects but reports not-verified when another manifest cannot be parsed", () => {
    const repo = fixture({
      "web/e2e/package.json": '{ "devDependencies": { "@playwright/test": "^1.50.0" } }\n',
      "web/broken/package.json": "{ not json\n",
    });
    try {
      const result = detectPlaywrightProjects(repo);
      assert.equal(result.status, "not-verified");
      assert.deepEqual(result.unreadable, ["web/broken/package.json"]);
      assert.deepEqual(summary(result), ["node:web/e2e:true"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  const brokenXml = {
    "unclosed without Playwright": "<Project><ItemGroup>\n",
    "unclosed with Playwright": '<Project><ItemGroup><PackageReference Include="Microsoft.Playwright" />\n',
    "mismatched close tag": "<Project><ItemGroup></Project></ItemGroup>\n",
    "unterminated comment": "<Project><!-- </Project>\n",
    "unterminated tag": '<Project><PackageReference Include="Microsoft.Playwright"\n',
    "stray close tag": "</Project>\n",
    "second root": "<Project></Project><Project></Project>\n",
    "no element": "<!-- empty -->\n",
    "stray less-than after the root": "<Project></Project><\n",
    "unquoted attribute": "<Project><ItemGroup><PackageReference Include=Microsoft.Playwright /></ItemGroup></Project>\n",
    "attribute without equals":
      '<Project><ItemGroup><PackageReference Include "Microsoft.Playwright" /></ItemGroup></Project>\n',
    "attributes without a space": '<Project><ItemGroup a="1"b="2"></ItemGroup></Project>\n',
  };
  for (const [shape, content] of Object.entries(brokenXml)) {
    for (const file of ["src/App/App.csproj", "src/Directory.Build.props"]) {
      it(`reports not-verified for ${file} with ${shape}`, () => {
        const repo = fixture({ [file]: content });
        try {
          const result = detectPlaywrightProjects(repo);
          assert.equal(result.status, "not-verified");
          assert.deepEqual(result.unreadable, [file]);
          assert.deepEqual(result.projects, []);
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });
    }
  }

  it("keeps detected projects when another project file has invalid attribute syntax", () => {
    const repo = fixture({
      "tests/App/App.csproj": '<Project><PackageReference Include="Microsoft.Playwright" /></Project>\n',
      "tests/Bad/Bad.csproj": "<Project><PackageReference Include=Microsoft.Playwright /></Project>\n",
    });
    try {
      const result = detectPlaywrightProjects(repo);
      assert.equal(result.status, "not-verified");
      assert.deepEqual(result.unreadable, ["tests/Bad/Bad.csproj"]);
      assert.deepEqual(summary(result), ["dotnet:tests/App:true"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  const validXml = {
    "byte order mark and declaration":
      '\uFEFF<?xml version="1.0"?><Project><ItemGroup><PackageReference Include="Microsoft.Playwright" /></ItemGroup></Project>\n',
    "greater-than inside conditions":
      '<Project><ItemGroup Condition="\'$(V)\' > \'1\'"><PackageReference Condition="\'$(V)\' > \'1\'" Include="Microsoft.Playwright" /></ItemGroup></Project>\n',
    "open and close PackageReference":
      '<Project><ItemGroup><PackageReference Update="Microsoft.Playwright.MSTest"><Version>1.50.0</Version></PackageReference></ItemGroup></Project>\n',
  };
  for (const [shape, content] of Object.entries(validXml)) {
    it(`detects a valid project file with ${shape}`, () => {
      const repo = fixture({ "tests/App/App.csproj": content });
      try {
        const result = detectPlaywrightProjects(repo);
        assert.equal(result.status, "detected");
        assert.deepEqual(summary(result), ["dotnet:tests/App:true"]);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }

  it("runs as a CLI without shell quoting from a path containing spaces", () => {
    const cli = spawnSync(process.execPath, [repoPath(".devpro/scripts/detect-playwright-projects.mjs")], {
      cwd: declaredRepo,
      env,
      encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).status, "detected");
  });
});
