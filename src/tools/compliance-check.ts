import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const ComplianceCheckInput = z.object({
  repoPath: z
    .string()
    .optional()
    .describe('Path to the repository (default: current directory)'),
  remote: z
    .string()
    .optional()
    .describe('Git remote name (default: origin)'),
});

const RuleResult = z.object({
  rule: z.string(),
  status: z.enum(['pass', 'fail', 'warn']),
  detail: z.string(),
});

const ComplianceCheckOutput = z.object({
  rules: z.array(RuleResult),
  overall: z.enum(['pass', 'fail']),
});

type ComplianceCheckIn = z.infer<typeof ComplianceCheckInput>;
type ComplianceCheckOut = z.infer<typeof ComplianceCheckOutput>;
type RuleResultType = z.infer<typeof RuleResult>;

/**
 * Extract owner/repo from a git remote URL.
 * Handles both SSH and HTTPS formats:
 *   git@github.com:owner/repo.git  -> owner/repo
 *   https://github.com/owner/repo.git -> owner/repo
 *   https://github.com/owner/repo -> owner/repo
 */
export function parseOwnerRepo(remoteUrl: string): string | null {
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?\s*$/);
  if (sshMatch) return sshMatch[1];

  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(
    /https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\s*$/,
  );
  if (httpsMatch) return httpsMatch[1];

  return null;
}

export const complianceCheckTool: Tool<ComplianceCheckIn, ComplianceCheckOut> = {
  definition: {
    name: 'compliance-check',
    description:
      'Check repository compliance: branch protection, review requirements, status checks.',
    inputSchema: ComplianceCheckInput,
    outputSchema: ComplianceCheckOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    // 1. Get remote URL
    const remoteResult = await exec(
      'git',
      ['remote', 'get-url', input.remote ?? 'origin'],
      cwd,
    );
    if (remoteResult.exitCode !== 0) {
      return err(
        'remote-not-found',
        `Could not get URL for remote '${input.remote}': ${remoteResult.stderr.trim()}`,
        false,
      );
    }

    const ownerRepo = parseOwnerRepo(remoteResult.stdout.trim());
    if (!ownerRepo) {
      return err(
        'parse-failed',
        `Could not parse owner/repo from remote URL: ${remoteResult.stdout.trim()}`,
        false,
      );
    }

    // 2. Get default branch
    const repoResult = await exec(
      'gh',
      ['api', `repos/${ownerRepo}`, '--jq', '.default_branch'],
      cwd,
    );
    if (repoResult.exitCode !== 0) {
      return err(
        'api-failed',
        `Could not query repo info: ${repoResult.stderr.trim()}`,
        true,
      );
    }
    const defaultBranch = repoResult.stdout.trim();

    // 3. Query branch protection
    const protectionResult = await exec(
      'gh',
      ['api', `repos/${ownerRepo}/branches/${defaultBranch}/protection`],
      cwd,
    );

    const rules: RuleResultType[] = [];

    // If the protection endpoint returns non-zero, protection is not enabled
    if (protectionResult.exitCode !== 0) {
      rules.push({
        rule: 'branch-protection-enabled',
        status: 'fail',
        detail: 'Branch protection is not enabled on the default branch',
      });
      return ok({
        rules,
        overall: 'fail',
      });
    }

    // Protection is enabled
    rules.push({
      rule: 'branch-protection-enabled',
      status: 'pass',
      detail: 'Branch protection is enabled',
    });

    let protection: Record<string, unknown>;
    try {
      protection = JSON.parse(protectionResult.stdout);
    } catch {
      return err(
        'parse-failed',
        'Could not parse branch protection JSON response',
        true,
      );
    }

    // Check: require pull request reviews
    const reviews = protection.required_pull_request_reviews as
      | Record<string, unknown>
      | undefined;
    if (reviews) {
      const count =
        (reviews.required_approving_review_count as number) ?? 0;
      if (count >= 1) {
        rules.push({
          rule: 'require-pr-reviews',
          status: 'pass',
          detail: `Requires ${count} approving review(s)`,
        });
      } else {
        rules.push({
          rule: 'require-pr-reviews',
          status: 'fail',
          detail: 'Pull request reviews required but 0 approvers configured',
        });
      }
    } else {
      rules.push({
        rule: 'require-pr-reviews',
        status: 'fail',
        detail: 'Pull request reviews are not required',
      });
    }

    // Check: require status checks
    const statusChecks = protection.required_status_checks as
      | Record<string, unknown>
      | undefined;
    if (statusChecks) {
      rules.push({
        rule: 'require-status-checks',
        status: 'pass',
        detail: 'Status checks are required before merging',
      });
    } else {
      rules.push({
        rule: 'require-status-checks',
        status: 'fail',
        detail: 'Status checks are not required',
      });
    }

    // Check: no force pushes
    const forcePush = protection.allow_force_pushes as
      | Record<string, unknown>
      | undefined;
    if (forcePush && forcePush.enabled === true) {
      rules.push({
        rule: 'no-force-push',
        status: 'fail',
        detail: 'Force pushes are allowed',
      });
    } else {
      rules.push({
        rule: 'no-force-push',
        status: 'pass',
        detail: 'Force pushes are not allowed',
      });
    }

    // Check: no deletions
    const deletions = protection.allow_deletions as
      | Record<string, unknown>
      | undefined;
    if (deletions && deletions.enabled === true) {
      rules.push({
        rule: 'no-deletions',
        status: 'fail',
        detail: 'Branch deletion is allowed',
      });
    } else {
      rules.push({
        rule: 'no-deletions',
        status: 'pass',
        detail: 'Branch deletion is not allowed',
      });
    }

    // Check: signed commits (warn level)
    const signatures = protection.required_signatures as
      | Record<string, unknown>
      | undefined;
    if (signatures && signatures.enabled === true) {
      rules.push({
        rule: 'signed-commits',
        status: 'pass',
        detail: 'Signed commits are required',
      });
    } else {
      rules.push({
        rule: 'signed-commits',
        status: 'warn',
        detail: 'Signed commits are not required',
      });
    }

    // Determine overall status: fail if any rule is 'fail'
    const overall = rules.some((r) => r.status === 'fail') ? 'fail' : 'pass';

    return ok({ rules, overall });
  },
};
