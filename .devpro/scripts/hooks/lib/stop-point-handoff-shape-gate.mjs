/**
 * stop-point-handoff-shape-gate.mjs
 *
 * Stop-point handoff shape gate: if the final assistant message leaves the ball
 * with the user, it must end with the stop-point-comms presentation shape:
 *   - 為什麼停
 *   - 要你做什麼（回數字）
 *   - 回了會怎樣
 *   - numbered options whose last option is open-ended
 *
 * This is deliberately a shape gate, not a flow classifier. It only triggers on
 * strong user-owned stop markers, then enforces the user-facing handoff format.
 */

const COMMIT_MSG_CONTEXT_PATTERNS = [
  /git\s+commit\s+-m\b/i,
  /<commit[-_]msg>/i,
  /Co-Authored-By:/i,
  /^Co-Authored-By:/m,
];

const HANDOFF_LABELS = {
  why: /(?:^|\n)\s*>?\s*(?:\*\*)?為什麼停(?:\*\*)?\s*[:：]/,
  ask: /(?:^|\n)\s*>?\s*(?:\*\*)?要你做什麼(?:[（(][^）)]*[）)])?(?:\*\*)?\s*[:：]/,
  next: /(?:^|\n)\s*>?\s*(?:\*\*)?回了會怎樣(?:\*\*)?\s*[:：]/,
};

const USER_OWNER_RE = /(?:^|\n)\s*(?:[-*]\s*)?`?Owner`?\s*:\s*(?:user|使用者)\b/i;
const USER_OWNER_INLINE_RE = /\bowner\s*=\s*(?:user|使用者)\b/i;
const NON_USER_OWNER_RE =
  /(?:^|\n)\s*(?:[-*]\s*)?`?Owner`?\s*:\s*(?:TL(?:\s*\/\s*reviewer)?|reviewer|automation|AI|third[- ]party|審查者|自動化|第三方)\b/i;
const NON_USER_OWNER_INLINE_RE =
  /\bowner\s*=\s*(?:TL(?:\s*\/\s*reviewer)?|reviewer|automation|AI|third[- ]party)\b/i;
const ASK_FIRST_PENDING_RE =
  /(?:^|\n)\s*(?:[-*]\s*)?`?AskFirstPending`?\s*:\s*(?!none\b|n\/a\b|無\b)[^\n]+/i;
const PR_USER_WAIT_RE =
  /(?:PR\s*(?:#\d+|opened|created|已建立|已開)|pull\/\d+)[\s\S]{0,180}(?:等你|待你|需要你|請你|使用者|user|授權|核准|merge authorization|review\s*\/\s*merge|review\/merge|由你.*merge|你.*merge)/i;
const PR_OPEN_NOT_MERGED_RE =
  /(?:PR\s*(?:#\d+|opened|created|open|已建立|已開)|pull\/\d+)[\s\S]{0,180}(?:(?:尚未|還沒|未|沒有)\s*(?:merge(?:d)?|合併)|not\s+(?:yet\s+)?merged|not\s+merged\s+yet|unmerged|await(?:ing)?\s+(?:merge|merge-review|review)|waiting\s+for\s+(?:merge|merge-review|review)|尚待\s*(?:merge|review|合併|審核))/i;
const UNFINISHED_GIT_PR_HANDOFF_RE =
  /(?:(?:尚未|還沒|沒有|not\s+yet)[\s\S]{0,80}|未\s*)(?:commit(?:ted)?|提交)[\s\S]{0,80}(?:push(?:ed)?|推送)[\s\S]{0,80}(?:PR|pull\s+request|開\s*PR|create(?:d)?\s*(?:PR|pull\s+request))/i;

const OPTION_MARKER_RE = /(^|[\n\s>→:;，、])(?:\*\*)?([1-9]\d*)\.(?:\*\*)?\s*/g;
const OPEN_LAST_RE = /其他|以上都不是|我想直接|直接跟你說|我不確定|不確定|自由|說明|other/i;

function isCommitMessageContext(messageText) {
  return COMMIT_MSG_CONTEXT_PATTERNS.some((re) => re.test(messageText));
}

function hasLabel(messageText, key) {
  return HANDOFF_LABELS[key].test(messageText);
}

function hasAnyHandoffLabel(messageText) {
  return Object.keys(HANDOFF_LABELS).some((key) => hasLabel(messageText, key));
}

function hasNonUserOwnerMarker(messageText) {
  return NON_USER_OWNER_RE.test(messageText) || NON_USER_OWNER_INLINE_RE.test(messageText);
}

function hasCompleteHandoffLabels(messageText) {
  return Object.keys(HANDOFF_LABELS).every((key) => hasLabel(messageText, key));
}

function detectUserOwnedStopMarker(messageText) {
  if (hasAnyHandoffLabel(messageText)) return "stop-point handoff label";
  if (USER_OWNER_RE.test(messageText) || USER_OWNER_INLINE_RE.test(messageText)) return "Owner: user";
  if (ASK_FIRST_PENDING_RE.test(messageText)) return "AskFirstPending";
  if (PR_USER_WAIT_RE.test(messageText)) return "PR user-owned wait";
  if (PR_OPEN_NOT_MERGED_RE.test(messageText) && !hasNonUserOwnerMarker(messageText)) {
    return "PR open/not-merged handoff";
  }
  if (UNFINISHED_GIT_PR_HANDOFF_RE.test(messageText)) return "unfinished git/PR handoff";
  return "";
}

function parseNumberedOptions(messageText) {
  const options = [];
  const markers = [];
  let match;
  OPTION_MARKER_RE.lastIndex = 0;
  while ((match = OPTION_MARKER_RE.exec(messageText)) !== null) {
    markers.push({
      number: Number(match[2]),
      markerStart: match.index + match[1].length,
      textStart: OPTION_MARKER_RE.lastIndex,
    });
  }

  for (let i = 0; i < markers.length; i += 1) {
    const current = markers[i];
    const next = markers[i + 1];
    options.push({
      number: current.number,
      text: messageText.slice(current.textStart, next ? next.markerStart : undefined).trim(),
    });
  }

  return options;
}

function hasNumberedOptions(messageText) {
  return parseNumberedOptions(messageText).length >= 2;
}

function hasOpenLastOption(messageText) {
  const options = parseNumberedOptions(messageText);
  if (options.length === 0) return false;
  return OPEN_LAST_RE.test(options[options.length - 1].text);
}

function missingParts(messageText) {
  const missing = [];
  if (!hasCompleteHandoffLabels(messageText)) {
    for (const [key, label] of Object.entries({
      why: "為什麼停",
      ask: "要你做什麼",
      next: "回了會怎樣",
    })) {
      if (!hasLabel(messageText, key)) missing.push(label);
    }
  }
  if (!hasNumberedOptions(messageText)) missing.push("numbered options");
  if (!hasOpenLastOption(messageText)) missing.push("open-ended last option");
  return missing;
}

function blockMessage(trigger, missing) {
  return [
    "### Stop-Point Handoff Shape Gate 違規",
    "",
    `最後回覆看起來把球交給使用者（trigger: ${trigger}），但缺少合格的 user-facing handoff。`,
    "",
    `Missing: ${missing.join(", ")}`,
    "",
    "請把回覆最後改成這個形狀：",
    "",
    "為什麼停：<目前狀態 + blocker/dependency>",
    "要你做什麼（回數字）：",
    "1. 是，授權 AI 執行下一個具名動作",
    "2. 否，先停著",
    "3. 其他",
    "回了會怎樣：回 1 我會執行 <next AI-actionable step>；回 2 我等你；回 3 我照你的說明調整。",
    "",
    "Labels such as `Status:` / `Owner:` / `AskFirstPending:` and agent-facing hook text do not replace the user-facing numbered options.",
    "Per stop-point-comms.md + ai-autonomy.md §Stop-Point Next Step Contract.",
  ].join("\n");
}

export function checkStopPointHandoffShape({ messageText }) {
  if (!messageText || !messageText.trim()) {
    return { shouldBlock: false, message: "", trigger: "" };
  }

  if (isCommitMessageContext(messageText)) {
    return { shouldBlock: false, message: "", trigger: "" };
  }

  const trigger = detectUserOwnedStopMarker(messageText);
  if (!trigger) {
    return { shouldBlock: false, message: "", trigger: "" };
  }

  const missing = missingParts(messageText);
  if (missing.length === 0) {
    return { shouldBlock: false, message: "", trigger };
  }

  return {
    shouldBlock: true,
    message: blockMessage(trigger, missing),
    trigger,
  };
}

export {
  detectUserOwnedStopMarker,
  hasCompleteHandoffLabels,
  hasNumberedOptions,
  hasOpenLastOption,
  parseNumberedOptions,
};
