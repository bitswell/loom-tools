# Phase 3 — Lifecycle, Workflow, and Self-Service Tools

## Approach

Implement 10 new tools following the exact patterns established by phase-2. Each tool is a standalone file exporting a `Tool<I, O>` with Zod schemas, role scoping, and a handler that shells out via `exec()`. Tests mock `exec` the same way `commit.test.ts` does. The registry and its test are updated to include all 16 tools.

The `parseTrailers` helper is duplicated in `status-query.ts` and `read-assignment.ts`. Factor it into `src/util/trailers.ts` and import from both existing tools and the new ones that need it (`wait`, `status`).

## Steps

1. **Extract `parseTrailers` to `src/util/trailers.ts`** — move the shared helper out of `status-query.ts` and `read-assignment.ts`, update their imports.

2. **Implement lifecycle tools (orchestrator-only)**:
   - `src/tools/assign.ts` — builds an ASSIGNED commit on a target branch with all required trailers (Agent-Id, Task-Status: ASSIGNED, Assigned-To, Assignment, Scope, Dependencies, Budget). Uses `exec` to run `git commit --allow-empty` with `--trailer` args. Returns commit SHA.
   - `src/tools/dispatch.ts` — creates a git worktree for a branch if needed (`git worktree add`), verifies the branch exists. Returns dispatch metadata (worktree path, branch, agent ID). Does not actually spawn a process — that is the runtime adapter's job.
   - `src/tools/wait.ts` — polls a branch's HEAD commit for a terminal Task-Status trailer (COMPLETED, FAILED, BLOCKED). Uses `setTimeout`-based polling with configurable interval and timeout. Returns the terminal status and parsed trailers.
   - `src/tools/status.ts` — extends `status-query` with richer output: agent ID, assignment name, last heartbeat, time since heartbeat, and staleness flag (>5 min since heartbeat). Scans `loom/*` branches.

3. **Implement workflow tools (orchestrator-only)**:
   - `src/tools/pr-create.ts` — shells out to `gh pr create --head <head> --base <base> --title <title> --body <body>`. Parses URL and PR number from stdout.
   - `src/tools/pr-retarget.ts` — shells out to `gh pr edit <number> --base <newBase>`. Returns success.
   - `src/tools/pr-merge.ts` — shells out to `gh pr merge <number> --<method>`. Parses merge SHA from output.
   - `src/tools/review-request.ts` — shells out to `gh pr edit <number> --add-reviewer <list>`. Returns success.
   - `src/tools/submodule.ts` — runs `git -C <submodulePath> checkout <ref>` then stages the submodule change. Returns new submodule SHA.

4. **Implement self-service tool (all roles)**:
   - `src/tools/tool-request.ts` — writes a commit with `Tool-Requested: <name>` trailer and reason in the body. If `blocking: true`, polls for a `Tool-Provided: <name>` trailer on the branch. Returns request status.

5. **Update `src/tools/index.ts`** — import all 10 new tools, add exports, register in `createDefaultRegistry()`.

6. **Update `src/index.ts`** — export the new `parseTrailers` util.

7. **Write tests**:
   - `tests/tools/assign.test.ts` — verify trailer construction, commit SHA returned.
   - `tests/tools/dispatch.test.ts` — verify worktree creation, branch verification.
   - `tests/tools/wait.test.ts` — verify polling with terminal status detection, timeout handling.
   - `tests/tools/status.test.ts` — verify richer output format, staleness calculation.
   - `tests/tools/pr-create.test.ts` — verify `gh` command construction, output parsing.
   - `tests/tools/pr-retarget.test.ts` — verify `gh pr edit` call.
   - `tests/tools/pr-merge.test.ts` — verify merge command and SHA extraction.
   - `tests/tools/review-request.test.ts` — verify reviewer list handling.
   - `tests/tools/submodule.test.ts` — verify checkout and staging.
   - `tests/tools/tool-request.test.ts` — verify commit creation, blocking poll.
   - `tests/util/trailers.test.ts` — unit tests for extracted `parseTrailers`.

8. **Update existing tests**:
   - `tests/tools/registry.test.ts` — update tool count from 6 to 16, add checks for new tools, update role assertions.
   - `tests/tools/schemas.test.ts` — add schema validation tests for all 10 new tools.

9. **Verify**: `npx tsc --noEmit` and `npx vitest run` both pass.

## Files to Modify

### New files
- `src/util/trailers.ts`
- `src/tools/assign.ts`
- `src/tools/dispatch.ts`
- `src/tools/wait.ts`
- `src/tools/status.ts`
- `src/tools/pr-create.ts`
- `src/tools/pr-retarget.ts`
- `src/tools/pr-merge.ts`
- `src/tools/review-request.ts`
- `src/tools/submodule.ts`
- `src/tools/tool-request.ts`
- `tests/tools/assign.test.ts`
- `tests/tools/dispatch.test.ts`
- `tests/tools/wait.test.ts`
- `tests/tools/status.test.ts`
- `tests/tools/pr-create.test.ts`
- `tests/tools/pr-retarget.test.ts`
- `tests/tools/pr-merge.test.ts`
- `tests/tools/review-request.test.ts`
- `tests/tools/submodule.test.ts`
- `tests/tools/tool-request.test.ts`
- `tests/util/trailers.test.ts`

### Modified files
- `src/tools/index.ts` — register all new tools
- `src/tools/status-query.ts` — import `parseTrailers` from util
- `src/tools/read-assignment.ts` — import `parseTrailers` from util
- `src/index.ts` — export `parseTrailers`
- `tests/tools/registry.test.ts` — update counts and assertions
- `tests/tools/schemas.test.ts` — add new tool schema tests

## Risks

1. **`wait` and `tool-request` use polling with `setTimeout`**. Need to use `vi.useFakeTimers()` in tests to avoid real delays. The polling loop must be cancellable via timeout.

2. **`gh` CLI availability**. The PR tools depend on `gh` being installed. Handlers should return clear errors if `gh` is not found. Tests mock `exec` so this is not a test concern.

3. **`dispatch` does not spawn processes**. The task description says "spawn an agent" but the tool layer should only prepare the worktree. Actual process spawning belongs to the runtime adapter. The tool prepares infrastructure and returns metadata.

4. **Registry test hardcodes tool count (6)**. Must update to 16. If a tool name is misspelled or its registration is skipped, the count test will catch it.

5. **`parseTrailers` extraction**. Must ensure no import breaks. Both `status-query.ts` and `read-assignment.ts` have their own copies — delete both and import from the shared util.

## Estimated Effort

- 10 tool implementations: ~40 min each avg (simpler tools like pr-retarget: 15 min, complex like wait: 60 min)
- Extract parseTrailers + update imports: 15 min
- Update registry + index: 15 min
- 12 test files: ~25 min each avg
- Integration verification (tsc, vitest): 15 min
- **Total: ~10-12 hours of focused work**
