import { readSourceFile } from "./read.mjs";

/**
 * `devpro:pre-pr` is split across two carriers:
 * - `SKILL.md` keeps every lite step plus the 第三步 paragraphs a capability spec
 *   names `SKILL.md` as the authoritative carrier for (assert those on raw SKILL.md).
 * - `references/full-review-and-archive.md` holds the full-rigor-only steps
 *   第三點零步段／第三步／第三點六步段／第三點七步段, with a `> 本處適用` back-pointer
 *   where each kept 第三步 paragraph applies.
 *
 * `readPrePrSkillFullReadingOrder()` rebuilds the full-rigor reading order: SKILL.md up to
 * the pointer section, the reference body with every back-pointer replaced by the kept
 * SKILL.md paragraph, then SKILL.md from Post-Ledger Final Evidence Gate on. Use it for
 * assertions on Step 3 body text or on cross-step ordering. It throws when the split
 * structure drifts (pointer, heading, back-pointer or kept paragraph missing or duplicated).
 */
export const PRE_PR_SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
export const PRE_PR_FULL_REFERENCE =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/full-review-and-archive.md";

const POINTER_HEADING = "### 第三點零步段～第三點七步段（僅 full）";
const STEP3_HEADING = "### 第三步：Six-Axis Review";
const POST_LEDGER_HEADING = "### Post-Ledger Final Evidence Gate";
const REFERENCE_START = "### 第三點零步段：";
const REFERENCE_TRAILER =
  "\n> 第三點七步段完成後，回 `SKILL.md` 執行 Post-Ledger Final Evidence Gate。";
const BACK_POINTER = /^> 本處適用 `SKILL\.md` §第三步 的「([^」]+)」段.*$/gm;

function indexOnce(text, needle, carrier) {
  const first = text.indexOf(needle);
  if (first < 0 || text.indexOf(needle, first + 1) >= 0) {
    throw new Error(`${carrier} must contain exactly one ${JSON.stringify(needle)}`);
  }
  return first;
}

export function composePrePrFullReadingOrder(skill, reference) {
  const pointer = indexOnce(skill, POINTER_HEADING, PRE_PR_SKILL);
  const step3 = indexOnce(skill, STEP3_HEADING, PRE_PR_SKILL);
  const postLedger = indexOnce(skill, POST_LEDGER_HEADING, PRE_PR_SKILL);
  if (!(pointer < step3 && step3 < postLedger)) {
    throw new Error(`${PRE_PR_SKILL} must order the pointer section, 第三步, then Post-Ledger`);
  }
  const keptRegion = skill.slice(step3, postLedger);
  const kept = keptRegion
    .slice(keptRegion.indexOf("\n**"))
    .split(/\n(?=\*\*)/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const start = indexOnce(reference, REFERENCE_START, PRE_PR_FULL_REFERENCE);
  const end = indexOnce(reference, REFERENCE_TRAILER, PRE_PR_FULL_REFERENCE);
  const used = new Set();
  const body = reference.slice(start, end).replace(BACK_POINTER, (_line, label) => {
    const hits = kept.filter((paragraph) => paragraph.startsWith(`**${label}`));
    if (hits.length !== 1) {
      throw new Error(`back-pointer 「${label}」 must match exactly one kept 第三步 paragraph, got ${hits.length}`);
    }
    if (used.has(hits[0])) {
      throw new Error(`back-pointer 「${label}」 is duplicated; each kept 第三步 paragraph needs exactly one back-pointer`);
    }
    used.add(hits[0]);
    return hits[0];
  });
  if (used.size !== kept.length) {
    throw new Error(`every kept 第三步 paragraph needs one back-pointer (${used.size}/${kept.length})`);
  }
  return `${skill.slice(0, pointer)}${body.replace(/\n+$/, "\n")}\n${skill.slice(postLedger)}`;
}

export function readPrePrSkillFullReadingOrder() {
  return composePrePrFullReadingOrder(
    readSourceFile(PRE_PR_SKILL),
    readSourceFile(PRE_PR_FULL_REFERENCE),
  );
}
