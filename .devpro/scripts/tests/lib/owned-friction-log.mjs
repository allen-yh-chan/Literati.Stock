import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A hook that blocks appends to DEVPRO_FRICTION_LOG. hooks/lib/friction-log.mjs binds that path when it is first
 * imported and falls back to the live hooks/state/session-friction.log when the variable is unset or empty. The
 * suite runner injects an owned log into every test child, so running a file alone with `node --test` is the only
 * way to reach the live log.
 *
 * Import this module for its side effect, as the first non-builtin import of a test file that drives a hook, so the
 * variable is set before any hook module loads (an in-process hook call reads the path bound at import time, a
 * spawned hook inherits the variable). The temp directory is removed when the process exits. A non-empty value that
 * is already set, such as the one the suite runner injects, is left untouched.
 */
function ownFrictionLogWhenUnset() {
  const current = process.env.DEVPRO_FRICTION_LOG;
  if (typeof current === "string" && current !== "") return;
  const dir = mkdtempSync(path.join(os.tmpdir(), "devpro-test-friction-"));
  process.env.DEVPRO_FRICTION_LOG = path.join(dir, "session-friction.log");
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
}

ownFrictionLogWhenUnset();
