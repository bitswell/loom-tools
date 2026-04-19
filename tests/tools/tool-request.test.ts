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

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Synthetic 40-char hex shas — ls-remote parsing demands real-looking hex.
const FAKE_NEW_SHA = '1111111111111111111111111111111111111111';
const FAKE_PARENT_SHA = '2222222222222222222222222222222222222222';
const FAKE_ORIGIN_SHA = '3333333333333333333333333333333333333333';
const FAKE_LOCAL_SHA = '4444444444444444444444444444444444444444';
const FAKE_REQ_SHA = '5555555555555555555555555555555555555555';
const FAKE_SAME_SHA = '6666666666666666666666666666666666666666';

/**
 * Stage the non-blocking happy path when origin lacks the ref and
 * there is no local tip (full orphan).
 *
 * Calls:
 *   0. ls-remote → exit 2 (no ref on origin)
 *   1. rev-parse --verify --quiet (readLocalTip) → exit 1
 *   2. hash-object → tree sha
 *   3. commit-tree → newSha
 *   4. update-ref → ok
 *   5. push → ok
 */
function stageOrphanPath(newSha: string): void {
  mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 2 });
  mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
  mockExec.mockResolvedValueOnce({
    stdout: `${EMPTY_TREE_SHA}\n`,
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

/**
 * Stage the non-blocking happy path when origin has the ref AND local
 * already matches origin (equal case — no fetch, no merge-base).
 *
 * parentSha MUST be 40-char hex (ls-remote stdout sha-format check).
 *
 * Calls:
 *   0. ls-remote → exit 0, sha
 *   1. rev-parse (readLocalTip) → same sha
 *   2. hash-object → tree sha
 *   3. commit-tree → newSha
 *   4. update-ref → ok
 *   5. push → ok
 */
function stageParentedPath(parentSha: string, newSha: string): void {
  mockExec.mockResolvedValueOnce({
    stdout: `${parentSha}\trefs/heads/tool-requests\n`,
    stderr: '',
    exitCode: 0,
  });
  mockExec.mockResolvedValueOnce({
    stdout: `${parentSha}\n`,
    stderr: '',
    exitCode: 0,
  });
  mockExec.mockResolvedValueOnce({
    stdout: `${EMPTY_TREE_SHA}\n`,
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

  it('returns commitSha and pushed=true on orphan creation', async () => {
    stageOrphanPath('new-sha');

    const result = await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'staging' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requested).toBe('deploy');
      expect(result.data.commitSha).toBe('new-sha');
      expect(result.data.fulfilled).toBe(false);
      expect(result.data.pushed).toBe(true);
    }

    // commit-tree (call 3) has no -p on orphan path.
    expect(mockExec.mock.calls[3][1][0]).toBe('commit-tree');
    expect(mockExec.mock.calls[3][1]).not.toContain('-p');

    // update-ref (call 4) uses null sha as expected-old.
    const updateArgs = mockExec.mock.calls[4][1];
    expect(updateArgs[0]).toBe('update-ref');
    expect(updateArgs[1]).toBe('refs/heads/tool-requests');
    expect(updateArgs[3]).toBe('0'.repeat(40));
  });

  it('chains onto existing origin tip when local matches origin', async () => {
    stageParentedPath(FAKE_PARENT_SHA, FAKE_NEW_SHA);

    await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx(),
    );

    // Call order: ls-remote, rev-parse, hash-object, commit-tree, update-ref, push.
    const commitTreeArgs = mockExec.mock.calls[3][1];
    const pIdx = commitTreeArgs.indexOf('-p');
    expect(pIdx).toBeGreaterThan(-1);
    expect(commitTreeArgs[pIdx + 1]).toBe(FAKE_PARENT_SHA);

    const updateArgs = mockExec.mock.calls[4][1];
    expect(updateArgs[3]).toBe(FAKE_PARENT_SHA);
  });

  it('embeds required trailers in commit message', async () => {
    stageOrphanPath('sha');

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
    stageOrphanPath('sha');

    await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx(),
    );

    for (const call of mockExec.mock.calls) {
      expect(call[1][0]).not.toBe('commit');
    }
  });

  it('refuses when caller is on the tool-requests branch', async () => {
    const ctx = makeCtx({ branch: 'tool-requests' });
    const result = await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      ctx,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('caller-on-tool-requests');
      expect(result.error.retryable).toBe(false);
    }
    expect(mockExec).not.toHaveBeenCalled();
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it('refuses when caller is on refs/heads/tool-requests', async () => {
    const result = await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx({ branch: 'refs/heads/tool-requests' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('caller-on-tool-requests');
    }
  });

  it('errors with tool-requests-diverged when local and origin truly diverge', async () => {
    // ls-remote ok (origin tip), readLocalTip returns a different sha,
    // neither is ancestor of the other.
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_ORIGIN_SHA}\trefs/heads/tool-requests\n`,
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_LOCAL_SHA}\n`,
      stderr: '',
      exitCode: 0,
    });
    // merge-base --is-ancestor origin local → not ancestor
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
    // merge-base --is-ancestor local origin → not ancestor
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });

    const result = await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('tool-requests-diverged');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('treats local-ahead-of-origin as valid (stranded commits) — no fetch', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_ORIGIN_SHA}\trefs/heads/tool-requests\n`,
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_LOCAL_SHA}\n`,
      stderr: '',
      exitCode: 0,
    });
    // merge-base --is-ancestor origin local → 0 (origin is ancestor)
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    // tree, commit-tree, update-ref, push
    mockExec.mockResolvedValueOnce({
      stdout: `${EMPTY_TREE_SHA}\n`,
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_NEW_SHA}\n`,
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    const result = await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commitSha).toBe(FAKE_NEW_SHA);
    }

    // No fetch was run — stranded commits preserved.
    for (const call of mockExec.mock.calls) {
      expect(call[1][0]).not.toBe('fetch');
    }

    // commit-tree parented onto local tip.
    const commitTreeArgs = mockExec.mock.calls[4][1];
    const pIdx = commitTreeArgs.indexOf('-p');
    expect(commitTreeArgs[pIdx + 1]).toBe(FAKE_LOCAL_SHA);
  });

  it('fetches when origin is strictly ahead of local', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_ORIGIN_SHA}\trefs/heads/tool-requests\n`,
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_LOCAL_SHA}\n`,
      stderr: '',
      exitCode: 0,
    });
    // merge-base origin local → not ancestor
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
    // merge-base local origin → IS ancestor (origin ahead)
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    // fetch ok
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    // readLocalTip after fetch
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_ORIGIN_SHA}\n`,
      stderr: '',
      exitCode: 0,
    });
    // tree, commit-tree, update-ref, push
    mockExec.mockResolvedValueOnce({
      stdout: `${EMPTY_TREE_SHA}\n`,
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_NEW_SHA}\n`,
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    const result = await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commitSha).toBe(FAKE_NEW_SHA);
    }

    // commit-tree parented onto origin (post-fetch local tip).
    const commitTreeArgs = mockExec.mock.calls[7][1];
    const pIdx = commitTreeArgs.indexOf('-p');
    expect(commitTreeArgs[pIdx + 1]).toBe(FAKE_ORIGIN_SHA);
  });

  it('returns origin-unreachable error when ls-remote fails and no local tip', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'Could not resolve host: github.com',
      exitCode: 128,
    });
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: 1,
    });

    const result = await toolRequestTool.handler(
      { toolName: 'deploy', reason: 'need it' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('origin-unreachable');
    }
  });

  it('emits tool-requested event with commitSha', async () => {
    stageOrphanPath('new-sha');

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

  it('emits tool-request-push-failed with pushed=false on push failure', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 2 });
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
    mockExec.mockResolvedValueOnce({
      stdout: `${EMPTY_TREE_SHA}\n`,
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
      expect(result.data.pushed).toBe(false);
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
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 2 });
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
    mockExec.mockResolvedValueOnce({
      stdout: `${EMPTY_TREE_SHA}\n`,
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

  /**
   * Stage one poll tick that re-syncs with origin (sees origin equals
   * local, no fetch) and then runs git log.
   */
  function stagePollTick(logStdout: string): void {
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_SAME_SHA}\trefs/heads/tool-requests\n`,
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_SAME_SHA}\n`,
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({
      stdout: logStdout,
      stderr: '',
      exitCode: 0,
    });
  }

  it('blocking poll resolves fulfilled=true on matching Tool-Request-Sha', async () => {
    stageOrphanPath(FAKE_REQ_SHA);

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

    stagePollTick('other\x00Agent-Id: other\nTool-Requested: other\n\x1e');
    await vi.advanceTimersByTimeAsync(100);

    stagePollTick(
      `fulfill\x00Tool-Provided: deploy\nTool-Request-Sha: ${FAKE_REQ_SHA}\n\x1e`,
    );
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fulfilled).toBe(true);
      expect(result.data.pushed).toBe(true);
    }
  });

  it('blocking poll ignores fulfillment for a different request sha', async () => {
    stageOrphanPath(FAKE_REQ_SHA);

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

    mockExec.mockImplementation(async (_cmd: string, args: string[]) => {
      const sub = args[0];
      if (sub === 'ls-remote') {
        return {
          stdout: `${FAKE_SAME_SHA}\trefs/heads/tool-requests\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (sub === 'rev-parse') {
        return { stdout: `${FAKE_SAME_SHA}\n`, stderr: '', exitCode: 0 };
      }
      if (sub === 'log') {
        return {
          stdout:
            'x\x00Tool-Provided: deploy\nTool-Request-Sha: 9999999999999999999999999999999999999999\n\x1e',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await vi.advanceTimersByTimeAsync(400);

    const result = await promise;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fulfilled).toBe(false);
    }
  });

  it('blocking poll bails out on divergence detected during sync', async () => {
    stageOrphanPath(FAKE_REQ_SHA);

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

    // Poll tick: ls-remote ok, local has different sha, neither ancestor.
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_ORIGIN_SHA}\trefs/heads/tool-requests\n`,
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({
      stdout: `${FAKE_LOCAL_SHA}\n`,
      stderr: '',
      exitCode: 0,
    });
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('tool-requests-diverged');
    }
  });

  it('times out when blocking and no fulfillment arrives', async () => {
    stageOrphanPath(FAKE_REQ_SHA);

    mockExec.mockImplementation(async (_cmd: string, args: string[]) => {
      const sub = args[0];
      if (sub === 'ls-remote') {
        return {
          stdout: `${FAKE_SAME_SHA}\trefs/heads/tool-requests\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (sub === 'rev-parse') {
        return { stdout: `${FAKE_SAME_SHA}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
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

  it('is accessible to writer, reviewer, orchestrator', () => {
    expect(toolRequestTool.definition.roles).toEqual([
      'writer',
      'reviewer',
      'orchestrator',
    ]);
  });
});
