import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const NO_NEWLINES = /^[^\n\r]*$/;
const NO_NEWLINES_MSG = 'must not contain newlines or carriage returns';
const SafeString = z.string().regex(NO_NEWLINES, NO_NEWLINES_MSG);
const HEX_SHA = /^[0-9a-f]+$/i;

const SubmoduleBumpInput = z.object({
  submodulePath: SafeString.describe(
    'Path of the submodule inside the parent repo, e.g. repos/bitswell/loom-tools.',
  ),
  targetSha: SafeString.regex(HEX_SHA, 'must be a hex commit SHA').describe(
    'Full or short commit SHA to bump the submodule to.',
  ),
  remoteUrl: SafeString.optional().describe(
    'Override the upstream URL to fetch from. Defaults to the URL in .gitmodules.',
  ),
  parentDir: z
    .string()
    .optional()
    .describe('Parent repo root. Defaults to cwd.'),
});

const SubmoduleBumpOutput = z.object({
  submodulePath: z.string(),
  previousSha: z
    .string()
    .describe('SHA previously recorded in the parent (pre-bump).'),
  targetSha: z
    .string()
    .describe('Full SHA now recorded in the parent (post-bump, post-resolution).'),
  staged: z
    .boolean()
    .describe('Whether the gitlink update is staged in the parent.'),
});

type SubmoduleBumpIn = z.infer<typeof SubmoduleBumpInput>;
type SubmoduleBumpOut = z.infer<typeof SubmoduleBumpOutput>;

export const submoduleBumpTool: Tool<SubmoduleBumpIn, SubmoduleBumpOut> = {
  definition: {
    name: 'submodule-bump',
    description:
      'Advance a git submodule pointer in the parent repo to a given commit, staging the gitlink update. Does not commit.',
    inputSchema: SubmoduleBumpInput,
    outputSchema: SubmoduleBumpOutput,
    roles: ['orchestrator'],
  },
  handler: async (input) => {
    const parsed = SubmoduleBumpInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const p = issue.path.join('.');
      return err(
        'invalid-input',
        p ? `${p}: ${issue.message}` : issue.message,
        false,
      );
    }
    const safe = parsed.data;

    const parentDir = safe.parentDir ?? process.cwd();
    const { submodulePath, targetSha } = safe;

    const gitDir = await exec(
      'git',
      ['-C', parentDir, 'rev-parse', '--git-dir'],
      parentDir,
    );
    if (gitDir.exitCode !== 0) {
      return err('not-a-repo', `${parentDir} is not a git repository`, false);
    }

    const urlLookup = await exec(
      'git',
      [
        '-C',
        parentDir,
        'config',
        '--file',
        '.gitmodules',
        `submodule.${submodulePath}.url`,
      ],
      parentDir,
    );
    if (urlLookup.exitCode !== 0) {
      return err(
        'not-a-submodule',
        `${submodulePath} is not registered in .gitmodules`,
        false,
      );
    }
    const gitmodulesUrl = urlLookup.stdout.trim();
    const remoteUrl = safe.remoteUrl ?? gitmodulesUrl;

    const lsTree = await exec(
      'git',
      ['-C', parentDir, 'ls-tree', 'HEAD', submodulePath],
      parentDir,
    );
    if (lsTree.exitCode !== 0) {
      return err(
        'ls-tree-failed',
        lsTree.stderr.trim() || 'could not read parent index',
        false,
      );
    }
    // ls-tree format: "<mode> <type> <sha>\t<path>"
    const match = lsTree.stdout.trim().match(/^\S+\s+commit\s+(\S+)\s/);
    if (!match) {
      return err(
        'not-a-gitlink',
        `${submodulePath} is not recorded as a gitlink in HEAD`,
        false,
      );
    }
    const previousSha = match[1];

    const fetch = await exec(
      'git',
      ['-C', submodulePath, 'fetch', remoteUrl, targetSha],
      parentDir,
    );
    if (fetch.exitCode !== 0) {
      return err('fetch-failed', fetch.stderr.trim(), true);
    }

    const checkout = await exec(
      'git',
      ['-C', submodulePath, 'checkout', targetSha],
      parentDir,
    );
    if (checkout.exitCode !== 0) {
      return err('checkout-failed', checkout.stderr.trim(), false);
    }

    const revParse = await exec(
      'git',
      ['-C', submodulePath, 'rev-parse', 'HEAD'],
      parentDir,
    );
    if (revParse.exitCode !== 0) {
      return err('rev-parse-failed', revParse.stderr.trim(), false);
    }
    const resolvedSha = revParse.stdout.trim();

    const addResult = await exec(
      'git',
      ['-C', parentDir, 'add', submodulePath],
      parentDir,
    );
    if (addResult.exitCode !== 0) {
      return err('git-add-failed', addResult.stderr.trim(), true);
    }

    return ok({
      submodulePath,
      previousSha,
      targetSha: resolvedSha,
      staged: true,
    });
  },
};
