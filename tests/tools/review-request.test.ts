import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { reviewRequestTool } from '../../src/tools/review-request.js';

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

describe('review-request tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requests review from a single reviewer', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    const result = await reviewRequestTool.handler(
      { number: 42, reviewers: ['drift'] },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.number).toBe(42);
      expect(result.data.reviewers).toEqual(['drift']);
    }
  });

  it('requests review from multiple reviewers', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await reviewRequestTool.handler(
      { number: 42, reviewers: ['drift', 'sable', 'thorn'] },
      makeCtx(),
    );

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'edit', '42', '--add-reviewer', 'drift,sable,thorn'],
      '/tmp/worktree',
    );
  });

  it('returns error on failure', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'user not found',
      exitCode: 1,
    });

    const result = await reviewRequestTool.handler(
      { number: 42, reviewers: ['unknown-user'] },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('review-request-failed');
    }
  });

  it('is scoped to orchestrator role only', () => {
    expect(reviewRequestTool.definition.roles).toEqual(['orchestrator']);
  });
});
