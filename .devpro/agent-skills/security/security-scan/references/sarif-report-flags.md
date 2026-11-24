# sarif-report.mjs Flag Reference (cold reference)

SSOT: `security-scanning.md` §報告產生器：`sarif-report.mjs`.

```bash
node .devpro/scripts/sarif-report.mjs \
  --sarif ./codeql-results/csharp.sarif \
  --source-root . \
  --project "<consumer-name>" \
  --out ./docs/codeql-YYYY-MM-DD.html
```

| Flag | Meaning |
|---|---|
| `--sarif <path>` | SARIF v2.1.0 input file (required) |
| `--source-root <dir>` | Base directory for snippet injection (default: `.`) |
| `--project <name>` | Report title (default: repo folder name) |
| `--out <path>` | HTML output path (default: `docs/codeql-YYYY-MM-DD.html`) |

The generated HTML report includes dual-axis severity classification: Security Severity (4-bucket CVSS) and Problem Severity (3-bucket). `sarif-report.mjs` is a zero-dependency ES module (Node.js built-ins only) — do not add a package dependency to extend it.

## `.gitignore` convention

- Raw SARIF (`codeql-results/`): **ignored** (large, not human-readable); baseline entry managed by `gitignore-alignment.md`
- HTML report (`docs/codeql-*.html`): **tracked** (PR-diffable, retained 30 days as Actions artifact)

## Verification

```bash
node .devpro/scripts/sarif-report.mjs --sarif ./codeql-results/csharp.sarif --out ./docs/codeql-YYYY-MM-DD.html
```
