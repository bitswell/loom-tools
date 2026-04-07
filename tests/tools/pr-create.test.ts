import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { prCreateTool } from '../../src/tools/pr-create.js';

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

describe('pr-create tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a PR and returns URL and number', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: 'https://github.com/owner/repo/pull/42\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await prCreateTool.handler(
      {
        head: 'loom/ratchet-task',
        base: 'main',
        title: 'feat: add thing',
        body: 'Description here',
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe('https://github.com/owner/repo/pull/42');
      expect(result.data.number).toBe(42);
    }
  });

  it('constructs correct gh command with body', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: 'https://github.com/owner/repo/pull/1\n',
      stderr: '',
      exitCode: 0,
    });

    await prCreateTool.handler(
      {
        head: 'feature-branch',
        base: 'main',
        title: 'My PR',
        body: 'PR body',
      },
      makeCtx(),
    );

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'create', '--head', 'feature-branch', '--base', 'main', '--title', 'My PR', '--body', 'PR body'],
      '/tmp/worktree',
    );
  });

  it('omits body flag when body is not provided', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: 'https://github.com/owner/repo/pull/5\n',
      stderr: '',
      exitCode: 0,
    });

    await prCreateTool.handler(
      {
        head: 'feature',
        base: 'main',
        title: 'title',
      },
      makeCtx(),
    );

    const args = mockExec.mock.calls[0][1];
    expect(args).not.toContain('--body');
  });

  it('returns error on gh failure', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'not authenticated',
      exitCode: 1,
    });

    const result = await prCreateTool.handler(
      {
        head: 'branch',
        base: 'main',
        title: 'title',
      },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('pr-create-failed');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('handles URL without PR number gracefully', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: 'Created PR\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await prCreateTool.handler(
      {
        head: 'branch',
        base: 'main',
        title: 'title',
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.number).toBe(0);
    }
  });

  it('is scoped to orchestrator role only', () => {
    expect(prCreateTool.definition.roles).toEqual(['orchestrator']);
  });
});
