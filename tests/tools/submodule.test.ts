import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { submoduleTool } from '../../src/tools/submodule.js';

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

describe('submodule tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks out ref and stages submodule change', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '', exitCode: 0 }) // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // git add

    const result = await submoduleTool.handler(
      { path: 'repos/loom-tools', ref: 'v1.0.0' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe('repos/loom-tools');
      expect(result.data.sha).toBe('abc123');
      expect(result.data.ref).toBe('v1.0.0');
    }
  });

  it('runs git -C with correct submodule path', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await submoduleTool.handler(
      { path: 'deps/external', ref: 'main' },
      makeCtx(),
    );

    // Checkout call
    expect(mockExec.mock.calls[0]).toEqual([
      'git',
      ['-C', 'deps/external', 'checkout', 'main'],
      '/tmp/worktree',
    ]);

    // Rev-parse call
    expect(mockExec.mock.calls[1]).toEqual([
      'git',
      ['-C', 'deps/external', 'rev-parse', 'HEAD'],
      '/tmp/worktree',
    ]);

    // Stage call
    expect(mockExec.mock.calls[2]).toEqual([
      'git',
      ['add', 'deps/external'],
      '/tmp/worktree',
    ]);
  });

  it('returns error on checkout failure', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'error: pathspec not found',
      exitCode: 1,
    });

    const result = await submoduleTool.handler(
      { path: 'repos/thing', ref: 'nonexistent-tag' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('submodule-checkout-failed');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('returns error on staging failure', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout ok
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 }) // rev-parse ok
      .mockResolvedValueOnce({ stdout: '', stderr: 'not a submodule', exitCode: 128 }); // add fails

    const result = await submoduleTool.handler(
      { path: 'repos/thing', ref: 'main' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('git-add-failed');
    }
  });

  it('is scoped to orchestrator role only', () => {
    expect(submoduleTool.definition.roles).toEqual(['orchestrator']);
  });
});
