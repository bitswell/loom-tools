import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const PushInput = z.object({
  remote: z
    .string()
    .optional()
    .describe('Remote name (default: origin)'),
  force: z
    .boolean()
    .optional()
    .describe('Force push (use with caution)'),
});

const PushOutput = z.object({
  ref: z.string().describe('Remote ref that was updated'),
  branch: z.string().describe('Branch that was pushed'),
});

type PushIn = z.infer<typeof PushInput>;
type PushOut = z.infer<typeof PushOutput>;

export const pushTool: Tool<PushIn, PushOut> = {
  definition: {
    name: 'push',
    description: "Push the agent's branch to the remote.",
    inputSchema: PushInput,
    outputSchema: PushOutput,
    roles: ['writer', 'orchestrator'],
    emits: ['branch-updated'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;
    const branch = ctx.branch;
    const remote = input.remote ?? 'origin';

    const args = ['push', remote, branch];
    if (input.force) {
      args.push('--force-with-lease');
    }
    // Set upstream on first push
    args.push('-u');

    const result = await exec('git', args, cwd);
    if (result.exitCode !== 0) {
      return err('push-failed', result.stderr.trim(), true);
    }

    const ref = `${remote}/${branch}`;

    await ctx.emit({
      type: 'branch-updated',
      branch,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      timestamp: new Date().toISOString(),
      payload: { remote, ref },
    });

    return ok({ ref, branch });
  },
};
