import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const PrMergeInput = z.object({
  number: z.number().describe('PR number to merge'),
  method: z
    .enum(['merge', 'squash', 'rebase'])
    .optional()
    .describe('Merge method (default: merge)'),
});

const PrMergeOutput = z.object({
  number: z.number().describe('PR number that was merged'),
  sha: z.string().describe('Merge commit SHA'),
});

type PrMergeIn = z.infer<typeof PrMergeInput>;
type PrMergeOut = z.infer<typeof PrMergeOutput>;

export const prMergeTool: Tool<PrMergeIn, PrMergeOut> = {
  definition: {
    name: 'pr-merge',
    description: 'Merge a GitHub pull request using the gh CLI.',
    inputSchema: PrMergeInput,
    outputSchema: PrMergeOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    const result = await exec(
      'gh',
      ['pr', 'merge', String(input.number), `--${input.method ?? 'merge'}`],
      cwd,
    );
    if (result.exitCode !== 0) {
      return err('pr-merge-failed', result.stderr.trim(), true);
    }

    // Try to extract a merge SHA from the output.
    // gh pr merge prints something like "Merged pull request #42 (abc123)"
    // or just a success message. Fall back to reading HEAD.
    const shaMatch = result.stdout.match(/([0-9a-f]{7,40})/);
    let sha = shaMatch ? shaMatch[1] : '';

    if (!sha) {
      // Try to get the merge commit SHA from git
      const headResult = await exec('git', ['rev-parse', 'HEAD'], cwd);
      sha = headResult.exitCode === 0 ? headResult.stdout.trim() : 'unknown';
    }

    return ok({ number: input.number, sha });
  },
};
