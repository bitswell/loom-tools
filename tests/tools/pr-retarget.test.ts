import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { prRetargetTool } from '../../src/tools/pr-retarget.js';

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

describe('pr-retarget tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retargets a PR to a new base branch', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    const result = await prRetargetTool.handler(
      { number: 42, base: 'develop' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.number).toBe(42);
      expect(result.data.base).toBe('develop');
    }
  });

  it('calls gh pr edit with correct args', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await prRetargetTool.handler(
      { number: 10, base: 'staging' },
      makeCtx(),
    );

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'edit', '10', '--base', 'staging'],
      '/tmp/worktree',
    );
  });

  it('returns error on failure', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'could not find PR',
      exitCode: 1,
    });

    const result = await prRetargetTool.handler(
      { number: 999, base: 'main' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('pr-retarget-failed');
    }
  });

  it('is scoped to orchestrator role only', () => {
    expect(prRetargetTool.definition.roles).toEqual(['orchestrator']);
  });
});
