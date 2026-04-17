import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { npmInstallTool } from '../../src/tools/npm-install.js';

vi.mock('../../src/util/exec.js', () => ({
  exec: vi.fn(),
}));

import { exec } from '../../src/util/exec.js';
const mockExec = vi.mocked(exec);

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'ratchet',
    sessionId: 'test-session',
    role: 'writer',
    branch: 'loom/ratchet-fix',
    worktree: '/tmp/worktree',
    scope: ['src/'],
    scopeDenied: [],
    emit: vi.fn(),
    ...overrides,
  };
}

describe('npm-install tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs npm install successfully', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: 'added 42 packages\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await npmInstallTool.handler(
      { command: 'install' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stdout).toContain('added 42 packages');
      expect(result.data.exitCode).toBe(0);
    }

    expect(mockExec).toHaveBeenCalledWith('npm', ['install'], '/tmp/worktree');
  });

  it('passes args to npm', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await npmInstallTool.handler(
      { command: 'run', args: ['build'] },
      makeCtx(),
    );

    expect(mockExec).toHaveBeenCalledWith(
      'npm',
      ['run', 'build'],
      '/tmp/worktree',
    );
  });

  it('resolves relative cwd within worktree', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await npmInstallTool.handler(
      { command: 'install', cwd: 'packages/core' },
      makeCtx(),
    );

    expect(mockExec).toHaveBeenCalledWith(
      'npm',
      ['install'],
      '/tmp/worktree/packages/core',
    );
  });

  it('rejects cwd that escapes worktree', async () => {
    const result = await npmInstallTool.handler(
      { command: 'install', cwd: '../../etc' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('scope-violation');
      expect(result.error.retryable).toBe(false);
    }
    // exec should not have been called
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('rejects absolute cwd outside worktree', async () => {
    const result = await npmInstallTool.handler(
      { command: 'install', cwd: '/etc/passwd' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('scope-violation');
    }
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('defaults to worktree when cwd is not provided', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await npmInstallTool.handler(
      { command: 'create', args: ['vite@latest'] },
      makeCtx(),
    );

    expect(mockExec).toHaveBeenCalledWith(
      'npm',
      ['create', 'vite@latest'],
      '/tmp/worktree',
    );
  });

  it('returns error on npm failure', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'ERR! code ENOENT',
      exitCode: 1,
    });

    const result = await npmInstallTool.handler(
      { command: 'install' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('npm-failed');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('handles empty args array', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await npmInstallTool.handler(
      { command: 'install', args: [] },
      makeCtx(),
    );

    expect(mockExec).toHaveBeenCalledWith('npm', ['install'], '/tmp/worktree');
  });

  it('is scoped to writer and orchestrator roles', () => {
    expect(npmInstallTool.definition.roles).toEqual(['writer', 'orchestrator']);
  });

  it('schema rejects invalid command', () => {
    const parsed = npmInstallTool.definition.inputSchema.safeParse({
      command: 'publish',
    });
    expect(parsed.success).toBe(false);
  });

  it('schema accepts valid commands', () => {
    for (const command of ['install', 'create', 'run']) {
      const parsed = npmInstallTool.definition.inputSchema.safeParse({ command });
      expect(parsed.success).toBe(true);
    }
  });

  it('schema describes cwd as relative path within worktree', () => {
    const cwdProp = npmInstallTool.definition.inputSchema.shape.cwd;
    expect(cwdProp.description).toContain('within worktree');
  });
});
