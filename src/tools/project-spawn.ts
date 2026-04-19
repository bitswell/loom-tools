import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';

const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const DEFAULT_AGENTS = [
  'bitswell',
  'shuttle',
  'bitsweller',
  'vesper',
  'ratchet',
  'moss',
  'drift',
  'sable',
  'thorn',
  'glitch',
  'bitswelt',
] as const;

const DEFAULT_DESCRIPTION = 'TODO: describe this project.';

const ProjectSpawnInput = z.object({
  slug: z.string().describe('Kebab-case project slug (lowercase letters/digits, dashes).'),
  name: z.string().optional().describe('Display name. Defaults to title-cased slug.'),
  description: z.string().optional().describe('Free-form description. Defaults to a TODO stub.'),
  repos: z.array(z.string()).optional().describe('Submodule paths in scope.'),
  agents: z
    .array(z.string())
    .optional()
    .describe('Agent roster. Defaults to the 11-agent standard roster.'),
  teams: z
    .array(
      z.object({
        name: z.string(),
        agents: z.array(z.string()).optional(),
      }),
    )
    .optional()
    .describe('Sub-team partitioning for team-of-teams projects.'),
  githubProject: z.string().optional().describe('GitHub Project board URL.'),
});

const ProjectSpawnOutput = z.object({
  files: z
    .record(z.string(), z.string())
    .describe('Map of file path to content'),
  manifestPath: z.string().describe('Path of the project manifest file'),
  worktreeDir: z.string().describe('Path of the project worktree root'),
});

type ProjectSpawnIn = z.infer<typeof ProjectSpawnInput>;
type ProjectSpawnOut = z.infer<typeof ProjectSpawnOutput>;

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface ResolvedInput {
  slug: string;
  name: string;
  description: string;
  githubProject: string | undefined;
  repos: string[];
  agents: string[];
  teams: { name: string; agents?: string[] | undefined }[] | undefined;
}

function renderManifest(i: ResolvedInput): string {
  const lines: string[] = [];

  lines.push(`slug: ${i.slug}`);
  lines.push(`name: ${i.name}`);

  lines.push('description: |');
  for (const line of i.description.split('\n')) {
    lines.push(`  ${line}`);
  }

  if (i.githubProject === undefined) {
    lines.push('github_project: null  # TODO: link when a board is created');
  } else {
    lines.push(`github_project: ${i.githubProject}`);
  }

  if (i.repos.length === 0) {
    lines.push('repos: []  # TODO: list submodule paths');
  } else {
    lines.push('repos:');
    for (const repo of i.repos) {
      lines.push(`  - ${repo}`);
    }
  }

  lines.push('agents:');
  for (const agent of i.agents) {
    lines.push(`  - ${agent}`);
  }

  if (i.teams !== undefined) {
    lines.push('teams:');
    for (const team of i.teams) {
      lines.push(`  - name: ${team.name}`);
      if (team.agents === undefined || team.agents.length === 0) {
        lines.push('    agents: []');
      } else {
        lines.push('    agents:');
        for (const agent of team.agents) {
          lines.push(`      - ${agent}`);
        }
      }
    }
  }

  return lines.join('\n') + '\n';
}

export const projectSpawnTool: Tool<ProjectSpawnIn, ProjectSpawnOut> = {
  definition: {
    name: 'project-spawn',
    description:
      'Generate a bitswell project manifest (projects/<slug>.yaml) and worktree-root scaffold (.loom/projects/<slug>/.gitkeep).',
    inputSchema: ProjectSpawnInput,
    outputSchema: ProjectSpawnOutput,
    roles: ['orchestrator'],
  },
  handler: async (input) => {
    if (!SLUG_RE.test(input.slug)) {
      return err(
        'invalid-slug',
        'slug must be kebab-case (lowercase letters/digits, dashes; start with a letter, no leading/trailing/double dashes, not empty)',
        false,
      );
    }

    const resolved: ResolvedInput = {
      slug: input.slug,
      name: input.name ?? titleCase(input.slug),
      description: input.description ?? DEFAULT_DESCRIPTION,
      githubProject: input.githubProject,
      repos: input.repos ?? [],
      agents: input.agents ?? [...DEFAULT_AGENTS],
      teams: input.teams,
    };

    const manifestPath = `projects/${resolved.slug}.yaml`;
    const worktreeDir = `.loom/projects/${resolved.slug}`;

    return ok({
      files: {
        [manifestPath]: renderManifest(resolved),
        [`${worktreeDir}/.gitkeep`]: '',
      },
      manifestPath,
      worktreeDir,
    });
  },
};
