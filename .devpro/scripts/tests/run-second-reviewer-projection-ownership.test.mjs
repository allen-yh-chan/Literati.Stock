import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.DEVPRO_SECOND_REVIEWER_PROJECTION_TEST_GROUP = "ownership";

await import("./run-second-reviewer-projection.test.mjs");

const sharedAttemptLockPath = fileURLToPath(
  new URL("../lib/second-review-attempt-lock.mjs", import.meta.url),
);
const sharedAttemptLockExists = existsSync(sharedAttemptLockPath);
const sharedAttemptLock = sharedAttemptLockExists
  ? await import(pathToFileURL(sharedAttemptLockPath).href)
  : null;
const sharedPrimitiveOptions = { skip: !sharedAttemptLockExists };

function withTempDir(prefix, callback) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function validOwner(overrides = {}) {
  return {
    attempt_id: "attempt-shared-owner",
    pid: process.pid,
    created_at: "2026-07-27T00:00:00.000Z",
    owner_token: "shared-owner-token",
    ...overrides,
  };
}

test("attempt ownership is extracted to the shared primitive", () => {
  assert.equal(
    sharedAttemptLockExists,
    true,
    "missing shared primitive: .devpro/scripts/lib/second-review-attempt-lock.mjs",
  );
});

test("shared primitive preserves the exact lock path and ordered owner schema", sharedPrimitiveOptions, () => {
  withTempDir("second-review-shared-lock-schema-", (dir) => {
    const contextPath = path.join(dir, "observability-context.json");
    const expectedLockPath = `${path.resolve(contextPath)}.attempt.lock`;

    assert.equal(sharedAttemptLock.attemptLockPath(contextPath), expectedLockPath);
    const ownership = sharedAttemptLock.acquireAttemptOwnership(contextPath, "attempt-shared-schema");
    assert.equal(ownership.owned, true);
    assert.equal(ownership.lockPath, expectedLockPath);

    const ownerText = readFileSync(expectedLockPath, "utf8");
    const owner = JSON.parse(ownerText);
    assert.deepEqual(
      Object.keys(owner),
      ["attempt_id", "pid", "created_at", "owner_token"],
      "owner JSON key order is part of the shared runner/pruner contract",
    );
    assert.equal(owner.attempt_id, "attempt-shared-schema");
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.created_at, "string");
    assert.equal(typeof owner.owner_token, "string");
    assert.equal(ownerText.endsWith("\n"), true);
    assert.equal(sharedAttemptLock.releaseAttemptOwnership(ownership), true);
    assert.equal(existsSync(expectedLockPath), false);
  });
});

test("shared primitive preserves live, unknown, dead, and malformed owner classifications", sharedPrimitiveOptions, () => {
  withTempDir("second-review-shared-lock-state-", (dir) => {
    const contextPath = path.join(dir, "observability-context.json");
    const lockPath = sharedAttemptLock.attemptLockPath(contextPath);
    const cases = [
      {
        name: "live",
        content: `${JSON.stringify(validOwner())}\n`,
        signalOwner() {},
        ownerState: "live",
        classification: "projection_attempt_already_active",
      },
      {
        name: "unknown",
        content: `${JSON.stringify(validOwner())}\n`,
        signalOwner() {
          const error = new Error("liveness permission denied");
          error.code = "EPERM";
          throw error;
        },
        ownerState: "unknown",
        classification: "projection_attempt_already_active",
      },
      {
        name: "dead",
        content: `${JSON.stringify(validOwner())}\n`,
        signalOwner() {
          const error = new Error("owner is gone");
          error.code = "ESRCH";
          throw error;
        },
        ownerState: "dead",
        classification: "projection_attempt_recovery_required",
      },
      {
        name: "malformed",
        content: "not-json\n",
        signalOwner() {
          assert.fail("malformed owner must not reach the liveness probe");
        },
        ownerState: "malformed",
        classification: "projection_attempt_recovery_required",
      },
    ];

    for (const ownerCase of cases) {
      writeFileSync(lockPath, ownerCase.content, "utf8");
      const result = sharedAttemptLock.acquireAttemptOwnership(
        contextPath,
        `attempt-contender-${ownerCase.name}`,
        { signalOwner: ownerCase.signalOwner },
      );
      assert.equal(result.owned, false, ownerCase.name);
      assert.equal(result.ownerState, ownerCase.ownerState, ownerCase.name);
      assert.equal(result.classification, ownerCase.classification, ownerCase.name);
      assert.equal(readFileSync(lockPath, "utf8"), ownerCase.content, `${ownerCase.name} lock must not be stolen`);
      assert.equal(
        readdirSync(dir).some((entry) => entry.includes(".candidate-")),
        false,
        `${ownerCase.name} contender candidate must be cleaned`,
      );
      unlinkSync(lockPath);
    }
  });
});

test("shared primitive classifies an unsupported hard-link without publishing ownership", sharedPrimitiveOptions, () => {
  withTempDir("second-review-shared-link-unavailable-", (dir) => {
    const contextPath = path.join(dir, "observability-context.json");
    const lockPath = sharedAttemptLock.attemptLockPath(contextPath);
    const result = sharedAttemptLock.acquireAttemptOwnership(contextPath, "attempt-link-unavailable", {
      publishLink() {
        const error = new Error("hard links unsupported");
        error.code = "EOPNOTSUPP";
        throw error;
      },
    });

    assert.equal(result.owned, false);
    assert.equal(result.ownerState, "unknown");
    assert.equal(result.classification, "attempt_lock_primitive_unavailable");
    assert.equal(existsSync(lockPath), false);
    assert.equal(readdirSync(dir).some((entry) => entry.includes(".candidate-")), false);
  });
});

test("shared primitive release is owner-token safe before rename or unlink", sharedPrimitiveOptions, () => {
  withTempDir("second-review-shared-release-token-", (dir) => {
    const contextPath = path.join(dir, "observability-context.json");
    const ownership = sharedAttemptLock.acquireAttemptOwnership(contextPath, "attempt-release-owner");
    assert.equal(ownership.owned, true);
    const ownerBefore = readFileSync(ownership.lockPath, "utf8");
    let renameCalls = 0;
    let unlinkCalls = 0;

    const released = sharedAttemptLock.releaseAttemptOwnership({
      ...ownership,
      owner: { ...ownership.owner, owner_token: "not-the-owner-token" },
    }, {
      renamePath() { renameCalls += 1; },
      unlinkPath() { unlinkCalls += 1; },
    });

    assert.equal(released, false);
    assert.equal(renameCalls, 0);
    assert.equal(unlinkCalls, 0);
    assert.equal(readFileSync(ownership.lockPath, "utf8"), ownerBefore);
    assert.equal(sharedAttemptLock.releaseAttemptOwnership(ownership), true);
    assert.equal(existsSync(ownership.lockPath), false);
  });
});
