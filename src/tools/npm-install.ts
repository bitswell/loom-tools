import { z } from 'zod';
import { resolve } from 'node:path';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const NpmCommand = z.enum(['install', 'create', 'run']);

const NpmInstallInput = z.object({
  command: NpmCommand.describe('npm command to run: install, create, or run'),
  args: z
    .array(z.string())
    .optional()
    .describe('Additional arguments to pass to the npm command'),
  cwd: z
    .string()
    .optional()
    .describe('Relative path within worktree (defaults to worktree root)'),
});

const NpmInstallOutput = z.object({
  stdout: z.string().describe('Command stdout'),
  exitCode: z.number().describe('Process exit code'),
});

type NpmInstallIn = z.infer<typeof NpmInstallInput>;
type NpmInstallOut = z.infer<typeof NpmInstallOutput>;

export const npmInstallTool: Tool<NpmInstallIn, NpmInstallOut> = {
  definition: {
    name: 'npm-install',
    description: 'Run npm commands (install, create, run) in the agent worktree or a specified subdirectory.',
    inputSchema: NpmInstallInput,
    outputSchema: NpmInstallOutput,
    roles: ['writer', 'orchestrator'],
  },
  handler: async (input, ctx) => {
    const targetDir = input.cwd ? resolve(ctx.worktree, input.cwd) : ctx.worktree;

    // Validate cwd is within the worktree to prevent scope escape
    if (!targetDir.startsWith(ctx.worktree)) {
      return err('scope-violation', `cwd must be within worktree: ${ctx.worktree}`, false);
    }

    const args = [input.command, ...(input.args ?? [])];

    const result = await exec('npm', args, targetDir);
    if (result.exitCode !== 0) {
      return err(
        'npm-failed',
        `npm ${input.command} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
        true,
      );
    }

    return ok({ stdout: result.stdout, exitCode: result.exitCode });
  },
};
