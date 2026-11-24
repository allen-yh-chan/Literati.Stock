import { readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./repo-root.mjs";

// Line-number cites of rule files (`.devpro/agent-rules/**/*.md`). A line number goes stale on the
// next edit of the rule file, so carriers name the owning section instead. Used by
// pre-tool-gates-spec-rule-cites-grep.test.mjs and rule-file-line-cite-ban-grep.test.mjs.

const RULES_DIR = path.join(REPO_ROOT, ".devpro/agent-rules");

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

// Rule files by base name, platform-adapters/ included.
export const ruleFilePaths = new Map(markdownFiles(RULES_DIR).map((full) => [path.basename(full), full]));

// The written forms caught, each with or without a closing backtick after the file name.
// Directly after the name:
//   `<name>.md:<n>` (also `:<n>-<m>`, `:<n>/<m>`, `:L<n>`)
//   `<name>.md L<n>` (also `#L<n>`, `L<n>-L<m>`, and `L<n>` after a comma or an opening bracket)
//   `<name>.md line <n>` / `lines <n>-<m>`
//   `<name>.md 第 <n> 行`
// Further away, on the same line and before the next `.md` name (at most FAR_WINDOW characters):
//   `<name>.md §<section> (… :<n>)`, `<name>.md, around line <n>`, `<name>.md 的第 <n> 行`
//   `line <n> of <name>.md` / `lines <n>-<m> in <name>.md`
// Only names that are rule files count. A bare `L<n>` away from the name is not a cite (layer and
// lane labels are written that way), and neither is a line number on another line.
const LINE_CITE_TAIL = [
  ":L?\\d+(?:[-/]L?\\d+)*",
  "(?:[ ,(（]+|#)#?L\\d+(?:-L?\\d+)?",
  " +lines? +\\d+(?:-\\d+)?",
  " *第 *\\d+ *行",
].join("|");
const FAR_WINDOW = 120;
const MD_NAME_RE = /[A-Za-z0-9_-]+\.md/g;
const NEAR_CITE_RE = new RegExp(`^\\x60?(?:${LINE_CITE_TAIL})(?![A-Za-z0-9_])`);
// A far token stands on its own: `:<n>` must not continue a word or a number (`12:30`, `foo.mjs:864`).
const FAR_TOKEN_RE = /(?<![A-Za-z0-9_.:/-])(?::L?\d+(?:[-/]L?\d+)*|lines? +\d+(?:-\d+)?|第 *\d+ *行)(?![A-Za-z0-9_:])/;
const LINE_OF_RE = /(?<![A-Za-z0-9_])lines? +\d+(?:-\d+)? +(?:of|in) +\x60?$/;

export function ruleFileLineCites(text) {
  const cites = [];
  for (const line of text.split("\n")) {
    const names = [...line.matchAll(MD_NAME_RE)];
    names.forEach((m, i) => {
      if (!ruleFilePaths.has(m[0])) return;
      const nameEnd = m.index + m[0].length;
      const rest = line.slice(nameEnd);
      const near = NEAR_CITE_RE.exec(rest);
      if (near) return void cites.push(m[0] + near[0]);
      const before = LINE_OF_RE.exec(line.slice(0, m.index));
      if (before) return void cites.push(before[0] + m[0]);
      // A `line <n> of` that leads into the next name belongs to that name.
      const nextStart = names[i + 1]?.index ?? line.length;
      const leadIn = LINE_OF_RE.exec(line.slice(0, nextStart));
      const windowEnd = Math.min(leadIn ? leadIn.index : nextStart, nameEnd + FAR_WINDOW);
      const far = FAR_TOKEN_RE.exec(line.slice(nameEnd, windowEnd));
      if (far) cites.push(line.slice(m.index, nameEnd + far.index + far[0].length));
    });
  }
  return cites;
}
