import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';
import { validateScope } from '../util/scope.js';
import { parseTrailersMulti } from '../util/trailers.js';

const ScopeCheckInput = z.object({
  branch: z
    .string()
    .describe('Branch ref to check (tip of the LOOM branch).'),
  base: z
    .string()
    .optional()
    .describe('Base ref to diff against. Default: main.'),
  allowedPaths: z
    .array(z.string())
    .describe('Scope patterns for allowed paths (glob, directory prefix, or exact).'),
  deniedPaths: z
    .array(z.string())
    .optional()
    .describe('Scope patterns for denied paths. Files matching denied paths are always violations.'),
});

const Violation = z.object({
  file: z.string(),
  commit: z.string(),
  rule: z.enum(['scope-violation', 'scope-denied']),
});

const Expansion = z.object({
  file: z.string(),
  reason: z.string(),
  commit: z.string(),
});

const ScopeCheckOutput = z.object({
  ok: z.boolean(),
  violations: z.array(Violation),
  expansions: z.array(Expansion),
  checkedFiles: z.array(z.string()),
});

type ScopeCheckIn = z.infer<typeof ScopeCheckInput>;
type ScopeCheckOut = z.infer<typeof ScopeCheckOutput>;
type ViolationT = z.infer<typeof Violation>;
type ExpansionT = z.infer<typeof Expansion>;

/**
 * Find the first commit on base..branch that touched a given file.
 */
async function firstCommitForFile(
  cwd: string,
  base: string,
  branch: string,
  file: string,
): Promise<string> {
  const result = await exec(
    'git',
    [
      'log',
      '--reverse',
      '--diff-filter=ACMR',
      '--format=%H',
      `${base}..${branch}`,
      '--',
      file,
    ],
    cwd,
  );
  const shas = result.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return shas.length > 0 ? shas[0] : 'unknown';
}

/**
 * Collect all Scope-Expand trailers from commits on base..branch.
 *
 * Returns an array of { path, reason, commit } in chronological order.
 */
async function collectScopeExpands(
  cwd: string,
  base: string,
  branch: string,
): Promise<Array<{ path: string; reason: string; commit: string }>> {
  const logResult = await exec(
    'git',
    ['log', '--reverse', '--first-parent', '--format=%H', `${base}..${branch}`],
    cwd,
  );
  if (logResult.exitCode !== 0) return [];

  const shas = logResult.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const expands: Array<{ path: string; reason: string; commit: string }> = [];

  for (const sha of shas) {
    const tr = await exec(
      'git',
      ['log', '-1', '--format=%(trailers)', sha],
      cwd,
    );
    if (tr.exitCode !== 0) continue;

    const trailers = parseTrailersMulti(tr.stdout);
    const scopeExpandValues = trailers['Scope-Expand'] ?? [];

    for (const value of scopeExpandValues) {
      const sepIdx = value.indexOf('--');
      if (sepIdx === -1) continue;
      const p = value.slice(0, sepIdx).trim();
      const r = value.slice(sepIdx + 2).trim();
      if (p && r) {
        expands.push({ path: p, reason: r, commit: sha });
      }
    }
  }

  return expands;
}

/**
 * Check whether a file matches a denied path pattern.
 *
 * Uses the same matching logic as validateScope: directory prefix,
 * glob, or exact match.
 */
function isDenied(file: string, deniedPaths: string[]): boolean {
  if (deniedPaths.length === 0) return false;
  // Reuse validateScope with empty allowed (so everything fails allowed
  // check) and the denied list. A file is denied if validateScope
  // reports it as a violation when allowed=["**"] and denied=deniedPaths.
  const result = validateScope([file], ['**'], deniedPaths);
  return result.violations.length > 0;
}

/**
 * Validate that all files changed on a LOOM branch are within the
 * declared scope.
 *
 * Reports violations (out-of-scope files), expansions (out-of-scope
 * files covered by Scope-Expand trailers), and the full list of
 * checked files.
 */
export const scopeCheckTool: Tool<ScopeCheckIn, ScopeCheckOut> = {
  definition: {
    name: 'scope-check',
    description:
      'Validate that all files changed on a LOOM branch are within the declared scope.',
    inputSchema: ScopeCheckInput,
    outputSchema: ScopeCheckOutput,
    roles: ['writer', 'reviewer', 'orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;
    const base = input.base ?? 'main';
    const branch = input.branch;
    const allowedPaths = input.allowedPaths;
    const deniedPaths = input.deniedPaths ?? [];

    // 1. Get changed files
    const diffResult = await exec(
      'git',
      ['diff', '--name-only', `${base}..${branch}`],
      cwd,
    );
    if (diffResult.exitCode !== 0) {
      return err(
        'diff-failed',
        `Could not diff ${base}..${branch}: ${diffResult.stderr.trim()}`,
        false,
      );
    }

    const checkedFiles = diffResult.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Empty diff -> everything is fine
    if (checkedFiles.length === 0) {
      return ok({ ok: true, violations: [], expansions: [], checkedFiles: [] });
    }

    // 2. Run validateScope to find all violations.
    // Note: validateScope treats empty allowed as "allow all", but for
    // scope-check, empty allowedPaths means "nothing is allowed" — every
    // file is out of scope. Handle this by treating all files as
    // violations when allowedPaths is empty.
    const scopeResult =
      allowedPaths.length === 0
        ? { valid: false, violations: [...checkedFiles] }
        : validateScope(checkedFiles, allowedPaths, deniedPaths);

    if (scopeResult.valid) {
      // All files are in scope
      return ok({ ok: true, violations: [], expansions: [], checkedFiles });
    }

    // 3. Separate denied-path violations from scope violations
    const deniedFiles = new Set<string>();
    const nonDeniedViolations: string[] = [];

    for (const file of scopeResult.violations) {
      if (isDenied(file, deniedPaths)) {
        deniedFiles.add(file);
      } else {
        nonDeniedViolations.push(file);
      }
    }

    // 4. Collect Scope-Expand trailers from branch commits
    const expands = await collectScopeExpands(cwd, base, branch);

    // 5. Match non-denied violations against Scope-Expand paths
    const expansions: ExpansionT[] = [];
    const remainingViolations: string[] = [];

    for (const file of nonDeniedViolations) {
      const match = expands.find((e) => e.path === file);
      if (match) {
        expansions.push({
          file,
          reason: match.reason,
          commit: match.commit,
        });
      } else {
        remainingViolations.push(file);
      }
    }

    // 6. Build final violations with commit info
    const violations: ViolationT[] = [];

    for (const file of remainingViolations) {
      const commit = await firstCommitForFile(cwd, base, branch, file);
      violations.push({ file, commit, rule: 'scope-violation' });
    }

    for (const file of deniedFiles) {
      const commit = await firstCommitForFile(cwd, base, branch, file);
      violations.push({ file, commit, rule: 'scope-denied' });
    }

    return ok({
      ok: violations.length === 0,
      violations,
      expansions,
      checkedFiles,
    });
  },
};
