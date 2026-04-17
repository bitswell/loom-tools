import { z } from 'zod';
import { join } from 'node:path';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const SubmoduleAction = z.enum(['add', 'remove', 'sync', 'list']);

const PolyrepoManageInput = z.object({
  action: SubmoduleAction.describe('Submodule operation: add, remove, sync, or list'),
  repo: z
    .string()
    .optional()
    .describe('Repository name (used in messages)'),
  path: z
    .string()
    .optional()
    .describe('Submodule path relative to worktree root'),
  url: z
    .string()
    .optional()
    .describe('Git URL for the submodule (required for add)'),
});

const SubmoduleEntry = z.object({
  path: z.string().describe('Submodule path'),
  url: z.string().describe('Submodule remote URL'),
  sha: z.string().describe('Current commit SHA'),
});

const PolyrepoManageOutput = z.object({
  submodules: z.array(SubmoduleEntry).describe('List of submodules after the operation'),
  message: z.string().describe('Human-readable result message'),
});

type PolyrepoManageIn = z.infer<typeof PolyrepoManageInput>;
type PolyrepoManageOut = z.infer<typeof PolyrepoManageOutput>;

/**
 * Parse `git submodule status` output into structured entries.
 * Each line looks like: " abc1234 path/to/submodule (v1.0)" or "-abc1234 path/to/submodule"
 */
async function listSubmodules(cwd: string): Promise<Array<{ path: string; url: string; sha: string }>> {
  const statusResult = await exec('git', ['submodule', 'status'], cwd);
  if (statusResult.exitCode !== 0 || !statusResult.stdout.trim()) {
    return [];
  }

  const entries: Array<{ path: string; url: string; sha: string }> = [];
  const lines = statusResult.stdout.trim().split('\n');

  for (const line of lines) {
    // Format: [+-U ]<sha> <path> [(desc)]
    const match = line.match(/^[+-U ]?([0-9a-f]+)\s+(\S+)/);
    if (!match) continue;

    const sha = match[1];
    const subPath = match[2];

    // Get the URL from git config
    const urlResult = await exec(
      'git',
      ['config', '--file', '.gitmodules', `submodule.${subPath}.url`],
      cwd,
    );
    const url = urlResult.exitCode === 0 ? urlResult.stdout.trim() : '';

    entries.push({ path: subPath, url, sha });
  }

  return entries;
}

export const polyrepoManageTool: Tool<PolyrepoManageIn, PolyrepoManageOut> = {
  definition: {
    name: 'polyrepo-manage',
    description: 'Manage git submodules: add, remove, sync, or list.',
    inputSchema: PolyrepoManageInput,
    outputSchema: PolyrepoManageOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    switch (input.action) {
      case 'add': {
        if (!input.url || !input.path) {
          return err('missing-params', 'add requires both url and path', false);
        }

        const addResult = await exec(
          'git',
          ['submodule', 'add', input.url, input.path],
          cwd,
        );
        if (addResult.exitCode !== 0) {
          return err('submodule-add-failed', addResult.stderr.trim(), true);
        }

        const submodules = await listSubmodules(cwd);
        return ok({
          submodules,
          message: `Added submodule at ${input.path}`,
        });
      }

      case 'remove': {
        if (!input.path) {
          return err('missing-params', 'remove requires path', false);
        }

        // Deinit the submodule
        const deinitResult = await exec(
          'git',
          ['submodule', 'deinit', '-f', input.path],
          cwd,
        );
        if (deinitResult.exitCode !== 0) {
          return err('submodule-deinit-failed', deinitResult.stderr.trim(), true);
        }

        // Remove from index
        const rmResult = await exec(
          'git',
          ['rm', '-f', input.path],
          cwd,
        );
        if (rmResult.exitCode !== 0) {
          return err('git-rm-failed', rmResult.stderr.trim(), true);
        }

        // Remove the .git/modules entry (resolve gitdir for worktree safety)
        const gitDirResult = await exec('git', ['rev-parse', '--git-common-dir'], cwd);
        const gitDir = gitDirResult.exitCode === 0 ? gitDirResult.stdout.trim() : '.git';
        await exec(
          'rm',
          ['-rf', join(gitDir, 'modules', input.path)],
          cwd,
        );

        const submodules = await listSubmodules(cwd);
        return ok({
          submodules,
          message: `Removed submodule at ${input.path}`,
        });
      }

      case 'sync': {
        const syncResult = await exec(
          'git',
          ['submodule', 'sync'],
          cwd,
        );
        if (syncResult.exitCode !== 0) {
          return err('submodule-sync-failed', syncResult.stderr.trim(), true);
        }

        const updateResult = await exec(
          'git',
          ['submodule', 'update', '--init'],
          cwd,
        );
        if (updateResult.exitCode !== 0) {
          return err('submodule-update-failed', updateResult.stderr.trim(), true);
        }

        const submodules = await listSubmodules(cwd);
        return ok({
          submodules,
          message: 'Submodules synced and updated',
        });
      }

      case 'list': {
        const submodules = await listSubmodules(cwd);
        return ok({
          submodules,
          message: `Found ${submodules.length} submodule(s)`,
        });
      }
    }
  },
};
