# CodeQL Workflow Templates (cold reference)

SSOT: `security-scanning.md` §CodeQL Workflow Template. This file is a distilled copy for quick access when authoring `.github/workflows/codeql.yml`; if the templates drift, the rule leaf wins.

**Token scope note**: replace `<github-org>` / `<consumer-repo>` with actual values. `devpro-agent-rules` is the submodule source repo — `actions/create-github-app-token@v1` defaults to only the current repo's token, so submodule checkout needs explicit scope or you get a 404.

## Stack A: dotnet-framework (net4x, legacy csproj)

Applies to `<Project ToolsVersion="...">` format, target framework `net40`–`net48`. Requires Windows runner + MSBuild.

```yaml
name: CodeQL Security Analysis
on:
  workflow_dispatch:
defaults:
  run:
    shell: pwsh
jobs:
  analyze:
    name: Analyze (net48)
    runs-on: [self-hosted, <consumer-label>, codeql]
    permissions:
      security-events: write
      actions: read
      contents: read
    steps:
      - name: Generate token
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          owner: <github-org>
          repositories: |
            <consumer-repo>
            devpro-agent-rules
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          token: ${{ steps.app-token.outputs.token }}
          submodules: recursive
      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: csharp
          queries: security-and-quality
      - name: Setup MSBuild
        uses: microsoft/setup-msbuild@v2
      - name: Disable MvcBuildViews for CodeQL
        run: |
          Get-ChildItem -Recurse -Filter *.csproj | ForEach-Object {
            $content = Get-Content $_.FullName -Raw -Encoding utf8
            $content = $content -replace 'Condition="''\$\(MvcBuildViews\)''==''true''"', 'Condition="false"'
            Set-Content $_.FullName -Value $content -Encoding utf8 -NoNewline
          }
      - name: Restore NuGet packages
        run: nuget restore <solution>.sln
      - name: Build
        run: msbuild <solution>.sln /p:Configuration=Release /p:UseSharedCompilation=false
      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3
        with:
          category: "/language:csharp"
          upload: never
          output: codeql-results
      - name: Upload SARIF as artifact
        uses: actions/upload-artifact@v4
        with:
          name: codeql-results
          path: codeql-results
          retention-days: 30
```

`upload: never` corresponds to repos without GitHub Advanced Security enabled; repos with GHAS can switch to the default upload.

## Stack B: dotnet-sdk (net5.0+, including net8)

Applies to `<Project Sdk="Microsoft.NET.Sdk">` SDK-style csproj; runs on `ubuntu-latest`.

```yaml
name: CodeQL Security Analysis
on:
  workflow_dispatch:
jobs:
  analyze:
    name: Analyze (dotnet-sdk)
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      actions: read
      contents: read
    steps:
      - name: Generate token
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          owner: <github-org>
          repositories: |
            <consumer-repo>
            devpro-agent-rules
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          token: ${{ steps.app-token.outputs.token }}
          submodules: recursive
      - name: Setup .NET
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '8.0.x'
      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: csharp
          queries: security-and-quality
      - name: Restore
        run: dotnet restore
      - name: Build
        run: dotnet build --configuration Release --no-restore
      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3
        with:
          category: "/language:csharp"
          upload: never
          output: codeql-results
      - name: Upload SARIF as artifact
        uses: actions/upload-artifact@v4
        with:
          name: codeql-results
          path: codeql-results
          retention-days: 30
```

## Stack C: nodejs / python / other

**TBD (P1 expansion)**: template to be added once a consumer actually adopts this stack for CodeQL scanning.

## Verification

```bash
rg -n "ToolsVersion|Sdk=\"Microsoft.NET.Sdk\"" .devpro/agent-rules/security-scanning.md
```
