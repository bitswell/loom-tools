# Plan: repo management tools — ci-generate, repo-init, compliance-check

## Approach

Build three orchestrator-only tools following the existing patterns: Zod input/output schemas, `Tool<I, O>` interface, `ok`/`err` result helpers, `exec` for shell commands. Each tool produces structured data rather than executing side effects (ci-generate and repo-init return file maps; compliance-check returns rule results). Register all three in `createDefaultRegistry()` bringing the total from 16 to 19.

## Steps

### 1. ci-generate.ts
- Define `CiGenerateInput` schema: `language` (rust|typescript|go), `features` array (test, typecheck, lint, gh-pages, release)
- Define `CiGenerateOutput` schema: `files` as `Record<string, string>` (path -> YAML content)
- Build workflow YAML strings in-memory using template functions (no YAML library — the output is simple enough for string templates)
- Each feature maps to either a job within `.github/workflows/ci.yml` or a separate workflow file (gh-pages, release get their own files)
- Language determines the actual commands within each job:
  - Rust: `cargo check` (typecheck), `cargo test` (test), `cargo clippy` (lint)
  - TypeScript: `npx tsc --noEmit` (typecheck), `npx vitest run` (test), `npx eslint .` (lint)
  - Go: `go build ./...` (typecheck), `go test ./...` (test), `golangci-lint run` (lint)
- Export the generation logic as a standalone function so repo-init can call it without constructing a ToolContext
- Role: `['orchestrator']`

### 2. repo-init.ts
- Define `RepoInitInput` schema: `repoName`, `language` (rust|typescript|go), `features` array (ci, branch-protection, license, gitignore)
- Define `RepoInitOutput` schema: `files` as `Record<string, string>` (path -> content)
- For `ci` feature: call ci-generate's exported generation function directly (not the tool handler)
- For `branch-protection`: generate a shell script using `gh api` to set branch protection rules (require PR reviews, require status checks, no force push, no deletion)
- For `license`: MIT template with current year and `repoName` as org
- For `gitignore`: language-appropriate template strings
- Role: `['orchestrator']`

### 3. compliance-check.ts
- Define `ComplianceCheckInput` schema: `repoPath` (optional, default `.`), `remote` (optional, default `origin`)
- Define `ComplianceCheckOutput` schema: `rules` array of `{ rule, status: 'pass'|'fail'|'warn', detail }`, `overall: 'pass'|'fail'`
- Use `exec('gh', ['api', ...])` to query branch protection rules from GitHub API
- First determine owner/repo from git remote URL via `git remote get-url <remote>`
- Then determine default branch via `gh api repos/{owner}/{repo}` and parse `default_branch`
- Then query `repos/{owner}/{repo}/branches/{branch}/protection`
- Parse the JSON response and check each rule:
  - Branch protection enabled (protection endpoint returns 200 vs 404)
  - Require pull request reviews (at least 1 required reviewer)
  - Require status checks to pass
  - No force pushes allowed
  - No deletions allowed
  - Signed commits (warn level, not fail)
- Role: `['orchestrator']`

### 4. Update index.ts
- Import and export all three new tools
- Register them in `createDefaultRegistry()` under `// Phase 4 — repo management tools (orchestrator only)`
- Total becomes 19

### 5. Tests

**ci-generate.test.ts**
- Test each language produces expected command mappings
- Verify output file paths start with `.github/workflows/`
- Test individual features (test, typecheck, lint) produce correct jobs
- Test gh-pages and release produce separate workflow files
- Test empty features produces minimal workflow

**repo-init.test.ts**
- Test `ci` feature includes workflow files (delegates to ci-generate)
- Test `license` feature produces MIT text with year/org
- Test `gitignore` feature produces language-appropriate content
- Test `branch-protection` feature produces a script with gh api calls
- Test composition — all features together

**compliance-check.test.ts**
- Mock `exec` to return gh api JSON responses
- Test all-passing scenario
- Test mixed pass/fail scenario
- Test API failure (repo not found, no permissions)
- Test remote URL parsing for owner/repo extraction

**registry.test.ts** — update existing
- Change count from 16 to 19
- Add registration checks for ci-generate, repo-init, compliance-check
- Update orchestrator access count from 16 to 19
- Verify writer still has 7 tools, reviewer still has 3

## Files to Modify

### New files
- `src/tools/ci-generate.ts`
- `src/tools/repo-init.ts`
- `src/tools/compliance-check.ts`
- `tests/tools/ci-generate.test.ts`
- `tests/tools/repo-init.test.ts`
- `tests/tools/compliance-check.test.ts`

### Modified files
- `src/tools/index.ts` — imports, exports, registry registration
- `tests/tools/registry.test.ts` — updated counts and new tool checks

## Risks

1. **YAML generation without a library**: Building YAML via string templates is brittle if structure gets complex. Mitigation: keep workflows minimal and well-tested with substring assertions. The spec says "test with a YAML parser or snapshot" — substring checks are simpler and avoid adding a dependency.

2. **gh api response shape**: The GitHub branch protection API response structure could vary between GitHub.com and GHES. Mitigation: test against realistic mock responses; handle missing fields gracefully with 'warn' status rather than crashing.

3. **ci-generate reuse in repo-init**: Calling the tool handler would require constructing a full ToolContext. Instead, extract the generation logic into a standalone exported function that both the tool handler and repo-init can call directly.

4. **Remote URL parsing**: Git remotes can be SSH (`git@github.com:owner/repo.git`) or HTTPS (`https://github.com/owner/repo.git`). The compliance-check tool needs to handle both formats when extracting owner/repo.

## Estimated Effort

~300 lines of tool implementation across 3 files, ~250 lines of tests across 3 test files, plus ~30 lines of index/registry changes. Moderate complexity — mostly template generation and JSON parsing. Estimate: 2-3 hours of focused work.
