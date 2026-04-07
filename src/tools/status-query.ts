import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';
import { parseTrailers } from '../util/trailers.js';

const StatusQueryInput = z.object({
  pattern: z
    .string()
    .optional()
    .describe('Branch name pattern to scan (default: loom/*)'),
});

const BranchStatus = z.object({
  status: z.string().optional(),
  agentId: z.string().optional(),
  lastHeartbeat: z.string().optional(),
});

const StatusQueryOutput = z.object({
  branches: z.record(BranchStatus),
});

type StatusQueryIn = z.infer<typeof StatusQueryInput>;
type StatusQueryOut = z.infer<typeof StatusQueryOutput>;

export const statusQueryTool: Tool<StatusQueryIn, StatusQueryOut> = {
  definition: {
    name: 'status-query',
    description:
      'Scan loom/* branches and read the latest Task-Status trailer from each.',
    inputSchema: StatusQueryInput,
    outputSchema: StatusQueryOutput,
    roles: ['writer', 'reviewer', 'orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;
    const pattern = input.pattern ?? 'loom/*';

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
    const result: Record<
      string,
      { status?: string; agentId?: string; lastHeartbeat?: string }
    > = {};

    for (const branch of branches) {
      // Read latest commit trailers
      const trailerResult = await exec(
        'git',
        ['log', '-1', '--format=%(trailers)', branch],
        cwd,
      );

      const trailers = parseTrailers(trailerResult.stdout);
      result[branch] = {
        status: trailers['Task-Status'],
        agentId: trailers['Agent-Id'],
        lastHeartbeat: trailers['Heartbeat'],
      };
    }

    return ok({ branches: result });
  },
};

