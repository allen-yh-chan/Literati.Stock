#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDirectCliInvocation } from "./lib/cli-entry.mjs";

const CONFIG_FILE = /^playwright\.config\.[^/]+$/;
const NODE_PACKAGES = ["@playwright/test", "playwright"];
const NODE_DEPENDENCY_FIELDS = ["dependencies", "devDependencies"];
const DOTNET_PACKAGE_REFERENCE =
  /^<PackageReference(?:[^"']|"[^"]*"|'[^']*')*?\s(?:Include|Update)\s*=\s*["']Microsoft\.Playwright(?:\.[\w.]+)?["']/i;
const XML_TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s<>"'/=!?]+)(?:\s+[^\s<>"'/=]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*(\/?)>/y;

export const CHECKED_SIGNALS = Object.freeze([
  "playwright.config.*",
  "package.json",
  "*.csproj",
  "Directory.Build.props",
]);

function listTrackedSignalFiles(repoRoot) {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--", ...CHECKED_SIGNALS.map((signal) => `:(glob)**/${signal}`)],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter(Boolean);
}

function declaresNodePlaywright(text) {
  const manifest = JSON.parse(text);
  return NODE_DEPENDENCY_FIELDS.some((field) =>
    NODE_PACKAGES.some((name) => Object.hasOwn(manifest?.[field] ?? {}, name))
  );
}

/**
 * Walks the tags so comments and CDATA never count and a truncated project file
 * throws instead of reading as undeclared. Not a full XML parser: it checks tag
 * balance and tag and attribute syntax only, the limit the environment-setup
 * spec states. Text outside the root, bare ampersands and duplicate attributes pass.
 */
function declaresDotnetPlaywright(text) {
  const open = [];
  let rootSeen = false;
  let declared = false;
  for (let index = text.indexOf("<"); index !== -1; index = text.indexOf("<", XML_TOKEN.lastIndex)) {
    XML_TOKEN.lastIndex = index;
    const token = XML_TOKEN.exec(text);
    if (!token) throw new Error("malformed XML");
    const [tag, closing, name, selfClosing] = token;
    if (!name) continue;
    if (closing) {
      if (open.pop() !== name) throw new Error("malformed XML");
      continue;
    }
    if (open.length === 0 && rootSeen) throw new Error("malformed XML");
    rootSeen = true;
    declared ||= DOTNET_PACKAGE_REFERENCE.test(tag);
    if (!selfClosing) open.push(name);
  }
  if (!rootSeen || open.length > 0) throw new Error("malformed XML");
  return declared;
}

function addProject(projects, stack, signal, declared) {
  const project = path.posix.dirname(signal);
  const key = `${stack}:${project}`;
  const entry = projects.get(key) ?? { stack, project, declared: false, signals: [] };
  entry.declared ||= declared;
  entry.signals.push(signal);
  projects.set(key, entry);
}

/**
 * Tracked Playwright projects at any depth. `not-verified` means a manifest
 * could not be read or parsed, so the caller MUST NOT report N/A or a complete
 * result; `projects` still lists what the readable manifests declare.
 */
export function detectPlaywrightProjects(repoRoot) {
  const projects = new Map();
  const unreadable = [];
  for (const file of listTrackedSignalFiles(repoRoot)) {
    const name = path.posix.basename(file);
    if (CONFIG_FILE.test(name)) {
      addProject(projects, "node", file, false);
      continue;
    }
    try {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      if (name === "package.json") {
        if (declaresNodePlaywright(text)) addProject(projects, "node", file, true);
      } else if (declaresDotnetPlaywright(text)) {
        addProject(projects, "dotnet", file, true);
      }
    } catch {
      unreadable.push(file);
    }
  }
  const found = [...projects.values()].sort((a, b) => a.project.localeCompare(b.project));
  const status = unreadable.length > 0 ? "not-verified" : found.length > 0 ? "detected" : "none";
  return { status, checked: [...CHECKED_SIGNALS], projects: found, unreadable };
}

if (isDirectCliInvocation(import.meta.url)) {
  try {
    console.log(JSON.stringify(detectPlaywrightProjects(process.cwd()), null, 2));
  } catch (error) {
    console.error(`detect-playwright-projects: ${error.message}`);
    process.exitCode = 1;
  }
}
