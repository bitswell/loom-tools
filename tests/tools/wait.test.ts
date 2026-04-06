import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { waitTool } from '../../src/tools/wait.js';

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

describe('wait tool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately if branch already has terminal status', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: 'Task-Status: COMPLETED\nAgent-Id: ratchet\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await waitTool.handler(
      { branch: 'loom/ratchet-task' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('COMPLETED');
      expect(result.data.branch).toBe('loom/ratchet-task');
      expect(result.data.trailers['Agent-Id']).toBe('ratchet');
    }
  });

  it('recognizes FAILED as terminal', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: 'Task-Status: FAILED\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await waitTool.handler(
      { branch: 'loom/agent' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('FAILED');
    }
  });

  it('recognizes BLOCKED as terminal', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: 'Task-Status: BLOCKED\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await waitTool.handler(
      { branch: 'loom/agent' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('BLOCKED');
    }
  });

  it('polls until terminal status is found', async () => {
    // First check: not terminal
    mockExec.mockResolvedValueOnce({
      stdout: 'Task-Status: IMPLEMENTING\n',
      stderr: '',
      exitCode: 0,
    });

    const promise = waitTool.handler(
      { branch: 'loom/ratchet-task', pollIntervalMs: 1000, timeoutMs: 10000 },
      makeCtx(),
    );

    // After first poll, set up the terminal response
    mockExec.mockResolvedValueOnce({
      stdout: 'Task-Status: COMPLETED\nAgent-Id: ratchet\n',
      stderr: '',
      exitCode: 0,
    });

    // Advance time past the poll interval
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('COMPLETED');
    }
  });

  it('times out if no terminal status found', async () => {
    // Always return non-terminal
    mockExec.mockResolvedValue({
      stdout: 'Task-Status: IMPLEMENTING\n',
      stderr: '',
      exitCode: 0,
    });

    const promise = waitTool.handler(
      { branch: 'loom/stuck', pollIntervalMs: 100, timeoutMs: 500 },
      makeCtx(),
    );

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('timeout');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('is scoped to orchestrator role only', () => {
    expect(waitTool.definition.roles).toEqual(['orchestrator']);
  });
});
