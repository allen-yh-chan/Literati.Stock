/**
 * projection-io.mjs
 *
 * Shared JSON write + activity-log appenders for second-reviewer projection
 * scripts. The activity script field name is parameterized per caller.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { nowIso as defaultNowIso } from "./primitives.mjs";

export function writeJson(filePath, value) {
  if (!filePath) return;
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function createActivityAppender({ scriptField, scriptValue, now = defaultNowIso }) {
  return function appendActivity(context, event, payload = {}) {
    if (!context?.activity_log_path) return;
    appendFileSync(
      context.activity_log_path,
      `${JSON.stringify({
        event,
        attempt_id: context.attempt_id,
        generated_at: now(),
        [scriptField]: scriptValue,
        ...payload,
      })}\n`,
      "utf8"
    );
  };
}
