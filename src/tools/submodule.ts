import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const SubmoduleInput = z.object({
  path: z.string().describe('Path to the submodule (relative to worktree root)'),
  ref: z.string().describe('Branch, tag, or SHA to check out'),
});

const SubmoduleOutput = z.object({
  path: z.string().describe('Submodule path'),
  sha: z.string().describe('New submodule commit SHA'),
  ref: z.string().describe('Ref that was checked out'),
});

type SubmoduleIn = z.infer<typeof SubmoduleInput>;
type SubmoduleOut = z.infer<typeof SubmoduleOutput>;

export const submoduleTool: Tool<SubmoduleIn, SubmoduleOut> = {
  definition: {
    name: 'submodule',
    description: 'Update a git submodule to a specific ref.',
    inputSchema: SubmoduleInput,
    outputSchema: SubmoduleOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    // Checkout the desired ref inside the submodule
    const checkoutResult = await exec(
      'git',
      ['-C', input.path, 'checkout', input.ref],
      cwd,
    );
    if (checkoutResult.exitCode !== 0) {
      return err('submodule-checkout-failed', checkoutResult.stderr.trim(), true);
    }

    // Get the new SHA
    const shaResult = await exec(
      'git',
      ['-C', input.path, 'rev-parse', 'HEAD'],
      cwd,
    );
    if (shaResult.exitCode !== 0) {
      return err('rev-parse-failed', shaResult.stderr.trim(), false);
    }
    const sha = shaResult.stdout.trim();

    // Stage the submodule change in the parent repo
    const addResult = await exec(
      'git',
      ['add', input.path],
      cwd,
    );
    if (addResult.exitCode !== 0) {
      return err('git-add-failed', addResult.stderr.trim(), true);
    }

    return ok({ path: input.path, sha, ref: input.ref });
  },
};
