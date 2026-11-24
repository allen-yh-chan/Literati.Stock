/**
 * test-suite-manifest.test.mjs
 *
 * Prove-it for test-suite-manifest SSOT, lint gate, and subset runner args.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  MANIFEST,
  SUITE_DIR,
  TIER_INTEGRATION,
  TIER_UNIT,
  listFiles,
  resolveTier,
} from "../test-suite-manifest.mjs";
import * as manifestLint from "../lint-test-suite-manifest.mjs";
import * as testRunner from "../run-test-suite.mjs";
import { parseArgs, resolveTierFromArgv } from "../run-test-suite.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const suiteDirAbs = repoPath(SUITE_DIR);
const { lintManifest } = manifestLint;
const productionTierLinter = manifestLint.lintTierAssignment;
const recursiveScanDetector = manifestLint.detectRecursiveRepoScan;
const shardImportTargetDetector = manifestLint.detectShardImportTargets;
const DYNAMIC_IMPORT_ONLY_SOURCE = `
  const modulePromise = import("./subject.mjs");
  void modulePromise;
`;

// Unit tier on purpose: `--changed` drops a listed guard the manifest no
// longer holds, so a rename or tier change of a guard must fail every run.
test("the repo-sweep guard list names existing integration-tier tests", () => {
  const list = testRunner.REPO_SWEEP_INTEGRATION_TESTS;
  assert.ok(Array.isArray(list), "run-test-suite.mjs must export REPO_SWEEP_INTEGRATION_TESTS");
  assert.ok(Object.isFrozen(list), "the list is a fixed, frozen constant");
  assert.deepEqual([...list], [
    `${SUITE_DIR}hotfix-release-carrier-marker-scan.test.mjs`,
    `${SUITE_DIR}opencode-skill-discovery.test.mjs`,
    `${SUITE_DIR}second-review-reconciliation-unreachable-sweep.test.mjs`,
    `${SUITE_DIR}skill-entry-rename-sweep-guard.test.mjs`,
  ]);
  for (const file of list) {
    assert.ok(existsSync(repoPath(file)), `${file} must exist`);
    assert.equal(
      resolveTier(file.slice(SUITE_DIR.length)),
      TIER_INTEGRATION,
      `${file} must be an integration-tier manifest test`,
    );
  }
});

test("recursive repo-scan detector is a manifest-lint content-level detector (must-keep, C4)", () => {
  assert.equal(typeof recursiveScanDetector, "function");
  const source = `
    import { readdirSync } from "node:fs";
    function scanRepo(current) {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) scanRepo(path.join(current, entry.name));
      }
    }
    scanRepo(repoRoot);
  `;
  assert.equal(
    recursiveScanDetector(source, { file: ".devpro/scripts/tests/renamed-scanner.test.mjs" }),
    true,
    "classification must derive from content rather than a filename allowlist",
  );
  assert.equal(recursiveScanDetector("export const value = true;\n"), false);
});

test("shard-import detector is one content-level SSOT shared with the runner", () => {
  assert.equal(typeof shardImportTargetDetector, "function");
  assert.equal(testRunner.detectShardImportTargets, shardImportTargetDetector);

  const wrapperSource =
    'process.env.DEVPRO_RENAMED_SHARD_TEST_GROUP = "runner_a";\n\nawait import("./renamed-shard.test.mjs");\n';
  assert.deepEqual(
    shardImportTargetDetector(wrapperSource, {
      file: ".devpro/scripts/tests/renamed-shard-runner-a.test.mjs",
    }),
    [".devpro/scripts/tests/renamed-shard.test.mjs"],
    "classification must derive from content rather than a filename allowlist",
  );
  assert.deepEqual(shardImportTargetDetector("export const value = true;\n", {
    file: ".devpro/scripts/tests/no-signal.test.mjs",
  }), []);
});

const EXECUTED_INTEGRATION_FIXTURES = [
  {
    name: "direct async execFile call",
    source: `
      import { execFile } from "node:child_process";
      execFile("git", ["status", "--short"], () => {});
    `,
  },
  {
    name: "direct named child_process call",
    source: `
      import { spawnSync } from "node:child_process";
      spawnSync("node", ["--version"]);
    `,
  },
  {
    name: "aliased child_process call",
    source: `
      import { spawnSync as runChild } from "node:child_process";
      runChild("node", ["--version"]);
    `,
  },
  {
    name: "child_process namespace call",
    source: `
      import * as childProcess from "node:child_process";
      childProcess.execFileSync("git", ["status", "--short"]);
    `,
  },
  {
    name: "child_process namespace async execFile call",
    source: `
      import * as childProcess from "node:child_process";
      childProcess.execFile("git", ["status", "--short"], () => {});
    `,
  },
  {
    name: "dynamic named child_process call",
    source: `
      const { spawnSync } = await import("node:child_process");
      spawnSync("node", ["--version"]);
    `,
  },
  {
    name: "dynamic aliased child_process call",
    source: `
      const { execFile: runChild } = await import("node:child_process");
      runChild("git", ["status", "--short"], () => {});
    `,
  },
  {
    name: "dynamic namespace child_process call",
    source: `
      const childProcess = await import("node:child_process");
      childProcess.execFile("git", ["status", "--short"], () => {});
    `,
  },
  {
    name: "aliased Git helper call",
    source: `
      import { git as runGit } from "./lib/git.mjs";
      runGit(repoRoot, ["status", "--short"]);
    `,
  },
  {
    name: "aliased Git fixture call",
    source: `
      import { initRepo as makeRepo } from "./lib/git.mjs";
      makeRepo();
    `,
  },
  {
    name: "direct local Git helper call",
    source: `
      import { execFileSync } from "node:child_process";
      function git(args) {
        return execFileSync("git", args, { encoding: "utf8" });
      }
      git(["status", "--short"]);
    `,
  },
  {
    name: "child_process call inside template interpolation",
    source: `
      import { spawnSync as runChild } from "node:child_process";
      const description = \`version: \${runChild("node", ["--version"]).stdout}\`;
    `,
  },
  {
    name: "executed recursive repository scan",
    source: `
      import { readdirSync } from "node:fs";
      function scanRepo(current) {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          if (entry.isDirectory()) scanRepo(path.join(current, entry.name));
        }
      }
      scanRepo(repoRoot);
    `,
  },
];

const UNIT_ELIGIBLE_FIXTURES = [
  {
    name: "import-only declarations",
    source: `
      import * as childProcess from "node:child_process";
      import { git as runGit, initRepo as makeRepo } from "./lib/git.mjs";
    `,
  },
  {
    name: "comments",
    source: `
      // spawnSync("git", ["status"]);
      /* childProcess.execFileSync("git", ["status"]); git(repoRoot, []); */
      /* const { execFile } = await import("node:child_process"); execFile("git", [], () => {}); */
    `,
  },
  {
    name: "string literals",
    source: `
      const example = 'spawnSync("git", ["status"])';
      const dynamicExample = 'const childProcess = await import("node:child_process"); childProcess.execFile("git", [], () => {})';
    `,
  },
  {
    name: "plain template quasi",
    source: `
      const description = \`const { execFile } = await import("node:child_process"); execFile("git", [], () => {})\`;
    `,
  },
  {
    name: "regex and grep-style source guards",
    source: `
      const source = readFileSync(target, "utf8");
      assert.match(source, /spawnSync\\s*\\(/u);
      assert.ok(source.includes("git(repoRoot"));
    `,
  },
  {
    name: "injected object method without child_process binding",
    source: `
      const injected = {
        execFile() {
          return { status: 0 };
        },
      };
      injected.execFile();
    `,
  },
  {
    name: "unbound local execFile function",
    source: `
      function execFile() {
        return { status: 0 };
      }
      execFile();
    `,
  },
  {
    name: "other-module dynamic namespace call",
    source: `
      const childProcess = await import("./child-process-fixture.mjs");
      childProcess.execFile("git", [], () => {});
    `,
  },
  {
    name: "dynamic import only",
    source: DYNAMIC_IMPORT_ONLY_SOURCE,
  },
  {
    name: "dynamic child_process named import without execution",
    source: `
      const { spawnSync } = await import("node:child_process");
      void spawnSync;
    `,
  },
  {
    name: "dynamic child_process namespace import without execution",
    source: `
      const childProcess = await import("node:child_process");
      void childProcess;
    `,
  },
  {
    name: "non-awaited dynamic named import is not a child-process binding",
    source: `
      const { execFile } = import("node:child_process");
      execFile("git", [], () => {});
    `,
  },
  {
    name: "non-awaited dynamic namespace import is not a child-process binding",
    source: `
      const childProcess = import("node:child_process");
      childProcess.execFile("git", [], () => {});
    `,
  },
];

const LEXICAL_SCOPE_COLLISION_UNIT_FIXTURES = [
  {
    name: "dynamic named binding is data-only beside injected same-name call",
    source: `
      async function inspectChildProcessBinding() {
        const { execFile } = await import("node:child_process");
        void execFile;
      }
      function exerciseInjected(execFile) {
        return execFile("fixture-only");
      }
      exerciseInjected((value) => value);
    `,
  },
  {
    name: "dynamic aliased binding is data-only beside injected same-name call",
    source: `
      async function inspectAliasedChildProcessBinding() {
        const { execFile: runChild } = await import("node:child_process");
        void runChild;
      }
      function exerciseInjected(runChild) {
        return runChild("fixture-only");
      }
      exerciseInjected((value) => value);
    `,
  },
  {
    name: "dynamic namespace binding is data-only beside injected same-name call",
    source: `
      async function inspectChildProcessNamespace() {
        const childProcess = await import("node:child_process");
        void childProcess;
      }
      function exerciseInjected(childProcess) {
        return childProcess.execFile("fixture-only");
      }
      exerciseInjected({ execFile: (value) => value });
    `,
  },
  {
    name: "dynamic named binding is data-only beside a member property call",
    source: `
      async function inspectChildProcessBinding(holder) {
        const { execFile } = await import("node:child_process");
        void execFile;
        holder . execFile("fixture-only");
      }
    `,
  },
  {
    name: "dynamic namespace binding is data-only beside a nested member call",
    source: `
      async function inspectChildProcessNamespace(holder) {
        const childProcess = await import("node:child_process");
        void childProcess;
        holder . childProcess . execFile("fixture-only");
      }
    `,
  },
  {
    name: "dynamic named binding is shadowed before a nested injected call",
    source: `
      async function inspectChildProcessBinding() {
        const { execFile } = await import("node:child_process");
        void execFile;
        {
          const execFile = (value) => value;
          execFile("fixture-only");
        }
      }
    `,
  },
  {
    name: "dynamic aliased binding is reassigned before the same-scope call",
    source: `
      async function inspectAliasedChildProcessBinding() {
        let { execFile: runChild } = await import("node:child_process");
        runChild = (value) => value;
        runChild("fixture-only");
      }
    `,
  },
  {
    name: "dynamic namespace binding is reassigned before the same-scope call",
    source: `
      async function inspectChildProcessNamespace() {
        let childProcess = await import("node:child_process");
        childProcess = { execFile: (value) => value };
        childProcess.execFile("fixture-only");
      }
    `,
  },
];

const SAME_SCOPE_CHILD_PROCESS_EXECUTION_FIXTURES = [
  {
    name: "same-scope dynamic named execution",
    source: `
      async function executeChildProcess() {
        const { execFile } = await import("node:child_process");
        execFile("git", ["status", "--short"], () => {});
      }
    `,
  },
  {
    name: "same-scope dynamic aliased execution",
    source: `
      async function executeAliasedChildProcess() {
        const { execFile: runChild } = await import("node:child_process");
        runChild("git", ["status", "--short"], () => {});
      }
    `,
  },
  {
    name: "same-scope dynamic namespace execution",
    source: `
      async function executeChildProcessNamespace() {
        const childProcess = await import("node:child_process");
        childProcess.execFile("git", ["status", "--short"], () => {});
      }
    `,
  },
];

const DESCENDANT_SCOPE_CHILD_PROCESS_EXECUTION_FIXTURES = [
  {
    name: "dynamic named binding executes from a descendant block",
    source: `
      async function executeChildProcess() {
        const { execFile } = await import("node:child_process");
        {
          execFile("git", ["status", "--short"], () => {});
        }
      }
    `,
  },
  {
    name: "dynamic aliased binding executes from a descendant closure",
    source: `
      async function executeAliasedChildProcess() {
        const { execFile: runChild } = await import("node:child_process");
        const invoke = () => {
          runChild("git", ["status", "--short"], () => {});
        };
        invoke();
      }
    `,
  },
  {
    name: "dynamic namespace binding executes from a descendant object method",
    source: `
      async function executeChildProcessNamespace() {
        const childProcess = await import("node:child_process");
        const runner = {
          invoke() {
            childProcess.execFile("git", ["status", "--short"], () => {});
          },
        };
        runner.invoke();
      }
    `,
  },
  {
    name: "dynamic named binding executes from a template interpolation",
    source: `
      async function executeChildProcessInTemplate() {
        const { execFile } = await import("node:child_process");
        const description = \`status: \${execFile("git", ["status", "--short"], () => {})}\`;
        void description;
      }
    `,
  },
];

const DESCENDANT_SHADOWED_BINDING_UNIT_FIXTURES = [
  {
    name: "descendant block shadows a dynamic named binding",
    source: `
      async function inspectChildProcessBinding() {
        const { execFile } = await import("node:child_process");
        {
          const execFile = (value) => value;
          execFile("fixture-only");
        }
      }
    `,
  },
  {
    name: "descendant closure parameter shadows a dynamic aliased binding",
    source: `
      async function inspectAliasedChildProcessBinding() {
        const { execFile: runChild } = await import("node:child_process");
        const invoke = (runChild) => {
          return runChild("fixture-only");
        };
        invoke((value) => value);
      }
    `,
  },
  {
    name: "descendant object method parameter shadows a dynamic namespace binding",
    source: `
      async function inspectChildProcessNamespace() {
        const childProcess = await import("node:child_process");
        const runner = {
          invoke(childProcess) {
            return childProcess.execFile("fixture-only");
          },
        };
        runner.invoke({ execFile: (value) => value });
      }
    `,
  },
];

const INNER_SHADOW_MUTATION_OUTER_EXECUTION_FIXTURES = [
  {
    name: "inner named shadow assignment preserves the outer child-process binding",
    source: `
      async function executeOuterNamedBinding(injectedChild) {
        const { execFile } = await import("node:child_process");
        {
          let execFile = injectedChild;
          execFile = (value) => value;
          execFile("fixture-only");
        }
        execFile("git", ["status", "--short"], () => {});
      }
    `,
  },
  {
    name: "inner alias shadow assignment preserves the outer child-process binding",
    source: `
      async function executeOuterAliasedBinding(injectedChild) {
        const { execFile: runChild } = await import("node:child_process");
        {
          let runChild = injectedChild;
          runChild = (value) => value;
          runChild("fixture-only");
        }
        runChild("git", ["status", "--short"], () => {});
      }
    `,
  },
  {
    name: "inner namespace shadow assignment preserves the outer child-process binding",
    source: `
      async function executeOuterNamespaceBinding(injectedNamespace) {
        const childProcess = await import("node:child_process");
        {
          let childProcess = injectedNamespace;
          childProcess = { execFile: (value) => value };
          childProcess.execFile("fixture-only");
        }
        childProcess.execFile("git", ["status", "--short"], () => {});
      }
    `,
  },
];

const MEMBER_PROPERTY_ASSIGNMENT_OUTER_EXECUTION_FIXTURES = [
  {
    name: "holder execFile property assignment preserves imported named execution",
    source: `
      async function executeImportedNamedBinding(stub) {
        const { execFile } = await import("node:child_process");
        const holder = {};
        holder.execFile = stub;
        execFile("git", ["status", "--short"], () => {});
      }
    `,
  },
  {
    name: "holder childProcess property assignment preserves imported namespace execution",
    source: `
      async function executeImportedNamespaceBinding() {
        const childProcess = await import("node:child_process");
        const holder = {};
        holder.childProcess = {};
        childProcess.execFile("git", ["status", "--short"], () => {});
      }
    `,
  },
  {
    name: "spaced holder execFile property assignment preserves imported named execution",
    source: `
      async function executeImportedNamedBinding(stub) {
        const { execFile } = await import("node:child_process");
        const holder = {};
        holder . execFile = stub;
        execFile("git", ["status", "--short"], () => {});
      }
    `,
  },
  {
    name: "spaced holder childProcess property assignment preserves imported namespace execution",
    source: `
      async function executeImportedNamespaceBinding() {
        const childProcess = await import("node:child_process");
        const holder = {};
        holder . childProcess = {};
        childProcess.execFile("git", ["status", "--short"], () => {});
      }
    `,
  },
];

const DESTRUCTURED_AND_FOR_OF_SHADOW_UNIT_FIXTURES = [
  {
    name: "destructured arrow parameter shadows imported named binding",
    source: `
      async function inspectImportedNamedBinding(injected) {
        const { execFile } = await import("node:child_process");
        const invoke = ({ execFile }) => {
          return execFile("fixture-only");
        };
        invoke(injected);
      }
    `,
  },
  {
    name: "destructured arrow parameter shadows imported namespace binding",
    source: `
      async function inspectImportedNamespaceBinding(injected) {
        const childProcess = await import("node:child_process");
        const invoke = ({ childProcess }) => {
          return childProcess.execFile("fixture-only");
        };
        invoke(injected);
      }
    `,
  },
  {
    name: "destructured child-scope declaration shadows imported named binding",
    source: `
      async function inspectImportedNamedBinding(injected) {
        const { execFile } = await import("node:child_process");
        {
          const { execFile } = injected;
          execFile("fixture-only");
        }
      }
    `,
  },
  {
    name: "destructured child-scope declaration shadows imported namespace binding",
    source: `
      async function inspectImportedNamespaceBinding(injected) {
        const childProcess = await import("node:child_process");
        {
          const { childProcess } = injected;
          childProcess.execFile("fixture-only");
        }
      }
    `,
  },
  {
    name: "for-of const binding shadows imported named binding",
    source: `
      async function inspectImportedNamedBinding(injectedChildren) {
        const { execFile } = await import("node:child_process");
        for (const execFile of injectedChildren) {
          execFile("fixture-only");
        }
      }
    `,
  },
  {
    name: "for-of const binding shadows imported namespace binding",
    source: `
      async function inspectImportedNamespaceBinding(injectedChildren) {
        const childProcess = await import("node:child_process");
        for (const childProcess of injectedChildren) {
          childProcess.execFile("fixture-only");
        }
      }
    `,
  },
];

const D19_FOR_AWAIT_SHADOW_UNIT_FIXTURES = [
  {
    name: "for-await-of const binding shadows imported named binding",
    source: `
      async function inspectImportedNamedBinding(injectedChildren) {
        const { execFile } = await import("node:child_process");
        for await (const execFile of injectedChildren) {
          execFile("fixture-only");
        }
      }
    `,
  },
  {
    name: "for-await-of const binding shadows imported namespace binding",
    source: `
      async function inspectImportedNamespaceBinding(injectedChildren) {
        const childProcess = await import("node:child_process");
        for await (const childProcess of injectedChildren) {
          childProcess.execFile("fixture-only");
        }
      }
    `,
  },
];

const D19_FUNCTION_EXPRESSION_SELF_BINDING_UNIT_FIXTURES = [
  {
    name: "named function-expression self binding shadows imported named binding",
    source: `
      async function inspectImportedNamedBinding() {
        const { execFile } = await import("node:child_process");
        const invoke = function execFile(depth = 0) {
          return depth === 0 ? execFile(depth + 1) : "fixture-only";
        };
        invoke();
      }
    `,
  },
  {
    name: "named function-expression self binding shadows imported namespace binding",
    source: `
      async function inspectImportedNamespaceBinding(stub) {
        const childProcess = await import("node:child_process");
        const invoke = function childProcess() {
          return childProcess.execFile("fixture-only");
        };
        invoke.execFile = stub;
        invoke();
      }
    `,
  },
];

const D19_OPTIONAL_IMPORTED_EXECUTION_FIXTURES = [
  {
    name: "optional imported named child-process call",
    source: `
      async function executeOptionalNamedBinding() {
        const { execFile } = await import("node:child_process");
        execFile?.("git", ["status", "--short"], () => {});
      }
    `,
  },
  {
    name: "optional imported namespace child-process call",
    source: `
      async function executeOptionalNamespaceBinding() {
        const childProcess = await import("node:child_process");
        childProcess?.execFile("git", ["status", "--short"], () => {});
      }
    `,
  },
];

const D19_DESTRUCTURING_ASSIGNMENT_UNIT_FIXTURES = [
  {
    name: "destructuring assignment replaces imported named binding",
    source: `
      async function exerciseNamedDestructuringAssignment(holder) {
        let { execFile } = await import("node:child_process");
        ({ execFile } = holder);
        execFile("fixture-only");
      }
    `,
  },
  {
    name: "destructuring assignment replaces imported namespace binding",
    source: `
      async function exerciseNamespaceDestructuringAssignment(holder) {
        let childProcess = await import("node:child_process");
        ({ childProcess } = holder);
        childProcess.execFile("fixture-only");
      }
    `,
  },
];

const REASSIGNMENT_OPERATORS = [
  { name: "logical AND assignment", named: "execFile &&= injectedChild", namespace: "childProcess &&= injectedNamespace" },
  { name: "logical OR assignment", named: "execFile ||= injectedChild", namespace: "childProcess ||= injectedNamespace" },
  { name: "nullish assignment", named: "execFile ??= injectedChild", namespace: "childProcess ??= injectedNamespace" },
  { name: "compound addition assignment", named: "execFile += injectedChild", namespace: "childProcess += injectedNamespace" },
  { name: "prefix update", named: "++execFile", namespace: "++childProcess" },
  { name: "postfix update", named: "execFile++", namespace: "childProcess++" },
];

const SAME_SCOPE_REASSIGNED_BINDING_UNIT_FIXTURES = REASSIGNMENT_OPERATORS.flatMap(
  ({ name, named, namespace }) => [
    {
      name: `dynamic named binding ${name}`,
      source: `
        async function exerciseNamedReassignment(injectedChild) {
          let { execFile } = await import("node:child_process");
          ${named};
          execFile("fixture-only");
        }
      `,
    },
    {
      name: `dynamic namespace binding ${name}`,
      source: `
        async function exerciseNamespaceReassignment(injectedNamespace) {
          let childProcess = await import("node:child_process");
          ${namespace};
          childProcess.execFile("fixture-only");
        }
      `,
    },
  ],
);

const ROUND3_STATIC_TIER_POLARITY_FIXTURES = [
  {
    name: "static named import shadowed by descendant parameter",
    expected: [true, false],
    source: `
      import { execFile } from "node:child_process";
      const invoke = (execFile) => {
        return execFile("fixture-only");
      };
      invoke((value) => value);
    `,
  },
  {
    name: "static namespace import shadowed by descendant binding",
    expected: [true, false],
    source: `
      import * as childProcess from "node:child_process";
      {
        const childProcess = { execFile: (value) => value };
        childProcess.execFile("fixture-only");
      }
    `,
  },
  {
    name: "static named imported alias invalidated before call",
    expected: [true, false],
    source: `
      import { execFile as runChild } from "node:child_process";
      runChild = (value) => value;
      runChild("fixture-only");
    `,
  },
  {
    name: "unrelated module pure git helper call",
    expected: [true, false],
    source: `
      import { git } from "./pure-helper.mjs";
      git("fixture-only");
    `,
  },
  {
    name: "static named child-process actual call",
    expected: [false, true],
    source: `
      import { execFile } from "node:child_process";
      execFile("git", ["status", "--short"], () => {});
    `,
  },
  {
    name: "static namespace child-process actual call",
    expected: [false, true],
    source: `
      import * as childProcess from "node:child_process";
      childProcess.execFile("git", ["status", "--short"], () => {});
    `,
  },
  {
    name: "trusted local git helper actual call",
    expected: [false, true],
    source: `
      import { git } from "./lib/git.mjs";
      git(repoRoot, ["status", "--short"]);
    `,
  },
];

const ROUND4_STATIC_TIER_POLARITY_FIXTURES = [
  {
    name: "trusted namespace git helper actual call",
    expected: [false, true],
    source: `
      import * as gitLib from "./lib/git.mjs";
      gitLib.git(repoRoot, ["status", "--short"]);
    `,
  },
  {
    name: "unrelated namespace pure git helper call",
    expected: [true, false],
    source: `
      import * as helper from "./pure-helper.mjs";
      helper.git("fixture-only");
    `,
  },
  {
    name: "expression-body arrow shadows named child-process import",
    expected: [true, false],
    source: `
      import { execFile } from "node:child_process";
      const invoke = (execFile) => execFile("fixture-only");
      invoke((value) => value);
    `,
  },
  {
    name: "absolute-ish git helper import lacks trusted fixture authority",
    expected: [true, false],
    source: `
      import { git } from "/lib/git.mjs";
      git("fixture-only");
    `,
  },
  {
    name: "bare git helper import lacks trusted fixture authority",
    expected: [true, false],
    source: `
      import { git } from "lib/git.mjs";
      git("fixture-only");
    `,
  },
  {
    name: "over-traversal git helper import above suite root lacks trusted fixture authority",
    expected: [true, false],
    source: `
      import { git } from "../lib/git.mjs";
      git("fixture-only");
    `,
  },
];

function diskTestFiles() {
  const files = [];

  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".test.mjs")) continue;
      files.push(path.relative(suiteDirAbs, abs).split(path.sep).join("/"));
    }
  }

  walk(suiteDirAbs);
  return files.sort();
}

test("MANIFEST covers every *.test.mjs on disk exactly once", () => {
  const disk = diskTestFiles();
  const manifestKeys = Object.keys(MANIFEST).sort();
  assert.deepEqual(
    manifestKeys,
    disk,
    "manifest keys must match disk test files",
  );
});

test("legacy proposal readability linter is absent from the suite manifest", () => {
  assert.equal(
    Object.hasOwn(MANIFEST, "readability-precheck-lint.test.mjs"),
    false,
  );
});

test("lintManifest passes on current repo", () => {
  const { ok, errors } = lintManifest({ repoRoot: REPO_ROOT });
  assert.equal(ok, true, errors.join("\n"));
});

test("canonical manifest tiers the real review fixture as integration and keeps the grep guard unit", () => {
  assert.equal(
    MANIFEST["review-findings-persistence-grep.test.mjs"],
    TIER_UNIT,
    "review-findings-persistence-grep.test.mjs must remain unit",
  );
  assert.equal(
    MANIFEST["review-remediation-evidence.test.mjs"],
    TIER_INTEGRATION,
    "review-remediation-evidence.test.mjs executes real Git and child processes",
  );
});

test("manifest lint exports its production semantic tier-assignment seam", () => {
  assert.equal(
    typeof productionTierLinter,
    "function",
    "lint-test-suite-manifest.mjs must export lintTierAssignment so focused tests exercise production tier decisions",
  );
});

test(
  "unit tier rejects executed child-process, Git fixture, and recursive scan cases",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyAccepted = [];
    for (const fixture of EXECUTED_INTEGRATION_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_UNIT,
      });
      if (result.ok) wronglyAccepted.push(fixture.name);
    }
    assert.deepEqual(
      wronglyAccepted,
      [],
      `unit tier incorrectly accepted executed integration fixtures: ${wronglyAccepted.join(", ")}`,
    );
  },
);

test(
  "integration tier accepts executed child-process, Git fixture, and recursive scan cases",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyRejected = [];
    for (const fixture of EXECUTED_INTEGRATION_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_INTEGRATION,
      });
      if (!result.ok) wronglyRejected.push(fixture.name);
    }
    assert.deepEqual(
      wronglyRejected,
      [],
      `integration tier incorrectly rejected executed fixtures: ${wronglyRejected.join(", ")}`,
    );
  },
);

test(
  "unit tier accepts import, comment, literal, regex, and grep guard cases",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    for (const fixture of UNIT_ELIGIBLE_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_UNIT,
      });
      assert.equal(
        result.ok,
        true,
        `${fixture.name} must remain unit-eligible: ${result.errors?.join("\n")}`,
      );
    }
  },
);

test(
  "data-only imports, literals, source guards, and injected methods cannot justify integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyAccepted = [];
    for (const fixture of UNIT_ELIGIBLE_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_INTEGRATION,
      });
      if (result.ok) wronglyAccepted.push(fixture.name);
    }
    assert.deepEqual(
      wronglyAccepted,
      [],
      `integration tier incorrectly accepted data-only fixtures: ${wronglyAccepted.join(", ")}`,
    );
  },
);

test(
  "dynamic import alone cannot justify integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const result = productionTierLinter({
      content: DYNAMIC_IMPORT_ONLY_SOURCE,
      file: "dynamic-import-only.test.mjs",
      tier: TIER_INTEGRATION,
    });
    assert.equal(
      result.ok,
      false,
      "dynamic import alone is not an executed integration signal",
    );
  },
);

test(
  "dynamic child-process bindings do not cross lexical scopes into injected same-name calls",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyRejected = [];
    for (const fixture of LEXICAL_SCOPE_COLLISION_UNIT_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_UNIT,
      });
      if (!result.ok) wronglyRejected.push(fixture.name);
    }
    assert.deepEqual(
      wronglyRejected,
      [],
      `unit tier incorrectly joined distinct lexical bindings: ${wronglyRejected.join(", ")}`,
    );
  },
);

test(
  "lexical-scope collision fixtures cannot justify integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyAccepted = [];
    for (const fixture of LEXICAL_SCOPE_COLLISION_UNIT_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_INTEGRATION,
      });
      if (result.ok) wronglyAccepted.push(fixture.name);
    }
    assert.deepEqual(
      wronglyAccepted,
      [],
      `integration tier incorrectly joined distinct lexical bindings: ${wronglyAccepted.join(", ")}`,
    );
  },
);

test(
  "same-scope dynamic child-process bindings remain positive integration signals",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    for (const fixture of SAME_SCOPE_CHILD_PROCESS_EXECUTION_FIXTURES) {
      const unitResult = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_UNIT,
      });
      const integrationResult = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_INTEGRATION,
      });
      assert.equal(unitResult.ok, false, `${fixture.name} must require integration`);
      assert.equal(integrationResult.ok, true, `${fixture.name} must satisfy integration`);
    }
  },
);

test(
  "descendant-scope child-process execution still requires integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyAcceptedAsUnit = [];
    for (const fixture of DESCENDANT_SCOPE_CHILD_PROCESS_EXECUTION_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_UNIT,
      });
      if (result.ok) wronglyAcceptedAsUnit.push(fixture.name);
    }
    assert.deepEqual(
      wronglyAcceptedAsUnit,
      [],
      `unit tier missed descendant binding execution: ${wronglyAcceptedAsUnit.join(", ")}`,
    );
  },
);

test(
  "descendant-scope child-process execution satisfies integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyRejectedAsIntegration = [];
    for (const fixture of DESCENDANT_SCOPE_CHILD_PROCESS_EXECUTION_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_INTEGRATION,
      });
      if (!result.ok) wronglyRejectedAsIntegration.push(fixture.name);
    }
    assert.deepEqual(
      wronglyRejectedAsIntegration,
      [],
      `integration tier missed descendant binding execution: ${wronglyRejectedAsIntegration.join(", ")}`,
    );
  },
);

test(
  "descendant shadowing remains unit-eligible",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyRejected = [];
    for (const fixture of DESCENDANT_SHADOWED_BINDING_UNIT_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_UNIT,
      });
      if (!result.ok) wronglyRejected.push(fixture.name);
    }
    assert.deepEqual(
      wronglyRejected,
      [],
      `unit tier treated descendant shadow calls as child-process execution: ${wronglyRejected.join(", ")}`,
    );
  },
);

test(
  "descendant shadowing cannot justify integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyAccepted = [];
    for (const fixture of DESCENDANT_SHADOWED_BINDING_UNIT_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_INTEGRATION,
      });
      if (result.ok) wronglyAccepted.push(fixture.name);
    }
    assert.deepEqual(
      wronglyAccepted,
      [],
      `integration tier treated descendant shadow calls as child-process execution: ${wronglyAccepted.join(", ")}`,
    );
  },
);

test(
  "inner shadow assignment cannot hide outer child-process execution from unit rejection",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyAcceptedAsUnit = [];
    for (const fixture of INNER_SHADOW_MUTATION_OUTER_EXECUTION_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_UNIT,
      });
      if (result.ok) wronglyAcceptedAsUnit.push(fixture.name);
    }
    assert.deepEqual(
      wronglyAcceptedAsUnit,
      [],
      `unit tier let inner shadow mutation hide outer execution: ${wronglyAcceptedAsUnit.join(", ")}`,
    );
  },
);

test(
  "inner shadow assignment preserves outer child-process integration authority",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyRejectedAsIntegration = [];
    for (const fixture of INNER_SHADOW_MUTATION_OUTER_EXECUTION_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_INTEGRATION,
      });
      if (!result.ok) wronglyRejectedAsIntegration.push(fixture.name);
    }
    assert.deepEqual(
      wronglyRejectedAsIntegration,
      [],
      `integration tier let inner shadow mutation hide outer execution: ${wronglyRejectedAsIntegration.join(", ")}`,
    );
  },
);

test(
  "member property assignment cannot hide imported child-process execution from unit rejection",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyAcceptedAsUnit = [];
    for (const fixture of MEMBER_PROPERTY_ASSIGNMENT_OUTER_EXECUTION_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_UNIT,
      });
      if (result.ok) wronglyAcceptedAsUnit.push(fixture.name);
    }
    assert.deepEqual(
      wronglyAcceptedAsUnit,
      [],
      `unit tier treated member-property writes as imported-binding reassignment: ${wronglyAcceptedAsUnit.join(", ")}`,
    );
  },
);

test(
  "member property assignment preserves imported child-process integration authority",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyRejectedAsIntegration = [];
    for (const fixture of MEMBER_PROPERTY_ASSIGNMENT_OUTER_EXECUTION_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_INTEGRATION,
      });
      if (!result.ok) wronglyRejectedAsIntegration.push(fixture.name);
    }
    assert.deepEqual(
      wronglyRejectedAsIntegration,
      [],
      `integration tier treated member-property writes as imported-binding reassignment: ${wronglyRejectedAsIntegration.join(", ")}`,
    );
  },
);

test(
  "destructured and for-of shadows remain unit-eligible",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyRejected = [];
    for (const fixture of DESTRUCTURED_AND_FOR_OF_SHADOW_UNIT_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_UNIT,
      });
      if (!result.ok) wronglyRejected.push(fixture.name);
    }
    assert.deepEqual(
      wronglyRejected,
      [],
      `unit tier trusted destructured/for-of shadow calls as imported execution: ${wronglyRejected.join(", ")}`,
    );
  },
);

test(
  "destructured and for-of shadows cannot justify integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyAccepted = [];
    for (const fixture of DESTRUCTURED_AND_FOR_OF_SHADOW_UNIT_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_INTEGRATION,
      });
      if (result.ok) wronglyAccepted.push(fixture.name);
    }
    assert.deepEqual(
      wronglyAccepted,
      [],
      `integration tier trusted destructured/for-of shadow calls as imported execution: ${wronglyAccepted.join(", ")}`,
    );
  },
);

function assertD19UnitPolarity(fixtures, label) {
  const wronglyRejected = [];
  for (const fixture of fixtures) {
    const result = productionTierLinter({
      content: fixture.source,
      file: `${fixture.name}.test.mjs`,
      tier: TIER_UNIT,
    });
    if (!result.ok) wronglyRejected.push(fixture.name);
  }
  assert.deepEqual(
    wronglyRejected,
    [],
    `${label} must remain unit-eligible: ${wronglyRejected.join(", ")}`,
  );
}

function assertD19NonIntegrationPolarity(fixtures, label) {
  const wronglyAccepted = [];
  for (const fixture of fixtures) {
    const result = productionTierLinter({
      content: fixture.source,
      file: `${fixture.name}.test.mjs`,
      tier: TIER_INTEGRATION,
    });
    if (result.ok) wronglyAccepted.push(fixture.name);
  }
  assert.deepEqual(
    wronglyAccepted,
    [],
    `${label} cannot justify integration: ${wronglyAccepted.join(", ")}`,
  );
}

function assertD19IntegrationPolarity(fixtures, label) {
  const wronglyRejected = [];
  for (const fixture of fixtures) {
    const result = productionTierLinter({
      content: fixture.source,
      file: `${fixture.name}.test.mjs`,
      tier: TIER_INTEGRATION,
    });
    if (!result.ok) wronglyRejected.push(fixture.name);
  }
  assert.deepEqual(
    wronglyRejected,
    [],
    `${label} must satisfy integration: ${wronglyRejected.join(", ")}`,
  );
}

function assertD19NonUnitPolarity(fixtures, label) {
  const wronglyAccepted = [];
  for (const fixture of fixtures) {
    const result = productionTierLinter({
      content: fixture.source,
      file: `${fixture.name}.test.mjs`,
      tier: TIER_UNIT,
    });
    if (result.ok) wronglyAccepted.push(fixture.name);
  }
  assert.deepEqual(
    wronglyAccepted,
    [],
    `${label} must require integration: ${wronglyAccepted.join(", ")}`,
  );
}

test(
  "D19 for-await-of shadows remain unit-eligible",
  { skip: typeof productionTierLinter !== "function" },
  () => assertD19UnitPolarity(D19_FOR_AWAIT_SHADOW_UNIT_FIXTURES, "for-await-of shadows"),
);

test(
  "D19 for-await-of shadows cannot justify integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => assertD19NonIntegrationPolarity(D19_FOR_AWAIT_SHADOW_UNIT_FIXTURES, "for-await-of shadows"),
);

test(
  "D19 named function-expression self bindings remain unit-eligible",
  { skip: typeof productionTierLinter !== "function" },
  () => assertD19UnitPolarity(D19_FUNCTION_EXPRESSION_SELF_BINDING_UNIT_FIXTURES, "function-expression self bindings"),
);

test(
  "D19 named function-expression self bindings cannot justify integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => assertD19NonIntegrationPolarity(D19_FUNCTION_EXPRESSION_SELF_BINDING_UNIT_FIXTURES, "function-expression self bindings"),
);

test(
  "D19 optional imported calls require integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => assertD19NonUnitPolarity(D19_OPTIONAL_IMPORTED_EXECUTION_FIXTURES, "optional imported calls"),
);

test(
  "D19 optional imported calls satisfy integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => assertD19IntegrationPolarity(D19_OPTIONAL_IMPORTED_EXECUTION_FIXTURES, "optional imported calls"),
);

test(
  "D19 destructuring assignments remain unit-eligible",
  { skip: typeof productionTierLinter !== "function" },
  () => assertD19UnitPolarity(D19_DESTRUCTURING_ASSIGNMENT_UNIT_FIXTURES, "destructuring assignments"),
);

test(
  "D19 destructuring assignments cannot justify integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => assertD19NonIntegrationPolarity(D19_DESTRUCTURING_ASSIGNMENT_UNIT_FIXTURES, "destructuring assignments"),
);

test(
  "same-scope reassignment operator matrix remains unit-eligible",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyRejected = [];
    for (const fixture of SAME_SCOPE_REASSIGNED_BINDING_UNIT_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_UNIT,
      });
      if (!result.ok) wronglyRejected.push(fixture.name);
    }
    assert.deepEqual(
      wronglyRejected,
      [],
      `unit tier trusted reassigned child-process bindings: ${wronglyRejected.join(", ")}`,
    );
  },
);

test(
  "same-scope reassignment operator matrix cannot justify integration tier",
  { skip: typeof productionTierLinter !== "function" },
  () => {
    const wronglyAccepted = [];
    for (const fixture of SAME_SCOPE_REASSIGNED_BINDING_UNIT_FIXTURES) {
      const result = productionTierLinter({
        content: fixture.source,
        file: `${fixture.name}.test.mjs`,
        tier: TIER_INTEGRATION,
      });
      if (result.ok) wronglyAccepted.push(fixture.name);
    }
    assert.deepEqual(
      wronglyAccepted,
      [],
      `integration tier trusted reassigned child-process bindings: ${wronglyAccepted.join(", ")}`,
    );
  },
);

test(
  "Round 3 static tier detector resolves binding authority and trusted sources",
  { skip: typeof productionTierLinter !== "function" },
  async (t) => {
    for (const fixture of ROUND3_STATIC_TIER_POLARITY_FIXTURES) {
      await t.test(fixture.name, () => {
        const actual = [TIER_UNIT, TIER_INTEGRATION].map((tier) =>
          productionTierLinter({
            content: fixture.source,
            file: `${fixture.name}.test.mjs`,
            tier,
          }).ok,
        );
        assert.deepEqual(actual, fixture.expected, "expected [unit, integration] polarity");
      });
    }
  },
);

test(
  "Round 4 static tier detector covers fixture namespace, expression-arrow shadow, absolute source rejection, and over-traversal rejection",
  { skip: typeof productionTierLinter !== "function" },
  async (t) => {
    for (const fixture of ROUND4_STATIC_TIER_POLARITY_FIXTURES) {
      await t.test(fixture.name, () => {
        const actual = [TIER_UNIT, TIER_INTEGRATION].map((tier) =>
          productionTierLinter({
            content: fixture.source,
            file: `${fixture.name}.test.mjs`,
            tier,
          }).ok,
        );
        assert.deepEqual(actual, fixture.expected, "expected [unit, integration] polarity");
      });
    }
  },
);

test("listFiles includes nested version-helper test in the unit tier", () => {
  const unitFiles = listFiles(TIER_UNIT);
  assert.ok(
    unitFiles.includes(`${SUITE_DIR}lib/version-helpers.test.mjs`),
    "nested version-helper test must be included in the unit tier",
  );
});

test("integration manifest files pass production semantic tier assignment", () => {
  for (const [file, tier] of Object.entries(MANIFEST)) {
    if (tier !== TIER_INTEGRATION) continue;
    const content = readFileSync(path.join(suiteDirAbs, file), "utf8");
    const result = productionTierLinter({ content, file, tier });
    assert.equal(
      result.ok,
      true,
      result.errors.join("\n"),
    );
  }
});

test("adapter anchor-footnote Git guard is integration", () => {
  assert.equal(resolveTier("adapter-anchor-footnote.test.mjs"), TIER_INTEGRATION);
});

test("agent reference-digest Git guard is integration", () => {
  assert.equal(
    resolveTier("agent-reference-digest-grep.test.mjs"),
    TIER_INTEGRATION,
  );
});

test("consumer adoption matrix stays unit", () => {
  assert.equal(resolveTier("consumer-adoption-matrix.test.mjs"), TIER_UNIT);
});

test("rule-load ledger test stays unit", () => {
  assert.equal(resolveTier("rule-load-ledger.test.mjs"), TIER_UNIT);
});

test("resolveTier throws for unknown file", () => {
  assert.throws(
    () => resolveTier("nonexistent.test.mjs"),
    /unknown file/,
  );
});

test("parseArgs defaults to all tier", () => {
  assert.deepEqual(parseArgs([]), {
    tier: "all",
    changedBase: null,
    repoRoot: REPO_ROOT,
    stdioMode: "log",
    allowFullFallback: false,
  });
});

test("resolveTierFromArgv parses unit and integration", () => {
  assert.equal(resolveTierFromArgv(["--tier", "unit"]), "unit");
  assert.equal(resolveTierFromArgv(["--tier", "integration"]), "integration");
  assert.equal(resolveTierFromArgv([]), "all");
});

test("listFiles paths are under SUITE_DIR", () => {
  for (const p of listFiles(TIER_UNIT)) {
    assert.ok(p.startsWith(SUITE_DIR), p);
    assert.ok(p.endsWith(".test.mjs"), p);
  }
});

test("MANIFEST is exported object with unit and integration values only", () => {
  const values = new Set(Object.values(MANIFEST));
  assert.deepEqual([...values].sort(), [TIER_INTEGRATION, TIER_UNIT]);
});
