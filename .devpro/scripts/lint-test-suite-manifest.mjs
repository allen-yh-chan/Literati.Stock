#!/usr/bin/env node
/**
 * lint-test-suite-manifest.mjs
 *
 * Mechanical gate for test-suite-manifest.mjs:
 * - every *.test.mjs on disk appears exactly once in MANIFEST
 * - no manifest entries for missing files
 * - integration tier files must execute an integration signal
 * - unit tier files must not execute an integration signal
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MANIFEST,
  SUITE_DIR,
  TIER_INTEGRATION,
  TIER_UNIT,
} from "./test-suite-manifest.mjs";

const CHILD_PROCESS_CALLS = new Set([
  "execFile",
  "execFileSync",
  "execSync",
  "spawn",
  "spawnSync",
]);

const TRUSTED_FIXTURE_EXPORTS_BY_MODULE = new Map([
  ["lib/git.mjs", new Set(["git", "initRepo", "tryGit"])],
  ["lib/sync-agent-rules-harness.mjs", new Set(["createConsumerRepo", "withConsumerRepo"])],
  ["lib/cli.mjs", new Set(["runCli"])],
  ["lib/hook-harness.mjs", new Set(["runHook"])],
]);

const FIXTURE_CALLS = new Set(
  [...TRUSTED_FIXTURE_EXPORTS_BY_MODULE.values()].flatMap((exports) => [...exports]),
);

const TEMP_FIXTURE_CALLS = new Set([
  "makeTempDir",
  "mkdtempSync",
  "withTempDir",
]);

function isRegexStart(code, index) {
  let previous = index - 1;
  while (previous >= 0 && /\s/u.test(code[previous])) previous -= 1;
  if (previous < 0) return true;
  if (/[[({=,:;!?&|+*%^~<>-]/u.test(code[previous])) return true;

  const prefix = code.slice(0, previous + 1);
  return /\b(?:case|delete|in|instanceof|new|return|throw|typeof|void|yield)\s*$/u.test(
    prefix,
  );
}

function maskNonExecutableSyntax(content) {
  const masked = content.split("");
  const blank = (index) => {
    if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
  };

  const maskLineComment = (start) => {
    blank(start);
    blank(start + 1);
    let index = start + 2;
    while (index < content.length && content[index] !== "\n") {
      blank(index);
      index += 1;
    }
    return index - 1;
  };

  const maskBlockComment = (start) => {
    blank(start);
    blank(start + 1);
    let index = start + 2;
    while (index < content.length) {
      if (content[index] === "*" && content[index + 1] === "/") {
        blank(index);
        blank(index + 1);
        return index + 1;
      }
      blank(index);
      index += 1;
    }
    return content.length - 1;
  };

  const maskQuotedLiteral = (start, quote) => {
    blank(start);
    let index = start + 1;
    while (index < content.length) {
      blank(index);
      if (content[index] === "\\") {
        index += 1;
        if (index < content.length) blank(index);
      } else if (content[index] === quote) {
        return index;
      }
      index += 1;
    }
    return content.length - 1;
  };

  const maskRegexLiteral = (start) => {
    let inCharacterClass = false;
    blank(start);
    let index = start + 1;
    while (index < content.length) {
      blank(index);
      if (content[index] === "\\") {
        index += 1;
        if (index < content.length) blank(index);
      } else if (content[index] === "[") {
        inCharacterClass = true;
      } else if (content[index] === "]") {
        inCharacterClass = false;
      } else if (content[index] === "/" && !inCharacterClass) {
        while (/[a-z]/iu.test(content[index + 1] ?? "")) {
          index += 1;
          blank(index);
        }
        return index;
      }
      index += 1;
    }
    return content.length - 1;
  };

  let maskTemplateLiteral;
  const maskTemplateExpression = (start) => {
    let braceDepth = 1;
    let index = start;
    while (index < content.length) {
      const current = content[index];
      const next = content[index + 1];
      if (current === "/" && next === "/") {
        index = maskLineComment(index);
      } else if (current === "/" && next === "*") {
        index = maskBlockComment(index);
      } else if (current === "'" || current === '"') {
        index = maskQuotedLiteral(index, current);
      } else if (current === "`") {
        index = maskTemplateLiteral(index);
      } else if (current === "/" && isRegexStart(content, index)) {
        index = maskRegexLiteral(index);
      } else if (current === "{") {
        braceDepth += 1;
      } else if (current === "}") {
        braceDepth -= 1;
        if (braceDepth === 0) return index;
      }
      index += 1;
    }
    return content.length - 1;
  };

  maskTemplateLiteral = (start) => {
    blank(start);
    let index = start + 1;
    while (index < content.length) {
      if (content[index] === "\\") {
        blank(index);
        index += 1;
        if (index < content.length) blank(index);
      } else if (content[index] === "`") {
        blank(index);
        return index;
      } else if (content[index] === "$" && content[index + 1] === "{") {
        blank(index);
        index = maskTemplateExpression(index + 2);
      } else {
        blank(index);
      }
      index += 1;
    }
    return content.length - 1;
  };

  for (let i = 0; i < content.length; i += 1) {
    const current = content[i];
    const next = content[i + 1];

    if (current === "/" && next === "/") {
      i = maskLineComment(i);
      continue;
    }

    if (current === "/" && next === "*") {
      i = maskBlockComment(i);
      continue;
    }

    if (current === "'" || current === '"') {
      i = maskQuotedLiteral(i, current);
      continue;
    }

    if (current === "`") {
      i = maskTemplateLiteral(i);
      continue;
    }

    if (current === "/" && isRegexStart(content, i)) {
      i = maskRegexLiteral(i);
    }
  }

  return masked.join("");
}

function importDeclarations(content, executableCode) {
  const declarations = [];
  const importPattern = /\bimport\s+([\s\S]*?)\s+from\s+[ \t]*(?:;|$)/gmu;

  for (const match of executableCode.matchAll(importPattern)) {
    const original = content.slice(match.index, match.index + match[0].length);
    const source = original.match(/\bfrom\s*(["'])([^"']+)\1/u)?.[2];
    if (!source) continue;
    declarations.push({
      clause: match[1],
      source,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return declarations;
}

function findExpressionBodyEnd(executableCode, start) {
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  for (let index = start; index < executableCode.length; index += 1) {
    const current = executableCode[index];
    if (current === "(") {
      depthParen += 1;
      continue;
    }
    if (current === ")") {
      if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) return index;
      depthParen -= 1;
      continue;
    }
    if (current === "[") {
      depthBracket += 1;
      continue;
    }
    if (current === "]") {
      if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) return index;
      depthBracket -= 1;
      continue;
    }
    if (current === "{") {
      depthBrace += 1;
      continue;
    }
    if (current === "}") {
      if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) return index;
      depthBrace -= 1;
      continue;
    }
    if (
      (current === ";" || current === ",") &&
      depthParen === 0 &&
      depthBracket === 0 &&
      depthBrace === 0
    ) {
      return index;
    }
  }
  return executableCode.length;
}

function lexicalScopes(executableCode) {
  const root = {
    start: 0,
    end: executableCode.length,
    depth: 0,
    openIndex: -1,
    parent: null,
  };
  const scopes = [root];
  const stack = [root];

  for (let index = 0; index < executableCode.length; index += 1) {
    while (
      stack.length > 1 &&
      stack.at(-1).expressionBody &&
      index >= stack.at(-1).end
    ) {
      stack.pop();
    }

    if (
      executableCode[index] === "=" &&
      executableCode[index + 1] === ">"
    ) {
      let expressionStart = index + 2;
      while (
        expressionStart < executableCode.length &&
        /\s/u.test(executableCode[expressionStart])
      ) {
        expressionStart += 1;
      }
      if (
        expressionStart < executableCode.length &&
        executableCode[expressionStart] !== "{"
      ) {
        const expressionEnd = findExpressionBodyEnd(
          executableCode,
          expressionStart,
        );
        const scope = {
          start: expressionStart,
          end: expressionEnd,
          depth: stack.length,
          openIndex: expressionStart,
          parent: stack.at(-1),
          expressionBody: true,
        };
        scopes.push(scope);
        stack.push(scope);
      }
      index += 1;
      continue;
    }

    if (executableCode[index] === "{") {
      const scope = {
        start: index + 1,
        end: executableCode.length,
        depth: stack.length,
        openIndex: index,
        parent: stack.at(-1),
      };
      scopes.push(scope);
      stack.push(scope);
      continue;
    }
    if (executableCode[index] === "}" && stack.length > 1) {
      const closing = stack.at(-1);
      if (closing.expressionBody) continue;
      stack.pop().end = index;
    }
  }

  return scopes;
}

function resolveTrustedFixtureModule(suiteRelativeFile, source) {
  if (typeof source !== "string") return null;
  if (!(source.startsWith("./") || source.startsWith("../"))) return null;

  const dirname = path.posix.dirname(suiteRelativeFile);
  const parts = dirname === "." ? [] : dirname.split("/").filter(Boolean);
  for (const segment of source.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    if (segment.includes("\0")) return null;
    parts.push(segment);
  }

  const resolved = parts.join("/");
  return TRUSTED_FIXTURE_EXPORTS_BY_MODULE.has(resolved) ? resolved : null;
}

function lexicalScopeAt(scopes, index) {
  let selected = scopes[0];
  for (const scope of scopes) {
    if (
      scope.start <= index &&
      index < scope.end &&
      scope.depth >= selected.depth
    ) {
      selected = scope;
    }
  }
  return selected;
}

function isScopeWithin(scope, ancestor) {
  for (let current = scope; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function splitTopLevelBindings(source) {
  const parts = [];
  const stack = [];
  let start = 0;
  const matchingOpen = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    if (current === "(" || current === "[" || current === "{") {
      stack.push(current);
      continue;
    }
    if (Object.hasOwn(matchingOpen, current)) {
      if (stack.at(-1) === matchingOpen[current]) stack.pop();
      continue;
    }
    if (current === "," && stack.length === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function bindingNamesFromPattern(pattern) {
  const normalized = pattern.trim().replace(/^\.\.\./u, "").trim();
  if (!normalized) return [];
  if (
    (normalized.startsWith("{") && normalized.endsWith("}")) ||
    (normalized.startsWith("[") && normalized.endsWith("]"))
  ) {
    const inner = normalized.slice(1, -1);
    return splitTopLevelBindings(inner).flatMap((entry) => {
      const colon = entry.indexOf(":");
      return bindingNamesFromPattern(colon >= 0 ? entry.slice(colon + 1) : entry);
    });
  }
  const name = normalized.match(/^([A-Za-z_$][\w$]*)/u)?.[1];
  return name ? [name] : [];
}

function scopeParameterNames(executableCode, scope) {
  if (scope.openIndex < 0) return [];
  const prefix = executableCode.slice(0, scope.openIndex);
  const arrowSingle = prefix.match(/([A-Za-z_$][\w$]*)\s*=>\s*$/u);
  if (arrowSingle) return [arrowSingle[1]];

  const parameterList = prefix.match(/\(([^()]*)\)\s*(=>)?\s*$/u);
  if (!parameterList) return [];
  const beforeParameters = prefix.slice(0, parameterList.index).trimEnd();
  const precedingToken = beforeParameters.match(/([A-Za-z_$][\w$]*)\s*$/u)?.[1];
  if (precedingToken === "for" || /\bfor\s+await\s*$/u.test(beforeParameters)) {
    const loopBinding = parameterList[1].match(
      /^\s*(?:const|let|var)\s+([\s\S]*?)\s+(?:of|in)\b/u,
    )?.[1];
    return loopBinding ? bindingNamesFromPattern(loopBinding) : [];
  }
  if (
    !parameterList[2] &&
    new Set(["if", "while", "switch", "with"]).has(precedingToken)
  ) {
    return [];
  }
  const names = splitTopLevelBindings(parameterList[1]).flatMap(
    bindingNamesFromPattern,
  );
  const functionSelf = beforeParameters.match(
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*$/u,
  )?.[1];
  if (functionSelf) names.push(functionSelf);
  return [...new Set(names)];
}

function scopeDeclaresBinding(executableCode, scopes, scope, name) {
  if (scopeParameterNames(executableCode, scope).includes(name)) return true;
  const pattern = new RegExp(
    `\\b(?:const|let|var|function|class)\\s+${escapeRegExp(name)}\\b`,
    "gu",
  );
  for (const match of executableCode.matchAll(pattern)) {
    if (lexicalScopeAt(scopes, match.index) === scope) return true;
  }
  for (const match of executableCode.matchAll(
    /\b(?:const|let|var)\s+(\{[^;\n]*?\}|\[[^;\n]*?\])/gu,
  )) {
    if (lexicalScopeAt(scopes, match.index) !== scope) continue;
    if (bindingNamesFromPattern(match[1]).includes(name)) return true;
  }
  return false;
}

function bindingResolvesAt(executableCode, binding, scopes, index) {
  const useScope = lexicalScopeAt(scopes, index);
  if (!isScopeWithin(useScope, binding.scope)) return false;
  for (
    let current = useScope;
    current && current !== binding.scope;
    current = current.parent
  ) {
    if (scopeDeclaresBinding(executableCode, scopes, current, binding.local)) {
      return false;
    }
  }
  return true;
}

function isMemberPropertyIdentifier(executableCode, index) {
  let previous = index - 1;
  while (previous >= 0 && /\s/u.test(executableCode[previous])) previous -= 1;
  return executableCode[previous] === ".";
}

function importedBindings(content, executableCode, file) {
  const childNamed = [];
  const childNamespaces = [];
  const dynamicChildNamed = [];
  const dynamicChildNamespaces = [];
  const fixtureNamed = [];
  const fixtureNamespaces = [];
  const readdirAliases = new Set(["readdirSync"]);
  const scopes = lexicalScopes(executableCode);
  const suiteRelativeFile = file.startsWith(SUITE_DIR) ? file.slice(SUITE_DIR.length) : file;

  for (const declaration of importDeclarations(content, executableCode)) {
    const { clause, source } = declaration;
    const authority = {
      declarationEnd: declaration.end,
      scope: lexicalScopeAt(scopes, declaration.start),
    };
    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/u)?.[1];
    if (source === "node:child_process" && namespace) {
      childNamespaces.push({ ...authority, local: namespace });
    }
    const trustedFixtureModule = resolveTrustedFixtureModule(
      suiteRelativeFile,
      source,
    );
    if (namespace && trustedFixtureModule) {
      fixtureNamespaces.push({
        ...authority,
        local: namespace,
        module: trustedFixtureModule,
        trustedExports: TRUSTED_FIXTURE_EXPORTS_BY_MODULE.get(
          trustedFixtureModule,
        ),
      });
    }

    const named = clause.match(/\{([\s\S]*?)\}/u)?.[1];
    if (!named) continue;
    for (const specifier of named.split(",")) {
      const binding = specifier.trim().match(
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u,
      );
      if (!binding) continue;
      const imported = binding[1];
      const local = binding[2] ?? imported;
      if (source === "node:child_process" && CHILD_PROCESS_CALLS.has(imported)) {
        childNamed.push({ ...authority, imported, local });
      }
      if (source === "node:fs" && imported === "readdirSync") {
        readdirAliases.add(local);
      }
      if (
        trustedFixtureModule &&
        FIXTURE_CALLS.has(imported) &&
        TRUSTED_FIXTURE_EXPORTS_BY_MODULE.get(trustedFixtureModule)?.has(
          imported,
        )
      ) {
        fixtureNamed.push({ ...authority, imported, local });
      }
    }
  }

  const isChildProcessDynamicImport = (match) => {
    const original = content.slice(match.index, match.index + match[0].length);
    return /\bimport\s*\(\s*(["'])node:child_process\1\s*\)/u.test(original);
  };

  for (const match of executableCode.matchAll(
    /\b(?:const|let|var)\s+\{([\s\S]*?)\}\s*=\s*await\s+import\s*\(\s*[^)]*\)/gu,
  )) {
    if (!isChildProcessDynamicImport(match)) continue;
    for (const specifier of match[1].split(",")) {
      const binding = specifier.trim().match(
        /^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/u,
      );
      if (!binding || !CHILD_PROCESS_CALLS.has(binding[1])) continue;
      dynamicChildNamed.push({
        local: binding[2] ?? binding[1],
        imported: binding[1],
        declarationEnd: match.index + match[0].length,
        scope: lexicalScopeAt(scopes, match.index),
      });
    }
  }

  for (const match of executableCode.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\s*\(\s*[^)]*\)/gu,
  )) {
    if (!isChildProcessDynamicImport(match)) continue;
    dynamicChildNamespaces.push({
      local: match[1],
      declarationEnd: match.index + match[0].length,
      scope: lexicalScopeAt(scopes, match.index),
    });
  }

  return {
    childNamed,
    childNamespaces,
    dynamicChildNamed,
    dynamicChildNamespaces,
    fixtureNamed,
    fixtureNamespaces,
    readdirAliases,
    scopes,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasExecutedCall(executableCode, name) {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "gu");
  for (const match of executableCode.matchAll(pattern)) {
    const prefix = executableCode.slice(Math.max(0, match.index - 12), match.index);
    if (/\bfunction\s*$/u.test(prefix)) continue;
    return true;
  }
  return false;
}

function bindingWasReassigned(executableCode, binding, callIndex, scopes) {
  const name = escapeRegExp(binding.local);
  const target = `(?<![.\\w$])${name}\\b`;
  const pattern = new RegExp(
    `(?:${target}\\s*(?:\\?\\?=|&&=|\\|\\|=|>>>=|>>=|<<=|\\*\\*=|[+\\-*/%&|^]=|=(?!=|>))|(?:\\+\\+|--)\\s*${target}|${target}\\s*(?:\\+\\+|--))`,
    "gu",
  );
  for (const match of executableCode.matchAll(pattern)) {
    if (match.index < binding.declarationEnd || match.index >= callIndex) continue;
    const identifierIndex = match.index + match[0].indexOf(binding.local);
    if (isMemberPropertyIdentifier(executableCode, identifierIndex)) continue;
    if (bindingResolvesAt(executableCode, binding, scopes, match.index)) return true;
  }
  for (const match of executableCode.matchAll(
    /(\{[^;\n]*?\}|\[[^;\n]*?\])\s*=\s*/gu,
  )) {
    if (match.index < binding.declarationEnd || match.index >= callIndex) continue;
    if (!bindingNamesFromPattern(match[1]).includes(binding.local)) continue;
    const identifierIndex = match.index + match[0].indexOf(binding.local);
    if (bindingResolvesAt(executableCode, binding, scopes, identifierIndex)) {
      return true;
    }
  }
  return false;
}

function hasExecutedCallInScope(executableCode, name, binding, scopes) {
  const pattern = new RegExp(
    `\\b${escapeRegExp(name)}\\s*(?:\\?\\.\\s*)?\\(`,
    "gu",
  );
  for (const match of executableCode.matchAll(pattern)) {
    if (match.index < binding.declarationEnd) continue;
    if (isMemberPropertyIdentifier(executableCode, match.index)) continue;
    if (!bindingResolvesAt(executableCode, binding, scopes, match.index)) continue;
    if (bindingWasReassigned(executableCode, binding, match.index, scopes)) continue;
    const prefix = executableCode.slice(Math.max(0, match.index - 12), match.index);
    if (/\bfunction\s*$/u.test(prefix)) continue;
    return true;
  }
  return false;
}

function hasNamespaceCallInScope(
  executableCode,
  binding,
  scopes,
  memberCalls = CHILD_PROCESS_CALLS,
) {
  const members = [...memberCalls];
  if (members.length === 0) return false;
  const pattern = new RegExp(
    `\\b${escapeRegExp(binding.local)}\\s*(?:\\?\\.|\\.)\\s*(?:${members
      .map(escapeRegExp)
      .join("|")})\\s*(?:\\?\\.\\s*)?\\(`,
    "gu",
  );
  for (const match of executableCode.matchAll(pattern)) {
    if (match.index < binding.declarationEnd) continue;
    if (isMemberPropertyIdentifier(executableCode, match.index)) continue;
    if (!bindingResolvesAt(executableCode, binding, scopes, match.index)) continue;
    if (!bindingWasReassigned(executableCode, binding, match.index, scopes)) return true;
  }
  return false;
}

function detectRecursiveRepoScanFromExecutable(executableCode, readdirAliases) {
  if (![...readdirAliases].some((name) => hasExecutedCall(executableCode, name))) {
    return false;
  }

  for (const match of executableCode.matchAll(
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/gu,
  )) {
    const functionName = match[1];
    const callPattern = new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(`, "gu");
    const callCount = [...executableCode.matchAll(callPattern)].length;
    const rootCall = new RegExp(
      `\\b${escapeRegExp(functionName)}\\s*\\(\\s*(?:REPO_ROOT|repoRoot)\\s*\\)`,
      "u",
    );
    if (callCount >= 3 && rootCall.test(executableCode)) return true;
  }
  return false;
}

/**
 * Detect whether a test recursively scans the repository from repoRoot.
 * This is a content-level detector for manifest lint's must-keep
 * `recursive-repo-scan` signal (design.md C4); it is no longer consumed by
 * changed-suite selection (amend-pr-integration-test-scope D1).
 *
 * @param {string} content test source
 * @param {{ file?: string }} options
 * @returns {boolean}
 */
export function detectRecursiveRepoScan(
  content,
  { file = ".devpro/scripts/tests/unknown.test.mjs" } = {},
) {
  const executableCode = maskNonExecutableSyntax(content);
  const { readdirAliases } = importedBindings(content, executableCode, file);
  return detectRecursiveRepoScanFromExecutable(executableCode, readdirAliases);
}

/**
 * Predicate: does this executable code assign a `DEVPRO_*_TEST_GROUP` env var
 * AND call `import(`? This is the one content-level SSOT shared by manifest
 * lint's `integration-shard-import` signal and changed-suite shard-wrapper
 * selection (`detectShardImportTargets`); callers MUST NOT maintain filename
 * lists (design.md D3).
 * @param {string} executableCode `maskNonExecutableSyntax` output
 * @returns {boolean}
 */
function hasShardImportSignal(executableCode) {
  return (
    /\bprocess\s*\.\s*env\s*\.\s*DEVPRO_[A-Z0-9_]+_TEST_GROUP\s*=/u.test(
      executableCode,
    ) && /\b(?:await\s+)?import\s*\(/u.test(executableCode)
  );
}

// No trailing `\s*` after the paren: masking blanks quoted-literal bytes to
// plain spaces (same length, not real whitespace), so a greedy `\s*` here
// would eat straight through a masked argument and land past its opening
// quote. Whitespace between "(" and the argument is skipped separately below
// against the ORIGINAL (unmasked) content, where it is genuine whitespace.
const SHARD_IMPORT_CALL_RE = /\bimport\s*\(/gu;
const SHARD_IMPORT_LITERAL_SPECIFIER_RE = /^\s*["']([^"']+)["']/u;

/**
 * Detect the shard-import literal targets a shard wrapper's
 * `import("./<body>.test.mjs")` call points at, once `hasShardImportSignal`
 * confirms the file is a shard wrapper. Only literal `./`/`../`-relative
 * `.test.mjs` specifiers are collected; non-literal dynamic imports (e.g.
 * `import(pathToFileURL(...))`) are ignored — a bounded residual (design.md
 * D3). Throws when the signal is present but no literal target resolves, so
 * the caller can fail closed instead of silently under-selecting.
 *
 * @param {string} content raw file source
 * @param {{ file: string }} options suite-relative path of `content`, used to
 *   resolve `./`/`../` specifiers into suite-relative targets
 * @returns {string[]} sorted, de-duplicated suite-relative `.test.mjs` targets
 */
export function detectShardImportTargets(content, { file }) {
  const executableCode = maskNonExecutableSyntax(content);
  if (!hasShardImportSignal(executableCode)) return [];

  const targets = new Set();
  const fileDir = path.posix.dirname(file);
  for (const match of executableCode.matchAll(SHARD_IMPORT_CALL_RE)) {
    const afterCall = content.slice(match.index + match[0].length);
    const literal = afterCall.match(SHARD_IMPORT_LITERAL_SPECIFIER_RE)?.[1];
    if (!literal) continue;
    if (!literal.startsWith("./") && !literal.startsWith("../")) continue;
    if (!literal.endsWith(".test.mjs")) continue;
    targets.add(path.posix.normalize(path.posix.join(fileDir, literal)));
  }

  if (targets.size === 0) {
    throw new Error(
      `shard-import signal present but no literal ".test.mjs" import target found: ${file}`,
    );
  }
  return [...targets].sort();
}

function detectIntegrationExecution(content, file) {
  const executableCode = maskNonExecutableSyntax(content);
  const {
    childNamed,
    childNamespaces,
    dynamicChildNamed,
    dynamicChildNamespaces,
    fixtureNamed,
    fixtureNamespaces,
    readdirAliases,
    scopes,
  } = importedBindings(content, executableCode, file);
  const signals = [];

  if (hasShardImportSignal(executableCode)) {
    signals.push("integration-shard-import");
  }
  for (const name of TEMP_FIXTURE_CALLS) {
    if (hasExecutedCall(executableCode, name)) signals.push(name);
  }
  for (const binding of childNamed) {
    if (hasExecutedCallInScope(executableCode, binding.local, binding, scopes)) {
      signals.push(`child_process:${binding.imported}`);
    }
  }
  for (const binding of dynamicChildNamed) {
    if (hasExecutedCallInScope(executableCode, binding.local, binding, scopes)) {
      signals.push(`child_process:${binding.imported}`);
    }
  }
  for (const binding of childNamespaces) {
    if (hasNamespaceCallInScope(executableCode, binding, scopes)) {
      signals.push("child_process:namespace");
    }
  }
  for (const binding of dynamicChildNamespaces) {
    if (hasNamespaceCallInScope(executableCode, binding, scopes)) {
      signals.push("child_process:namespace");
    }
  }
  for (const binding of fixtureNamed) {
    if (hasExecutedCallInScope(executableCode, binding.local, binding, scopes)) {
      signals.push(`fixture:${binding.imported}`);
    }
  }
  for (const binding of fixtureNamespaces) {
    if (
      hasNamespaceCallInScope(
        executableCode,
        binding,
        scopes,
        binding.trustedExports,
      )
    ) {
      signals.push(`fixture:namespace:${binding.module}`);
    }
  }
  if (detectRecursiveRepoScanFromExecutable(executableCode, readdirAliases)) {
    signals.push("recursive-repo-scan");
  }

  return [...new Set(signals)].sort();
}

/**
 * @param {{ content: string, file: string, tier: string }} input
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function lintTierAssignment({ content, file, tier }) {
  const signals = detectIntegrationExecution(content, file);
  const unitDisqualifyingSignals = signals.filter(
    (signal) =>
      signal.startsWith("child_process:") ||
      signal.startsWith("fixture:") ||
      signal === "integration-shard-import" ||
      signal === "recursive-repo-scan",
  );
  const errors = [];
  if (tier === TIER_INTEGRATION && signals.length === 0) {
    errors.push(`integration tier without executed integration signal: ${file}`);
  }
  if (tier === TIER_UNIT && unitDisqualifyingSignals.length > 0) {
    errors.push(
      `unit tier executes integration signal (${unitDisqualifyingSignals.join(", ")}): ${file}`,
    );
  }
  return { ok: errors.length === 0, errors };
}

function defaultRepoRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, "../..");
}

function suiteDirAbs(repoRoot) {
  return path.join(repoRoot, SUITE_DIR);
}

function listDiskTestFiles(repoRoot) {
  const dir = suiteDirAbs(repoRoot);
  const files = [];

  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".test.mjs")) continue;
      files.push(path.relative(dir, abs).split(path.sep).join("/"));
    }
  }

  walk(dir);
  return files.sort();
}

/**
 * @param {{ repoRoot?: string }} [options]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function lintManifest({ repoRoot = defaultRepoRoot() } = {}) {
  const errors = [];
  const diskFiles = listDiskTestFiles(repoRoot);
  const manifestFiles = Object.keys(MANIFEST).sort();

  const diskSet = new Set(diskFiles);
  const manifestSet = new Set(manifestFiles);

  for (const file of diskFiles) {
    if (!manifestSet.has(file)) {
      errors.push(`missing from MANIFEST: ${SUITE_DIR}${file}`);
    }
  }

  for (const file of manifestFiles) {
    if (!diskSet.has(file)) {
      errors.push(`manifest entry for missing file: ${SUITE_DIR}${file}`);
    }
  }

  const dupCheck = new Set();
  for (const file of manifestFiles) {
    if (dupCheck.has(file)) {
      errors.push(`duplicate manifest entry: ${file}`);
    }
    dupCheck.add(file);
  }

  for (const [file, tier] of Object.entries(MANIFEST)) {
    const abs = path.join(suiteDirAbs(repoRoot), file);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, "utf8");
    const assignment = lintTierAssignment({
      content,
      file: `${SUITE_DIR}${file}`,
      tier,
    });
    errors.push(...assignment.errors);
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  const { ok, errors } = lintManifest();
  if (ok) {
    console.log(
      `[lint-test-suite-manifest] PASS: ${Object.keys(MANIFEST).length} files, manifest complete`,
    );
    process.exit(0);
  }

  console.error("[lint-test-suite-manifest] FAIL:");
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
