/**
 * hook-command-context-cwd.test.mjs
 *
 * Locks the shared hook cwd arithmetic (`commandCwdAt`, `commandCwd`,
 * `commandCwdForGitMatch` in lib/hook-command-context.mjs):
 *   - R16: a chdir verb inside parentheses or backticks is unresolvable (default).
 *   - R15: the opt-in `tolerateRedirectsAndPipes` resolves fd redirects and
 *     chdir-free pipelines; the default keeps them unresolvable.
 * Pure function calls on real (temporary) directories; no process spawn.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, test } from "node:test";

import {
  UNRESOLVABLE_CWD,
  commandCwd,
  commandCwdAt,
  commandCwdForGitMatch,
  resolveToolInputCwd,
} from "../hooks/lib/hook-command-context.mjs";
import { CMD_POSITION_ANCHOR, anchoredVerbIndex } from "../hooks/lib/shell-context.mjs";

const MARK = "GATEDCMD";
let root;
let base;
let dirA;
let dirB;

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "hook-cwd-arith-"));
  base = path.join(root, "base");
  dirA = path.join(root, "dir-a");
  dirB = path.join(root, "dir-b");
  for (const dir of [base, dirA, dirB]) mkdirSync(dir);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// `template` uses {A}/{B} for the temp dirs and MARK for the gated command.
function cwdAt(template, options) {
  const cmd = template.replaceAll("{A}", dirA).replaceAll("{B}", dirB);
  const index = cmd.indexOf(MARK);
  assert.ok(index >= 0, `template must contain ${MARK}: ${template}`);
  return options === undefined
    ? commandCwdAt(cmd, base, index)
    : commandCwdAt(cmd, base, index, "", options);
}

const TOLERATE = { tolerateRedirectsAndPipes: true };

const REDIRECT_AND_PIPE_FORMS = [
  ["2>&1", "cd {A} && echo x 2>&1 && GATEDCMD"],
  [">&2", "cd {A} && echo x >&2 && GATEDCMD"],
  ["1>&2", "cd {A} && echo x 1>&2 && GATEDCMD"],
  ["&>file", "cd {A} && echo x &>/dev/null && GATEDCMD"],
  ["&>>file", "cd {A} && echo x &>>/dev/null && GATEDCMD"],
  ["|&", "cd {A} && echo x |& cat && GATEDCMD"],
  ["pipeline", "cd {A} && echo x | cat && GATEDCMD"],
  ["multi-element pipeline", "cd {A} && echo x | cat | cat && GATEDCMD"],
];

describe("Scenario: The default cwd arithmetic keeps treating redirects and pipelines as unresolved", () => {
  for (const [label, template] of REDIRECT_AND_PIPE_FORMS) {
    it(`option off: ${label} after cd stays unresolvable`, () => {
      assert.equal(cwdAt(template), UNRESOLVABLE_CWD);
      assert.equal(cwdAt(template, {}), UNRESOLVABLE_CWD);
      assert.equal(cwdAt(template, { tolerateRedirectsAndPipes: false }), UNRESOLVABLE_CWD);
    });
  }

  it("option off: || after cd stays unresolvable", () => {
    assert.equal(cwdAt("cd {A} || echo x && GATEDCMD"), UNRESOLVABLE_CWD);
  });

  it("option off: a background & after cd stays unresolvable", () => {
    assert.equal(cwdAt("cd {A} && sleep 1 & GATEDCMD"), UNRESOLVABLE_CWD);
  });

  it("option off: the commandCwd entry point keeps the redirect as unresolvable", () => {
    const cmd = `cd ${dirA} && echo x 2>&1 && gh pr create`;
    assert.equal(commandCwd(cmd, base), UNRESOLVABLE_CWD);
  });

  it("option off: commandCwdForGitMatch keeps the redirect as unresolvable", () => {
    const cmd = `cd ${dirA} && echo x 2>&1 && git commit -m x`;
    assert.equal(
      commandCwdForGitMatch(cmd, "git ", base, cmd.indexOf("git commit")),
      UNRESOLVABLE_CWD,
    );
  });

  describe("option on resolves the chdir-free forms to the cd target", () => {
    for (const [label, template] of REDIRECT_AND_PIPE_FORMS) {
      it(`option on: ${label} after cd resolves to the cd target`, () => {
        assert.equal(cwdAt(template, TOLERATE), dirA);
      });
    }

    it("option on: a redirect with no cd resolves to the base cwd", () => {
      assert.equal(cwdAt("echo x 2>&1 && GATEDCMD", TOLERATE), base);
    });

    it("option on: a pipeline with no cd resolves to the base cwd", () => {
      assert.equal(cwdAt("echo x | cat && GATEDCMD", TOLERATE), base);
    });

    it("option on: a cd after the redirect still applies", () => {
      assert.equal(cwdAt("echo x 2>&1 && cd {B} && GATEDCMD", TOLERATE), dirB);
    });

    it("option on: a cd after a pipeline still applies", () => {
      assert.equal(cwdAt("echo x | cat && cd {B} && GATEDCMD", TOLERATE), dirB);
    });

    it("option on: a redirect and a pipeline combined keep the cd target", () => {
      assert.equal(cwdAt("cd {A} && echo x 2>&1 | cat && GATEDCMD", TOLERATE), dirA);
    });

    it("option on: a cd that is a pipeline element stays unresolvable (cd after pipe)", () => {
      assert.equal(cwdAt("echo x | cd {A} && GATEDCMD", TOLERATE), UNRESOLVABLE_CWD);
    });

    it("option on: a cd that is a pipeline element stays unresolvable (cd before pipe)", () => {
      assert.equal(cwdAt("cd {A} | cat && GATEDCMD", TOLERATE), UNRESOLVABLE_CWD);
    });

    it("option on: a newline after the pipe continues the pipeline (cd after pipe)", () => {
      assert.equal(cwdAt("echo x |\n cd {A} && GATEDCMD", TOLERATE), UNRESOLVABLE_CWD);
    });

    it("option on: a newline after the pipe continues the pipeline (cd before pipe)", () => {
      assert.equal(cwdAt("cd {A} |\n cat && GATEDCMD", TOLERATE), UNRESOLVABLE_CWD);
    });

    it("option on: a newline after |& continues the pipeline too", () => {
      assert.equal(cwdAt("echo x |&\n cd {A} && GATEDCMD", TOLERATE), UNRESOLVABLE_CWD);
    });

    it("option on: a newline after a chdir-free pipe still keeps the cd target", () => {
      assert.equal(cwdAt("cd {A} && echo x |\n cat && GATEDCMD", TOLERATE), dirA);
    });

    // A pipe continues over any run of blank, comment-only and backslash-continued lines, not just a single newline.
    const PIPE_CONTINUATIONS = [
      ["a blank line", "|\n\n "],
      ["several blank lines", "|\n\n\n\n "],
      ["a comment-only line", "|\n# note\n "],
      ["a trailing comment", "| # note\n "],
      ["a backslash continuation", "| \\\n "],
      ["a backslash continuation and a blank line", "| \\\n\n "],
    ];
    for (const [label, joiner] of PIPE_CONTINUATIONS) {
      it(`option on: ${label} after the pipe continues the pipeline (cd after pipe)`, () => {
        assert.equal(cwdAt(`echo x ${joiner}cd {A} && GATEDCMD`, TOLERATE), UNRESOLVABLE_CWD);
      });

      it(`option on: ${label} after the pipe continues the pipeline (cd before pipe)`, () => {
        assert.equal(cwdAt(`cd {A} ${joiner}cat && GATEDCMD`, TOLERATE), UNRESOLVABLE_CWD);
      });

      it(`option on: ${label} after a chdir-free pipe keeps the cd target`, () => {
        assert.equal(cwdAt(`cd {A} && echo x ${joiner}cat && GATEDCMD`, TOLERATE), dirA);
      });

      it(`option on: ${label} after a chdir-free pipe keeps every later cd at its own offset`, () => {
        assert.equal(cwdAt(`cd {A} && echo x ${joiner}cat && cd {B} && GATEDCMD`, TOLERATE), dirB);
      });
    }

    it("option on: a pipe at the end of a heredoc header keeps the cd target when no chdir follows", () => {
      assert.equal(cwdAt("cd {A} && cat <<EOF |\nbody\n\nmore\nEOF\n cat && GATEDCMD", TOLERATE), dirA);
    });

    it("option on: a cd before |& stays unresolvable", () => {
      assert.equal(cwdAt("cd {A} |& cat && GATEDCMD", TOLERATE), UNRESOLVABLE_CWD);
    });

    it("option on: pushd as a pipeline element stays unresolvable", () => {
      assert.equal(cwdAt("pushd {A} | cat && GATEDCMD", TOLERATE), UNRESOLVABLE_CWD);
    });

    it("option on: || after cd stays unresolvable", () => {
      assert.equal(cwdAt("cd {A} || echo x && GATEDCMD", TOLERATE), UNRESOLVABLE_CWD);
    });

    it("option on: a background & after cd stays unresolvable", () => {
      assert.equal(cwdAt("cd {A} && sleep 1 & GATEDCMD", TOLERATE), UNRESOLVABLE_CWD);
    });

    it("option on: a redirect does not mask a following background &", () => {
      assert.equal(cwdAt("cd {A} && echo x 2>&1 & GATEDCMD", TOLERATE), UNRESOLVABLE_CWD);
    });
  });
});

describe("Scenario: A cd in parentheses or backticks is unresolved in the shared cwd arithmetic", () => {
  it("(cd dir && cmd) is unresolvable", () => {
    assert.equal(cwdAt("(cd {A} && GATEDCMD)"), UNRESOLVABLE_CWD);
  });

  it("(cd dir; cmd) is unresolvable", () => {
    assert.equal(cwdAt("(cd {A}; GATEDCMD)"), UNRESOLVABLE_CWD);
  });

  it("$(cd dir; cmd) is unresolvable", () => {
    assert.equal(cwdAt("echo $(cd {A}; GATEDCMD)"), UNRESOLVABLE_CWD);
  });

  it("a backtick-quoted cd is unresolvable", () => {
    assert.equal(cwdAt("echo `cd {A}`; GATEDCMD"), UNRESOLVABLE_CWD);
  });

  it("pushd and popd in parentheses are unresolvable", () => {
    assert.equal(cwdAt("(pushd {A} && GATEDCMD)"), UNRESOLVABLE_CWD);
    assert.equal(cwdAt("(popd && GATEDCMD)"), UNRESOLVABLE_CWD);
  });

  it("the opt-in option does not rescue a parenthesized cd", () => {
    assert.equal(cwdAt("(cd {A} && GATEDCMD)", TOLERATE), UNRESOLVABLE_CWD);
  });

  it("commandCwd entry point reports a parenthesized cd as unresolvable", () => {
    assert.equal(commandCwd(`(cd ${dirA} && gh pr create)`, base), UNRESOLVABLE_CWD);
  });

  it("commandCwdForGitMatch reports (cd dir && git commit) as unresolvable", () => {
    const cmd = `(cd ${dirA} && git commit -m x)`;
    assert.equal(
      commandCwdForGitMatch(cmd, "git ", base, cmd.indexOf("git commit")),
      UNRESOLVABLE_CWD,
    );
  });

  it("commandCwdForGitMatch still resolves a flat cd and a parenthesized command without cd", () => {
    const flat = `cd ${dirA} && git commit -m x`;
    assert.equal(commandCwdForGitMatch(flat, "git ", base, flat.indexOf("git commit")), dirA);
    const grouped = "(git commit -m x)";
    assert.equal(commandCwdForGitMatch(grouped, "git ", base, grouped.indexOf("git commit")), base);
  });

  it("a parenthesized command without cd resolves to the base cwd", () => {
    assert.equal(cwdAt("(GATEDCMD --flag)"), base);
    assert.equal(cwdAt("echo hi; (GATEDCMD --flag)"), base);
    assert.equal(cwdAt("echo `date`; GATEDCMD"), base);
  });

  it("a parenthesis or backtick inside a quoted string does not change a flat cd", () => {
    assert.equal(cwdAt('cd {A} && echo "(cd {B})" && GATEDCMD'), dirA);
    assert.equal(cwdAt("cd {A} && echo '`cd {B}`' && GATEDCMD"), dirA);
    assert.equal(cwdAt('echo "(cd {B})" && GATEDCMD'), base);
  });

  it("a parenthesis or backtick inside a comment does not change a flat cd", () => {
    assert.equal(cwdAt("cd {A} # (cd {B}) `cd {B}`\nGATEDCMD"), dirA);
    assert.equal(cwdAt("# (cd {B})\nGATEDCMD"), base);
  });

  it("a parenthesis or backtick inside a heredoc body does not change a flat cd", () => {
    assert.equal(
      cwdAt("cd {A} && cat <<EOF\n(cd {B})\n`cd {B}`\nEOF\nGATEDCMD"),
      dirA,
    );
    assert.equal(cwdAt("cat <<EOF\n(cd {B})\nEOF\nGATEDCMD"), base);
  });
});

describe("Scenario: Control-flow dependent cwd stays unresolved and the hard-blocking gates fail open", () => {
  for (const [label, template] of [
    ["||", "cd {A} || echo x; GATEDCMD"],
    ["background &", "cd {A} & GATEDCMD"],
    ["group { ...; }", "{ cd {A}; }; GATEDCMD"],
    ["command substitution", "cd $(echo {A}) && GATEDCMD"],
    ["shell control keyword", "if true; then cd {A}; fi; GATEDCMD"],
    ["CDPATH=", "CDPATH=/tmp; cd {A} && GATEDCMD"],
  ]) {
    it(`helper: ${label} after cd is unresolvable by default and with the option`, () => {
      assert.equal(cwdAt(template), UNRESOLVABLE_CWD);
      assert.equal(cwdAt(template, TOLERATE), UNRESOLVABLE_CWD);
    });
  }

  it("helper: the same control-flow forms without any cd resolve to the base cwd", () => {
    assert.equal(cwdAt("echo x || echo y; GATEDCMD"), base);
    assert.equal(cwdAt("true & GATEDCMD"), base);
  });
});

describe("existing flat cwd arithmetic is unchanged", () => {
  it("&& chain applies the cd", () => {
    assert.equal(cwdAt("cd {A} && GATEDCMD"), dirA);
  });

  it("; chain applies the cd", () => {
    assert.equal(cwdAt("cd {A}; GATEDCMD"), dirA);
  });

  it("newline chain applies the cd", () => {
    assert.equal(cwdAt("cd {A}\nGATEDCMD"), dirA);
  });

  it("the last cd in a chain wins", () => {
    assert.equal(cwdAt("cd {A} && cd {B} && GATEDCMD"), dirB);
  });

  it("pushd applies and popd restores", () => {
    assert.equal(cwdAt("pushd {A} && GATEDCMD"), dirA);
    assert.equal(cwdAt("pushd {A} && popd && GATEDCMD"), base);
    assert.equal(cwdAt("pushd {A} && pushd {B} && popd && GATEDCMD"), dirA);
  });

  it("a popd with an empty stack is unresolvable", () => {
    assert.equal(cwdAt("popd && GATEDCMD"), UNRESOLVABLE_CWD);
  });

  it("a command with no cd resolves to the base cwd", () => {
    assert.equal(cwdAt("echo x && GATEDCMD"), base);
  });

  it("a cd after the gated command does not affect it", () => {
    assert.equal(cwdAt("GATEDCMD && cd {A}"), base);
  });
});
// `-C` means "run in this directory" only as a git GLOBAL option (between `git` and the verb). After the verb it
// belongs to the verb: `switch -C <branch>` force-creates, `commit -C <commit>` reuses a message. Reading that
// value as a directory made the lookup report "unresolvable", and a gate that skips on unresolvable let the
// command through. The caller says which `git` token it matched by passing its index.
describe("commandCwdForGitMatch reads -C only among the global options of the git token it is given", () => {
  // Index of the last `git` command token: the fixtures put any decoy `git` text before it.
  const gitIndex = (cmd) => cmd.lastIndexOf("git ");
  const resolve = (cmd, matchText = cmd) => commandCwdForGitMatch(cmd, matchText, base, gitIndex(cmd));

  it("a verb-level -C is not a directory", () => {
    assert.equal(resolve("git switch -C chore/add-foo"), base);
    assert.equal(resolve("git commit -C HEAD"), base);
    assert.equal(resolve("git --no-pager switch -C chore/add-foo"), base);
    assert.equal(resolve("git branch -C old-name new-name"), base);
  });

  it("a global -C still moves the cwd, with or without a verb-level -C after it", () => {
    assert.equal(resolve(`git -C ${dirA} switch chore/add-foo`), dirA);
    assert.equal(resolve(`git -C ${dirA} switch -C chore/add-foo`), dirA);
    assert.equal(resolve(`git --no-pager -C ${dirA} commit -C HEAD`), dirA);
    assert.equal(resolve(`git -c user.name=x -C ${dirA} commit -m x`), dirA);
    assert.equal(resolve(`git -C ${root} -C dir-b switch -C chore/add-foo`), dirB);
    assert.equal(resolve(`git -C "${dirA}" switch -C chore/add-foo`), dirA);
  });

  it("a global -C to a missing directory stays unresolvable", () => {
    assert.equal(resolve(`git -C ${path.join(root, "missing")} switch chore/add-foo`), UNRESOLVABLE_CWD);
    assert.equal(resolve(`git -C ${path.join(root, "missing")} switch -C chore/add-foo`), UNRESOLVABLE_CWD);
  });

  it("the match text may start at the boundary character; a leading cd && is still applied", () => {
    assert.equal(resolve("true && git switch -C x", " git switch -C x"), base);
    assert.equal(resolve(`true; git -C ${dirA} switch -C x`, `; git -C ${dirA} switch -C x`), dirA);
    assert.equal(resolve(`cd ${dirA} && git switch -C x`, "& git switch -C x"), dirA);
    assert.equal(resolve(`cd ${dirA} && git checkout -`, "& git checkout -"), dirA);
  });

  it("an env prefix or a path-qualified git does not move the token the options are read from", () => {
    assert.equal(resolve(`env FOO=1 git -C ${dirA} switch -C x`), dirA);
    assert.equal(resolve(`FOO=1 /usr/bin/git -C ${dirA} switch -C x`), dirA);
    assert.equal(resolve("FOO=1 /usr/bin/git switch -C x"), base);
  });

  it("a git inside an environment value is not the command's git token", () => {
    assert.equal(resolve(`FOO="a git b" git -C ${dirA} add -A`), dirA);
    assert.equal(resolve(`X=/opt/git git -C ${dirA} add -A`), dirA);
    assert.equal(resolve(`FOO="a git -C ${dirB} b" git -C ${dirA} switch -C x`), dirA);
  });

  // The callers take the index from `anchoredVerbIndex` on their own anchored match, so the lookup is only as right
  // as that index: these go through it instead of computing the position by hand.
  it("the index a caller derives from its anchored match is the command's git token", () => {
    const anchored = new RegExp(`${CMD_POSITION_ANCHOR}git\\s+(?:-C\\s+\\S+\\s+)*(?:add|switch)\\b.*`);
    const viaCaller = (cmd) => {
      const m = anchored.exec(cmd);
      return commandCwdForGitMatch(cmd, m[0], base, anchoredVerbIndex(m));
    };
    assert.equal(viaCaller(`X=/opt/git git -C ${dirA} add -A`), dirA);
    assert.equal(viaCaller(`env X=/opt/git git -C ${dirA} add -A`), dirA);
    assert.equal(viaCaller(`GH_HOST=gh.example.com git -C ${dirA} add -A`), dirA);
    assert.equal(viaCaller(`FOO="a git b" git -C ${dirA} add -A`), dirA);
    assert.equal(viaCaller("GIT_SSH=/usr/bin/git-ssh git switch -C x"), base);
    assert.equal(viaCaller("/opt/homebrew/opt/git/bin/git switch -C x"), base);
    assert.equal(viaCaller(`true && /usr/lib/git-core/git -C ${dirA} switch -C x`), dirA);
  });

  it("anchoredVerbIndex points at the token the prefix grammar ends on", () => {
    const at = (cmd) => anchoredVerbIndex(new RegExp(`${CMD_POSITION_ANCHOR}(?:git|gh)\\s+\\S+`).exec(cmd));
    for (const [cmd, tail] of [
      ["git push", "git push"],
      ["true; git push", "git push"],
      ["X=/opt/git git push", "git push"],
      ["GH_HOST=gh.example.com gh pr create", "gh pr create"],
      ["/opt/git/bin/git push", "git push"],
      ['FOO="a gh b" git push', "git push"],
    ]) {
      assert.equal(cmd.slice(at(cmd)), tail, cmd);
    }
  });

  it("without a token index the whole match text is scanned, as before", () => {
    assert.equal(commandCwdForGitMatch(`git -C ${dirA} commit`, `git -C ${dirA} commit`, base), dirA);
    assert.equal(commandCwdForGitMatch("git commit", "git commit", base), base);
    assert.equal(commandCwdForGitMatch("git switch -C x", "git switch -C x", base), UNRESOLVABLE_CWD);
  });
});

// The arithmetic blanks data regions (quoted strings, heredoc bodies, comments) before it reads any chdir. The
// lookup for "is this index in a data region" used to walk every segment for every character: O(chars × segments),
// seconds for a command that holds a few thousand quoted strings.
describe("cwd arithmetic stays linear on a command with thousands of quoted strings", () => {
  const repeats = 12000;
  const quotedRun = 'echo "a b" '.repeat(repeats);

  it("resolves a cd that follows the quoted strings, in well under a second", () => {
    const start = process.hrtime.bigint();
    const resolved = cwdAt(`${quotedRun}&& cd {A} && GATEDCMD`);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(resolved, dirA);
    assert.ok(ms < 1000, `${ms.toFixed(0)}ms is not linear`);
  });

  it("still ignores a cd that only appears inside a quoted string", () => {
    assert.equal(cwdAt('echo "cd {A}" && GATEDCMD'), base);
    assert.equal(cwdAt("echo 'cd {A}' && GATEDCMD"), base);
    assert.equal(cwdAt("echo ok # cd {A}\nGATEDCMD"), base);
  });
});

test("resolveToolInputCwd keeps the documented alias precedence", () => {
  const all = {
    cwd: "/a",
    workdir: "/a2",
    working_dir: "/a3",
    workingDir: "/a4",
    working_directory: "/b",
    workingDirectory: "/b2",
  };
  const top = {
    cwd: "/c",
    workdir: "/c2",
    working_dir: "/c3",
    workingDir: "/c4",
    working_directory: "/d",
    workingDirectory: "/d2",
    current_working_directory: "/e",
    currentWorkingDirectory: "/e2",
  };
  assert.equal(resolveToolInputCwd(all, top).source, "tool_input.cwd");
  assert.equal(resolveToolInputCwd({ ...all, cwd: "" }, top).source, "tool_input.workdir");
  assert.equal(
    resolveToolInputCwd({ working_directory: "/b" }, { cwd: "/c" }).source,
    "tool_input.working_directory"
  );
  assert.equal(resolveToolInputCwd({}, top).source, "cwd");
  assert.equal(
    resolveToolInputCwd({}, { current_working_directory: "/e", cwd: "/c" }).source,
    "cwd"
  );
  assert.equal(resolveToolInputCwd({}, { currentWorkingDirectory: "/e2" }).source, "currentWorkingDirectory");
});

// PR #3703 r11 W2-F3, #3706 r1 F2: the hook reads a git command from its own git token, so the assignments in front of
// it, a quoted or escaped space or a nested default included, never hide its -C target.
test("commandCwd resolves git -C after an assignment with a quoted or escaped space or a nested default", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "cwd-w2f3-"));
  try {
    const target = path.join(scratch, "target");
    const start = path.join(scratch, "start");
    mkdirSync(target);
    mkdirSync(start);
    const expected = commandCwd(`git -C "${target}" status`, start);
    assert.ok(expected.endsWith(`${path.sep}target`), expected);
    for (const prefix of ['GIT_AUTHOR_NAME="A B"', "GIT_AUTHOR_NAME='A B'", String.raw`GIT_AUTHOR_NAME=A\ B`, "GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-${USER}}", "GIT_AUTHOR_NAME=AB"]) {
      const command = `${prefix} git -C "${target}" status`;
      assert.equal(commandCwd(command, start), expected, command);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
