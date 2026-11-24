import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceFile } from "./read.mjs";
import {
  SECOND_REVIEW_HOST_ROUTES,
  SECOND_REVIEW_SKILL,
  composeSecondReviewSkillWithHostRoutes,
  readSecondReviewHostRoute,
  readSecondReviewSkillWithHostRoutes,
} from "./second-review-skill.mjs";

const skill = readSourceFile(SECOND_REVIEW_SKILL);
const references = Object.fromEntries(SECOND_REVIEW_HOST_ROUTES.map(({ file }) => [file, readSourceFile(file)]));

test("SKILL.md routes each host to exactly one reference and keeps no host route body", () => {
  const routes = skill.split("\n## Projection Routes\n")[1]?.split("\n## ")[0];
  assert.ok(routes, "SKILL.md must keep §Projection Routes");
  for (const { host, file } of SECOND_REVIEW_HOST_ROUTES) {
    assert.match(routes, new RegExp(`^\\| ${host} \\| \`${file.slice(file.indexOf("references/")).replaceAll(".", "\\.")}\` \\|$`, "m"));
  }
  assert.match(routes, /^只讀當前 host 那一檔；其他 host 的路由不影響本 host 的判斷。$/m);
  for (const { heading } of SECOND_REVIEW_HOST_ROUTES) {
    assert.ok(!skill.includes(`\n${heading}\n`), `SKILL.md must not keep ${heading}`);
  }
});

test("each host reference says when it loads and holds only its own host route", () => {
  for (const { host, heading } of SECOND_REVIEW_HOST_ROUTES) {
    const text = readSecondReviewHostRoute(host);
    assert.match(text, /^由 `SKILL\.md` §Projection Routes 載入：當前 host 是 .+ 時讀，其他 host 不讀。/m);
    for (const other of SECOND_REVIEW_HOST_ROUTES) {
      assert.equal(text.includes(`\n${other.heading}\n`), other.heading === heading, `${host} reference and ${other.heading}`);
    }
  }
});

test("the rebuilt skill keeps the host routes in their original order before Boundaries", () => {
  const composed = readSecondReviewSkillWithHostRoutes();
  assert.ok(!composed.includes("| Host | 路由檔 |"), "routing table must be replaced");
  const order = ["## Projection Routes", ...SECOND_REVIEW_HOST_ROUTES.map(({ heading }) => heading), "## Boundaries"].map((needle) => {
    const at = composed.indexOf(`\n${needle}\n`);
    assert.ok(at >= 0, `rebuilt skill lost ${needle}`);
    assert.equal(composed.indexOf(`\n${needle}\n`, at + 1), -1, `rebuilt skill duplicates ${needle}`);
    return at;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("structure drift fails closed", () => {
  const dropRow = skill.replace(/^\| Codex \| .*\n/m, "");
  assert.throws(() => composeSecondReviewSkillWithHostRoutes(dropRow, references), /exactly once/);
  const dropTable = skill.replace("| Host | 路由檔 |", "| Host | file |");
  assert.throws(() => composeSecondReviewSkillWithHostRoutes(dropTable, references), /exactly one/);
  const codex = SECOND_REVIEW_HOST_ROUTES[1].file;
  const dropHeading = { ...references, [codex]: references[codex].replace("\n### Codex Host\n", "\n### Codex\n") };
  assert.throws(() => composeSecondReviewSkillWithHostRoutes(skill, dropHeading), /exactly one/);
  const missing = { ...references };
  delete missing[codex];
  assert.throws(() => composeSecondReviewSkillWithHostRoutes(skill, missing), /missing reference/);
});
