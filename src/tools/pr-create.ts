import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const PrCreateInput = z.object({
  head: z.string().describe('Head branch for the PR'),
  base: z.string().describe('Base branch to merge into'),
  title: z.string().describe('PR title'),
  body: z.string().optional().describe('PR body/description'),
});

const PrCreateOutput = z.object({
  url: z.string().describe('URL of the created PR'),
  number: z.number().describe('PR number'),
});

type PrCreateIn = z.infer<typeof PrCreateInput>;
type PrCreateOut = z.infer<typeof PrCreateOutput>;

export const prCreateTool: Tool<PrCreateIn, PrCreateOut> = {
  definition: {
    name: 'pr-create',
    description: 'Create a GitHub pull request using the gh CLI.',
    inputSchema: PrCreateInput,
    outputSchema: PrCreateOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    const args = [
      'pr', 'create',
      '--head', input.head,
      '--base', input.base,
      '--title', input.title,
    ];
    if (input.body) {
      args.push('--body', input.body);
    }

    const result = await exec('gh', args, cwd);
    if (result.exitCode !== 0) {
      return err('pr-create-failed', result.stderr.trim(), true);
    }

    // gh pr create outputs the URL on stdout
    const url = result.stdout.trim();
    // Extract PR number from URL: https://github.com/owner/repo/pull/42
    const match = url.match(/\/pull\/(\d+)/);
    const number = match ? Number(match[1]) : 0;

    return ok({ url, number });
  },
};
