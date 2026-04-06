import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const ReadAssignmentInput = z.object({
  branch: z
    .string()
    .optional()
    .describe('Branch to search. Defaults to current branch from context.'),
});

const ReadAssignmentOutput = z.object({
  body: z.string().describe('Full commit message body'),
  trailers: z.object({
    agentId: z.string().optional(),
    sessionId: z.string().optional(),
    assignedTo: z.string().optional(),
    assignment: z.string().optional(),
    scope: z.string().optional(),
    scopeDenied: z.string().optional(),
    dependencies: z.string().optional(),
    budget: z.string().optional(),
    taskStatus: z.string().optional(),
  }),
  sha: z.string().describe('SHA of the ASSIGNED commit'),
});

type ReadAssignmentIn = z.infer<typeof ReadAssignmentInput>;
type ReadAssignmentOut = z.infer<typeof ReadAssignmentOutput>;

export const readAssignmentTool: Tool<ReadAssignmentIn, ReadAssignmentOut> = {
  definition: {
    name: 'read-assignment',
    description:
      'Find the ASSIGNED commit on the current branch and parse its trailers.',
    inputSchema: ReadAssignmentInput,
    outputSchema: ReadAssignmentOutput,
    roles: ['writer', 'reviewer', 'orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;
    const branch = input.branch ?? ctx.branch;

    // Walk the branch looking for a commit with Task-Status: ASSIGNED trailer
    const logResult = await exec(
      'git',
      ['log', branch, '--format=%H', '-50'],
      cwd,
    );
    if (logResult.exitCode !== 0) {
      return err('git-log-failed', logResult.stderr.trim(), true);
    }

    const shas = logResult.stdout.trim().split('\n').filter(Boolean);

    for (const sha of shas) {
      // Get trailers for this commit
      const trailerResult = await exec(
        'git',
        ['log', '-1', '--format=%(trailers:key,valueonly)', sha],
        cwd,
      );

      // Check for Task-Status: ASSIGNED
      const trailersRaw = await exec(
        'git',
        ['log', '-1', '--format=%(trailers)', sha],
        cwd,
      );

      if (!trailersRaw.stdout.includes('Task-Status: ASSIGNED')) {
        continue;
      }

      // Found it — parse the full message and trailers
      const bodyResult = await exec(
        'git',
        ['log', '-1', '--format=%B', sha],
        cwd,
      );

      const trailers = parseTrailers(trailersRaw.stdout);

      return ok({
        body: bodyResult.stdout.trim(),
        trailers: {
          agentId: trailers['Agent-Id'],
          sessionId: trailers['Session-Id'],
          assignedTo: trailers['Assigned-To'],
          assignment: trailers['Assignment'],
          scope: trailers['Scope'],
          scopeDenied: trailers['Scope-Denied'],
          dependencies: trailers['Dependencies'],
          budget: trailers['Budget'],
          taskStatus: trailers['Task-Status'],
        },
        sha,
      });
    }

    return err(
      'no-assignment',
      'No commit with Task-Status: ASSIGNED found in recent history',
      false,
    );
  },
};

function parseTrailers(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}
