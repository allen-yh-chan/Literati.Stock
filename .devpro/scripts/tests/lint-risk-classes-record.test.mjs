/**
 * Unit tests for lint-risk-classes-record.mjs (leading YAML front-matter contract).
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintRiskClassesRecord } from '../lint-risk-classes-record.mjs';
import { makeTempDir } from './lib/tmp.mjs';
import { FIXTURE_RELATIVE } from './lib/risk-classes-alignment-fixture.mjs';
import { repoPath } from './lib/repo-root.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lint-risk-classes-record.mjs');
const SHARED_ALIGNMENT_FIXTURE = repoPath(FIXTURE_RELATIVE);

function fm(body, trailing = '# Proposal\n') {
  return `---\n${body}---\n\n${trailing}`;
}

function makeChange(files) {
  const root = makeTempDir('lint-risk-classes-');
  const changeFolder = join(root, 'openspec', 'changes', 'fixture-change');
  mkdirSync(changeFolder, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(changeFolder, name), body, 'utf8');
  }
  return { root, changeFolder };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

describe('lintRiskClassesRecord (leading front matter)', () => {
  test('pass: shared lint/classify-bounded alignment fixture', () => {
    const { root, changeFolder } = makeChange({
      'proposal-mini.md': readFileSync(SHARED_ALIGNMENT_FIXTURE, 'utf8'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('pass: proposal with leading FM list', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm('risk_classes: [auth]\n'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.deepEqual(result.violations, []);
    } finally {
      cleanup(root);
    }
  });

  test('pass: slash-form state/invariant token', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm(
        'risk_classes: [state/invariant, write]\nrationale: gate changes invariant + write path\n',
      ),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('pass: meeting-notes leading FM none + rationale (proposal present undeclared)', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': '# Proposal\n\nNo FM here.\n',
      'meeting-notes.md': fm(
        'risk_classes: none\nrationale: no auth/disclosure surface in this change\n',
        '# Notes\n',
      ),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('pass: BOM-prefixed leading FM', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `\uFEFF${fm('risk_classes: [write]\n')}`,
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('pass: multi-file normalize-equal declarations', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm('risk_classes: [auth, write]\n'),
      'brd.md': fm('risk_classes: [write, authorization]\n', '# BRD\n'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('pass: Chore A exemption ignores malformed brd/notes', () => {
    const { root, changeFolder } = makeChange({
      'meeting-notes.md': '---\nrisk_classes: [banana]\n',
      'brd.md': '---\nrisk_classes: {nested: true}\n---\n',
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.deepEqual(result.violations, []);
    } finally {
      cleanup(root);
    }
  });

  test('pass: thematic break after closer is opaque (not second FM)', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md':
        '---\nrisk_classes: [auth]\n---\n\n# Title\n\n---\n\nrisk_classes: [banana]\n',
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('fail: prose-only risk_classes is not a live record', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': '# Proposal\n\nrisk_classes: [auth]\n',
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(
        result.violations.some((v) => v.reason === 'missing-risk-classes'),
        JSON.stringify(result.violations),
      );
    } finally {
      cleanup(root);
    }
  });

  test('fail: fenced example only', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': '# Proposal\n\n```md\nrisk_classes: [auth]\n```\n',
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(result.violations.some((v) => v.reason === 'missing-risk-classes'));
    } finally {
      cleanup(root);
    }
  });

  test('fail: <pre> example only', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md':
        '# Proposal\n\n<pre>\nrisk_classes: [auth]\n</pre>\n',
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(result.violations.some((v) => v.reason === 'missing-risk-classes'));
    } finally {
      cleanup(root);
    }
  });

  test('fail: unclosed front matter', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': '---\nrisk_classes: [auth]\n\n# Proposal\n',
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(
        result.violations.some((v) => v.reason === 'malformed-front-matter' && v.file === 'proposal.md'),
        JSON.stringify(result.violations),
      );
    } finally {
      cleanup(root);
    }
  });

  test('fail: duplicate key', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm('risk_classes: [auth]\nrisk_classes: [write]\n'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(
        result.violations.some((v) => v.reason === 'duplicate-key' && v.file === 'proposal.md'),
        JSON.stringify(result.violations),
      );
    } finally {
      cleanup(root);
    }
  });

  test('fail: illegal nested value', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm('risk_classes: {a: 1}\n'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(
        result.violations.some((v) => v.reason === 'illegal-nested' && v.file === 'proposal.md'),
        JSON.stringify(result.violations),
      );
    } finally {
      cleanup(root);
    }
  });

  test('fail: empty list', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm('risk_classes: []\n'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(result.violations.some((v) => v.reason === 'empty-list'));
    } finally {
      cleanup(root);
    }
  });

  test('fail: placeholder list', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm('risk_classes: [<a-d subset>]\n'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(result.violations.some((v) => v.reason === 'placeholder-list'));
    } finally {
      cleanup(root);
    }
  });

  test('fail: unknown token', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm('risk_classes: [banana]\n'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(result.violations.some((v) => v.reason === 'invalid-token'));
    } finally {
      cleanup(root);
    }
  });

  test('fail: none without rationale', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm('risk_classes: none\n'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(result.violations.some((v) => v.reason === 'none-without-rationale'));
    } finally {
      cleanup(root);
    }
  });

  for (const [label, body] of [
    ['comment-only', 'risk_classes: none\nrationale: # TODO\n'],
    ['quoted-empty-double', 'risk_classes: none\nrationale: ""\n'],
    ['quoted-empty-single', "risk_classes: none\nrationale: ''\n"],
    ['quoted-empty-with-comment', 'risk_classes: none\nrationale: "" # TODO\n'],
    ['flow-empty-list', 'risk_classes: none\nrationale: []\n'],
    ['flow-list', 'risk_classes: none\nrationale: [todo]\n'],
    ['null', 'risk_classes: none\nrationale: null\n'],
    ['tilde', 'risk_classes: none\nrationale: ~\n'],
    ['quoted-newline-only', 'risk_classes: none\nrationale: "\\n"\n'],
    ['quoted-nul', 'risk_classes: none\nrationale: "\\0"\n'],
    ['quoted-hex-nul', 'risk_classes: none\nrationale: "\\x00"\n'],
    ['quoted-bell', 'risk_classes: none\nrationale: "\\a"\n'],
    ['quoted-word-joiner', 'risk_classes: none\nrationale: "\\u2060"\n'],
    ['punctuation-only', 'risk_classes: none\nrationale: "!!!"\n'],
    ['hangul-filler', 'risk_classes: none\nrationale: "\\u3164"\n'],
    ['hangul-choseong-filler', 'risk_classes: none\nrationale: "\\u115F"\n'],
    ['zwj-obfuscated-todo', 'risk_classes: none\nrationale: "T\\u200DODO"\n'],
    ['obfuscated-rationale-label', 'risk_classes: none\nrationale: "rationale\\u2060:"\n'],
    ['nul-obfuscated-todo', 'risk_classes: none\nrationale: "T\\0ODO"\n'],
    ['nul-obfuscated-rationale-label', 'risk_classes: none\nrationale: "rationale\\0:"\n'],
  ]) {
    test(`fail: none with non-substantive YAML scalar rationale (${label})`, () => {
      const { root, changeFolder } = makeChange({
        'proposal.md': fm(body),
      });
      try {
        const result = lintRiskClassesRecord({ changeFolder });
        assert.equal(result.pass, false, JSON.stringify(result));
        assert.ok(
          result.violations.some(
            (v) =>
              v.reason === 'none-without-rationale' ||
              v.reason === 'illegal-nested' ||
              v.reason === 'malformed-front-matter',
          ),
          JSON.stringify(result.violations),
        );
      } finally {
        cleanup(root);
      }
    });
  }

  test('fail: quoted risk_classes "no\\ne" is not none (escape decode)', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm(
        'risk_classes: "no\\ne"\nrationale: would wrongly pass if backslash discarded\n',
      ),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.ok(
        result.violations.some((v) => v.reason === 'malformed-front-matter'),
        JSON.stringify(result.violations),
      );
    } finally {
      cleanup(root);
    }
  });

  test('fail: unsupported double-quoted escape fail-closed', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm(
        'risk_classes: none\nrationale: "bad\\qescape must fail"\n',
      ),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.ok(
        result.violations.some((v) => v.reason === 'malformed-front-matter'),
        JSON.stringify(result.violations),
      );
    } finally {
      cleanup(root);
    }
  });

  test('fail: lone surrogate escape fail-closed', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm(
        'risk_classes: none\nrationale: "\\uD800"\n',
      ),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.ok(
        result.violations.some((v) => v.reason === 'malformed-front-matter'),
        JSON.stringify(result.violations),
      );
    } finally {
      cleanup(root);
    }
  });

  test('fail: ignored key with unsupported escape fail-closed', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm('title: "bad\\q"\nrisk_classes: [auth]\n'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.ok(
        result.violations.some((v) => v.reason === 'malformed-front-matter'),
        JSON.stringify(result.violations),
      );
    } finally {
      cleanup(root);
    }
  });

  for (const [label, body] of [
    ['leading-empty', 'risk_classes: [,auth]\n'],
    ['double-comma', 'risk_classes: [auth,,write]\n'],
    ['trailing-empty', 'risk_classes: [auth,]\n'],
  ]) {
    test(`fail: empty flow-list entry (${label})`, () => {
      const { root, changeFolder } = makeChange({
        'proposal.md': fm(body),
      });
      try {
        const result = lintRiskClassesRecord({ changeFolder });
        assert.equal(result.pass, false, JSON.stringify(result));
        assert.ok(
          result.violations.some((v) => v.reason === 'malformed-front-matter'),
          JSON.stringify(result.violations),
        );
      } finally {
        cleanup(root);
      }
    });
  }

  test('pass: risk_classes list with trailing inline comment', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm('risk_classes: [auth] # note\n'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('pass: risk_classes none with trailing inline comment + rationale', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm(
        'risk_classes: none # note\nrationale: no auth surface in this change\n',
      ),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('pass: none with rationale and trailing inline comment', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm(
        'risk_classes: none\nrationale: no auth surface in this change # note\n',
      ),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('fail: no leading --- is undeclared (missing across change)', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': '# Proposal\n\nSomething else.\n',
      'meeting-notes.md': '# Notes\n',
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(result.violations.some((v) => v.reason === 'missing-risk-classes'));
    } finally {
      cleanup(root);
    }
  });

  test('fail: multi-owner conflict', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm('risk_classes: [auth]\n'),
      'brd.md': fm('risk_classes: [write]\n', '# BRD\n'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(
        result.violations.some((v) => v.reason === 'multi-owner-conflict'),
        JSON.stringify(result.violations),
      );
    } finally {
      cleanup(root);
    }
  });

  test('fail: leading FM without risk_classes key is not a declaration', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': fm('title: only\n'),
    });
    try {
      const result = lintRiskClassesRecord({ changeFolder });
      assert.equal(result.pass, false);
      assert.ok(result.violations.some((v) => v.reason === 'missing-risk-classes'));
    } finally {
      cleanup(root);
    }
  });

  test('CLI exits non-zero and names file+reason on missing FM', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': '# Proposal\n\nNo classes.\n',
    });
    try {
      const run = spawnSync(process.execPath, [SCRIPT, changeFolder], {
        encoding: 'utf8',
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /\[lint-risk-classes-record\]/);
      assert.match(run.stderr, /missing-risk-classes/);
    } finally {
      cleanup(root);
    }
  });
});
