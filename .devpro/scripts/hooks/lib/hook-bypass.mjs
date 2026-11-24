import { segmentCommand, isMatchInCommandSegment } from "./shell-context.mjs";

export const HOOK_BYPASS_ENV = "DEVPRO_HOOK_BYPASS";
export const HOOK_BYPASS_ASSIGNMENT = `${HOOK_BYPASS_ENV}=1`;
export const HOOK_BYPASS_HINT =
  "Bypass：使用者明示授權後，在同一個 Bash payload 放入 `DEVPRO_HOOK_BYPASS=1`；命中後整個 payload 的 Bash gates 都會跳過。";

const SHELL_VALUE_RE = String.raw`(?:"[^"]*"|'[^']*'|[^\s;|&()]+)`;
const SHELL_ASSIGNMENT_RE = String.raw`[A-Za-z_][A-Za-z0-9_]*=${SHELL_VALUE_RE}`;

// Match a shell env-prefix assignment at the beginning of a command segment,
// including chained commands like `cd /repo && DEVPRO_HOOK_BYPASS=1 git ...`.
// Deliberately does not match plain prose such as `echo DEVPRO_HOOK_BYPASS=1`.
// `matchAll()` creates a fresh iterator, so the global flag has no reusable
// `lastIndex` state across calls.
const INLINE_HOOK_BYPASS_RE = new RegExp(
  String.raw`(?:^|[;\n|&])\s*(?:env\s+)?(?:${SHELL_ASSIGNMENT_RE}\s+)*${HOOK_BYPASS_ENV}=(?:"1"|'1'|1)(?=\s|$|[;\n|&])`,
  "g",
);

function isInsideCommandSubstitution(cmd, index) {
  let single = false;
  let double = false;
  let backtick = false;
  let dollarParenDepth = 0;

  for (let i = 0; i < index; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];

    if (single) {
      if (ch === "'") single = false;
      continue;
    }

    if (backtick) {
      if (ch === "\\" && i + 1 < index) i++;
      else if (ch === "`") backtick = false;
      continue;
    }

    if (double) {
      if (ch === "\\" && i + 1 < index) {
        i++;
      } else if (ch === '"') {
        double = false;
      } else if (ch === "`") {
        backtick = true;
      } else if (ch === "$" && next === "(") {
        dollarParenDepth++;
        i++;
      } else if (ch === ")" && dollarParenDepth > 0) {
        dollarParenDepth--;
      }
      continue;
    }

    if (ch === "'") single = true;
    else if (ch === '"') double = true;
    else if (ch === "`") backtick = true;
    else if (ch === "$" && next === "(") {
      dollarParenDepth++;
      i++;
    } else if (ch === ")" && dollarParenDepth > 0) {
      dollarParenDepth--;
    }
  }

  return backtick || dollarParenDepth > 0;
}

export function hasInlineHookBypass(command) {
  const cmd = String(command || "");
  if (!cmd.includes(HOOK_BYPASS_ENV)) return false;

  let segs = null;
  try {
    segs = segmentCommand(cmd);
  } catch {
    segs = null;
  }

  for (const match of cmd.matchAll(INLINE_HOOK_BYPASS_RE)) {
    const assignmentIndex = match.index + match[0].lastIndexOf(HOOK_BYPASS_ENV);
    if (isInsideCommandSubstitution(cmd, assignmentIndex)) continue;
    if (isMatchInCommandSegment(assignmentIndex, segs)) return true;
  }
  return false;
}
