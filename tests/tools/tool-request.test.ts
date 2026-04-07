import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { toolRequestTool } from '../../src/tools/tool-request.js';

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
    branch: 'loom/ratchet-task',
    worktree: '/tmp/worktree',
    scope: ['src/'],
    scopeDenied: [],
    emit: vi.fn(),
    ...overrides,
  };
}

describe('tool-request tool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a commit with Tool-Requested trailer (non-blocking)', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit
      .mockResolvedValueOnce({ stdout: 'req-sha\n', stderr: '', exitCode: 0 }); // rev-parse

    const ctx = makeCtx();
    const result = await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'Need to deploy to staging' },
      ctx,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requested).toBe('deploy');
      expect(result.data.commitSha).toBe('req-sha');
      expect(result.data.fulfilled).toBe(false);
    }
  });

  it('includes Tool-Requested trailer in commit args', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 });

    await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx(),
    );

    const commitArgs = mockExec.mock.calls[0][1];
    expect(commitArgs.join(' ')).toContain('Tool-Requested: deploy');
    expect(commitArgs).toContain('--allow-empty');
  });

  it('emits tool-requested event', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 });

    const ctx = makeCtx();
    await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'staging deploy' },
      ctx,
    );

    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool-requested',
        payload: expect.objectContaining({
          toolName: 'deploy',
          reason: 'staging deploy',
        }),
      }),
    );
  });

  it('polls for Tool-Provided when blocking', async () => {
    // Commit and rev-parse for the request
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 });

    const promise = toolRequestTool.handler(
      {
        toolName: 'deploy',
        reason: 'need it',
        blocking: true,
        pollIntervalMs: 100,
        timeoutMs: 5000,
      },
      makeCtx(),
    );

    // First poll: not yet provided
    mockExec.mockResolvedValueOnce({
      stdout: 'Tool-Requested: deploy\n',
      stderr: '',
      exitCode: 0,
    });
    await vi.advanceTimersByTimeAsync(100);

    // Second poll: provided
    mockExec.mockResolvedValueOnce({
      stdout: 'Tool-Provided: deploy\n',
      stderr: '',
      exitCode: 0,
    });
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fulfilled).toBe(true);
    }
  });

  it('times out when blocking and tool not provided', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 });

    // Always return non-provided
    mockExec.mockResolvedValue({
      stdout: 'Tool-Requested: deploy\n',
      stderr: '',
      exitCode: 0,
    });

    const promise = toolRequestTool.handler(
      {
        toolName: 'deploy',
        reason: 'need it',
        blocking: true,
        pollIntervalMs: 100,
        timeoutMs: 500,
      },
      makeCtx(),
    );

    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fulfilled).toBe(false);
    }
  });

  it('returns error when commit fails', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'commit error',
      exitCode: 1,
    });

    const result = await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('commit-failed');
    }
  });

  it('is accessible to all roles', () => {
    expect(toolRequestTool.definition.roles).toEqual([
      'writer',
      'reviewer',
      'orchestrator',
    ]);
  });
});
