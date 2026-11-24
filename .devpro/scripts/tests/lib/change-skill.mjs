import { readSourceFile } from "./read.mjs";

/**
 * `devpro:change` is split across two carriers:
 * - `SKILL.md` keeps every step lite runs (第零步～第三步, Formalize auto-promote,
 *   change naming, batch-consent extension, 第七步) plus two pointer paragraphs.
 * - `references/full-analysis-and-design.md` holds the full-rigor-only text in two
 *   sections: 「第四步～第六步」 (pre-analyst, dp-analyst, dp-architect, design gate,
 *   fallback) and 「proposal 同步～委派計畫」 (Architect → proposal sync, Redirect Entry
 *   parity, tasks.md, Design Cold Read, Step 5 delegation plan).
 *
 * `readChangeSkillFullReadingOrder()` rebuilds the full-rigor reading order by replacing
 * each pointer line in SKILL.md with the matching reference section body. Use it for
 * assertions on moved text that also check order or position against SKILL.md text.
 * It throws when the split structure drifts (pointer, section heading or return
 * trailer missing or duplicated).
 */
export const CHANGE_SKILL = ".devpro/agent-skills/devpro-workflows/change/SKILL.md";
export const CHANGE_FULL_REFERENCE =
  ".devpro/agent-skills/devpro-workflows/change/references/full-analysis-and-design.md";

const SECTIONS = [
  {
    pointer: "**第四步～第六步（僅 full）**：",
    heading: "## 第四步～第六步",
    trailer: "> 第六步完成後，回 `SKILL.md` 從「接著根據參數決定 change 名稱」繼續。",
  },
  {
    pointer: "**proposal 同步、Design Cold Read 與委派計畫（僅 full）**：",
    heading: "## proposal 同步～委派計畫",
    trailer: "> 委派計畫完成後，回 `SKILL.md` 第七步。",
  },
];

function indexOnce(text, needle, carrier) {
  const first = text.indexOf(needle);
  if (first < 0 || text.indexOf(needle, first + 1) >= 0) {
    throw new Error(`${carrier} must contain exactly one ${JSON.stringify(needle)}`);
  }
  return first;
}

function pointerLine(skill, pointer) {
  const lines = skill.split("\n").filter((line) => line.startsWith(pointer));
  if (lines.length !== 1) {
    throw new Error(`${CHANGE_SKILL} must contain exactly one line starting ${JSON.stringify(pointer)}, got ${lines.length}`);
  }
  return lines[0];
}

function sectionBody(reference, { heading, trailer }) {
  const start = indexOnce(reference, `\n${heading}\n\n`, CHANGE_FULL_REFERENCE) + heading.length + 3;
  const end = indexOnce(reference, `\n\n${trailer}\n`, CHANGE_FULL_REFERENCE);
  if (end <= start) throw new Error(`${CHANGE_FULL_REFERENCE} section ${heading} is empty or out of order`);
  return reference.slice(start, end);
}

export function composeChangeFullReadingOrder(skill, reference) {
  const positions = SECTIONS.map(({ pointer }) => skill.indexOf(pointerLine(skill, pointer)));
  if (!(positions[0] < positions[1])) {
    throw new Error(`${CHANGE_SKILL} must place the 第四步～第六步 pointer before the 委派計畫 pointer`);
  }
  const headings = SECTIONS.map(({ heading }) => indexOnce(reference, `\n${heading}\n\n`, CHANGE_FULL_REFERENCE));
  if (!(headings[0] < headings[1])) {
    throw new Error(`${CHANGE_FULL_REFERENCE} must order 第四步～第六步 before proposal 同步～委派計畫`);
  }
  return SECTIONS.reduce(
    (text, section) => text.replace(`${pointerLine(skill, section.pointer)}\n`, `${sectionBody(reference, section)}\n`),
    skill,
  );
}

export function readChangeSkillFullReadingOrder() {
  return composeChangeFullReadingOrder(readSourceFile(CHANGE_SKILL), readSourceFile(CHANGE_FULL_REFERENCE));
}
