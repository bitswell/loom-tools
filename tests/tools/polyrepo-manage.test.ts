import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { polyrepoManageTool } from '../../src/tools/polyrepo-manage.js';

vi.mock('../../src/util/exec.js', () => ({
  exec: vi.fn(),
}));

import { exec } from '../../src/util/exec.js';
const mockExec = vi.mocked(exec);

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'bitswell',
    sessionId: 'orch-session',
    role: 'orchestrator',
    branch: 'main',
    worktree: '/tmp/worktree',
    scope: [],
    scopeDenied: [],
    emit: vi.fn(),
    ...overrides,
  };
}

describe('polyrepo-manage tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- add ---

  it('adds a submodule', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // submodule add
      .mockResolvedValueOnce({                                          // submodule status
        stdout: ' abc1234 repos/new-mod (heads/main)\n',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({                                          // config url
        stdout: 'git@github.com:org/new-mod.git\n',
        stderr: '',
        exitCode: 0,
      });

    const result = await polyrepoManageTool.handler(
      { action: 'add', path: 'repos/new-mod', url: 'git@github.com:org/new-mod.git' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toContain('Added submodule');
      expect(result.data.submodules).toHaveLength(1);
      expect(result.data.submodules[0].path).toBe('repos/new-mod');
    }
  });

  it('returns error when add is missing url', async () => {
    const result = await polyrepoManageTool.handler(
      { action: 'add', path: 'repos/thing' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('missing-params');
    }
  });

  it('returns error when add is missing path', async () => {
    const result = await polyrepoManageTool.handler(
      { action: 'add', url: 'git@github.com:org/repo.git' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('missing-params');
    }
  });

  it('returns error when submodule add fails', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'already exists',
      exitCode: 1,
    });

    const result = await polyrepoManageTool.handler(
      { action: 'add', path: 'repos/dup', url: 'git@github.com:org/dup.git' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('submodule-add-failed');
    }
  });

  // --- remove ---

  it('removes a submodule', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // deinit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git rm
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // rm -rf modules
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // submodule status (empty)

    const result = await polyrepoManageTool.handler(
      { action: 'remove', path: 'repos/old-mod' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toContain('Removed submodule');
    }
  });

  it('returns error when remove is missing path', async () => {
    const result = await polyrepoManageTool.handler(
      { action: 'remove' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('missing-params');
    }
  });

  it('returns error when deinit fails', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'fatal: not a submodule',
      exitCode: 1,
    });

    const result = await polyrepoManageTool.handler(
      { action: 'remove', path: 'repos/bad' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('submodule-deinit-failed');
    }
  });

  // --- sync ---

  it('syncs submodules', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // sync
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // update --init
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // submodule status (empty)

    const result = await polyrepoManageTool.handler(
      { action: 'sync' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toContain('synced');
    }
  });

  it('returns error when sync fails', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'error',
      exitCode: 1,
    });

    const result = await polyrepoManageTool.handler(
      { action: 'sync' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('submodule-sync-failed');
    }
  });

  // --- list ---

  it('lists submodules', async () => {
    mockExec
      .mockResolvedValueOnce({                                          // submodule status
        stdout: ' abc1234 repos/a (v1.0)\n def5678 repos/b (v2.0)\n',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({                                          // config url for repos/a
        stdout: 'git@github.com:org/a.git\n',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({                                          // config url for repos/b
        stdout: 'git@github.com:org/b.git\n',
        stderr: '',
        exitCode: 0,
      });

    const result = await polyrepoManageTool.handler(
      { action: 'list' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.submodules).toHaveLength(2);
      expect(result.data.submodules[0].path).toBe('repos/a');
      expect(result.data.submodules[0].sha).toBe('abc1234');
      expect(result.data.submodules[0].url).toBe('git@github.com:org/a.git');
      expect(result.data.submodules[1].path).toBe('repos/b');
      expect(result.data.message).toContain('2 submodule');
    }
  });

  it('returns empty array when no submodules', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    const result = await polyrepoManageTool.handler(
      { action: 'list' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.submodules).toHaveLength(0);
      expect(result.data.message).toContain('0 submodule');
    }
  });

  // --- meta ---

  it('is scoped to orchestrator role only', () => {
    expect(polyrepoManageTool.definition.roles).toEqual(['orchestrator']);
  });

  it('schema rejects invalid action', () => {
    const parsed = polyrepoManageTool.definition.inputSchema.safeParse({
      action: 'reset',
    });
    expect(parsed.success).toBe(false);
  });

  it('schema accepts valid actions', () => {
    for (const action of ['add', 'remove', 'sync', 'list']) {
      const parsed = polyrepoManageTool.definition.inputSchema.safeParse({ action });
      expect(parsed.success).toBe(true);
    }
  });
});
