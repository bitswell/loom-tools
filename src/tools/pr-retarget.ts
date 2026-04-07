import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const PrRetargetInput = z.object({
  number: z.number().describe('PR number to retarget'),
  base: z.string().describe('New base branch'),
});

const PrRetargetOutput = z.object({
  number: z.number().describe('PR number that was retargeted'),
  base: z.string().describe('New base branch'),
});

type PrRetargetIn = z.infer<typeof PrRetargetInput>;
type PrRetargetOut = z.infer<typeof PrRetargetOutput>;

export const prRetargetTool: Tool<PrRetargetIn, PrRetargetOut> = {
  definition: {
    name: 'pr-retarget',
    description: "Change a PR's base branch using the gh CLI.",
    inputSchema: PrRetargetInput,
    outputSchema: PrRetargetOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    const result = await exec(
      'gh',
      ['pr', 'edit', String(input.number), '--base', input.base],
      cwd,
    );
    if (result.exitCode !== 0) {
      return err('pr-retarget-failed', result.stderr.trim(), true);
    }

    return ok({ number: input.number, base: input.base });
  },
};
