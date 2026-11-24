/**
 * clarification-contract.test.mjs
 *
 * Executable negative/positive coverage for Clarification State + Seams
 * Confirmation (CRITICAL follow-up for strengthen-pre-change-clarification).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  analystDispatchGate,
  computeSeamsContentFingerprint,
  detectSensitiveHits,
  parseBulletFields,
  seamsExpansionAllowed,
  validateClarificationStateFields,
  validateMeetingNotesClarificationContracts,
  validateSeamsConfirmationFields,
} from "../lib/clarification-contract.mjs";

const CLARIFICATION_SOURCE_URL = new URL("../lib/clarification-contract.mjs", import.meta.url);

function moduleDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function loadClarificationWithClassifier(classifierBody) {
  const source = readFileSync(CLARIFICATION_SOURCE_URL, "utf8");
  const realPiiUrl = new URL("../lib/pii-pattern-contract.mjs", import.meta.url).href;
  const realFenceUrl = new URL("../lib/markdown-fence-aware.mjs", import.meta.url).href;
  const stub = moduleDataUrl(`
    export const PII_EMAIL_RE = /email/g;
    export const PII_EMAIL_ALLOW_RE = /allow/i;
    export const PII_UNIX_USERS_RE = /users/g;
    export const PII_UNIX_HOME_RE = /home/g;
    export const PII_WINDOWS_USERS_RE = /windows/gi;
    export { isValidHitResult } from ${JSON.stringify(realPiiUrl)};
    export function findPIIHits() { ${classifierBody} }
  `);
  let piiReplacements = 0;
  let fenceReplacements = 0;
  const substituted = source
    .replace(
      /(["'])\.\/pii-pattern-contract\.mjs\1/,
      () => {
        piiReplacements += 1;
        return JSON.stringify(stub);
      },
    )
    .replace(
      /(["'])\.\/markdown-fence-aware\.mjs\1/,
      () => {
        fenceReplacements += 1;
        return JSON.stringify(realFenceUrl);
      },
    );
  assert.equal(piiReplacements, 1, "clarification consumer must import the shared PII leaf exactly once");
  assert.equal(fenceReplacements, 1, "clarification consumer must import markdown-fence-aware exactly once");
  return import(`${moduleDataUrl(`${substituted}\n// fault-${Math.random()}`)}`);
}

function meetingNotes(clarification, seams) {
  const bullets = (fields) => Object.entries(fields)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
  return `# Meeting notes\n\n## Clarification State\n${bullets(clarification)}\n\n## Seams Confirmation\n${bullets(seams)}\n`;
}

function baseClarification(overrides = {}) {
  return {
    round: "1",
    extension_used: "false",
    round4_completed: "false",
    cap_hit: "false",
    cap_resolution: "none",
    cap_resolution_provenance: "none",
    frontier: "(empty)",
    unresolved: "(empty)",
    decisions: "(empty)",
    shared_understanding: "pending",
    shared_understanding_provenance: "none",
    terminal: "none",
    gaps_written: "false",
    ...overrides,
  };
}

function baseSeams(overrides = {}) {
  const merged = {
    seams: "grep round policy",
    confirmed: "true",
    provenance: "user",
    bypass: "none",
    bypass_reason: "",
    reconfirm_required: "false",
    invalidation_reason: "none",
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "seams_fingerprint")) {
    merged.seams_fingerprint = computeSeamsContentFingerprint(merged.seams);
  }
  return merged;
}

test("frontier bullet without provenance fails", () => {
  const v = validateClarificationStateFields(
    baseClarification({ frontier: "should we pin tip?" }),
  );
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /provenance/.test(e)));
});

test("missing/partial clarification state fails closed", () => {
  assert.equal(validateClarificationStateFields({}).ok, false);
  assert.equal(validateClarificationStateFields({ round: "1" }).ok, false);
  assert.equal(analystDispatchGate({}).allowed, false);
  assert.equal(analystDispatchGate({ round: "1" }).allowed, false);
});

test("Gate-P path + email allowlist + secret/transcript coverage", () => {
  assert.ok(detectSensitiveHits("contact allen@devpro.com.tw").includes("email-like"));
  assert.equal(detectSensitiveHits("ok user@example.com").includes("email-like"), false);
  assert.ok(detectSensitiveHits("see /Users/allen/proj").includes("unix-users-path"));
  assert.ok(detectSensitiveHits("see /home/allen/proj").includes("unix-home-path"));
  assert.ok(detectSensitiveHits(String.raw`C:\Users\Allen\secrets`).includes("windows-users-path"));
  assert.ok(detectSensitiveHits(String.raw`c:\users\allen\secrets`).includes("windows-users-path"));
  assert.ok(detectSensitiveHits("C:/Users/Allen/docs").includes("windows-users-path"));
  assert.ok(detectSensitiveHits(String.raw`D:\Users\Alice\docs`).includes("windows-users-path"));
  assert.ok(detectSensitiveHits("e:/Users/Bob/notes").includes("windows-users-path"));
  assert.ok(detectSensitiveHits(String.raw`F:\USERS\Carol\x`).includes("windows-users-path"));
  assert.ok(detectSensitiveHits(String.raw`g:\uSeRs\dave\y`).includes("windows-users-path"));
  assert.ok(detectSensitiveHits("token sk-abcdefghijklmnopqrstuvwxyz").includes("secret-like"));
  assert.ok(detectSensitiveHits("paste full transcript here").includes("transcript-like"));
});

test("clarification shared subset has exact parity with the shared classifier", async () => {
  let contract;
  try {
    contract = await import("../lib/pii-pattern-contract.mjs");
  } catch (error) {
    assert.fail(`shared PII contract must load: ${error.message}`);
  }
  const label = {
    email: "email-like",
    "unix-users-path": "unix-users-path",
    "unix-home-path": "unix-home-path",
    "windows-users-path": "windows-users-path",
  };
  for (const text of [
    "person@corp.dev",
    "/Users/Alice/work",
    "/home/bob/work",
    "D:/Users/Alice/work",
    String.raw`e:\uSeRs/Bob\work`,
    "user@example.com",
    "/Users/<name>",
    "clean text",
  ]) {
    const expected = contract.findPIIHits(text).map((hit) => label[hit.type]);
    assert.deepEqual(detectSensitiveHits(text), expected, text);
  }
});

test("clarification-only secret/transcript labels append only after valid shared results", () => {
  assert.deepEqual(
    detectSensitiveHits("token sk-abcdefghijklmnopqrstuvwxyz and paste full transcript here"),
    ["secret-like", "transcript-like"],
  );
});

test("shared classifier throw becomes a terminal singleton sentinel in every generic consumer", async () => {
  const faulted = await loadClarificationWithClassifier("throw new Error('classifier exploded');");
  assert.deepEqual(
    faulted.detectSensitiveHits("sk-abcdefghijklmnopqrstuvwxyz full transcript"),
    ["pii-classification-failure"],
  );

  const unknown = faulted.validateClarificationStateFields({
    ...baseClarification(),
    unexpected: "value",
  });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((error) => error.includes("pii-classification-failure")));

  const unrecognized = faulted.parseBulletFields("unrecognized content");
  assert.ok(unrecognized.errors.some((error) => error.includes("pii-classification-failure")));

  const forbidden = faulted.parseBulletFields("- __proto__: value");
  assert.ok(forbidden.errors.some((error) => error.includes("pii-classification-failure")));

  const clarification = faulted.validateClarificationStateFields(
    baseClarification({ frontier: "question (provenance: user)" }),
  );
  assert.equal(clarification.ok, false);
  assert.ok(clarification.errors.some((error) => error.includes("pii-classification-failure")));

  const seams = faulted.validateSeamsConfirmationFields(baseSeams());
  assert.equal(seams.ok, false);
  assert.ok(seams.errors.some((error) => error.includes("pii-classification-failure")));

  const notes = faulted.validateMeetingNotesClarificationContracts(
    meetingNotes(baseClarification(), baseSeams()),
  );
  assert.equal(notes.ok, false);
  assert.ok(notes.errors.some((error) =>
    /^(?:Clarification State|Seams Confirmation):.*pii-classification-failure/.test(error),
  ));
});

test("each generic error-consumer loop propagates classifier failure", async () => {
  const faulted = await loadClarificationWithClassifier(
    "if (String(arguments[0]).includes('fault-marker')) throw new Error('classifier exploded'); return [];",
  );
  const cases = [
    [
      "unknown field name",
      () => faulted.validateClarificationStateFields({
        ...baseClarification(),
        "fault-marker": "clean",
      }),
    ],
    [
      "unknown field value",
      () => faulted.validateClarificationStateFields({
        ...baseClarification(),
        unexpected: "fault-marker",
      }),
    ],
    ["unrecognized line", () => faulted.parseBulletFields("fault-marker")],
    ["forbidden field value", () => faulted.parseBulletFields("- __proto__: fault-marker")],
    [
      "clarification list item",
      () => faulted.validateClarificationStateFields(
        baseClarification({ frontier: "fault-marker (provenance: user)" }),
      ),
    ],
    [
      "seams bypass reason",
      () => faulted.validateSeamsConfirmationFields(baseSeams({
        confirmed: "false",
        bypass: "ask-first-recorded",
        bypass_reason: "fault-marker",
      })),
    ],
    [
      "seams description",
      () => faulted.validateSeamsConfirmationFields(baseSeams({ seams: "fault-marker" })),
    ],
    [
      "seams fingerprint",
      () => faulted.validateSeamsConfirmationFields(baseSeams({ seams_fingerprint: "fault-marker" })),
    ],
  ];

  for (const [name, validate] of cases) {
    const result = validate();
    assert.ok(
      result.errors.some((error) => error.includes("pii-classification-failure")),
      name,
    );
  }
});

test("every invalid shared result becomes the same terminal singleton sentinel", async () => {
  const invalidBodies = [
    "return null;",
    "return {};",
    "return [null];",
    "return [1];",
    "return [{}];",
    "return [{ type: 'unknown', match: 'x', placeholder: 'y' }];",
    "return [{ type: 1, match: 'a@b.dev', placeholder: '<user-email>' }];",
    "return [{ type: 'email', match: '', placeholder: '<user-email>' }];",
    "return [{ type: 'email', match: 'a@b.dev', placeholder: 'wrong' }];",
    "return [{ type: 'email', match: 'a@b.dev', placeholder: '<user-email>', extra: 'x' }];",
  ];
  for (const body of invalidBodies) {
    const faulted = await loadClarificationWithClassifier(body);
    assert.deepEqual(
      faulted.detectSensitiveHits("sk-abcdefghijklmnopqrstuvwxyz full transcript"),
      ["pii-classification-failure"],
      body,
    );
    const clarification = faulted.validateClarificationStateFields(
      baseClarification({ frontier: "question (provenance: user)" }),
    );
    assert.equal(clarification.ok, false, body);
    assert.ok(
      clarification.errors.some((error) => error.includes("pii-classification-failure")),
      body,
    );
    const seams = faulted.validateSeamsConfirmationFields(baseSeams({ seams: "fault target" }));
    assert.equal(seams.ok, false, body);
    assert.ok(
      seams.errors.some((error) => error.includes("pii-classification-failure")),
      body,
    );
    const notes = faulted.validateMeetingNotesClarificationContracts(
      meetingNotes(
        baseClarification({ frontier: "question (provenance: user)" }),
        baseSeams(),
      ),
    );
    assert.equal(notes.ok, false, body);
    assert.ok(
      notes.errors.some((error) =>
        /^(?:Clarification State|Seams Confirmation):.*pii-classification-failure/.test(error),
      ),
      body,
    );
  }
});

test("PII in frontier fail-closed", () => {
  const v = validateClarificationStateFields(
    baseClarification({
      frontier: "email allen@devpro.com.tw (provenance: user)",
    }),
  );
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /sensitive/.test(e)));
});

test("shared_understanding=confirmed with non-empty frontier requires user provenance", () => {
  const base = baseClarification({
    frontier: "lock round=batch (provenance: user)",
    decisions: "D-ROUND locked (provenance: user)",
    shared_understanding: "confirmed",
    shared_understanding_provenance: "none",
    terminal: "shared-understanding",
  });
  assert.equal(validateClarificationStateFields(base).ok, false);
  assert.equal(analystDispatchGate(base).allowed, false);

  const okFields = {
    ...base,
    shared_understanding_provenance: "user",
  };
  assert.equal(validateClarificationStateFields(okFields).ok, true);
  assert.equal(analystDispatchGate(okFields).allowed, true);
});

test("terminal=frontier-empty with non-empty frontier is fail-closed", () => {
  const fields = baseClarification({
    frontier: "still open (provenance: user)",
    terminal: "frontier-empty",
  });
  assert.equal(validateClarificationStateFields(fields).ok, false);
  assert.equal(analystDispatchGate(fields).allowed, false);
});

test("write-back failure without recorded abort blocks analyst", () => {
  const fields = baseClarification({ frontier: "(empty)", terminal: "frontier-empty" });
  assert.equal(
    analystDispatchGate(fields, { writeBackFailed: true, writeBackAbortRecorded: false })
      .allowed,
    false,
  );
  assert.equal(
    analystDispatchGate(fields, { writeBackFailed: true, writeBackAbortRecorded: true })
      .allowed,
    false,
  );
});

test("cap_hit unresolved blocks even when shared_understanding confirmed", () => {
  const fields = baseClarification({
    round: "3",
    cap_hit: "true",
    frontier: "still open (provenance: user)",
    unresolved: "UNRESOLVED: x (provenance: user)",
    shared_understanding: "confirmed",
    shared_understanding_provenance: "user",
    terminal: "shared-understanding",
  });
  assert.equal(analystDispatchGate(fields).allowed, false);
});

test("derived cap-hit: round>=3 + non-empty frontier blocks even when cap_hit=false", () => {
  const fields = baseClarification({
    round: "3",
    cap_hit: "false",
    cap_resolution: "none",
    frontier: "still open (provenance: user)",
    shared_understanding: "confirmed",
    shared_understanding_provenance: "user",
    terminal: "shared-understanding",
  });
  assert.equal(validateClarificationStateFields(fields).ok, false);
  assert.ok(
    validateClarificationStateFields(fields).errors.some((e) =>
      /cap_hit=true|cap_resolution/.test(e),
    ),
  );
  assert.equal(analystDispatchGate(fields).allowed, false);
});

test("round=4 without recorded extension is fail-closed", () => {
  const fields = baseClarification({
    round: "4",
    extension_used: "false",
    cap_hit: "true",
    cap_resolution: "none",
    frontier: "(empty)",
    terminal: "frontier-empty",
  });
  assert.equal(validateClarificationStateFields(fields).ok, false);
  assert.ok(
    validateClarificationStateFields(fields).errors.some((e) =>
      /round=4 requires extension_used/.test(e),
    ),
  );
  assert.equal(analystDispatchGate(fields).allowed, false);
});

test("cap_resolution=split cannot fall through to frontier-empty allow", () => {
  const fields = baseClarification({
    round: "3",
    cap_hit: "true",
    cap_resolution: "split",
    cap_resolution_provenance: "user",
    frontier: "(empty)",
    shared_understanding: "confirmed",
    shared_understanding_provenance: "user",
    terminal: "none",
  });
  const gate = analystDispatchGate(fields);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /split/);
});

test("carry-gaps without terminal=carry-gaps is fail-closed", () => {
  const fields = baseClarification({
    round: "3",
    cap_hit: "true",
    cap_resolution: "carry-gaps",
    cap_resolution_provenance: "user",
    frontier: "left (provenance: user)",
    unresolved: "UNRESOLVED: left deferred to Non-goals (provenance: user)",
    terminal: "none",
    gaps_written: "true",
  });
  assert.equal(analystDispatchGate(fields).allowed, false);
  const ok = { ...fields, terminal: "carry-gaps" };
  assert.equal(validateClarificationStateFields(ok).ok, true);
  assert.equal(analystDispatchGate(ok).allowed, true);
});

test("carry-gaps with empty unresolved is fail-closed despite gaps_written", () => {
  const fields = baseClarification({
    round: "3",
    cap_hit: "true",
    cap_resolution: "carry-gaps",
    cap_resolution_provenance: "user",
    frontier: "still open (provenance: user)",
    unresolved: "(empty)",
    terminal: "carry-gaps",
    gaps_written: "true",
  });
  assert.equal(validateClarificationStateFields(fields).ok, false);
  assert.ok(
    validateClarificationStateFields(fields).errors.some((e) =>
      /durable gap evidence|unresolved/.test(e),
    ),
  );
  assert.equal(analystDispatchGate(fields).allowed, false);
  assert.match(
    analystDispatchGate(fields).reason,
    /durable unresolved|invalid clarification/,
  );
});

test("bypass=ask-first-recorded requires non-empty bypass_reason", () => {
  const bad = validateSeamsConfirmationFields(
    baseSeams({
      confirmed: "false",
      bypass: "ask-first-recorded",
      bypass_reason: "",
    }),
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /bypass_reason/.test(e)));

  const unconfirmedNoBypass = validateSeamsConfirmationFields(
    baseSeams({ confirmed: "false", bypass: "none", bypass_reason: "" }),
  );
  assert.equal(unconfirmedNoBypass.ok, false);

  const emptySeams = validateSeamsConfirmationFields(
    baseSeams({ seams: "(empty)", confirmed: "true", reconfirm_required: "false" }),
  );
  assert.equal(emptySeams.ok, false);
  assert.ok(emptySeams.errors.some((e) => /non-empty observable/.test(e)));
  assert.equal(
    seamsExpansionAllowed(
      baseSeams({ seams: "(empty)", confirmed: "true", reconfirm_required: "false" }),
    ).allowed,
    false,
  );

  const pendingReconfirm = validateSeamsConfirmationFields(
    baseSeams({
      confirmed: "false",
      bypass: "none",
      bypass_reason: "",
      reconfirm_required: "true",
      invalidation_reason: "frontier-change",
    }),
  );
  assert.equal(pendingReconfirm.ok, true, pendingReconfirm.errors.join("; "));
  assert.equal(
    seamsExpansionAllowed(
      baseSeams({
        confirmed: "false",
        bypass: "none",
        bypass_reason: "",
        reconfirm_required: "true",
        invalidation_reason: "frontier-change",
      }),
    ).allowed,
    false,
  );

  const good = validateSeamsConfirmationFields(
    baseSeams({
      confirmed: "false",
      bypass: "ask-first-recorded",
      bypass_reason: "user approved seams via AskUserQuestion batch 1",
    }),
  );
  assert.equal(good.ok, true);
});

test("missing Clarification/Seams sections fail closed", () => {
  const v = validateMeetingNotesClarificationContracts("# notes\n\n## Source\n- x\n");
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /Clarification State/.test(e)));
  assert.ok(v.errors.some((e) => /Seams Confirmation/.test(e)));
});

test("extend without extension_used=true is fail-closed", () => {
  const fields = baseClarification({
    round: "4",
    extension_used: "false",
    round4_completed: "true",
    cap_hit: "true",
    cap_resolution: "extend",
    cap_resolution_provenance: "user",
    frontier: "(empty)",
    terminal: "frontier-empty",
  });
  assert.equal(validateClarificationStateFields(fields).ok, false);
  assert.equal(analystDispatchGate(fields).allowed, false);
  const ok = { ...fields, extension_used: "true" };
  assert.equal(validateClarificationStateFields(ok).ok, true);
  assert.equal(analystDispatchGate(ok).allowed, true);
});

test("round4_completed on round=3 cannot bypass absolute-max extend gate", () => {
  const fields = baseClarification({
    round: "3",
    extension_used: "true",
    round4_completed: "true",
    cap_hit: "true",
    cap_resolution: "extend",
    cap_resolution_provenance: "user",
    frontier: "(empty)",
    terminal: "frontier-empty",
  });
  assert.equal(validateClarificationStateFields(fields).ok, false);
  assert.ok(
    validateClarificationStateFields(fields).errors.some((e) =>
      /round4_completed=true requires round=4/.test(e),
    ),
  );
  assert.equal(analystDispatchGate(fields).allowed, false);
});

test("round=4 extend without recorded cap_hit=true is fail-closed", () => {
  const fields = baseClarification({
    round: "4",
    extension_used: "true",
    round4_completed: "true",
    cap_hit: "false",
    cap_resolution: "extend",
    cap_resolution_provenance: "user",
    frontier: "(empty)",
    terminal: "frontier-empty",
  });
  assert.equal(validateClarificationStateFields(fields).ok, false);
  assert.ok(
    validateClarificationStateFields(fields).errors.some((e) =>
      /cap_hit=true.*working-cap|recorded working-cap/.test(e),
    ),
  );
  assert.equal(analystDispatchGate(fields).allowed, false);
});

test("parseBulletFields rejects duplicates and unrecognized sensitive lines", () => {
  const dup = parseBulletFields("- round: 1\n- round: 2\n- extension_used: false");
  assert.ok(dup.errors.some((e) => /duplicate field: round/.test(e)));

  const hidden = parseBulletFields(
    "- round: 1\nsee /Users/allen/secret\n- extension_used: false",
  );
  assert.ok(hidden.errors.some((e) => /unrecognized line/.test(e)));
  assert.ok(hidden.errors.some((e) => /sensitive/.test(e)));
});

test("parseBulletFields rejects __proto__/constructor/prototype (no inherited-setter bypass)", () => {
  const proto = parseBulletFields(
    "- __proto__: polluted\n- round: 1\n- contact: allen@devpro.com.tw",
  );
  assert.ok(proto.errors.some((e) => /forbidden field name: __proto__/.test(e)));
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.getPrototypeOf(proto.fields), null);
  assert.equal(Object.prototype.hasOwnProperty.call(proto.fields, "__proto__"), false);

  const ctor = parseBulletFields("- constructor: x\n- prototype: y");
  assert.ok(ctor.errors.some((e) => /forbidden field name: constructor/.test(e)));
  assert.ok(ctor.errors.some((e) => /forbidden field name: prototype/.test(e)));

  // Sensitive payload on forbidden key must still be reported
  const pii = parseBulletFields("- __proto__: see /Users/allen/secret");
  assert.ok(pii.errors.some((e) => /forbidden field name: __proto__/.test(e)));
  assert.ok(pii.errors.some((e) => /sensitive/.test(e)));
});

test("unknown clarification/seams fields fail closed (incl. PII payload)", () => {
  const clar = validateClarificationStateFields(
    baseClarification({ contact_email: "allen@devpro.com.tw" }),
  );
  assert.equal(clar.ok, false);
  assert.ok(clar.errors.some((e) => /unknown field: contact_email/.test(e)));
  assert.ok(clar.errors.some((e) => /sensitive email-like/.test(e)));

  const seams = validateSeamsConfirmationFields(
    baseSeams({ notes: String.raw`D:\USERS\Alice\x` }),
  );
  assert.equal(seams.ok, false);
  assert.ok(seams.errors.some((e) => /unknown field: notes/.test(e)));
  assert.ok(seams.errors.some((e) => /sensitive/.test(e)));
});

test("duplicate Clarification/Seams sections fail closed", () => {
  const md = `# notes

## Clarification State
- round: 1
- extension_used: false
- round4_completed: false
- cap_hit: false
- cap_resolution: none
- cap_resolution_provenance: none
- frontier: (empty)
- unresolved: (empty)
- decisions: (empty)
- shared_understanding: pending
- shared_understanding_provenance: none
- terminal: none
- gaps_written: false

## Clarification State
- round: 2
- extension_used: false
- round4_completed: false
- cap_hit: false
- cap_resolution: none
- cap_resolution_provenance: none
- frontier: (empty)
- unresolved: (empty)
- decisions: (empty)
- shared_understanding: pending
- shared_understanding_provenance: none
- terminal: none
- gaps_written: false

## Seams Confirmation
- seams: grep only
- confirmed: true
- provenance: user
- bypass: none
- bypass_reason:
- seams_fingerprint: fp1
- reconfirm_required: false
- invalidation_reason: none
`;
  const v = validateMeetingNotesClarificationContracts(md);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /duplicate ## Clarification State/.test(e)));
});

test("stale extension_used=true without cap_resolution=extend fails closed", () => {
  const fields = baseClarification({
    extension_used: "true",
    cap_hit: "false",
    cap_resolution: "none",
    frontier: "(empty)",
    terminal: "frontier-empty",
  });
  assert.equal(validateClarificationStateFields(fields).ok, false);
  assert.ok(
    validateClarificationStateFields(fields).errors.some((e) =>
      /extension_used=true requires cap_resolution=extend/.test(e),
    ),
  );
  assert.equal(analystDispatchGate(fields).allowed, false);
  assert.match(analystDispatchGate(fields).reason, /extension_used=true requires cap_resolution=extend/);
});

test("confirmed=true + reconfirm_required blocks seams expansion", () => {
  const stale = baseSeams({
    confirmed: "true",
    reconfirm_required: "true",
    invalidation_reason: "frontier-change",
  });
  assert.equal(validateSeamsConfirmationFields(stale).ok, false);
  assert.equal(seamsExpansionAllowed(stale).allowed, false);

  const waiting = baseSeams({
    confirmed: "false",
    bypass: "ask-first-recorded",
    bypass_reason: "awaiting reconfirm after frontier-change",
    reconfirm_required: "true",
    invalidation_reason: "frontier-change",
  });
  assert.equal(validateSeamsConfirmationFields(waiting).ok, true);
  assert.equal(seamsExpansionAllowed(waiting).allowed, false);
  assert.match(seamsExpansionAllowed(waiting).reason, /reconfirm_required/);

  const pendingNoBypass = baseSeams({
    confirmed: "false",
    bypass: "none",
    bypass_reason: "",
    reconfirm_required: "true",
    invalidation_reason: "seams-change",
  });
  assert.equal(validateSeamsConfirmationFields(pendingNoBypass).ok, true);
  assert.equal(seamsExpansionAllowed(pendingNoBypass).allowed, false);

  const ok = baseSeams({
    confirmed: "true",
    reconfirm_required: "false",
    invalidation_reason: "none",
  });
  assert.equal(validateSeamsConfirmationFields(ok).ok, true);
  assert.equal(seamsExpansionAllowed(ok).allowed, true);
});

test("seams_fingerprint must bind to sha256(canonical(seams)) (#2480)", () => {
  const seams = "observable done-when A; observable done-when B";
  const matching = baseSeams({
    seams,
    seams_fingerprint: computeSeamsContentFingerprint(seams),
  });
  assert.equal(validateSeamsConfirmationFields(matching).ok, true);
  assert.equal(seamsExpansionAllowed(matching).allowed, true);

  const freeText = baseSeams({
    seams,
    seams_fingerprint: "legacy-label-v1",
  });
  assert.equal(validateSeamsConfirmationFields(freeText).ok, false);
  assert.ok(
    validateSeamsConfirmationFields(freeText).errors.some((e) =>
      /sha256\(canonical\(seams\)\)/.test(e) &&
        /MUST NOT only recompute the hash/.test(e) &&
        /reconfirm_required=true/.test(e),
    ),
  );
  assert.equal(seamsExpansionAllowed(freeText).allowed, false);
  assert.match(seamsExpansionAllowed(freeText).reason, /invalid seams confirmation/);

  // Seams edited while fingerprint left stale — same fail-closed as forgetting reconfirm.
  const drifted = baseSeams({
    seams: "new seam after silent edit",
    seams_fingerprint: computeSeamsContentFingerprint("old seam before edit"),
    confirmed: "true",
    reconfirm_required: "false",
  });
  assert.equal(validateSeamsConfirmationFields(drifted).ok, false);
  assert.equal(seamsExpansionAllowed(drifted).allowed, false);

  // Canonicalization: trailing spaces / CRLF must not create a second identity.
  const crlf = "line-a\r\nline-b  ";
  const lf = "line-a\nline-b";
  assert.equal(
    computeSeamsContentFingerprint(crlf),
    computeSeamsContentFingerprint(lf),
  );
});

test("seams and bypass_reason reject PII/secret/path", () => {
  const badSeams = validateSeamsConfirmationFields(
    baseSeams({ seams: "see /Users/allen/notes" }),
  );
  assert.equal(badSeams.ok, false);
  assert.ok(badSeams.errors.some((e) => /sensitive/.test(e)));

  const badBypass = validateSeamsConfirmationFields(
    baseSeams({
      confirmed: "false",
      bypass: "ask-first-recorded",
      bypass_reason: "token sk-abcdefghijklmnopqrstuvwxyz approved",
    }),
  );
  assert.equal(badBypass.ok, false);
  assert.ok(badBypass.errors.some((e) => /bypass_reason.*sensitive/.test(e)));

  const badFpFields = baseSeams({ seams_fingerprint: String.raw`D:\USERS\Alice\fp` });
  assert.equal(validateSeamsConfirmationFields(badFpFields).ok, false);
  assert.ok(
    validateSeamsConfirmationFields(badFpFields).errors.some((e) =>
      /seams_fingerprint.*sensitive/.test(e),
    ),
  );
  assert.equal(seamsExpansionAllowed(badFpFields).allowed, false);
});

test("meeting-notes dogfood sections parse + validate", () => {
  const seams =
    "mechanical grep for cap 3/4; lexicon _Avoid_; Synthesis UNRESOLVED; Seams Confirmation schema";
  const md = `# notes

## Clarification State
- round: 1
- extension_used: false
- round4_completed: false
- cap_hit: false
- cap_resolution: none
- cap_resolution_provenance: none
- frontier: (empty)
- unresolved: (empty)
- decisions: D-ROUND batch≠question (provenance: user)
- shared_understanding: confirmed
- shared_understanding_provenance: user
- terminal: shared-understanding
- gaps_written: false

## Seams Confirmation
- seams: ${seams}
- confirmed: true
- provenance: user
- bypass: none
- bypass_reason:
- seams_fingerprint: ${computeSeamsContentFingerprint(seams)}
- reconfirm_required: false
- invalidation_reason: none
`;
  const v = validateMeetingNotesClarificationContracts(md);
  assert.equal(v.ok, true, v.errors.join("; "));
});
