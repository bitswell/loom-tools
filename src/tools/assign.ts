import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const AssignInput = z.object({
  agentId: z.string().describe('Agent to assign the task to'),
  branch: z.string().describe('Target branch for the assignment'),
  taskBody: z.string().describe('Task description (commit message body)'),
  scope: z.string().optional().describe('Allowed file paths (Scope trailer)'),
  dependencies: z
    .string()
    .optional()
    .describe('Branch dependencies (Dependencies trailer)'),
  budget: z
    .number()
    .optional()
    .describe('Token budget for the task (Budget trailer)'),
});

const AssignOutput = z.object({
  sha: z.string().describe('SHA of the ASSIGNED commit'),
  branch: z.string().describe('Branch the assignment was created on'),
});

type AssignIn = z.infer<typeof AssignInput>;
type AssignOut = z.infer<typeof AssignOutput>;

export const assignTool: Tool<AssignIn, AssignOut> = {
  definition: {
    name: 'assign',
    description:
      'Create an ASSIGNED commit on a target branch with proper LOOM trailers.',
    inputSchema: AssignInput,
    outputSchema: AssignOutput,
    roles: ['orchestrator'],
    emits: ['state-changed'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    // Ensure the target branch exists — check it out
    const checkoutResult = await exec(
      'git',
      ['checkout', input.branch],
      cwd,
    );
    if (checkoutResult.exitCode !== 0) {
      // Try creating it
      const createResult = await exec(
        'git',
        ['checkout', '-b', input.branch],
        cwd,
      );
      if (createResult.exitCode !== 0) {
        return err('branch-failed', createResult.stderr.trim(), true);
      }
    }

    // Build trailer args
    const trailerArgs: string[] = [];
    const addTrailer = (key: string, value: string) => {
      trailerArgs.push('--trailer', `${key}: ${value}`);
    };

    addTrailer('Agent-Id', ctx.agentId);
    addTrailer('Session-Id', ctx.sessionId);
    addTrailer('Task-Status', 'ASSIGNED');
    addTrailer('Assigned-To', input.agentId);
    addTrailer('Assignment', `${ctx.agentId}/${input.branch.replace('loom/', '')}`);
    if (input.scope) addTrailer('Scope', input.scope);
    if (input.dependencies) addTrailer('Dependencies', input.dependencies);
    if (input.budget !== undefined) addTrailer('Budget', String(input.budget));
    addTrailer('Heartbeat', new Date().toISOString());

    const commitResult = await exec(
      'git',
      ['commit', '--allow-empty', '-m', input.taskBody, ...trailerArgs],
      cwd,
    );
    if (commitResult.exitCode !== 0) {
      return err('commit-failed', commitResult.stderr.trim(), true);
    }

    const shaResult = await exec('git', ['rev-parse', 'HEAD'], cwd);
    if (shaResult.exitCode !== 0) {
      return err('rev-parse-failed', shaResult.stderr.trim(), false);
    }
    const sha = shaResult.stdout.trim();

    await ctx.emit({
      type: 'state-changed',
      branch: input.branch,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      timestamp: new Date().toISOString(),
      payload: { sha, status: 'ASSIGNED', assignedTo: input.agentId },
    });

    return ok({ sha, branch: input.branch });
  },
};
