import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



test("dp-second-reviewer verifies exact sticky comment before returning id", () => {
  const agent = read(".claude/agents/dp-second-reviewer.md");
  const shared = read(".devpro/agent-rules/code-review-cross-model.md");
  const spec = read("openspec/specs/code-review-checklist/spec.md");

  for (const [name, body] of [
    ["agent", agent],
    ["shared", shared],
    ["spec", spec],
  ]) {
    assert.match(
      body,
      /read-second-review-sticky-comment\.mjs|sticky_write_readback_recipe/,
      `${name}: gated sticky read helper`,
    );
    assert.match(body, /HTTP 200|200/, `${name}: successful read-back requirement`);
    assert.match(body, /<!-- cross-model-second-opinion:sticky -->/, `${name}: sticky marker verification`);
    assert.match(body, /verdict[\s\S]{0,120}(?:match|equal|一致|等於)/i, `${name}: verdict equality check`);
    assert.match(body, /last_reviewed_sha[\s\S]{0,120}(?:match|equal|一致|等於)/i, `${name}: sha equality check`);
    assert.match(body, /MUST NOT|不得|禁止/, `${name}: negative rule`);
    assert.match(body, /sticky_comment_id[\s\S]{0,160}(?:verified|自驗|read-back|read back|讀回|驗證)/i, `${name}: verified sticky_comment_id`);
    assert.match(body, /status:\s*blocked|`status: blocked`/, `${name}: blocked status on verification failure`);
    assert.match(body, /sticky_comment_id:\s*null|`sticky_comment_id: null`/, `${name}: null sticky id on verification failure`);
    assert.match(body, /sticky_comment_url:\s*null|`sticky_comment_url: null`/, `${name}: null sticky url on verification failure`);
  }
});

// fix-flow-gate-gaps R3 (design D3): the remediation ordering that keeps the
// pre-spawn live-head comparison satisfiable MUST be explicit in both dispatch
// carriers, on one physical line (same-line compound anchor) so a trim cannot
// decouple the ordering from its consequence.
test("fix-flow-gate-gaps R3: commit -> push -> suite/receipt -> render/dispatch is a same-line compound anchor in both carriers", () => {
  const ordered = /commit\s*→\s*push\s*→\s*suite\/receipt\s*→\s*render\/dispatch/;
  const carriers = [
    ["code-review-cross-model.md §Head movement ordering", read(".devpro/agent-rules/code-review-cross-model.md")],
    ["pre-pr/SKILL.md §Step 5.5 Head movement precheck", read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md")],
  ];
  for (const [name, body] of carriers) {
    const anchoredLines = body.split("\n").filter((line) => ordered.test(line));
    assert.ok(
      anchoredLines.length >= 1,
      `${name}: missing same-physical-line compound anchor commit → push → suite/receipt → render/dispatch`,
    );
  }
});
