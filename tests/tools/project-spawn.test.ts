import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { projectSpawnTool } from '../../src/tools/project-spawn.js';

function makeCtx(): ToolContext {
  return {
    agentId: 'bitswell',
    sessionId: 'orch-session',
    role: 'orchestrator',
    branch: 'main',
    worktree: '/tmp/worktree',
    scope: [],
    scopeDenied: [],
    emit: vi.fn(),
  };
}

describe('project-spawn tool', () => {
  // --- P1 ---
  it('is scoped to orchestrator role only', () => {
    expect(projectSpawnTool.definition.roles).toEqual(['orchestrator']);
  });

  // --- P2: minimal input ---
  it('minimal input produces manifest with defaults', async () => {
    const result = await projectSpawnTool.handler({ slug: 'kiln' }, makeCtx());
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.manifestPath).toBe('projects/kiln.yaml');
    expect(result.data.worktreeDir).toBe('.loom/projects/kiln');
    expect(result.data.files['.loom/projects/kiln/.gitkeep']).toBe('');

    const manifest = result.data.files['projects/kiln.yaml'];
    expect(manifest).toContain('slug: kiln');
    expect(manifest).toContain('name: Kiln');
    expect(manifest).toContain('description: |\n  TODO: describe this project.');
    expect(manifest).toContain('github_project: null');
    expect(manifest).toMatch(/github_project: null\s+#\s*TODO/);
    expect(manifest).toContain('repos: []');

    for (const agent of [
      'bitswell', 'shuttle', 'bitsweller', 'vesper', 'ratchet', 'moss',
      'drift', 'sable', 'thorn', 'glitch', 'bitswelt',
    ]) {
      expect(manifest).toContain(`  - ${agent}`);
    }
  });

  // --- P3: explicit input ---
  it('explicit input round-trips into manifest', async () => {
    const result = await projectSpawnTool.handler(
      {
        slug: 'forge',
        name: 'Forge',
        description: 'Long-running batch training project.',
        repos: ['repos/bitswell/loom-tools', 'repos/bitswell/memctl'],
        githubProject: 'https://github.com/orgs/bitswell/projects/3',
        agents: ['bitswell', 'shuttle', 'ratchet'],
      },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const manifest = result.data.files['projects/forge.yaml'];
    expect(manifest).toContain('slug: forge');
    expect(manifest).toContain('name: Forge');
    expect(manifest).toContain('description: |\n  Long-running batch training project.');
    expect(manifest).toContain('github_project: https://github.com/orgs/bitswell/projects/3');
    expect(manifest).not.toMatch(/github_project:.*#/);
    expect(manifest).toContain('  - repos/bitswell/loom-tools');
    expect(manifest).toContain('  - repos/bitswell/memctl');
    expect(manifest).toContain('  - bitswell');
    expect(manifest).toContain('  - shuttle');
    expect(manifest).toContain('  - ratchet');
    // Default-expansion regression guard:
    for (const agent of ['moss', 'vesper', 'drift', 'sable', 'thorn', 'glitch', 'bitswelt', 'bitsweller']) {
      expect(manifest).not.toContain(`  - ${agent}`);
    }
  });

  // --- P4: teams block ---
  it('teams input produces teams block and keeps default roster', async () => {
    const result = await projectSpawnTool.handler(
      {
        slug: 'atlas',
        teams: [
          { name: 'runtime' },
          { name: 'workers', agents: ['moss', 'ratchet'] },
        ],
      },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const manifest = result.data.files['projects/atlas.yaml'];
    expect(manifest).toContain('teams:');
    expect(manifest).toContain('  - name: runtime\n    agents: []');
    expect(manifest).toContain('  - name: workers\n    agents:\n      - moss\n      - ratchet');
    // Top-level default roster still present:
    expect(manifest).toContain('agents:\n  - bitswell');
    expect(manifest).toContain('  - bitswelt');
  });

  // --- N1–N5: slug validation ---
  it.each([
    ['BadSlug', 'uppercase'],
    ['bad_slug', 'underscore'],
    ['-leading-dash', 'leading dash'],
    ['trailing-', 'trailing dash'],
    ['', 'empty'],
  ])('rejects invalid slug %s (%s)', async (slug) => {
    const result = await projectSpawnTool.handler({ slug }, makeCtx());
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('invalid-slug');
  });
});
