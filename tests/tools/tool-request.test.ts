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

/**
 * Stage the six git calls of the non-blocking happy path:
 * fetch / rev-parse / hash-object / commit-tree / update-ref / push.
 *
 * Pass an empty `parent` to simulate an orphan creation.
 */
function stageHappyPath(parent: string, newSha: string): void {
  mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
  mockExec.mockResolvedValueOnce(
    parent
      ? { stdout: `${parent}\n`, stderr: '', exitCode: 0 }
      : { stdout: '', stderr: 'unknown ref', exitCode: 1 },
  );
  mockExec.mockResolvedValueOnce({
    stdout: '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n',
    stderr: '',
    exitCode: 0,
  });
  mockExec.mockResolvedValueOnce({
    stdout: `${newSha}\n`,
    stderr: '',
    exitCode: 0,
  });
  mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
  mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
}

describe('tool-request tool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns commitSha from commit-tree (orphan creation)', async () => {
    stageHappyPath('', 'new-sha');

    const ctx = makeCtx();
    const result = await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'Need to deploy to staging' },
      ctx,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requested).toBe('deploy');
      expect(result.data.commitSha).toBe('new-sha');
      expect(result.data.fulfilled).toBe(false);
    }

    const commitTreeArgs = mockExec.mock.calls[3][1];
    expect(commitTreeArgs[0]).toBe('commit-tree');
    expect(commitTreeArgs).not.toContain('-p');

    const updateArgs = mockExec.mock.calls[4][1];
    expect(updateArgs[0]).toBe('update-ref');
    expect(updateArgs[1]).toBe('refs/heads/tool-requests');
    expect(updateArgs[3]).toBe('0'.repeat(40));
  });

  it('uses existing tip as parent when ref exists', async () => {
    stageHappyPath('parent-sha', 'new-sha');

    await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx(),
    );

    const commitTreeArgs = mockExec.mock.calls[3][1];
    const pIdx = commitTreeArgs.indexOf('-p');
    expect(pIdx).toBeGreaterThan(-1);
    expect(commitTreeArgs[pIdx + 1]).toBe('parent-sha');

    const updateArgs = mockExec.mock.calls[4][1];
    expect(updateArgs[3]).toBe('parent-sha');
  });

  it('embeds required trailers in commit message', async () => {
    stageHappyPath('', 'sha');

    await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx({ agentId: 'moss', sessionId: 'sess-123' }),
    );

    const commitTreeArgs = mockExec.mock.calls[3][1];
    const mIdx = commitTreeArgs.indexOf('-m');
    const message = commitTreeArgs[mIdx + 1];
    expect(message).toContain('Agent-Id: moss');
    expect(message).toContain('Session-Id: sess-123');
    expect(message).toContain('Tool-Requested: deploy');
    expect(message).toMatch(/Heartbeat: \d{4}-\d{2}-\d{2}T/);
  });

  it('never invokes `git commit` against the caller worktree', async () => {
    stageHappyPath('', 'sha');

    await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx(),
    );

    for (const call of mockExec.mock.calls) {
      expect(call[1][0]).not.toBe('commit');
    }
  });

  it('emits tool-requested event with commitSha', async () => {
    stageHappyPath('', 'new-sha');

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
          commitSha: 'new-sha',
        }),
      }),
    );
  });

  it('emits tool-request-push-failed on push failure but still returns ok', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: 'x', exitCode: 1 });
    mockExec.mockResolvedValueOnce({
      stdout: '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n',
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({
      stdout: 'req-sha\n',
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'fatal: unable to access origin',
      exitCode: 128,
    });

    const ctx = makeCtx();
    const result = await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'offline test' },
      ctx,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commitSha).toBe('req-sha');
    }
    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool-request-push-failed',
        payload: expect.objectContaining({
          toolName: 'deploy',
          commitSha: 'req-sha',
        }),
      }),
    );
  });

  it('returns error when commit-tree fails', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: 'x', exitCode: 1 });
    mockExec.mockResolvedValueOnce({
      stdout: '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n',
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'commit-tree error',
      exitCode: 128,
    });

    const result = await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('commit-tree-failed');
    }
  });

  it('blocking poll resolves fulfilled=true on matching Tool-Request-Sha', async () => {
    stageHappyPath('', 'req-sha');

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

    // First poll: a commit that is Tool-Requested only — no fulfillment.
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    mockExec.mockResolvedValueOnce({
      stdout:
        'some-other-sha\x00Agent-Id: other\nTool-Requested: other\n\x1e',
      stderr: '',
      exitCode: 0,
    });
    await vi.advanceTimersByTimeAsync(100);

    // Second poll: fulfillment landed.
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    mockExec.mockResolvedValueOnce({
      stdout:
        'fulfill-sha\x00Tool-Provided: deploy\nTool-Request-Sha: req-sha\n\x1e',
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

  it('blocking poll ignores fulfillment for a different request sha', async () => {
    stageHappyPath('', 'req-sha');

    const promise = toolRequestTool.handler(
      {
        toolName: 'deploy',
        reason: 'need it',
        blocking: true,
        pollIntervalMs: 100,
        timeoutMs: 300,
      },
      makeCtx(),
    );

    mockExec.mockResolvedValue({
      stdout:
        'x\x00Tool-Provided: deploy\nTool-Request-Sha: other-sha\n\x1e',
      stderr: '',
      exitCode: 0,
    });

    await vi.advanceTimersByTimeAsync(400);

    const result = await promise;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fulfilled).toBe(false);
    }
  });

  it('times out when blocking and no fulfillment arrives', async () => {
    stageHappyPath('', 'req-sha');

    mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

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

  it('is accessible to writer, reviewer, orchestrator', () => {
    expect(toolRequestTool.definition.roles).toEqual([
      'writer',
      'reviewer',
      'orchestrator',
    ]);
  });
});
