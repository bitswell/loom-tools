import { z } from 'zod';
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
    .describe('Working directory (defaults to agent worktree)'),
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
    description: 'Run npm commands (install, create, run) in the agent worktree or a specified directory.',
    inputSchema: NpmInstallInput,
    outputSchema: NpmInstallOutput,
    roles: ['writer', 'orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = input.cwd ?? ctx.worktree;
    const args = [input.command, ...(input.args ?? [])];

    const result = await exec('npm', args, cwd);
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
