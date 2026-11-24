import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertStickyBodyCredentialFree,
  credentialGateTelemetry,
  credentialLenBucket,
  extractCredentialDenyTokens,
  STICKY_CREDENTIAL_LITERAL_BLOCKED,
} from "../lib/second-review-sticky-credential-gate.mjs";

const SYNTH = "SYNTH_PWD_TEST_ONLY_9f3a";

test("T2(a) shape / JSON quoted / URL userinfo extract and block", () => {
  const shapeTokens = extractCredentialDenyTokens({
    materialTexts: [`Pwd=${SYNTH};`],
  });
  assert.ok(shapeTokens.some((t) => t.value === SYNTH && t.kind === "pwd" && t.source === "material"));

  const jsonTokens = extractCredentialDenyTokens({
    materialTexts: [`{"password":"${SYNTH}"}`],
  });
  assert.ok(jsonTokens.some((t) => t.value === SYNTH && t.kind === "password"));

  const urlTokens = extractCredentialDenyTokens({
    materialTexts: [`https://synthuser:${SYNTH}@db.example.internal/app`],
  });
  assert.ok(urlTokens.some((t) => t.value === SYNTH && t.kind === "url_userinfo"));
  assert.ok(urlTokens.some((t) => t.value === "synthuser" && t.kind === "url_userinfo"));

  const blocked = assertStickyBodyCredentialFree(
    `reason: leak Pwd=${SYNTH} in sticky`,
    { materialTexts: [] },
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.classification, STICKY_CREDENTIAL_LITERAL_BLOCKED);
  assert.equal(blocked.source, "shape");
});

test("T2(a2) quoted connection-string tail and XML attribute hit", () => {
  const conn = extractCredentialDenyTokens({
    materialTexts: [`Server=db;Pwd="${SYNTH}";Encrypt=true`],
  });
  assert.ok(conn.some((t) => t.value === SYNTH));

  const xml = extractCredentialDenyTokens({
    materialTexts: [`<login password="${SYNTH}" />`],
  });
  assert.ok(xml.some((t) => t.value === SYNTH));

  const hit = assertStickyBodyCredentialFree(`note ${SYNTH}`, {
    materialTexts: [`Pwd="${SYNTH}"`],
  });
  assert.equal(hit.ok, false);
});

test("T2(b) material and explicit deny list", () => {
  const materialHit = assertStickyBodyCredentialFree(`body has ${SYNTH}`, {
    materialTexts: [`uid=synth_uid_ok_99; password=${SYNTH}`],
  });
  assert.equal(materialHit.ok, false);
  assert.equal(materialHit.source, "material");

  const explicitHit = assertStickyBodyCredentialFree("admin token present", {
    explicitDenyList: ["admin"],
  });
  assert.equal(explicitHit.ok, false);
  assert.equal(explicitHit.source, "explicit");
  assert.equal(explicitHit.matched_token_kind, "explicit");
  assert.equal(explicitHit.len_bucket, "4-7");
});

test("T2(c) non-literal narrative ok", () => {
  const ok = assertStickyBodyCredentialFree(
    "WARN: password handling looks weak; rotate credentials in the secret store.",
    { materialTexts: ["no assignment shapes here"] },
  );
  assert.equal(ok.ok, true);
});

test("T2(d) empty values mint no tokens", () => {
  const tokens = extractCredentialDenyTokens({
    materialTexts: ["Pwd=", "password=''", 'password=""', "uid=   ;"],
  });
  assert.equal(tokens.length, 0);
});

test("T2(e) shape/material UTF-8 length <4 excluded", () => {
  const tokens = extractCredentialDenyTokens({
    materialTexts: ["Pwd=ab", "password=xy", "uid=1"],
  });
  assert.equal(tokens.length, 0);
});

test("T2(f) explicit short token edge-aware word-boundary", () => {
  const hit = assertStickyBodyCredentialFree("use ab as login", {
    explicitDenyList: ["ab"],
  });
  assert.equal(hit.ok, false);
  assert.equal(hit.len_bucket, "1-3");

  const embedded = assertStickyBodyCredentialFree("label cab end", {
    explicitDenyList: ["ab"],
  });
  assert.equal(embedded.ok, true);
});

test("T2(g) guid/uuid/fluid/password: required/identifiers not false-positive", () => {
  const ok = assertStickyBodyCredentialFree(
    [
      "guid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "uuid=11111111-2222-3333-4444-555555555555",
      "fluid layout",
      "password: required",
      "DB_PASSWORD_HELPER and MYSQL_PWD_HELPER are identifiers",
    ].join("\n"),
    { materialTexts: [] },
  );
  assert.equal(ok.ok, true);

  const extracted = extractCredentialDenyTokens({
    materialTexts: ["password: required", "DB_PASSWORD=should_not_extract_this_value"],
  });
  assert.equal(extracted.length, 0);
});

test("T2(g2) dictionary words do not false-hit longer identifiers", () => {
  assert.equal(
    assertStickyBodyCredentialFree("tests suite", { explicitDenyList: ["test"] }).ok,
    true,
  );
  assert.equal(
    assertStickyBodyCredentialFree("administrator account", { explicitDenyList: ["admin"] }).ok,
    true,
  );
  assert.equal(
    assertStickyBodyCredentialFree("postgresdb", { explicitDenyList: ["postgres"] }).ok,
    true,
  );
});

test("T2(g2b) later independent short token still hits after longer sibling", () => {
  const hit = assertStickyBodyCredentialFree("first tests then test alone", {
    explicitDenyList: ["test"],
  });
  assert.equal(hit.ok, false);
});

test("T2(g3) token abutting CJK / fullwidth still hits", () => {
  const hit = assertStickyBodyCredentialFree(`帳密${SYNTH}。`, {
    explicitDenyList: [SYNTH],
  });
  assert.equal(hit.ok, false);
});

test("T2(g4) non-word edges x!Tok#y must hit", () => {
  const tok = "!Tok#";
  const hit = assertStickyBodyCredentialFree("x!Tok#y", {
    explicitDenyList: [tok],
  });
  assert.equal(hit.ok, false);
});

test("T2(g5) markdown _TOKEN_ and TOKEN_old hit via alnum second pass", () => {
  const token = "SYNTHTOKENONLY";
  assert.equal(
    assertStickyBodyCredentialFree(`_${token}_`, { explicitDenyList: [token] }).ok,
    false,
  );
  assert.equal(
    assertStickyBodyCredentialFree(`${token}_old`, { explicitDenyList: [token] }).ok,
    false,
  );
});

test("T2(g6) token compare is case-sensitive", () => {
  assert.equal(
    assertStickyBodyCredentialFree("SecretValue", {
      explicitDenyList: ["secretvalue"],
    }).ok,
    true,
  );
  assert.equal(
    assertStickyBodyCredentialFree("SecretValue", {
      explicitDenyList: ["SecretValue"],
    }).ok,
    false,
  );
});

test("T2(g7) DB_PASSWORD=/MYSQL_PWD= do not auto-extract; explicit still hits", () => {
  const auto = extractCredentialDenyTokens({
    materialTexts: [`DB_PASSWORD=${SYNTH}`, `MYSQL_PWD=${SYNTH}`],
  });
  assert.equal(auto.length, 0);

  const hit = assertStickyBodyCredentialFree(`env has ${SYNTH}`, {
    materialTexts: [`DB_PASSWORD=${SYNTH}`],
    explicitDenyList: [SYNTH],
  });
  assert.equal(hit.ok, false);
  assert.equal(hit.source, "explicit");
});

test("T2(h) failure telemetry has no secret / hash / prefix; len_bucket includes 1-3", () => {
  const hit = assertStickyBodyCredentialFree(`x ${SYNTH} y`, {
    materialTexts: [`Pwd=${SYNTH}`],
  });
  assert.equal(hit.ok, false);
  const telemetry = credentialGateTelemetry(hit);
  const serialized = JSON.stringify(telemetry);
  assert.equal(serialized.includes(SYNTH), false);
  assert.doesNotMatch(serialized, /sha256|hash|prefix/i);
  assert.deepEqual(Object.keys(telemetry).sort(), [
    "classification",
    "len_bucket",
    "matched_token_kind",
    "source",
  ]);
  assert.equal(credentialLenBucket("ab"), "1-3");
  assert.equal(
    assertStickyBodyCredentialFree("zz ab zz", { explicitDenyList: ["ab"] }).len_bucket,
    "1-3",
  );
});

test("T2(i) account value equal to a public repository identifier does not block repo names; secrets still do", () => {
  // Connection string whose account equals the repository owner segment.
  const material = [`Server=db.example.internal;User Id=synthowner;Password=${SYNTH};`];
  const repositorySlug = "synthowner-tw/synthowner-agent-rules";
  const body = "Reviewed synthowner-tw/synthowner-agent-rules; see synthowner-agent-rules rule leaf.";

  // Without repository identity the account literal still blocks (unchanged default).
  const legacy = assertStickyBodyCredentialFree(body, { materialTexts: material });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.matched_token_kind, "user_id");

  // With repository identity, the public account literal no longer blocks.
  assert.equal(assertStickyBodyCredentialFree(body, { materialTexts: material, repositorySlug }).ok, true);
  // Case-insensitive identity match: account `SynthOwner` is the same public name.
  assert.equal(assertStickyBodyCredentialFree(body, {
    materialTexts: [`uid=SynthOwner;pwd=${SYNTH}`], repositorySlug,
  }).ok, true);
  // URL userinfo account segment is exempt the same way; its password is not.
  assert.equal(assertStickyBodyCredentialFree(body, {
    materialTexts: [`https://synthowner:${SYNTH}@db.example.internal/app`], repositorySlug,
  }).ok, true);

  // Password literal still blocks even with repository identity.
  const pwd = assertStickyBodyCredentialFree(`${body} leaked ${SYNTH}`, { materialTexts: material, repositorySlug });
  assert.equal(pwd.ok, false);
  assert.equal(pwd.matched_token_kind, "password");
  const urlPwd = assertStickyBodyCredentialFree(`${body} leaked ${SYNTH}`, {
    materialTexts: [`https://synthowner:${SYNTH}@db.example.internal/app`], repositorySlug,
  });
  assert.equal(urlPwd.ok, false);

  // A password that happens to equal a public identifier still blocks.
  const pwdEqualsOwner = assertStickyBodyCredentialFree(body, {
    materialTexts: ["User Id=someone;Password=synthowner;"], repositorySlug,
  });
  assert.equal(pwdEqualsOwner.ok, false);
  assert.equal(pwdEqualsOwner.matched_token_kind, "password");

  // An account that is NOT a public identifier still blocks.
  const privateAccount = assertStickyBodyCredentialFree("account synth_admin_x appears", {
    materialTexts: ["User Id=synth_admin_x;"], repositorySlug,
  });
  assert.equal(privateAccount.ok, false);
  assert.equal(privateAccount.matched_token_kind, "user_id");

  // Explicit deny list is never exempted.
  const explicit = assertStickyBodyCredentialFree(body, { explicitDenyList: ["synthowner"], repositorySlug });
  assert.equal(explicit.ok, false);
  assert.equal(explicit.source, "explicit");

  // Malformed slug grants no exemption.
  assert.equal(assertStickyBodyCredentialFree(body, { materialTexts: material, repositorySlug: "not a slug" }).ok, false);
});
