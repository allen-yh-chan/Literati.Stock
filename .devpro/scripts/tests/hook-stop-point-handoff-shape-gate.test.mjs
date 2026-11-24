import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkStopPointHandoffShape,
  detectUserOwnedStopMarker,
  hasCompleteHandoffLabels,
  hasNumberedOptions,
  hasOpenLastOption,
  parseNumberedOptions,
} from "../hooks/lib/stop-point-handoff-shape-gate.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

const GATE_SOURCE = ".devpro/scripts/hooks/lib/stop-point-handoff-shape-gate.mjs";

test("stop-point shape gate passes ordinary final responses", () => {
  const result = checkStopPointHandoffShape({
    messageText: "已完成修正並跑完 focused tests。",
  });

  assert.equal(result.shouldBlock, false);
  assert.equal(result.trigger, "");
});

test("stop-point shape gate blocks labels-only user-owned post-PR waits", () => {
  const result = checkStopPointHandoffShape({
    messageText: [
      "Status: blocked",
      "Blocker: builder refused pr_repository_mismatch; the PR head is in another repository",
      "Owner: user",
      "Next step: /devpro:cross-review <PR#> after the user decides",
      "Unblock condition: sticky verdict PASS or WARN",
    ].join("\n"),
  });

  assert.equal(result.shouldBlock, true);
  assert.match(result.message, /Stop-Point Handoff Shape Gate/);
  assert.match(result.message, /要你做什麼/);
  assert.match(result.message, /numbered options/);
});

test("stop-point shape gate passes the full user-facing handoff shape", () => {
  const messageText = [
    "為什麼停：PR 的 head 在別的 repo，builder 以 pr_repository_mismatch 拒絕，不會自動派第二審。",
    "要你做什麼（回數字）：",
    "1. 是，這張 cross-repo PR 由你決定怎麼處理，我照辦",
    "2. 否，先停在目前 PR",
    "3. 其他",
    "回了會怎樣：回 1 我照你的決定處理；回 2 我不做 write；回 3 我照你的說明調整。",
  ].join("\n");

  const result = checkStopPointHandoffShape({ messageText });

  assert.equal(result.shouldBlock, false);
  assert.equal(result.trigger, "stop-point handoff label");
  assert.equal(hasCompleteHandoffLabels(messageText), true);
  assert.equal(hasNumberedOptions(messageText), true);
  assert.equal(hasOpenLastOption(messageText), true);
});

test("stop-point shape gate accepts blockquote and bolded handoff labels", () => {
  const messageText = [
    "> **為什麼停**：目前缺 git write approval。",
    "> **要你做什麼（回數字）**：",
    "> **1.** 是，commit 並 push",
    "> **2.** 否，停在本地 diff",
    "> **3.** 其他",
    "> **回了會怎樣**：回 1 我會執行；回 2 我會等待；回 3 我照你的說明調整。",
  ].join("\n");

  const result = checkStopPointHandoffShape({ messageText });

  assert.equal(result.shouldBlock, false);
  assert.equal(hasCompleteHandoffLabels(messageText), true);
  assert.equal(hasNumberedOptions(messageText), true);
  assert.equal(hasOpenLastOption(messageText), true);
});

test("stop-point shape gate blocks handoffs whose last numbered option is not open-ended", () => {
  const result = checkStopPointHandoffShape({
    messageText: [
      "為什麼停：目前缺 git write approval。",
      "要你做什麼（回數字）：",
      "1. 是，commit 並 push",
      "2. 否，停在本地 diff",
      "回了會怎樣：回 1 我會執行；回 2 我會等待。",
    ].join("\n"),
  });

  assert.equal(result.shouldBlock, true);
  assert.match(result.message, /open-ended last option/);
});

test("stop-point shape gate does not ask again when owner is TL or reviewer", () => {
  const result = checkStopPointHandoffShape({
    messageText: [
      "Status: blocked",
      "Owner: TL/reviewer",
      "Next step: /devpro:cross-review <PR#>",
      "Unblock condition: reviewer sticky verdict PASS or WARN",
    ].join("\n"),
  });

  assert.equal(result.shouldBlock, false);
});

test("stop-point shape gate does not treat open PR not-merged as user-owned when owner is TL or reviewer", () => {
  const result = checkStopPointHandoffShape({
    messageText: [
      "Status: waiting",
      "Owner: TL/reviewer",
      "PR #1642 is open and not merged yet.",
      "Next step: reviewer sticky write-back after PASS or WARN.",
    ].join("\n"),
  });

  assert.equal(result.shouldBlock, false);
  assert.equal(result.trigger, "");
});

test("stop-point shape gate blocks PR-opened user-owned waits without numbered options", () => {
  const result = checkStopPointHandoffShape({
    messageText: "PR #1577 已建立，接著待你 review / merge。",
  });

  assert.equal(result.shouldBlock, true);
  assert.equal(result.trigger, "PR user-owned wait");
});

test("stop-point shape gate blocks open PR not-merged final handoffs without numbered options", () => {
  const result = checkStopPointHandoffShape({
    messageText: "PR #1642 已開，目前尚未 merge。Checks 綠，cross-model PASS。",
  });

  assert.equal(result.shouldBlock, true);
  assert.equal(result.trigger, "PR open/not-merged handoff");
});

test("stop-point shape gate blocks English open PR not-merged final handoffs without numbered options", () => {
  const result = checkStopPointHandoffShape({
    messageText: "PR #1642 is open and not merged yet. Checks are green and cross-model PASS.",
  });

  assert.equal(result.shouldBlock, true);
  assert.equal(result.trigger, "PR open/not-merged handoff");
});

test("stop-point shape gate blocks AskFirstPending footer-only endings", () => {
  const result = checkStopPointHandoffShape({
    messageText: [
      "測試已綠，branch 已準備好。",
      "AskFirstPending: git add/commit/push",
    ].join("\n"),
  });

  assert.equal(result.shouldBlock, true);
  assert.equal(result.trigger, "AskFirstPending");
});

test("stop-point shape gate blocks unfinished git PR handoff prose even with AskFirstPending none", () => {
  const result = checkStopPointHandoffShape({
    messageText: [
      "已完成修正並跑完 focused tests。",
      "尚未 commit / push / PR。",
      "[AskFirstPending: none]",
    ].join("\n"),
  });

  assert.equal(result.shouldBlock, true);
  assert.equal(result.trigger, "unfinished git/PR handoff");
});

test("stop-point shape gate does not trigger on explanatory prose without stop labels", () => {
  const result = checkStopPointHandoffShape({
    messageText:
      "stop-point-comms.md 的三個元素是「為什麼停 / 要你做什麼 / 回了會怎樣」。",
  });

  assert.equal(result.shouldBlock, false);
  assert.equal(detectUserOwnedStopMarker(result.message), "");
});

test("stop-point shape gate skips commit-message contexts", () => {
  const result = checkStopPointHandoffShape({
    messageText: [
      "git commit -m \"fix: enforce stop handoff\" -m \"Owner: user\"",
      "",
      "AskFirstPending: git add/commit/push",
    ].join("\n"),
  });

  assert.equal(result.shouldBlock, false);
});

test("stop-point option parser preserves numbered option order", () => {
  const options = parseNumberedOptions(
    "要你做什麼（回數字）： **1.** 是 **2.** 否 **3.** 其他",
  );

  assert.deepEqual(
    options.map((option) => option.number),
    [1, 2, 3],
  );
  assert.match(options[2].text, /其他/);
});

test("Stop hook wires the stop-point shape gate before the handoff cite gate", () => {
  const hook = read(".devpro/scripts/hooks/stop-handoff-cite.mjs");

  assert.match(hook, /checkStopPointHandoffShape/);
  assert.match(hook, /DEVPRO_DISABLE_STOP_POINT_HANDOFF_SHAPE_GATE/);
  assert.match(
    hook,
    /checkStopPointHandoffShape[\s\S]*checkHandoffCite/,
    "shape gate must run before the cite gate so user options are enforced first",
  );
});

// Scenario: Cross-Repo PR Blocked Response Is User-Owned
test("Cross-repo PR stop stays user-owned: Owner: user is classified by the existing owner detector and needs the stop-point-comms layer", () => {
  const crossRepoStop = [
    "Status: blocked",
    "Blocker: builder refused pr_repository_mismatch; the PR head is in another repository",
    "Owner: user",
    "Next step: decide how to handle the cross-repo PR",
  ].join("\n");

  const bare = checkStopPointHandoffShape({ messageText: crossRepoStop });
  assert.equal(bare.shouldBlock, true);
  assert.equal(bare.trigger, "Owner: user", "classified through the existing Owner: user detector");
  assert.match(bare.message, /要你做什麼/);
  assert.match(bare.message, /numbered options/);

  const lastNotOpen = checkStopPointHandoffShape({
    messageText: [
      crossRepoStop,
      "為什麼停：這張 PR 的 head 在別的 repo，builder 以 pr_repository_mismatch 拒絕。",
      "要你做什麼（回數字）：",
      "1. 是，這張 PR 由你處理",
      "2. 否，這張 PR 先不處理",
      "回了會怎樣：回 1 我等你處理；回 2 我先停著。",
    ].join("\n"),
  });
  assert.equal(lastNotOpen.shouldBlock, true);
  assert.match(lastNotOpen.message, /open-ended last option/);

  const full = checkStopPointHandoffShape({
    messageText: [
      crossRepoStop,
      "為什麼停：這張 PR 的 head 在別的 repo，builder 以 pr_repository_mismatch 拒絕。",
      "要你做什麼（回數字）：",
      "1. 是，這張 PR 由你處理",
      "2. 否，這張 PR 先不處理，由你決定是否走 waiver",
      "3. 其他",
      "回了會怎樣：回 1 我等你處理；回 2 我先停著；回 3 我照你的說明調整。",
    ].join("\n"),
  });
  assert.equal(full.shouldBlock, false);

  const askFirst = checkStopPointHandoffShape({
    messageText: ["這張 cross-repo PR 先問你。", "AskFirstPending: cross-repo PR pr_repository_mismatch"].join("\n"),
  });
  assert.equal(askFirst.shouldBlock, true);
  assert.equal(askFirst.trigger, "AskFirstPending");
});

// Cross-repo PR stop: owner detectors without a disclosure-specific class
test("Cross-repo PR stop stays user-owned (detectors): owner detectors cover Owner: user, AskFirstPending and the pr_repository_mismatch stop, with no disclosure-specific class", () => {
  const ownerUser = checkStopPointHandoffShape({ messageText: "Status: blocked\nOwner: user\nNext step: 回覆如何處理這張 cross-repo PR" });
  assert.equal(ownerUser.shouldBlock, true);
  assert.equal(ownerUser.trigger, "Owner: user");

  const inlineOwner = checkStopPointHandoffShape({ messageText: "這張 cross-repo PR 先問你（owner=user）。" });
  assert.equal(inlineOwner.shouldBlock, true);
  assert.equal(inlineOwner.trigger, "Owner: user");

  const crossRepo = checkStopPointHandoffShape({
    messageText: "Status: blocked\nBlocker: builder 拒絕 pr_repository_mismatch\nOwner: user",
  });
  assert.equal(crossRepo.shouldBlock, true);
  assert.equal(crossRepo.trigger, "Owner: user");

  // The retired ExternalDisclosureApproval wait pattern is gone: that token alone no longer marks a user-owned stop.
  for (const messageText of [
    "ExternalDisclosureApproval missing，待核准。",
    "Blocker: ExternalDisclosureApproval 缺。\nNext step: /devpro:cross-review <PR#>",
  ]) {
    assert.equal(detectUserOwnedStopMarker(messageText), "", messageText);
    assert.equal(checkStopPointHandoffShape({ messageText }).shouldBlock, false, messageText);
  }
  const source = read(GATE_SOURCE);
  assert.doesNotMatch(source, /disclosure/i, "no disclosure-specific detector remains in the gate source");

  // A TL-owned second-review dispatch is not a user-owned stop.
  const tlOwned = checkStopPointHandoffShape({ messageText: "Status: blocked\nOwner: TL/reviewer\nNext step: /devpro:cross-review <PR#>" });
  assert.equal(tlOwned.shouldBlock, false);
  assert.equal(tlOwned.trigger, "");
});
