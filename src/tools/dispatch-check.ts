import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import type { ToolContext } from '../types/context.js';
import { ok } from '../types/result.js';
import { exec } from '../util/exec.js';
import { parseTrailersMulti } from '../util/trailers.js';
import { trailerValidateTool } from './trailer-validate.js';

const DispatchCheckInput = z.object({
  worktree: z
    .string()
    .describe(
      'Absolute path to the worktree being validated before spawn. The worktree must be a .loom/agents/<agent>/worktrees/<org>_<repo>_<slug> checkout whose HEAD is the ASSIGNED commit.',
    ),
});

const Violation = z.object({
  rule: z.string(),
  detail: z.string(),
  severity: z.enum(['error', 'warn']),
});

const DispatchCheckOutput = z.object({
  ok: z.boolean(),
  violations: z.array(Violation),
});

type DispatchCheckIn = z.infer<typeof DispatchCheckInput>;
type DispatchCheckOut = z.infer<typeof DispatchCheckOutput>;
type ViolationT = z.infer<typeof Violation>;

/**
 * Extract the trailing path segment after the final `<org>_<repo>_` prefix
 * in a .loom worktree directory name.
 *
 * Returns null if the worktree path doesn't match the expected shape:
 *   .../.loom/agents/<agent>/worktrees/<org>_<repo>_<slug>
 * where <slug> is non-empty.
 */
function parseWorktreeSlug(worktree: string): string | null {
  const re = /\.loom\/agents\/([^/]+)\/worktrees\/([^/_]+)_([^/_]+)_([^/]+)$/;
  const match = worktree.match(re);
  if (!match) return null;
  const slug = match[4];
  return slug && slug.length > 0 ? slug : null;
}

/**
 * Build a minimal ToolContext for invoking trailerValidateTool from
 * inside dispatch-check. Only `worktree` is actually read by
 * trailer-validate's handler; the other fields are stubbed with
 * values that are obviously not real runtime data.
 */
function stubContextFor(worktree: string): ToolContext {
  return {
    agentId: 'dispatch-check',
    sessionId: 'dispatch-check',
    role: 'orchestrator',
    branch: '',
    worktree,
    scope: [],
    scopeDenied: [],
    emit: async () => {},
  };
}

/**
 * Validate that an orchestrator's dispatch of a worktree is well-formed
 * BEFORE the worker agent is spawned. Six rules fire:
 *
 *   1. worktree-path-shape       — .loom/agents/<a>/worktrees/<o>_<r>_<slug>
 *   2. branch-name-shape         — current branch === loom/<slug>
 *   3. assigned-at-head          — HEAD has Task-Status: ASSIGNED
 *   4. assigned-trailers-valid   — delegates to trailer-validate
 *   5. no-sibling-agent-json     — <worktree>/../AGENT.json must not exist
 *   6. scope-paths-exist         — every Scope path exists in the worktree
 *
 * Rules are independent — every rule runs regardless of prior outcomes,
 * except rule #2's equality check is skipped when rule #1 failed
 * (we can't fabricate the expected branch name without a valid slug).
 */
export const dispatchCheckTool: Tool<DispatchCheckIn, DispatchCheckOut> = {
  definition: {
    name: 'dispatch-check',
    description:
      "Validate an orchestrator's dispatch (worktree layout, branch name, ASSIGNED commit, scope paths, no AGENT.json) before the worker is spawned.",
    inputSchema: DispatchCheckInput,
    outputSchema: DispatchCheckOutput,
    roles: ['orchestrator'],
  },
  handler: async (input) => {
    const worktree = input.worktree;
    const violations: ViolationT[] = [];

    // -------- Rule 1: worktree-path-shape --------
    const slug = parseWorktreeSlug(worktree);
    if (slug === null) {
      violations.push({
        rule: 'worktree-path-shape',
        detail: `Worktree path '${worktree}' does not match .loom/agents/<agent>/worktrees/<org>_<repo>_<slug>`,
        severity: 'error',
      });
    }

    // -------- Rule 2: branch-name-shape --------
    // Read the current branch. A failure here (detached HEAD, not a repo)
    // is itself a branch-name-shape violation — dispatch requires a
    // symbolic ref.
    const branchResult = await exec(
      'git',
      ['symbolic-ref', '--short', 'HEAD'],
      worktree,
    );
    let currentBranch: string | null = null;
    if (branchResult.exitCode !== 0) {
      violations.push({
        rule: 'branch-name-shape',
        detail: `Could not read current branch in '${worktree}': ${branchResult.stderr.trim() || 'git symbolic-ref failed'}`,
        severity: 'error',
      });
    } else {
      currentBranch = branchResult.stdout.trim();
      if (slug !== null) {
        const expected = `loom/${slug}`;
        if (currentBranch !== expected) {
          violations.push({
            rule: 'branch-name-shape',
            detail: `Branch '${currentBranch}' does not match expected 'loom/${slug}' derived from worktree slug`,
            severity: 'error',
          });
        }
      }
      // If slug is null, rule 1 already fired; don't double-report here.
    }

    // -------- Rule 3: assigned-at-head --------
    // Read HEAD trailers ONCE here and reuse for rule 6. Rule 4 deliberately
    // re-reads them via trailer-validate to keep the delegation pure.
    let headTrailers: Record<string, string[]> = {};
    const trailerResult = await exec(
      'git',
      ['log', '-1', '--format=%(trailers)', 'HEAD'],
      worktree,
    );
    if (trailerResult.exitCode !== 0) {
      violations.push({
        rule: 'assigned-at-head',
        detail: `Could not read HEAD trailers in '${worktree}': ${trailerResult.stderr.trim() || 'git log failed'}`,
        severity: 'error',
      });
    } else {
      headTrailers = parseTrailersMulti(trailerResult.stdout);
      const taskStatus = headTrailers['Task-Status']?.[0];
      if (taskStatus !== 'ASSIGNED') {
        violations.push({
          rule: 'assigned-at-head',
          detail:
            taskStatus === undefined
              ? 'HEAD commit has no Task-Status trailer; expected ASSIGNED'
              : `HEAD commit has Task-Status '${taskStatus}'; expected ASSIGNED`,
          severity: 'error',
        });
      }
    }

    // -------- Rule 4: assigned-trailers-valid --------
    // Delegate to trailer-validate. Only surface its errors — warnings
    // (e.g. heartbeat-missing) don't apply to ASSIGNED commits anyway.
    const tvResult = await trailerValidateTool.handler(
      { ref: 'HEAD', strict: false },
      stubContextFor(worktree),
    );
    if (tvResult.success) {
      for (const v of tvResult.data.violations) {
        if (v.severity !== 'error') continue;
        violations.push({
          rule: 'assigned-trailers-valid',
          detail: `${v.rule}: ${v.detail}`,
          severity: 'error',
        });
      }
    } else {
      // trailer-validate errored (e.g. ref-invalid). Surface as a rule-4
      // violation so dispatch-check has a single failure surface.
      violations.push({
        rule: 'assigned-trailers-valid',
        detail: `trailer-validate failed: ${tvResult.error.code}: ${tvResult.error.message}`,
        severity: 'error',
      });
    }

    // -------- Rule 5: no-sibling-agent-json --------
    const siblingAgentJson = path.join(worktree, '..', 'AGENT.json');
    if (existsSync(siblingAgentJson)) {
      violations.push({
        rule: 'no-sibling-agent-json',
        detail: `AGENT.json found at '${siblingAgentJson}'; the protocol commits to removing AGENT.json — use commit trailers instead`,
        severity: 'error',
      });
    }

    // -------- Rule 6: scope-paths-exist --------
    // Parse the Scope trailer from the trailers we already read in rule 3.
    // If Scope is absent, rule 4 (via trailer-validate) already surfaces
    // scope-required — don't double-report. No-op here.
    const scopeValues = headTrailers['Scope'] ?? [];
    if (scopeValues.length > 0) {
      const scopePaths = scopeValues
        .flatMap((v) => v.split(/\s+/))
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const rel of scopePaths) {
        const abs = path.join(worktree, rel);
        if (!existsSync(abs)) {
          violations.push({
            rule: 'scope-paths-exist',
            detail: `Scope path '${rel}' does not exist in worktree`,
            severity: 'error',
          });
        }
      }
    }

    const hasErrors = violations.some((v) => v.severity === 'error');
    return ok({ ok: !hasErrors, violations });
  },
};
