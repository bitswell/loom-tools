import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';
import { parseTrailers } from '../util/trailers.js';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

const StatusInput = z.object({
  pattern: z
    .string()
    .optional()
    .describe('Branch name pattern to scan (default: loom/*)'),
});

const AgentStatus = z.object({
  agentId: z.string().optional(),
  assignment: z.string().optional(),
  status: z.string().optional(),
  lastHeartbeat: z.string().optional(),
  timeSinceHeartbeatMs: z.number().optional(),
  stale: z.boolean(),
});

const StatusOutput = z.object({
  agents: z.array(
    z.object({
      branch: z.string(),
      agentId: z.string().optional(),
      assignment: z.string().optional(),
      status: z.string().optional(),
      lastHeartbeat: z.string().optional(),
      timeSinceHeartbeatMs: z.number().optional(),
      stale: z.boolean(),
    }),
  ),
});

type StatusIn = z.infer<typeof StatusInput>;
type StatusOut = z.infer<typeof StatusOutput>;

export const statusTool: Tool<StatusIn, StatusOut> = {
  definition: {
    name: 'status',
    description:
      'Dashboard of all agent states across loom/* branches with staleness detection.',
    inputSchema: StatusInput,
    outputSchema: StatusOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;
    const pattern = input.pattern ?? 'loom/*';
    const now = Date.now();

    // List branches matching pattern
    const branchResult = await exec(
      'git',
      ['for-each-ref', '--format=%(refname:short)', `refs/heads/${pattern}`],
      cwd,
    );
    if (branchResult.exitCode !== 0) {
      return err('git-branch-failed', branchResult.stderr.trim(), true);
    }

    const branches = branchResult.stdout.trim().split('\n').filter(Boolean);
    const agents: StatusOut['agents'] = [];

    for (const branch of branches) {
      const trailerResult = await exec(
        'git',
        ['log', '-1', '--format=%(trailers)', branch],
        cwd,
      );

      const trailers = parseTrailers(trailerResult.stdout);

      let timeSinceHeartbeatMs: number | undefined;
      let stale = false;
      if (trailers['Heartbeat']) {
        const heartbeatTime = new Date(trailers['Heartbeat']).getTime();
        if (!isNaN(heartbeatTime)) {
          timeSinceHeartbeatMs = now - heartbeatTime;
          stale = timeSinceHeartbeatMs > STALE_THRESHOLD_MS;
        }
      }

      agents.push({
        branch,
        agentId: trailers['Agent-Id'],
        assignment: trailers['Assignment'],
        status: trailers['Task-Status'],
        lastHeartbeat: trailers['Heartbeat'],
        timeSinceHeartbeatMs,
        stale,
      });
    }

    return ok({ agents });
  },
};

/** Exported for testing. */
export { STALE_THRESHOLD_MS };
