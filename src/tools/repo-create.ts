import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const Visibility = z.enum(['public', 'private']);

const RepoCreateInput = z.object({
  org: z.string().describe('GitHub organization or user'),
  name: z.string().describe('Repository name'),
  description: z
    .string()
    .optional()
    .describe('Repository description'),
  visibility: Visibility
    .optional()
    .describe('Repository visibility (default: private)'),
});

const RepoCreateOutput = z.object({
  url: z.string().describe('HTTPS URL of the created repository'),
  sshUrl: z.string().describe('SSH clone URL'),
  protected: z.boolean().describe('Whether branch protection was applied'),
});

type RepoCreateIn = z.infer<typeof RepoCreateInput>;
type RepoCreateOut = z.infer<typeof RepoCreateOutput>;

export const repoCreateTool: Tool<RepoCreateIn, RepoCreateOut> = {
  definition: {
    name: 'repo-create',
    description: 'Create a GitHub repository, initialize with a README on main, and apply branch protection.',
    inputSchema: RepoCreateInput,
    outputSchema: RepoCreateOutput,
    roles: ['orchestrator'],
  },
  handler: async (input) => {
    const fullName = `${input.org}/${input.name}`;
    const vis = input.visibility ?? 'private';

    // 1. Create the repo
    const createArgs = [
      'repo', 'create', fullName,
      `--${vis}`,
      '--clone=false',
    ];
    if (input.description) {
      createArgs.push('--description', input.description);
    }

    const createResult = await exec('gh', createArgs, tmpdir());
    if (createResult.exitCode !== 0) {
      return err('repo-create-failed', createResult.stderr.trim(), true);
    }

    // 2. Clone into temp dir, add README, commit, push main
    const cloneDir = join(tmpdir(), `loom-repo-init-${input.name}-${Date.now()}`);

    const cloneResult = await exec(
      'git',
      ['clone', `git@github.com:${fullName}.git`, cloneDir],
      tmpdir(),
    );
    if (cloneResult.exitCode !== 0) {
      return err('clone-failed', cloneResult.stderr.trim(), true);
    }

    // Write README
    const readmeResult = await exec(
      'bash',
      ['-c', `echo "# ${input.name}" > README.md`],
      cloneDir,
    );
    if (readmeResult.exitCode !== 0) {
      return err('readme-failed', readmeResult.stderr.trim(), false);
    }

    // Commit and push
    const addResult = await exec('git', ['add', 'README.md'], cloneDir);
    if (addResult.exitCode !== 0) {
      return err('git-add-failed', addResult.stderr.trim(), false);
    }

    const commitResult = await exec(
      'git',
      ['commit', '-m', `chore: initial commit\n\nAgent-Id: loom-orchestrator`],
      cloneDir,
    );
    if (commitResult.exitCode !== 0) {
      return err('commit-failed', commitResult.stderr.trim(), false);
    }

    const pushResult = await exec('git', ['push', '-u', 'origin', 'main'], cloneDir);
    if (pushResult.exitCode !== 0) {
      return err('push-failed', pushResult.stderr.trim(), true);
    }

    // 3. Create branch protection ruleset
    let protectionApplied = false;
    const rulesetBody = JSON.stringify({
      name: 'protect-main',
      target: 'branch',
      enforcement: 'active',
      conditions: {
        ref_name: { include: ['refs/heads/main'], exclude: [] },
      },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
          },
        },
      ],
    });

    const protectResult = await exec(
      'bash',
      ['-c', `echo '${rulesetBody.replace(/'/g, "'\\''")}' | gh api repos/${fullName}/rulesets -X POST --input -`],
      cloneDir,
    );
    if (protectResult.exitCode === 0) {
      protectionApplied = true;
    }

    // Clean up temp dir
    await exec('rm', ['-rf', cloneDir], tmpdir());

    const url = `https://github.com/${fullName}`;
    const sshUrl = `git@github.com:${fullName}.git`;

    return ok({ url, sshUrl, protected: protectionApplied });
  },
};
