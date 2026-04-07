import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';
import { validateScope } from '../util/scope.js';

const CommitInput = z.object({
  message: z.string().describe('Commit message (first line is subject)'),
  files: z
    .array(z.string())
    .optional()
    .describe('Files to stage. If empty, commits whatever is staged.'),
  trailers: z
    .record(z.string())
    .optional()
    .describe('Additional trailers (e.g. Task-Status, Key-Finding)'),
});

const CommitOutput = z.object({
  sha: z.string().describe('Resulting commit SHA'),
  trailers: z.record(z.string()).describe('All trailers applied to the commit'),
});

type CommitIn = z.infer<typeof CommitInput>;
type CommitOut = z.infer<typeof CommitOutput>;

export const commitTool: Tool<CommitIn, CommitOut> = {
  definition: {
    name: 'commit',
    description:
      'Stage files, validate scope, create a signed commit with LOOM trailers.',
    inputSchema: CommitInput,
    outputSchema: CommitOutput,
    roles: ['writer', 'orchestrator'],
    emits: ['state-changed'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    // Stage files if provided
    if (input.files && input.files.length > 0) {
      // Validate scope
      const scope = validateScope(input.files, ctx.scope, ctx.scopeDenied);
      if (!scope.valid) {
        await ctx.emit({
          type: 'scope-violation',
          branch: ctx.branch,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          timestamp: new Date().toISOString(),
          payload: { violations: scope.violations },
        });
        return err(
          'scope-violation',
          `Files outside scope: ${scope.violations.join(', ')}`,
          false,
        );
      }

      const addResult = await exec('git', ['add', '--', ...input.files], cwd);
      if (addResult.exitCode !== 0) {
        return err('git-add-failed', addResult.stderr.trim(), true);
      }
    }

    // Build trailers — auto-inject Agent-Id, Session-Id, Heartbeat
    const allTrailers: Record<string, string> = {
      'Agent-Id': ctx.agentId,
      'Session-Id': ctx.sessionId,
      Heartbeat: new Date().toISOString(),
      ...(input.trailers ?? {}),
    };

    const trailerArgs = Object.entries(allTrailers).flatMap(([k, v]) => [
      '--trailer',
      `${k}: ${v}`,
    ]);

    // Try signed commit via loom-sign-as
    const signedResult = await exec(
      'git',
      [
        '-c', 'gpg.format=ssh',
        '-c', `gpg.ssh.program=loom-sign-as`,
        '-c', `user.signingkey=${ctx.agentId}`,
        'commit', '-S',
        '-m', input.message,
        ...trailerArgs,
      ],
      cwd,
    );

    if (signedResult.exitCode !== 0) {
      // Fall back to unsigned commit
      const unsignedResult = await exec(
        'git',
        ['commit', '-m', input.message, ...trailerArgs],
        cwd,
      );
      if (unsignedResult.exitCode !== 0) {
        return err('commit-failed', unsignedResult.stderr.trim(), true);
      }
    }

    // Get the resulting SHA
    const shaResult = await exec('git', ['rev-parse', 'HEAD'], cwd);
    if (shaResult.exitCode !== 0) {
      return err('git-rev-parse-failed', shaResult.stderr.trim(), false);
    }
    const sha = shaResult.stdout.trim();

    // Emit state-changed if Task-Status trailer present
    if (allTrailers['Task-Status']) {
      await ctx.emit({
        type: 'state-changed',
        branch: ctx.branch,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        timestamp: new Date().toISOString(),
        payload: { sha, status: allTrailers['Task-Status'] },
      });
    }

    return ok({ sha, trailers: allTrailers });
  },
};
