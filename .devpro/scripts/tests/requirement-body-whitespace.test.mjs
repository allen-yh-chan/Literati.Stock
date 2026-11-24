import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRequirementBodyWhitespace,
  requirementBodiesPromotionEqual,
  findUnmappedPromotionTitles,
} from "../lib/requirement-body-whitespace.mjs";

describe("#2592 normalizeRequirementBodyWhitespace (D4/F3)", () => {
  it("0↔1 blank-line insert/delete are equivalent after normalize", () => {
    const zero = "The stable requirement SHALL remain.\n#### Scenario: S\n- **WHEN** a\n- **THEN** b";
    const one = "The stable requirement SHALL remain.\n\n#### Scenario: S\n- **WHEN** a\n- **THEN** b";
    const many = "The stable requirement SHALL remain.\n\n\n\n#### Scenario: S\n\n- **WHEN** a\n- **THEN** b";
    assert.equal(normalizeRequirementBodyWhitespace(zero), normalizeRequirementBodyWhitespace(one));
    assert.equal(normalizeRequirementBodyWhitespace(one), normalizeRequirementBodyWhitespace(many));
    assert.equal(requirementBodiesPromotionEqual(zero, one, { exact: false }), true);
  });

  it("trailing horizontal whitespace is ignored for non-delta compare", () => {
    const base = "The stable requirement SHALL remain.";
    const trailed = "The stable requirement SHALL remain.  \t";
    assert.equal(requirementBodiesPromotionEqual(base, trailed, { exact: false }), true);
    assert.equal(requirementBodiesPromotionEqual(base, trailed, { exact: true }), false);
  });

  it("indentation change is still a semantic mismatch", () => {
    const base = "The stable requirement SHALL remain.\n#### Scenario: S";
    const indented = "The stable requirement SHALL remain.\n  #### Scenario: S";
    assert.equal(requirementBodiesPromotionEqual(base, indented, { exact: false }), false);
  });

  it("token / SHALL-MUST change is still a semantic mismatch", () => {
    const base = "The stable requirement SHALL remain.";
    const token = "The stable requirement MUST remain.";
    assert.equal(requirementBodiesPromotionEqual(base, token, { exact: false }), false);
  });

  it("delta titles keep exact body equality", () => {
    const a = "Body\n\nwith blanks.";
    const b = "Body\nwith blanks.";
    assert.equal(requirementBodiesPromotionEqual(a, b, { exact: true }), false);
  });

  it("findUnmappedPromotionTitles: non-delta blank-line drift is not unmapped", () => {
    const stable = "Stable SHALL stay.\n\n#### Scenario: S\n- **THEN** ok";
    const drifted = "Stable SHALL stay.\n#### Scenario: S\n- **THEN** ok";
    const deltaBody = "Delta SHALL change.\n#### Scenario: D\n- **THEN** new";
    const mismatched = findUnmappedPromotionTitles({
      expectedMap: new Map([
        ["Stable Req", stable],
        ["Delta Req", deltaBody],
      ]),
      postMap: new Map([
        ["Stable Req", drifted],
        ["Delta Req", deltaBody],
      ]),
      deltaTitles: new Set(["Delta Req"]),
    });
    assert.deepEqual(mismatched, []);
  });

  it("findUnmappedPromotionTitles: non-delta indent/token still unmapped; delta exact enforced", () => {
    const stable = "Stable SHALL stay.";
    const indented = "  Stable SHALL stay.";
    const deltaExact = "Delta body\n\nwith blank.";
    const deltaDrifted = "Delta body\nwith blank.";
    const indentMismatch = findUnmappedPromotionTitles({
      expectedMap: new Map([["Stable Req", stable]]),
      postMap: new Map([["Stable Req", indented]]),
      deltaTitles: new Set(),
    });
    assert.deepEqual(indentMismatch, ["Stable Req"]);

    const deltaMismatch = findUnmappedPromotionTitles({
      expectedMap: new Map([["Delta Req", deltaExact]]),
      postMap: new Map([["Delta Req", deltaDrifted]]),
      deltaTitles: new Set(["Delta Req"]),
    });
    assert.deepEqual(deltaMismatch, ["Delta Req"]);
  });
});
