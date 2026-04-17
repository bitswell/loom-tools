import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const GhPagesEnableInput = z.object({
  repo: z
    .string()
    .describe('Repository in "owner/name" format (e.g. "bitswell/loom-site")'),
});

const GhPagesEnableOutput = z.object({
  url: z.string().describe('GitHub Pages URL'),
  enabled: z.boolean().describe('Whether Pages was successfully enabled'),
});

type GhPagesEnableIn = z.infer<typeof GhPagesEnableInput>;
type GhPagesEnableOut = z.infer<typeof GhPagesEnableOutput>;

export const ghPagesEnableTool: Tool<GhPagesEnableIn, GhPagesEnableOut> = {
  definition: {
    name: 'gh-pages-enable',
    description: 'Enable GitHub Pages on a repository using the GitHub Actions workflow build type.',
    inputSchema: GhPagesEnableInput,
    outputSchema: GhPagesEnableOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    const result = await exec(
      'gh',
      [
        'api',
        `repos/${input.repo}/pages`,
        '-X', 'POST',
        '-f', 'build_type=workflow',
        '-f', 'source[branch]=main',
        '-f', 'source[path]=/',
      ],
      cwd,
    );

    if (result.exitCode !== 0) {
      return err('gh-pages-enable-failed', result.stderr.trim(), true);
    }

    // Extract the pages URL from the API response
    let url = `https://${input.repo.split('/')[0]}.github.io/${input.repo.split('/')[1]}/`;
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed.html_url) {
        url = parsed.html_url;
      }
    } catch {
      // Use the constructed URL if parsing fails
    }

    return ok({ url, enabled: true });
  },
};
