import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok } from '../types/result.js';
import { generateCiFiles } from './ci-generate.js';

const Language = z.enum(['rust', 'typescript', 'go']);
type Language = z.infer<typeof Language>;

const RepoFeature = z.enum(['ci', 'branch-protection', 'license', 'gitignore']);

const RepoInitInput = z.object({
  repoName: z.string().describe('Repository name (used in license and scripts)'),
  language: Language.describe('Project language'),
  features: z.array(RepoFeature).describe('Features to scaffold'),
});

const RepoInitOutput = z.object({
  files: z
    .record(z.string(), z.string())
    .describe('Map of file path to content'),
});

type RepoInitIn = z.infer<typeof RepoInitInput>;
type RepoInitOut = z.infer<typeof RepoInitOutput>;

// --- Template generators ---

function mitLicense(org: string): string {
  const year = new Date().getFullYear();
  return [
    'MIT License',
    '',
    `Copyright (c) ${year} ${org}`,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
    '',
  ].join('\n');
}

const GITIGNORE: Record<Language, string> = {
  rust: [
    '/target/',
    'Cargo.lock',
    '*.swp',
    '.DS_Store',
    '',
  ].join('\n'),
  typescript: [
    'node_modules/',
    'dist/',
    '*.tsbuildinfo',
    '.DS_Store',
    '',
  ].join('\n'),
  go: [
    '/bin/',
    '/dist/',
    '*.exe',
    '.DS_Store',
    '',
  ].join('\n'),
};

function branchProtectionScript(repoName: string): string {
  return [
    '#!/usr/bin/env bash',
    '# Set branch protection rules via GitHub API',
    'set -euo pipefail',
    '',
    `REPO="${repoName}"`,
    'BRANCH="main"',
    '',
    'gh api \\',
    '  --method PUT \\',
    '  "repos/${REPO}/branches/${BRANCH}/protection" \\',
    '  -f required_status_checks[strict]=true \\',
    '  -f "required_status_checks[contexts][]=" \\',
    '  -f required_pull_request_reviews[required_approving_review_count]=1 \\',
    '  -f enforce_admins=true \\',
    '  -F allow_force_pushes=false \\',
    '  -F allow_deletions=false \\',
    '  -F required_linear_history=false',
    '',
  ].join('\n');
}

// --- Tool export ---

export const repoInitTool: Tool<RepoInitIn, RepoInitOut> = {
  definition: {
    name: 'repo-init',
    description:
      'Generate scaffold files for a new repository: CI workflows, license, gitignore, branch protection script.',
    inputSchema: RepoInitInput,
    outputSchema: RepoInitOutput,
    roles: ['orchestrator'],
  },
  handler: async (input) => {
    const files: Record<string, string> = {};

    if (input.features.includes('ci')) {
      const ciFiles = generateCiFiles(input.language, [
        'test',
        'typecheck',
        'lint',
      ]);
      Object.assign(files, ciFiles);
    }

    if (input.features.includes('license')) {
      files['LICENSE'] = mitLicense(input.repoName);
    }

    if (input.features.includes('gitignore')) {
      files['.gitignore'] = GITIGNORE[input.language];
    }

    if (input.features.includes('branch-protection')) {
      files['scripts/branch-protection.sh'] = branchProtectionScript(
        input.repoName,
      );
    }

    return ok({ files });
  },
};
