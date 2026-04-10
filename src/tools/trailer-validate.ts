import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';
import { parseTrailersMulti } from '../util/trailers.js';

const TrailerValidateInput = z.object({
  ref: z
    .string()
    .describe('Git ref to validate (branch, tag, SHA, HEAD~N, etc.)'),
  strict: z
    .boolean()
    .optional()
    .describe(
      'If true, treat warnings as errors (e.g., missing Heartbeat for IMPLEMENTING).',
    ),
});

const Violation = z.object({
  rule: z.string(),
  detail: z.string(),
  severity: z.enum(['error', 'warn']),
});

const TrailerValidateOutput = z.object({
  ok: z.boolean(),
  violations: z.array(Violation),
});

type TrailerValidateIn = z.infer<typeof TrailerValidateInput>;
type TrailerValidateOut = z.infer<typeof TrailerValidateOutput>;
type ViolationT = z.infer<typeof Violation>;

const TASK_STATUS_ENUM = new Set([
  'ASSIGNED',
  'PLANNING',
  'IMPLEMENTING',
  'COMPLETED',
  'BLOCKED',
  'FAILED',
]);

const ERROR_CATEGORY_ENUM = new Set([
  'task_unclear',
  'blocked',
  'resource_limit',
  'conflict',
  'internal',
]);

const HEARTBEAT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function first(
  trailers: Record<string, string[]>,
  key: string,
): string | undefined {
  const v = trailers[key];
  return v && v.length > 0 ? v[0] : undefined;
}

/**
 * Validate LOOM protocol trailers on a commit.
 *
 * Runs a set of named rules against the commit's trailer block.
 * Each violation references a stable rule ID so callers (and tests)
 * can assert on specific failures rather than free-form messages.
 */
export const trailerValidateTool: Tool<TrailerValidateIn, TrailerValidateOut> = {
  definition: {
    name: 'trailer-validate',
    description:
      'Validate LOOM protocol trailers on a commit against the protocol rules.',
    inputSchema: TrailerValidateInput,
    outputSchema: TrailerValidateOutput,
    roles: ['writer', 'reviewer', 'orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    const logResult = await exec(
      'git',
      ['log', '-1', '--format=%(trailers)', input.ref],
      cwd,
    );
    if (logResult.exitCode !== 0) {
      return err(
        'ref-invalid',
        `Could not read trailers for ref '${input.ref}': ${logResult.stderr.trim()}`,
        false,
      );
    }

    const trailers = parseTrailersMulti(logResult.stdout);
    const violations: ViolationT[] = [];
    const strict = input.strict ?? false;

    // Agent-Id required
    const agentId = first(trailers, 'Agent-Id');
    if (!agentId) {
      violations.push({
        rule: 'agent-id-required',
        detail: 'Agent-Id trailer is missing or empty',
        severity: 'error',
      });
    }

    // Session-Id required
    const sessionId = first(trailers, 'Session-Id');
    if (!sessionId) {
      violations.push({
        rule: 'session-id-required',
        detail: 'Session-Id trailer is missing or empty',
        severity: 'error',
      });
    }

    // Task-Status: optional, but if present must be in enum
    const taskStatus = first(trailers, 'Task-Status');
    if (taskStatus && !TASK_STATUS_ENUM.has(taskStatus)) {
      violations.push({
        rule: 'task-status-enum',
        detail: `Task-Status '${taskStatus}' is not one of: ${[...TASK_STATUS_ENUM].join(', ')}`,
        severity: 'error',
      });
    }

    // COMPLETED invariants
    if (taskStatus === 'COMPLETED') {
      const filesChanged = first(trailers, 'Files-Changed');
      if (filesChanged === undefined) {
        violations.push({
          rule: 'completed-files-changed',
          detail: 'COMPLETED commit is missing the Files-Changed trailer',
          severity: 'error',
        });
      } else if (!/^\d+$/.test(filesChanged)) {
        violations.push({
          rule: 'completed-files-changed-int',
          detail: `Files-Changed '${filesChanged}' is not a non-negative integer`,
          severity: 'error',
        });
      }

      const keyFindings = trailers['Key-Finding'] ?? [];
      if (keyFindings.length === 0) {
        violations.push({
          rule: 'completed-key-finding-required',
          detail:
            'COMPLETED commit must have at least one Key-Finding trailer',
          severity: 'error',
        });
      }
    }

    // BLOCKED invariants
    if (taskStatus === 'BLOCKED') {
      const blockedReason = first(trailers, 'Blocked-Reason');
      if (!blockedReason) {
        violations.push({
          rule: 'blocked-reason-required',
          detail: 'BLOCKED commit must have a Blocked-Reason trailer',
          severity: 'error',
        });
      }
    }

    // FAILED invariants
    if (taskStatus === 'FAILED') {
      const errorCategory = first(trailers, 'Error-Category');
      if (!errorCategory) {
        violations.push({
          rule: 'failed-error-category-required',
          detail: 'FAILED commit must have an Error-Category trailer',
          severity: 'error',
        });
      } else if (!ERROR_CATEGORY_ENUM.has(errorCategory)) {
        violations.push({
          rule: 'failed-error-category-enum',
          detail: `Error-Category '${errorCategory}' is not one of: ${[...ERROR_CATEGORY_ENUM].join(', ')}`,
          severity: 'error',
        });
      }

      const errorRetryable = first(trailers, 'Error-Retryable');
      if (errorRetryable === undefined) {
        violations.push({
          rule: 'failed-error-retryable-required',
          detail: 'FAILED commit must have an Error-Retryable trailer',
          severity: 'error',
        });
      } else if (errorRetryable !== 'true' && errorRetryable !== 'false') {
        violations.push({
          rule: 'failed-error-retryable-bool',
          detail: `Error-Retryable '${errorRetryable}' must be 'true' or 'false'`,
          severity: 'error',
        });
      }
    }

    // ASSIGNED invariants
    if (taskStatus === 'ASSIGNED') {
      for (const [trailer, rule] of [
        ['Assigned-To', 'assigned-to-required'],
        ['Assignment', 'assignment-required'],
        ['Scope', 'scope-required'],
        ['Dependencies', 'dependencies-required'],
      ] as const) {
        if (!first(trailers, trailer)) {
          violations.push({
            rule,
            detail: `ASSIGNED commit must have a ${trailer} trailer`,
            severity: 'error',
          });
        }
      }

      const budget = first(trailers, 'Budget');
      if (!budget) {
        violations.push({
          rule: 'budget-required',
          detail: 'ASSIGNED commit must have a Budget trailer',
          severity: 'error',
        });
      } else {
        const n = parseInt(budget, 10);
        if (isNaN(n) || n <= 0) {
          violations.push({
            rule: 'budget-required',
            detail: `Budget '${budget}' must be a positive integer`,
            severity: 'error',
          });
        }
      }
    }

    // Heartbeat: if present must match ISO-8601 UTC; if missing on
    // IMPLEMENTING/COMPLETED/BLOCKED/FAILED, warn (or error under strict).
    const HEARTBEAT_STATES = new Set([
      'IMPLEMENTING',
      'COMPLETED',
      'BLOCKED',
      'FAILED',
    ]);
    const heartbeat = first(trailers, 'Heartbeat');
    if (heartbeat !== undefined && !HEARTBEAT_RE.test(heartbeat)) {
      violations.push({
        rule: 'heartbeat-format',
        detail: `Heartbeat '${heartbeat}' is not ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ)`,
        severity: 'error',
      });
    }

    if (
      taskStatus &&
      HEARTBEAT_STATES.has(taskStatus) &&
      heartbeat === undefined
    ) {
      violations.push({
        rule: 'heartbeat-missing',
        detail: `${taskStatus} commit should have a Heartbeat trailer`,
        severity: strict ? 'error' : 'warn',
      });
    }

    const hasErrors = violations.some((v) => v.severity === 'error');
    return ok({ ok: !hasErrors, violations });
  },
};
