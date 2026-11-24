// Reject duplicate object keys before validating review evidence.
export function parseJsonDuplicateAware(text) {
  let index = 0;

  function fail(message) {
    throw new Error(`${message} at JSON byte-character offset ${index}`);
  }

  function skipWhitespace() {
    while (/[\t\n\r ]/.test(text[index] ?? "")) index += 1;
  }

  function parseString() {
    if (text[index] !== '"') fail("expected JSON string");
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code < 0x20) fail("unescaped control character in JSON string");
      if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (text[index] === "\\") {
        index += 1;
        if (index >= text.length) fail("unterminated JSON escape");
        if (text[index] === "u") {
          const digits = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail("invalid JSON unicode escape");
          index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/.test(text[index])) fail("invalid JSON escape");
      }
      index += 1;
    }
    fail("unterminated JSON string");
  }

  function parseNumber() {
    const match = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) fail("invalid JSON number");
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("non-finite JSON number");
    return value;
  }

  function parseArray() {
    const value = [];
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return value;
    }
    while (index < text.length) {
      value.push(parseValue());
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return value;
      }
      if (text[index] !== ",") fail("expected comma in JSON array");
      index += 1;
      skipWhitespace();
    }
    fail("unterminated JSON array");
  }

  function parseObject() {
    const value = {};
    const seen = new Set();
    index += 1;
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return value;
    }
    while (index < text.length) {
      const key = parseString();
      if (seen.has(key)) fail(`duplicate JSON object key: ${key}`);
      seen.add(key);
      skipWhitespace();
      if (text[index] !== ":") fail("expected colon after JSON object key");
      index += 1;
      value[key] = parseValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return value;
      }
      if (text[index] !== ",") fail("expected comma in JSON object");
      index += 1;
      skipWhitespace();
    }
    fail("unterminated JSON object");
  }

  function parseValue() {
    skipWhitespace();
    if (text[index] === '"') return parseString();
    if (text[index] === "{") return parseObject();
    if (text[index] === "[") return parseArray();
    if (text.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    return parseNumber();
  }

  const value = parseValue();
  skipWhitespace();
  if (index !== text.length) fail("trailing content after JSON value");
  return value;
}
