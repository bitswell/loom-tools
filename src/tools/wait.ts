import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';
import { parseTrailers } from '../util/trailers.js';

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'BLOCKED'] as const;

const WaitInput = z.object({
  branch: z.string().describe('Branch to poll for terminal status'),
  pollIntervalMs: z
    .number()
    .optional()
    .describe('Polling interval in milliseconds (default: 5000)'),
  timeoutMs: z
    .number()
    .optional()
    .describe('Timeout in milliseconds (default: 300000 / 5 min)'),
});

const WaitOutput = z.object({
  status: z.string().describe('Terminal status found (COMPLETED, FAILED, or BLOCKED)'),
  branch: z.string().describe('Branch that was polled'),
  trailers: z.record(z.string()).describe('All trailers from the terminal commit'),
});

type WaitIn = z.infer<typeof WaitInput>;
type WaitOut = z.infer<typeof WaitOutput>;

/**
 * Check a branch's HEAD commit for a terminal Task-Status trailer.
 * Returns the status and trailers if found, or null if not terminal.
 */
async function checkBranch(
  branch: string,
  cwd: string,
): Promise<{ status: string; trailers: Record<string, string> } | null> {
  const result = await exec(
    'git',
    ['log', '-1', '--format=%(trailers)', branch],
    cwd,
  );
  if (result.exitCode !== 0) return null;

  const trailers = parseTrailers(result.stdout);
  const status = trailers['Task-Status'];
  if (status && (TERMINAL_STATUSES as readonly string[]).includes(status)) {
    return { status, trailers };
  }
  return null;
}

export const waitTool: Tool<WaitIn, WaitOut> = {
  definition: {
    name: 'wait',
    description:
      'Poll a branch until it reaches a terminal state (COMPLETED, FAILED, BLOCKED).',
    inputSchema: WaitInput,
    outputSchema: WaitOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;
    const pollInterval = input.pollIntervalMs ?? 5000;
    const timeout = input.timeoutMs ?? 300000;

    // Check immediately before starting poll loop
    const immediate = await checkBranch(input.branch, cwd);
    if (immediate) {
      return ok({
        status: immediate.status,
        branch: input.branch,
        trailers: immediate.trailers,
      });
    }

    // Poll with setTimeout
    return new Promise((resolve) => {
      const startTime = Date.now();

      const poll = () => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeout) {
          resolve(
            err('timeout', `Timed out after ${timeout}ms waiting for ${input.branch}`, true),
          );
          return;
        }

        setTimeout(async () => {
          const found = await checkBranch(input.branch, cwd);
          if (found) {
            resolve(
              ok({
                status: found.status,
                branch: input.branch,
                trailers: found.trailers,
              }),
            );
          } else {
            poll();
          }
        }, pollInterval);
      };

      poll();
    });
  },
};

/** Exported for testing. */
export { checkBranch, TERMINAL_STATUSES };
