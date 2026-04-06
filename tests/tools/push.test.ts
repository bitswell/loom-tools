import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { pushTool } from '../../src/tools/push.js';

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

describe('push tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pushes successfully and emits branch-updated', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    const ctx = makeCtx();

    const result = await pushTool.handler({}, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ref).toBe('origin/loom/ratchet-fix');
      expect(result.data.branch).toBe('loom/ratchet-fix');
    }

    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'branch-updated' }),
    );
  });

  it('returns error on push failure', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'remote rejected',
      exitCode: 1,
    });

    const result = await pushTool.handler({}, makeCtx());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('push-failed');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('uses custom remote', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    const ctx = makeCtx();

    const result = await pushTool.handler({ remote: 'upstream' }, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ref).toBe('upstream/loom/ratchet-fix');
    }

    expect(mockExec).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['push', 'upstream']),
      '/tmp/worktree',
    );
  });

  it('uses force-with-lease when force is true', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    const ctx = makeCtx();

    await pushTool.handler({ force: true }, ctx);

    expect(mockExec).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['--force-with-lease']),
      '/tmp/worktree',
    );
  });

  it('does not emit branch-updated on failure', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'error',
      exitCode: 1,
    });
    const ctx = makeCtx();

    await pushTool.handler({}, ctx);
    expect(ctx.emit).not.toHaveBeenCalled();
  });
});
