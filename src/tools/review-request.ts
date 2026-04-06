import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const ReviewRequestInput = z.object({
  number: z.number().describe('PR number to request review on'),
  reviewers: z
    .array(z.string())
    .min(1)
    .describe('GitHub usernames to request review from'),
});

const ReviewRequestOutput = z.object({
  number: z.number().describe('PR number'),
  reviewers: z.array(z.string()).describe('Reviewers that were added'),
});

type ReviewRequestIn = z.infer<typeof ReviewRequestInput>;
type ReviewRequestOut = z.infer<typeof ReviewRequestOutput>;

export const reviewRequestTool: Tool<ReviewRequestIn, ReviewRequestOut> = {
  definition: {
    name: 'review-request',
    description: 'Request a review on a GitHub PR using the gh CLI.',
    inputSchema: ReviewRequestInput,
    outputSchema: ReviewRequestOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;
    const reviewerList = input.reviewers.join(',');

    const result = await exec(
      'gh',
      ['pr', 'edit', String(input.number), '--add-reviewer', reviewerList],
      cwd,
    );
    if (result.exitCode !== 0) {
      return err('review-request-failed', result.stderr.trim(), true);
    }

    return ok({ number: input.number, reviewers: input.reviewers });
  },
};
