import { readSourceFile } from "./read.mjs";

/**
 * `devpro:second-review` keeps everything every host reads in `SKILL.md`; the three
 * host-specific projection routes live one per file under `references/`, and
 * `SKILL.md` §Projection Routes keeps only a host -> file routing table.
 *
 * `readSecondReviewSkillWithHostRoutes()` rebuilds the pre-split skill text by
 * replacing that routing table with each reference's verbatim section (its
 * `### <Host>` heading onward). Use it for assertions on the skill as a whole that
 * also cover host-route text; read a single reference directly for host-only
 * assertions. It throws when the split structure drifts (table, row, reference
 * heading missing or duplicated).
 */
export const SECOND_REVIEW_SKILL = ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md";
const REFERENCES = ".devpro/agent-skills/devpro-reviews/second-review/references/";

export const SECOND_REVIEW_HOST_ROUTES = Object.freeze([
  Object.freeze({ host: "Claude Code", file: `${REFERENCES}claude-code-host.md`, heading: "### Claude Code Host" }),
  Object.freeze({ host: "Codex", file: `${REFERENCES}codex-host.md`, heading: "### Codex Host" }),
  Object.freeze({
    host: "Cursor 與其他 host",
    file: `${REFERENCES}cursor-and-other-hosts.md`,
    heading: "### Cursor And Other Hosts",
  }),
]);

const TABLE_START = "\n| Host | 路由檔 |\n|---|---|\n";
const TABLE_END = "\n只讀當前 host 那一檔；其他 host 的路由不影響本 host 的判斷。\n";

function indexOnce(text, needle, carrier) {
  const first = text.indexOf(needle);
  if (first < 0 || text.indexOf(needle, first + 1) >= 0) {
    throw new Error(`${carrier} must contain exactly one ${JSON.stringify(needle)}`);
  }
  return first;
}

function routingTable(skill) {
  const start = indexOnce(skill, TABLE_START, SECOND_REVIEW_SKILL);
  const end = indexOnce(skill, TABLE_END, SECOND_REVIEW_SKILL) + TABLE_END.length;
  if (end <= start) throw new Error(`${SECOND_REVIEW_SKILL} routing table is out of order`);
  const table = skill.slice(start, end);
  for (const { host, file } of SECOND_REVIEW_HOST_ROUTES) {
    const row = `| ${host} | \`${file.slice(file.indexOf("references/"))}\` |`;
    if (table.split("\n").filter((line) => line === row).length !== 1) {
      throw new Error(`${SECOND_REVIEW_SKILL} routing table must list ${row} exactly once`);
    }
  }
  return table;
}

export function composeSecondReviewSkillWithHostRoutes(skill, referencesByFile) {
  const table = routingTable(skill);
  const sections = SECOND_REVIEW_HOST_ROUTES.map(({ file, heading }) => {
    const text = referencesByFile[file];
    if (typeof text !== "string") throw new Error(`missing reference ${file}`);
    return text.slice(indexOnce(text, `\n${heading}\n`, file));
  });
  return skill.replace(table, sections.join(""));
}

export function readSecondReviewHostRoute(host) {
  const route = SECOND_REVIEW_HOST_ROUTES.find((entry) => entry.host === host);
  if (!route) throw new Error(`unknown second-review host route ${host}`);
  return readSourceFile(route.file);
}

export function readSecondReviewSkillWithHostRoutes() {
  return composeSecondReviewSkillWithHostRoutes(
    readSourceFile(SECOND_REVIEW_SKILL),
    Object.fromEntries(SECOND_REVIEW_HOST_ROUTES.map(({ file }) => [file, readSourceFile(file)])),
  );
}
