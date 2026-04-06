import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const DispatchInput = z.object({
  agentId: z.string().describe('Agent to dispatch'),
  worktreePath: z.string().describe('Path where the worktree should be created'),
  phase: z
    .enum(['planning', 'implementation'])
    .describe('Phase the agent is being dispatched for'),
  branch: z
    .string()
    .optional()
    .describe('Branch to check out in the worktree. Defaults to loom/<agentId>'),
});

const DispatchOutput = z.object({
  worktreePath: z.string().describe('Path to the created worktree'),
  branch: z.string().describe('Branch checked out in the worktree'),
  agentId: z.string().describe('Agent ID that was dispatched'),
  phase: z.string().describe('Phase the agent was dispatched for'),
});

type DispatchIn = z.infer<typeof DispatchInput>;
type DispatchOut = z.infer<typeof DispatchOutput>;

export const dispatchTool: Tool<DispatchIn, DispatchOut> = {
  definition: {
    name: 'dispatch',
    description:
      'Prepare a git worktree for an agent. Does not spawn the agent process — that is the runtime adapter\'s job.',
    inputSchema: DispatchInput,
    outputSchema: DispatchOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;
    const branch = input.branch ?? `loom/${input.agentId}`;

    // Verify the branch exists
    const branchCheck = await exec(
      'git',
      ['rev-parse', '--verify', branch],
      cwd,
    );
    if (branchCheck.exitCode !== 0) {
      return err(
        'branch-not-found',
        `Branch '${branch}' does not exist. Create it or assign first.`,
        false,
      );
    }

    // Create the worktree
    const worktreeResult = await exec(
      'git',
      ['worktree', 'add', input.worktreePath, branch],
      cwd,
    );
    if (worktreeResult.exitCode !== 0) {
      // Worktree might already exist — check
      if (worktreeResult.stderr.includes('already checked out')) {
        return ok({
          worktreePath: input.worktreePath,
          branch,
          agentId: input.agentId,
          phase: input.phase,
        });
      }
      return err('worktree-failed', worktreeResult.stderr.trim(), true);
    }

    return ok({
      worktreePath: input.worktreePath,
      branch,
      agentId: input.agentId,
      phase: input.phase,
    });
  },
};
