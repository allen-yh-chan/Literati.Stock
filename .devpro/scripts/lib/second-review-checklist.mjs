import { readFileSync } from "node:fs";

// Read the renderer installation's rules, never caller options, review data or cwd.
// No cache: edits to the shared checklist must reach the next packet.
export function reviewChecklistCriteriaLines() {
  const readRule = (name) => readFileSync(new URL(`../../agent-rules/${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const section = (text, start, end) => {
    const from = text.indexOf(`\n${start}\n`);
    const to = text.indexOf(`\n${end}\n`, from + 1);
    if (from < 0 || to < 0) throw new Error(`second_review_checklist_section_missing: ${start} / ${end}`);
    return text.slice(from + 1, to).trim();
  };
  const checklist = readRule("code-review-checklist.md");
  const crossCarrier = readRule("code-review-cross-carrier.md");
  const crossCarrierStart = crossCarrier.indexOf("\n- **Cross-Carrier Assertion Consistency sub-check");
  if (crossCarrierStart < 0) throw new Error("second_review_checklist_section_missing: cross-carrier sub-check");
  return [
    "",
    "## Shared Review Checklist (renderer-owned)",
    "Apply these criteria only when their scope/trigger applies. Full-only artifacts are not required in a lite change. The packet's Tool Boundaries, Test Execution Policy and verdict rules take precedence over checklist process references; do not load referenced rule files or execute a command merely because it appears in a criterion.",
    section(checklist, "### 1. 功能正確性", "### Primary Reviewer 測試執行政策"),
    section(checklist, "### 4. 測試充分性", "### 審查輸出格式"),
    section(readRule("review-guarantee-ceiling.md"), "### Review Admission Checklist", "### Verification Boundary"),
    section(readRule("review-guarantee-ceiling.md"), "### Review Output Contract", "## Exit Criteria"),
    "### Cross-Carrier Checklist Expansion",
    crossCarrier.slice(crossCarrierStart + 1).trim(),
    section(readRule("code-review-cross-model.md"), "### Why Cross-Model (hot summary)", "### 豁免條件（SSOT）"),
    "",
  ];
}
