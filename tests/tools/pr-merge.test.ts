import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { prMergeTool } from '../../src/tools/pr-merge.js';

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

describe('pr-merge tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges a PR and returns SHA', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: 'Merged pull request #42 (abc123def)\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await prMergeTool.handler(
      { number: 42 },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.number).toBe(42);
      expect(result.data.sha).toBe('abc123def');
    }
  });

  it('defaults to merge method', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: 'merged\n',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'merge-sha\n',
        stderr: '',
        exitCode: 0,
      });

    await prMergeTool.handler({ number: 1 }, makeCtx());

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'merge', '1', '--merge'],
      '/tmp/worktree',
    );
  });

  it('uses squash method when specified', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: 'squashed\n',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'squash-sha\n',
        stderr: '',
        exitCode: 0,
      });

    await prMergeTool.handler({ number: 5, method: 'squash' }, makeCtx());

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'merge', '5', '--squash'],
      '/tmp/worktree',
    );
  });

  it('uses rebase method when specified', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: 'rebased\n',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'rebase-sha\n',
        stderr: '',
        exitCode: 0,
      });

    await prMergeTool.handler({ number: 5, method: 'rebase' }, makeCtx());

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'merge', '5', '--rebase'],
      '/tmp/worktree',
    );
  });

  it('falls back to git rev-parse if no SHA in output', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: 'Pull request merged successfully\n',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'fallback-sha\n',
        stderr: '',
        exitCode: 0,
      });

    const result = await prMergeTool.handler({ number: 10 }, makeCtx());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sha).toBe('fallback-sha');
    }
  });

  it('returns error on merge failure', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'merge conflict',
      exitCode: 1,
    });

    const result = await prMergeTool.handler({ number: 42 }, makeCtx());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('pr-merge-failed');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('is scoped to orchestrator role only', () => {
    expect(prMergeTool.definition.roles).toEqual(['orchestrator']);
  });
});
