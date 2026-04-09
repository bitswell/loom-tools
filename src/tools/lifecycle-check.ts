import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';
import { parseTrailersMulti } from '../util/trailers.js';

/**
 * Task-Status values recognized by the LOOM lifecycle.
 *
 * Mirrors the enum in trailer-validate but is re-declared here so
 * lifecycle-check remains self-contained.
 */
export type TaskStatus =
  | 'ASSIGNED'
  | 'PLANNING'
  | 'IMPLEMENTING'
  | 'COMPLETED'
  | 'BLOCKED'
  | 'FAILED';

/**
 * Lifecycle state — either a TaskStatus or the sentinel 'START' used
 * before any Task-Status commit has been observed on the branch.
 */
export type LifecycleState = TaskStatus | 'START';

const TASK_STATUS_SET: ReadonlySet<string> = new Set([
  'ASSIGNED',
  'PLANNING',
  'IMPLEMENTING',
  'COMPLETED',
  'BLOCKED',
  'FAILED',
]);

const TERMINAL_STATES: ReadonlySet<LifecycleState> = new Set([
  'COMPLETED',
  'FAILED',
]);

/**
 * State machine for LOOM Task-Status transitions.
 *
 * Legal next-states keyed by current state. Terminal states map to
 * the empty set. The 'START' sentinel only permits ASSIGNED.
 */
const LEGAL: Record<LifecycleState, ReadonlySet<TaskStatus>> = {
  START: new Set<TaskStatus>(['ASSIGNED']),
  ASSIGNED: new Set<TaskStatus>(['PLANNING']),
  PLANNING: new Set<TaskStatus>(['IMPLEMENTING', 'BLOCKED', 'FAILED']),
  IMPLEMENTING: new Set<TaskStatus>([
    'IMPLEMENTING',
    'BLOCKED',
    'COMPLETED',
    'FAILED',
  ]),
  BLOCKED: new Set<TaskStatus>(['IMPLEMENTING', 'FAILED']),
  COMPLETED: new Set<TaskStatus>(),
  FAILED: new Set<TaskStatus>(),
};

/**
 * Pure transition function for the LOOM state machine.
 *
 * Returns ok=true with the new state on a legal edge, ok=false with a
 * human-readable error describing why the edge is illegal otherwise.
 * Unit-tested directly in addition to end-to-end lifecycle-check tests.
 */
export function transition(
  current: LifecycleState,
  next: TaskStatus,
): { ok: true; state: LifecycleState } | { ok: false; error: string } {
  const allowed = LEGAL[current];
  if (allowed.has(next)) {
    return { ok: true, state: next };
  }
  const allowedList = [...allowed].join(', ') || '<none: terminal>';
  return {
    ok: false,
    error: `illegal transition ${current} -> ${next} (allowed: ${allowedList})`,
  };
}

const LifecycleCheckInput = z.object({
  branch: z
    .string()
    .describe('Branch ref to walk (the tip of the LOOM branch).'),
  base: z
    .string()
    .describe(
      'Base ref (exclusive lower bound). lifecycle-check walks base..branch.',
    ),
  heartbeatWarnSec: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Warn if the gap between consecutive IMPLEMENTING Heartbeats exceeds this many seconds. Default: 300 (5 min, per issue #66).',
    ),
  heartbeatErrorSec: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Error if the gap between consecutive IMPLEMENTING Heartbeats exceeds this many seconds. Default: 900 (15 min, per issue #66).',
    ),
});

const Violation = z.object({
  rule: z.string(),
  commit: z.string(),
  detail: z.string(),
  severity: z.enum(['error', 'warn']),
});

const Transition = z.object({
  from: z.string(),
  to: z.string(),
  commit: z.string(),
});

const LifecycleCheckOutput = z.object({
  ok: z.boolean(),
  violations: z.array(Violation),
  transitions: z.array(Transition),
});

type LifecycleCheckIn = z.infer<typeof LifecycleCheckInput>;
type LifecycleCheckOut = z.infer<typeof LifecycleCheckOutput>;
type ViolationT = z.infer<typeof Violation>;
type TransitionT = z.infer<typeof Transition>;

const HEARTBEAT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function first(
  trailers: Record<string, string[]>,
  key: string,
): string | undefined {
  const v = trailers[key];
  return v && v.length > 0 ? v[0] : undefined;
}

function parseHeartbeat(raw: string | undefined): Date | null {
  if (raw === undefined) return null;
  if (!HEARTBEAT_RE.test(raw)) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Walk a LOOM branch and verify its Task-Status sequence obeys the
 * lifecycle state machine.
 *
 * Detects skipped states, post-terminal work, multiple COMPLETEDs,
 * missing ASSIGNED, and Heartbeat gaps during IMPLEMENTING.
 *
 * Uses `git log --reverse --first-parent` so merge-in commits from
 * the base branch are not treated as lifecycle events on the walked
 * branch.
 */
export const lifecycleCheckTool: Tool<LifecycleCheckIn, LifecycleCheckOut> = {
  definition: {
    name: 'lifecycle-check',
    description:
      'Walk a LOOM branch and verify its Task-Status sequence against the lifecycle state machine.',
    inputSchema: LifecycleCheckInput,
    outputSchema: LifecycleCheckOutput,
    roles: ['writer', 'reviewer', 'orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;
    // Defaults per issue #66: warn at 5 min, error at 15 min while IMPLEMENTING.
    const warnSec = input.heartbeatWarnSec ?? 300;
    const errorSec = input.heartbeatErrorSec ?? 900;

    // Enumerate commits in base..branch in chronological order, walking
    // only the first-parent lineage. If the range is empty, this is
    // still "fine" at the exec level — we just report lifecycle-missing-
    // assigned post-walk.
    const range = `${input.base}..${input.branch}`;
    const logResult = await exec(
      'git',
      ['log', '--reverse', '--first-parent', '--format=%H', range],
      cwd,
    );
    if (logResult.exitCode !== 0) {
      return err(
        'range-invalid',
        `Could not walk range '${range}': ${logResult.stderr.trim()}`,
        false,
      );
    }

    const shas = logResult.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    let state: LifecycleState = 'START';
    const transitions: TransitionT[] = [];
    const violations: ViolationT[] = [];
    let prevHeartbeat: Date | null = null;
    let prevHeartbeatIso: string | null = null;
    let assignedCount = 0;
    let completedCount = 0;
    let terminalReachedAt: string | null = null;

    for (const sha of shas) {
      // Read trailers for this commit. Each call is a subprocess —
      // acceptable for typical LOOM branches (<50 commits). See R7 in
      // the plan for the optimization path if this becomes hot.
      const tr = await exec(
        'git',
        ['log', '-1', '--format=%(trailers)', sha],
        cwd,
      );
      if (tr.exitCode !== 0) {
        return err(
          'trailers-read-failed',
          `Could not read trailers for ${sha}: ${tr.stderr.trim()}`,
          false,
        );
      }
      const trailers = parseTrailersMulti(tr.stdout);

      // lifecycle-post-terminal: any commit whose predecessor was
      // already in a terminal state is illegal, Task-Status or not.
      if (terminalReachedAt !== null) {
        violations.push({
          rule: 'lifecycle-post-terminal',
          commit: sha,
          detail: `commit ${sha.slice(0, 8)} follows terminal state ${state} reached at ${terminalReachedAt.slice(0, 8)}`,
          severity: 'error',
        });
      }

      const rawStatus = first(trailers, 'Task-Status');
      const status: TaskStatus | undefined =
        rawStatus !== undefined && TASK_STATUS_SET.has(rawStatus)
          ? (rawStatus as TaskStatus)
          : undefined;

      if (status !== undefined) {
        if (status === 'ASSIGNED') assignedCount++;
        if (status === 'COMPLETED') completedCount++;

        const result = transition(state, status);
        if (!result.ok) {
          violations.push({
            rule: 'lifecycle-illegal-transition',
            commit: sha,
            detail: `${result.error} at ${sha.slice(0, 8)}`,
            severity: 'error',
          });
          // Continue walking with the new state so we catch cascading
          // issues on subsequent commits. Tests assert via toContain()
          // so extra downstream violations are tolerated.
        }

        transitions.push({ from: state, to: status, commit: sha });
        state = status;

        // Enter terminal tracking as soon as we transition into a
        // terminal state. The current commit is not itself "after
        // terminal" — only subsequent commits are.
        if (TERMINAL_STATES.has(state) && terminalReachedAt === null) {
          terminalReachedAt = sha;
        }

        // Heartbeat logic scoped to IMPLEMENTING commits.
        const heartbeatRaw = first(trailers, 'Heartbeat');
        if (status === 'IMPLEMENTING') {
          const hb = parseHeartbeat(heartbeatRaw);
          if (hb === null) {
            // Missing or unparseable: lifecycle-check treats both as
            // missing. trailer-validate owns format validation.
            violations.push({
              rule: 'lifecycle-heartbeat-missing',
              commit: sha,
              detail: `IMPLEMENTING commit ${sha.slice(0, 8)} has no valid Heartbeat trailer`,
              severity: 'error',
            });
            // Do NOT advance prevHeartbeat on missing/unparseable —
            // a later valid heartbeat will compare against the last
            // valid one.
          } else {
            if (prevHeartbeat !== null) {
              const gapSec = Math.floor(
                (hb.getTime() - prevHeartbeat.getTime()) / 1000,
              );
              if (gapSec < 0) {
                // Time travel: this Heartbeat is earlier than the
                // previous IMPLEMENTING heartbeat. Without this branch,
                // a negative gap silently passes (both > checks are
                // false). Flag it as its own rule so callers can
                // distinguish "silent" from "slow".
                violations.push({
                  rule: 'lifecycle-heartbeat-backward',
                  commit: sha,
                  detail: `Heartbeat moved backward by ${-gapSec}s (from ${prevHeartbeatIso ?? '<unknown>'} to ${heartbeatRaw ?? '<unknown>'})`,
                  severity: 'error',
                });
              } else if (gapSec > errorSec) {
                violations.push({
                  rule: 'lifecycle-heartbeat-gap-error',
                  commit: sha,
                  detail: `heartbeat gap of ${gapSec}s exceeds error threshold of ${errorSec}s`,
                  severity: 'error',
                });
              } else if (gapSec > warnSec) {
                violations.push({
                  rule: 'lifecycle-heartbeat-gap-warn',
                  commit: sha,
                  detail: `heartbeat gap of ${gapSec}s exceeds warn threshold of ${warnSec}s`,
                  severity: 'warn',
                });
              }
            }
            prevHeartbeat = hb;
            prevHeartbeatIso = heartbeatRaw ?? null;
          }
        } else {
          // Leaving IMPLEMENTING resets the heartbeat window so a
          // future re-entry (BLOCKED -> IMPLEMENTING) starts fresh.
          prevHeartbeat = null;
          prevHeartbeatIso = null;
        }
      }
      // Non-Task-Status commits do not affect state or heartbeat window.
      // They DO still trigger lifecycle-post-terminal (handled above).
    }

    // Post-walk invariants.
    const headSha = shas.length > 0 ? shas[shas.length - 1] : input.branch;

    if (assignedCount === 0) {
      violations.push({
        rule: 'lifecycle-missing-assigned',
        commit: headSha,
        detail: 'branch has no Task-Status: ASSIGNED commit',
        severity: 'error',
      });
    } else if (assignedCount > 1) {
      violations.push({
        rule: 'lifecycle-multiple-assigned',
        commit: headSha,
        detail: `branch has ${assignedCount} ASSIGNED commits, expected exactly 1`,
        severity: 'error',
      });
    }

    if (completedCount > 1) {
      violations.push({
        rule: 'lifecycle-multiple-completed',
        commit: headSha,
        detail: `branch has ${completedCount} COMPLETED commits, expected at most 1`,
        severity: 'error',
      });
    }

    const hasErrors = violations.some((v) => v.severity === 'error');
    return ok({ ok: !hasErrors, violations, transitions });
  },
};
