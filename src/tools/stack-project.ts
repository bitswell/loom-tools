import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const StackProjectInput = z.object({
  epic: z.string().describe('Epic slug; used for stack/<epic>/... namespace'),
  order: z
    .array(
      z.object({
        agent: z.string(),
        slug: z.string(),
        branch: z.string().describe('Source loom/<agent>-<slug> branch'),
      }),
    )
    .describe('DAG-sorted layer order, bottom (closest to trunk) first'),
  base: z.string().optional().describe('Trunk branch (default: main)'),
  draft: z
    .boolean()
    .optional()
    .describe('Publish stack PRs as drafts (default: true)'),
  reproject: z
    .boolean()
    .optional()
    .describe('Tear down existing stack first via gh stack unstack (default: false)'),
});

const StackProjectOutput = z.object({
  mirrorBranches: z.array(z.string()),
  prUrls: z.array(z.string()),
});

type StackProjectIn = z.infer<typeof StackProjectInput>;
type StackProjectOut = z.infer<typeof StackProjectOutput>;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export const stackProjectTool: Tool<StackProjectIn, StackProjectOut> = {
  definition: {
    name: 'stack-project',
    description:
      'Publish a read-only stacked-PR projection of an integrated LOOM epic via gh-stack. Builds per-layer mirror branches by cherry-picking from each loom/<agent>-<slug> source, then adopts and submits them as a stack.',
    inputSchema: StackProjectInput,
    outputSchema: StackProjectOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;
    const base = input.base ?? 'main';
    const draft = input.draft ?? true;
    const reproject = input.reproject ?? false;
    const mirrorBranches: string[] = [];

    // Optionally tear down any existing stack first.
    if (reproject) {
      const unstack = await exec('gh', ['stack', 'unstack'], cwd);
      if (unstack.exitCode !== 0) {
        return err('stack-unstack-failed', unstack.stderr.trim(), true);
      }
    }

    // Build mirror branches by cherry-picking each layer onto the previous mirror.
    let prev = base;
    for (let i = 0; i < input.order.length; i++) {
      const layer = input.order[i];
      const mirror = `stack/${input.epic}/${pad2(i + 1)}-${layer.agent}-${layer.slug}`;

      // Enumerate commits unique to this layer's source branch over base.
      const revList = await exec(
        'git',
        ['rev-list', '--reverse', `${base}..${layer.branch}`],
        cwd,
      );
      if (revList.exitCode !== 0) {
        return err('mirror-rev-list-failed', revList.stderr.trim(), true);
      }
      const commits = revList.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      // Force the mirror branch to start at the previous mirror tip (or base
      // for the first layer). Cherry-pick from the layer source on top.
      const branchForce = await exec('git', ['branch', '-f', mirror, prev], cwd);
      if (branchForce.exitCode !== 0) {
        return err('mirror-branch-failed', branchForce.stderr.trim(), true);
      }

      const checkout = await exec('git', ['checkout', mirror], cwd);
      if (checkout.exitCode !== 0) {
        return err('mirror-checkout-failed', checkout.stderr.trim(), true);
      }

      if (commits.length > 0) {
        const cherry = await exec('git', ['cherry-pick', ...commits], cwd);
        if (cherry.exitCode !== 0) {
          return err(
            'mirror-cherry-pick-failed',
            cherry.stderr.trim() || cherry.stdout.trim(),
            false,
          );
        }
      }

      mirrorBranches.push(mirror);
      prev = mirror;
    }

    // Adopt the mirror branches into a gh-stack stack.
    const initArgs = ['stack', 'init', '--base', base, '--adopt', ...mirrorBranches];
    const initResult = await exec('gh', initArgs, cwd);
    if (initResult.exitCode !== 0) {
      return err('stack-init-failed', initResult.stderr.trim(), true);
    }

    // Submit the stack — optionally as draft PRs.
    const submitArgs = ['stack', 'submit', '--auto'];
    if (draft) {
      submitArgs.push('--draft');
    }
    const submitResult = await exec('gh', submitArgs, cwd);
    if (submitResult.exitCode !== 0) {
      return err('stack-submit-failed', submitResult.stderr.trim(), true);
    }

    // Extract any PR URLs gh emitted on stdout.
    const prUrls = submitResult.stdout
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(s));

    return ok({ mirrorBranches, prUrls });
  },
};
