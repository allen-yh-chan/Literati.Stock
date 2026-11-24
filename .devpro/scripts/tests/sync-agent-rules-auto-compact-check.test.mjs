import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  autoCompactEnv,
  createFakeCommand,
  fakePromptSession,
  maybeRepairClaudeAutoCompact,
  maybeRepairCodexAutoCompact,
  repoRoot,
  run,
  withEnv,
  withConsumerRepo,
  withSlimSyncSource,
} from "./lib/sync-agent-rules-harness.mjs";

async function captureConsoleLog(fn) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

it("applies Claude Code and Codex auto-compact settings when prompt confirmation is yes", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(homeDir, { recursive: true });
    await createFakeCommand(binDir, "claude");
    await createFakeCommand(binDir, "codex");

    await withEnv(autoCompactEnv(homeDir, binDir), async () => {
      await maybeRepairClaudeAutoCompact(fakePromptSession(true), homeDir);
      await maybeRepairCodexAutoCompact(fakePromptSession(true), homeDir);
    });

    const zshrc = await fs.readFile(path.join(homeDir, ".zshrc"), "utf8");
    assert.match(zshrc, /^export CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000$/m);
    assert.match(zshrc, /^export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80$/m);

    const codexConfig = await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    assert.match(codexConfig, /^model_auto_compact_token_limit = 400000$/m);
  });
});

it("applies Claude Code auto-compact settings to bash rc files", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(homeDir, { recursive: true });
    await createFakeCommand(binDir, "claude");

    await withEnv({ ...autoCompactEnv(homeDir, binDir), SHELL: "/usr/local/bin/bash" }, async () => {
      await maybeRepairClaudeAutoCompact(fakePromptSession(true), homeDir);
    });

    const bashrc = await fs.readFile(path.join(homeDir, ".bashrc"), "utf8");
    assert.match(bashrc, /^export CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000$/m);
    assert.match(bashrc, /^export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80$/m);
    assert.equal(await fs.access(path.join(homeDir, ".zshrc")).then(() => true).catch(() => false), false);
  });
});

it("applies Claude Code auto-compact settings to Windows PowerShell profiles", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(homeDir, { recursive: true });
    await createFakeCommand(binDir, "claude");

    await withEnv({ ...autoCompactEnv(homeDir, binDir), SHELL: "" }, async () => {
      await maybeRepairClaudeAutoCompact(fakePromptSession(true), homeDir, {
        env: { SHELL: "" },
        platform: "win32",
      });
    });

    for (const relPath of [
      path.join("Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
      path.join("Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    ]) {
      const profile = await fs.readFile(path.join(homeDir, relPath), "utf8");
      assert.match(profile, /^\$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = "500000"$/m);
      assert.match(profile, /^\$env:CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "80"$/m);
    }
    assert.equal(await fs.access(path.join(homeDir, ".zshrc")).then(() => true).catch(() => false), false);
    assert.equal(await fs.access(path.join(homeDir, ".bashrc")).then(() => true).catch(() => false), false);
  });
});

it("reports risk when one Windows PowerShell profile is unreadable and the other is suitable", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    const unreadableProfile = path.join(
      homeDir,
      "Documents",
      "PowerShell",
      "Microsoft.PowerShell_profile.ps1"
    );
    const suitableProfile = path.join(
      homeDir,
      "Documents",
      "WindowsPowerShell",
      "Microsoft.PowerShell_profile.ps1"
    );
    await fs.mkdir(unreadableProfile, { recursive: true });
    await fs.mkdir(path.dirname(suitableProfile), { recursive: true });
    await fs.writeFile(
      suitableProfile,
      '$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = "500000"\n' +
        '$env:CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "80"\n'
    );
    await createFakeCommand(binDir, "claude");

    let result;
    const stdout = await withEnv({ ...autoCompactEnv(homeDir, binDir), SHELL: "" }, async () => {
      return captureConsoleLog(async () => {
        result = await maybeRepairClaudeAutoCompact(fakePromptSession(true), homeDir, {
          env: { SHELL: "" },
          platform: "win32",
        });
      });
    });

    assert.equal(result.outcome, "risk");
    assert.match(result.detail, /could not be read|unknown/);
    assert.match(stdout, /WINDOW current=500000 recommended=500000/);
    assert.match(stdout, /WINDOW current=unreadable recommended=500000/);
    assert.doesNotMatch(stdout, /WINDOW current=missing recommended=500000/);
  });
});

it("keeps a risk outcome after repairing one Windows profile when the other is unreadable", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    const unreadableProfile = path.join(
      homeDir,
      "Documents",
      "PowerShell",
      "Microsoft.PowerShell_profile.ps1"
    );
    const repairableProfile = path.join(
      homeDir,
      "Documents",
      "WindowsPowerShell",
      "Microsoft.PowerShell_profile.ps1"
    );
    await fs.mkdir(unreadableProfile, { recursive: true });
    await createFakeCommand(binDir, "claude");

    const result = await withEnv({ ...autoCompactEnv(homeDir, binDir), SHELL: "" }, () =>
      maybeRepairClaudeAutoCompact(fakePromptSession(true), homeDir, {
        env: { SHELL: "" },
        platform: "win32",
      })
    );

    assert.equal(result.outcome, "risk");
    assert.match(result.detail, /updated.*unknown|unknown.*updated/);
    const repaired = await fs.readFile(repairableProfile, "utf8");
    assert.match(repaired, /^\$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = "500000"$/m);
  });
});

it("skips unsupported Claude Code shells while still applying Codex auto-compact settings", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(homeDir, { recursive: true });
    await createFakeCommand(binDir, "claude");
    await createFakeCommand(binDir, "codex");

    const stdout = await withEnv({ ...autoCompactEnv(homeDir, binDir), SHELL: "/usr/bin/fish" }, async () => {
      return captureConsoleLog(async () => {
        await maybeRepairClaudeAutoCompact(fakePromptSession(true), homeDir, {
          env: { SHELL: "/usr/bin/fish" },
          platform: "linux",
        });
        await maybeRepairCodexAutoCompact(fakePromptSession(true), homeDir);
      });
    });

    assert.match(stdout, /WINDOW current=unreadable recommended=500000/);
    assert.match(stdout, /PCT current=unreadable recommended=80/);
    assert.match(stdout, /effective current=unreadable recommended=400000/);
    assert.doesNotMatch(stdout, /WINDOW current=missing recommended=500000/);
    assert.equal(await fs.access(path.join(homeDir, ".zshrc")).then(() => true).catch(() => false), false);
    assert.equal(await fs.access(path.join(homeDir, ".bashrc")).then(() => true).catch(() => false), false);
    const codexConfig = await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    assert.match(codexConfig, /^model_auto_compact_token_limit = 400000$/m);
  });
});

it("leaves personal auto-compact settings unchanged when prompt confirmation is no", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(homeDir, { recursive: true });
    await createFakeCommand(binDir, "claude");
    await createFakeCommand(binDir, "codex");

    await withEnv(autoCompactEnv(homeDir, binDir), async () => {
      await maybeRepairClaudeAutoCompact(fakePromptSession(false), homeDir);
      await maybeRepairCodexAutoCompact(fakePromptSession(false), homeDir);
    });

    assert.equal(await fs.access(path.join(homeDir, ".zshrc")).then(() => true).catch(() => false), false);
    assert.equal(
      await fs.access(path.join(homeDir, ".codex", "config.toml")).then(() => true).catch(() => false),
      false
    );
  });
});

it("runtime auto-compact helper reports already suitable settings without prompting", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await createFakeCommand(binDir, "claude");
    await createFakeCommand(binDir, "codex");
    await fs.writeFile(
      path.join(homeDir, ".zshrc"),
      "export CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000\nexport CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80\n"
    );
    await fs.writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      "model_auto_compact_token_limit = 400000\n"
    );

    const stdout = await withEnv(autoCompactEnv(homeDir, binDir), async () => {
      return captureConsoleLog(async () => {
        const promptSession = {
          async ask() {
            throw new Error("already suitable runtime settings must not prompt");
          },
        };
        await maybeRepairClaudeAutoCompact(promptSession, homeDir);
        await maybeRepairCodexAutoCompact(promptSession, homeDir);
      });
    });

    assert.match(stdout, /Claude Code auto-compact settings already suitable/);
    assert.match(stdout, /Codex auto-compact settings already suitable/);
    assert.doesNotMatch(stdout, /auto-compact setting is missing or above or below the recommended target/);
    assert.doesNotMatch(stdout, /Apply recommended/);
  });
});

it("prompts to upgrade Claude 250000×80 and Codex 96000 to the recommended exact values", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await createFakeCommand(binDir, "claude");
    await createFakeCommand(binDir, "codex");
    await fs.writeFile(
      path.join(homeDir, ".zshrc"),
      "export CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000\nexport CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80\n"
    );
    await fs.writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      "model_auto_compact_token_limit = 96000\n"
    );

    const stdout = await withEnv(autoCompactEnv(homeDir, binDir), async () => {
      return captureConsoleLog(async () => {
        await maybeRepairClaudeAutoCompact(fakePromptSession(true), homeDir);
        await maybeRepairCodexAutoCompact(fakePromptSession(true), homeDir);
      });
    });

    assert.match(stdout, /auto-compact setting is missing or above or below the recommended target/);
    assert.match(stdout, /WINDOW current=250000 recommended=500000/);
    assert.match(stdout, /PCT current=80 recommended=80/);
    assert.match(stdout, /effective current=200000 recommended=400000/);
    assert.match(stdout, /model_auto_compact_token_limit current=96000 recommended=400000/);
    assert.doesNotMatch(stdout, /WINDOW current=\S+ recommended=400000/);
    assert.doesNotMatch(stdout, /~400000 tokens/);
    assert.doesNotMatch(stdout, /already suitable/);
    const zshrc = await fs.readFile(path.join(homeDir, ".zshrc"), "utf8");
    assert.match(zshrc, /^export CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000$/m);
    assert.match(zshrc, /^export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80$/m);
    const codexConfig = await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    assert.match(codexConfig, /^model_auto_compact_token_limit = 400000$/m);
  });
});

it("prints current vs recommended comparison and a TTY hint when skip is non-interactive", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await createFakeCommand(binDir, "claude");
    await createFakeCommand(binDir, "codex");
    await fs.writeFile(
      path.join(homeDir, ".zshrc"),
      "export CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000\nexport CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80\n"
    );
    await fs.writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      "model_auto_compact_token_limit = 96000\n"
    );

    const stdout = await withEnv(autoCompactEnv(homeDir, binDir), async () => {
      return captureConsoleLog(async () => {
        await maybeRepairClaudeAutoCompact(null, homeDir);
        await maybeRepairCodexAutoCompact(null, homeDir);
      });
    });

    assert.match(stdout, /WINDOW current=250000 recommended=500000/);
    assert.match(stdout, /PCT current=80 recommended=80/);
    assert.match(stdout, /effective current=200000 recommended=400000/);
    assert.match(stdout, /model_auto_compact_token_limit current=96000 recommended=400000/);
    assert.match(stdout, /real TTY via devpro:change startup/);
    assert.match(stdout, /non-interactive stdin/);
    assert.doesNotMatch(stdout, /WINDOW current=\S+ recommended=400000/);
    assert.doesNotMatch(stdout, /~400000 tokens/);
    const zshrc = await fs.readFile(path.join(homeDir, ".zshrc"), "utf8");
    assert.match(zshrc, /^export CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000$/m);
    const codexConfig = await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    assert.match(codexConfig, /^model_auto_compact_token_limit = 96000$/m);
  });
});

it("prompts to repair Claude and Codex auto-compact settings above the recommended exact values", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await createFakeCommand(binDir, "claude");
    await createFakeCommand(binDir, "codex");
    await fs.writeFile(
      path.join(homeDir, ".zshrc"),
      "export CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000\nexport CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80\n"
    );
    await fs.writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      "model_auto_compact_token_limit = 500000\n"
    );

    await withEnv(autoCompactEnv(homeDir, binDir), async () => {
      await maybeRepairClaudeAutoCompact(fakePromptSession(true), homeDir);
      await maybeRepairCodexAutoCompact(fakePromptSession(true), homeDir);
    });

    const zshrc = await fs.readFile(path.join(homeDir, ".zshrc"), "utf8");
    assert.match(zshrc, /^export CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000$/m);
    assert.match(zshrc, /^export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80$/m);
    const codexConfig = await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    assert.match(codexConfig, /^model_auto_compact_token_limit = 400000$/m);
  });
});

it("repairs Codex auto-compact settings that are not the recommended 400000 limit", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await createFakeCommand(binDir, "codex");
    await fs.writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      "model_auto_compact_token_limit = 200000\n"
    );

    await withEnv(autoCompactEnv(homeDir, binDir), async () => {
      await maybeRepairCodexAutoCompact(fakePromptSession(true), homeDir);
    });

    const codexConfig = await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    assert.match(codexConfig, /^model_auto_compact_token_limit = 400000$/m);
  });
});

it("repairs Codex auto-compact settings only at top-level TOML scope", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await createFakeCommand(binDir, "codex");
    await fs.writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      [
        "[profiles.default]",
        "model_auto_compact_token_limit = 64000",
        "",
      ].join("\n")
    );

    await withEnv(autoCompactEnv(homeDir, binDir), async () => {
      await maybeRepairCodexAutoCompact(fakePromptSession(true), homeDir);
    });

    const codexConfig = await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    assert.match(codexConfig, /^model_auto_compact_token_limit = 400000$/m);
    assert.match(codexConfig, /\[profiles\.default\]\nmodel_auto_compact_token_limit = 64000/);
    assert.ok(
      codexConfig.indexOf("model_auto_compact_token_limit = 400000") <
        codexConfig.indexOf("[profiles.default]"),
      "global Codex setting must be written before nested TOML tables"
    );
  });
});

it("runtime auto-compact CLI entrypoint executes diagnostics", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const runtimeScript = path.join(repoRoot, ".devpro", "scripts", "runtime-auto-compact-settings.mjs");

    const { stdout, exitCode, stderr } = run(runtimeScript, "", {
      cwd: local.tmpDir,
      env: autoCompactEnv(homeDir, binDir),
    });

    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /Claude Code runtime N\/A .*skipped auto-compact settings check/);
    assert.match(stdout, /Codex runtime N\/A .*skipped auto-compact settings check/);
  });
});

it("--sync does not inspect or mutate personal auto-compact settings", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(homeDir, { recursive: true });
    await createFakeCommand(binDir, "claude");
    await createFakeCommand(binDir, "codex");

    const { stdout, exitCode, stderr } = run(local.syncScript, "--sync", {
      cwd: local.tmpDir,
      env: autoCompactEnv(homeDir, binDir),
      input: "y\ny\n",
    });

    assert.equal(exitCode, 0, stderr);
    assert.doesNotMatch(stdout, /auto-compact setting is missing or above or below the recommended target/);
    assert.doesNotMatch(stdout, /Skipped .*auto-compact settings update/);
    assert.doesNotMatch(stdout, /Apply recommended/);
    assert.equal(await fs.access(path.join(homeDir, ".zshrc")).then(() => true).catch(() => false), false);
    assert.equal(
      await fs.access(path.join(homeDir, ".codex", "config.toml")).then(() => true).catch(() => false),
      false
    );
  });
});

it("skips one unreadable personal config while still checking the other runtime", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(path.join(homeDir, ".zshrc"), { recursive: true });
    await createFakeCommand(binDir, "claude");
    await createFakeCommand(binDir, "codex");

    const stdout = await withEnv(autoCompactEnv(homeDir, binDir), async () => {
      return captureConsoleLog(async () => {
        await maybeRepairClaudeAutoCompact(fakePromptSession(true), homeDir);
      });
    });
    await withEnv(autoCompactEnv(homeDir, binDir), async () => {
      await maybeRepairCodexAutoCompact(fakePromptSession(true), homeDir);
    });

    assert.match(stdout, /Skipped Claude Code auto-compact settings update for ~\/\.zshrc/);
    assert.match(stdout, /WINDOW current=unreadable recommended=500000/);
    assert.doesNotMatch(stdout, /WINDOW current=missing recommended=500000/);
    assert.doesNotMatch(stdout, /already suitable/);
    assert.equal(
      (await fs.stat(path.join(homeDir, ".zshrc"))).isDirectory(),
      true,
      "unreadable/unsafe shell config path must not be replaced"
    );
    const codexConfig = await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    assert.match(codexConfig, /^model_auto_compact_token_limit = 400000$/m);
  });
});

it("prints unreadable Codex comparison when ~/.codex/config.toml cannot be read", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(path.join(homeDir, ".codex", "config.toml"), { recursive: true });
    await createFakeCommand(binDir, "codex");

    const stdout = await withEnv(autoCompactEnv(homeDir, binDir), async () => {
      return captureConsoleLog(async () => {
        await maybeRepairCodexAutoCompact(fakePromptSession(true), homeDir);
      });
    });

    assert.match(stdout, /model_auto_compact_token_limit current=unreadable recommended=400000/);
    assert.doesNotMatch(stdout, /model_auto_compact_token_limit current=missing recommended=400000/);
    assert.equal(
      (await fs.stat(path.join(homeDir, ".codex", "config.toml"))).isDirectory(),
      true
    );
  });
});

it("--check does not inspect or mutate personal auto-compact settings", async () => {
  await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
    await withConsumerRepo(async (local) => {
      const homeDir = path.join(local.tmpDir, "home");
      const binDir = path.join(local.tmpDir, "bin");
      await fs.mkdir(homeDir, { recursive: true });
      await createFakeCommand(binDir, "claude");
      await createFakeCommand(binDir, "codex");
      const sync = run(local.syncScript, "--sync", {
        cwd: local.tmpDir,
        testSourceRoot: slimSourceRoot,
      });
      assert.equal(sync.exitCode, 0, sync.stderr);

      const rootScript = path.join(local.tmpDir, ".devpro", "scripts", "sync-agent-rules.mjs");
      const { stdout, exitCode, stderr } = run(rootScript, "--check", {
        cwd: local.tmpDir,
        env: autoCompactEnv(homeDir, binDir),
        input: "y\ny\n",
        testSourceRoot: slimSourceRoot,
      });

      assert.equal(exitCode, 0, stderr);
      assert.match(stdout, /All derived files are in sync/);
      assert.doesNotMatch(stdout, /auto-compact setting is missing or above or below the recommended target/);
      assert.equal(await fs.access(path.join(homeDir, ".zshrc")).then(() => true).catch(() => false), false);
      assert.equal(
        await fs.access(path.join(homeDir, ".codex", "config.toml")).then(() => true).catch(() => false),
        false
      );
    });
  });
});

it("skips auto-compact prompts for runtimes that are not installed", async () => {
  await withConsumerRepo(async (local) => {
    const homeDir = path.join(local.tmpDir, "home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    const stdout = await withEnv(autoCompactEnv(homeDir, binDir), async () => {
      return captureConsoleLog(async () => {
        await maybeRepairClaudeAutoCompact(fakePromptSession(true), homeDir);
        await maybeRepairCodexAutoCompact(fakePromptSession(true), homeDir);
      });
    });

    assert.match(stdout, /Claude Code runtime N\/A .*skipped auto-compact settings check/);
    assert.match(stdout, /Codex runtime N\/A .*skipped auto-compact settings check/);
    assert.doesNotMatch(stdout, /auto-compact setting is missing or above or below the recommended target/);
    assert.equal(await fs.access(path.join(homeDir, ".zshrc")).then(() => true).catch(() => false), false);
    assert.equal(
      await fs.access(path.join(homeDir, ".codex", "config.toml")).then(() => true).catch(() => false),
      false
    );
  });
});
