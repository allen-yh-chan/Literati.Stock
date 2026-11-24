/**
 * stdin.mjs
 *
 * Shared UTF-8 stdin reader for Claude Code hook JSON payloads.
 * Never rejects: I/O errors and timeouts resolve with already-buffered bytes.
 */

/**
 * Read UTF-8 bytes from stdin (or a test-only stream) with a timeout.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @param {NodeJS.ReadableStream} [opts.stream] test-only; defaults to process.stdin
 * @returns {Promise<string>} never rejects
 */
export async function readStdin({ timeoutMs = 5000, stream = process.stdin } = {}) {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    let timer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        stream.removeListener("error", onError);
        stream.removeListener("close", onEnd);
      } catch {
        // ignore cleanup failures
      }
      try {
        stream.on("error", () => {});
        if (typeof stream.pause === "function") stream.pause();
        if (typeof stream.destroy === "function" && !stream.destroyed) {
          stream.destroy();
        }
      } catch {
        // ignore cleanup failures
      }
      resolve(data);
    };

    function onData(chunk) {
      data += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    }
    function onEnd() {
      finish();
    }
    function onError() {
      finish();
    }

    try {
      if (typeof stream.setEncoding === "function") {
        stream.setEncoding("utf8");
      }
      stream.on("data", onData);
      stream.on("end", onEnd);
      stream.on("close", onEnd);
      stream.on("error", onError);
      timer = setTimeout(finish, timeoutMs);
      if (stream.readableEnded || stream.destroyed) {
        finish();
      }
    } catch {
      finish();
    }
  });
}
